import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SuiteStatus = 'not-run' | 'incomplete' | 'passed' | 'failed';

export interface SuiteResult {
  readonly key: string;
  readonly name: string;
  readonly status: SuiteStatus;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
}

export interface GateRecord {
  readonly schemaVersion: 2;
  readonly recordedAt: string;
  readonly commitSha: string | null;
  readonly environment: string | null;
  readonly exitCode: number | null;
  readonly valid: boolean;
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly suites: readonly SuiteResult[];
  readonly cucumber: {
    readonly scenarios: {
      readonly total: number;
      readonly passed: number;
      readonly failed: number;
      readonly skipped: number;
    };
    readonly steps: {
      readonly total: number;
      readonly passed: number;
      readonly failed: number;
      readonly skipped: number;
    };
  };
}

export interface GateMetadata {
  readonly commitSha?: string;
  readonly environment?: string;
  readonly recordedAt?: string;
}

interface SuiteSpec {
  readonly key: string;
  readonly name: string;
  readonly marker: string;
}

interface Counts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

interface ParsedSuite {
  readonly result: SuiteResult;
  readonly errors: readonly string[];
}

const SUITES: readonly SuiteSpec[] = [
  { key: 'unit', name: 'Unitária', marker: '$ bun test test/unit' },
  { key: 'infra', name: 'Infraestrutura', marker: '$ bun test test/infra' },
  { key: 'integration', name: 'Integração', marker: '$ bun test test/integration' },
  { key: 'concurrency', name: 'Concorrência', marker: '$ bun test test/concurrency' },
  { key: 'e2e', name: 'E2E', marker: '$ bun test test/e2e' },
  {
    key: 'features',
    name: 'Cenários Gherkin',
    marker: '$ bun --bun node_modules/.bin/cucumber-js',
  },
];

const EMPTY_COUNTS: Counts = { total: 0, passed: 0, failed: 0, skipped: 0 };

function sectionBetween(log: string, start: number, end: number): string {
  return log.slice(start, end);
}

function numberLines(body: string, expression: RegExp): number[] {
  return [...body.matchAll(expression)].flatMap((match) => {
    const value = match[1];
    if (value === undefined) return [];
    const number = Number.parseInt(value, 10);
    return Number.isSafeInteger(number) ? [number] : [];
  });
}

function notRun(spec: SuiteSpec): SuiteResult {
  return { key: spec.key, name: spec.name, status: 'not-run', ...EMPTY_COUNTS };
}

function incomplete(spec: SuiteSpec, counts: Counts = EMPTY_COUNTS): SuiteResult {
  return { key: spec.key, name: spec.name, status: 'incomplete', ...counts };
}

function bunSuite(body: string, spec: SuiteSpec): ParsedSuite {
  const passed = numberLines(body, /^\s*(\d+) pass\s*$/gm);
  const failed = numberLines(body, /^\s*(\d+) fail\s*$/gm);
  const skipped = numberLines(body, /^\s*(\d+) skip\s*$/gm);
  const runs = [...body.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)];
  if (passed.length !== 1 || failed.length !== 1 || skipped.length > 1 || runs.length !== 1) {
    return {
      result: incomplete(spec),
      errors: [`${spec.key}: resumo Bun ausente ou ambíguo`],
    };
  }

  const passCount = passed[0] ?? 0;
  const failCount = failed[0] ?? 0;
  const skipCount = skipped[0] ?? 0;
  const run = runs[0];
  const runCount = run?.[1] === undefined ? Number.NaN : Number.parseInt(run[1], 10);
  const fileCount = run?.[2] === undefined ? Number.NaN : Number.parseInt(run[2], 10);
  const counts: Counts = {
    passed: passCount,
    failed: failCount,
    skipped: skipCount,
    total: passCount + failCount + skipCount,
  };
  const consistent =
    Number.isSafeInteger(runCount) &&
    Number.isSafeInteger(fileCount) &&
    runCount > 0 &&
    fileCount > 0 &&
    counts.total === runCount;
  if (!consistent) {
    return {
      result: incomplete(spec, counts),
      errors: [`${spec.key}: totais do resumo Bun inconsistentes ou sem testes executados`],
    };
  }

  return {
    result: {
      key: spec.key,
      name: spec.name,
      status: failCount === 0 && skipCount === 0 ? 'passed' : 'failed',
      ...counts,
    },
    errors: [],
  };
}

function parseCucumberCounts(
  detail: string,
  total: number,
  label: string,
): { counts: Counts; errors: string[] } {
  const matches = [
    ...detail.matchAll(/(\d+)\s+(passed|failed|skipped|pending|undefined|ambiguous)\b/g),
  ];
  const remainder = detail
    .replace(/(\d+)\s+(?:passed|failed|skipped|pending|undefined|ambiguous)\b/g, '')
    .replace(/[\s,]/g, '');
  const statuses = new Map<string, number>();
  for (const match of matches) {
    const rawNumber = match[1];
    const status = match[2];
    if (rawNumber === undefined || status === undefined) continue;
    statuses.set(status, Number.parseInt(rawNumber, 10));
  }
  const passed = statuses.get('passed') ?? 0;
  const failed = statuses.get('failed') ?? 0;
  const skipped = ['skipped', 'pending', 'undefined', 'ambiguous'].reduce(
    (sum, status) => sum + (statuses.get(status) ?? 0),
    0,
  );
  const counts: Counts = { total, passed, failed, skipped };
  const errors: string[] = [];
  if (remainder !== '') errors.push(`${label}: resumo contém status desconhecido`);
  if (total <= 0 || matches.length === 0 || passed + failed + skipped !== total) {
    errors.push(`${label}: totais Gherkin inconsistentes ou sem testes executados`);
  }
  return { counts, errors };
}

function cucumberSuite(
  body: string,
  spec: SuiteSpec,
): ParsedSuite & {
  cucumber: { scenarios: Counts; steps: Counts };
} {
  const scenarioLines = [...body.matchAll(/^\s*(\d+) scenarios?\s*\(([^)]*)\)\s*$/gim)];
  const stepLines = [...body.matchAll(/^\s*(\d+) steps?\s*\(([^)]*)\)\s*$/gim)];
  if (scenarioLines.length !== 1 || stepLines.length !== 1) {
    return {
      result: incomplete(spec),
      errors: ['features: resumo Gherkin ausente ou ambíguo'],
      cucumber: { scenarios: EMPTY_COUNTS, steps: EMPTY_COUNTS },
    };
  }
  const scenarioLine = scenarioLines[0];
  const stepLine = stepLines[0];
  const scenarioTotal = Number.parseInt(scenarioLine?.[1] ?? '', 10);
  const stepTotal = Number.parseInt(stepLine?.[1] ?? '', 10);
  const scenarios = parseCucumberCounts(
    scenarioLine?.[2] ?? '',
    scenarioTotal,
    'features/cenários',
  );
  const steps = parseCucumberCounts(stepLine?.[2] ?? '', stepTotal, 'features/passos');
  const errors = [...scenarios.errors, ...steps.errors];
  const validCounts = errors.length === 0;
  const suiteCounts: Counts = {
    total: scenarios.counts.total,
    passed: scenarios.counts.passed,
    failed: scenarios.counts.failed,
    skipped: scenarios.counts.skipped,
  };
  return {
    result: {
      key: spec.key,
      name: spec.name,
      status: !validCounts
        ? 'incomplete'
        : suiteCounts.failed === 0 && suiteCounts.skipped === 0
          ? 'passed'
          : 'failed',
      ...suiteCounts,
    },
    errors,
    cucumber: { scenarios: scenarios.counts, steps: steps.counts },
  };
}

function metadataErrors(metadata: GateMetadata): string[] {
  const errors: string[] = [];
  if (metadata.commitSha === undefined || !/^[a-f0-9]{40}$/i.test(metadata.commitSha)) {
    errors.push('SHA completo do commit ausente ou inválido');
  }
  if (
    metadata.environment === undefined ||
    metadata.environment.trim() === '' ||
    metadata.environment.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(metadata.environment)
  ) {
    errors.push('ambiente ausente ou inválido');
  }
  if (
    metadata.recordedAt !== undefined &&
    (!Number.isFinite(Date.parse(metadata.recordedAt)) || metadata.recordedAt.trim() === '')
  ) {
    errors.push('data do registro inválida');
  }
  return errors;
}

function exitStatus(log: string): { exitCode: number | null; errors: string[] } {
  const matches = [...log.matchAll(/^check:all exit=(\d+)\s*$/gm)];
  if (matches.length !== 1) {
    return { exitCode: null, errors: ['log precisa conter exatamente um exit code explícito'] };
  }
  const match = matches[0];
  const exitCode = Number.parseInt(match?.[1] ?? '', 10);
  const index = match?.index;
  const trailer = match?.[0];
  if (
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    index === undefined ||
    trailer === undefined
  ) {
    return { exitCode: null, errors: ['exit code explícito inválido'] };
  }
  if (log.slice(index + trailer.length).trim() !== '') {
    return { exitCode: null, errors: ['log contém dados depois do exit code final'] };
  }
  return { exitCode, errors: [] };
}

export function parseCheckAllLog(log: string, metadata: GateMetadata = {}): GateRecord {
  const errors = [...metadataErrors(metadata)];
  const status = exitStatus(log);
  errors.push(...status.errors);

  const commandMarkers = [
    ...log.matchAll(
      /^\$ bun (?:test test\/[^\r\n]+|--bun node_modules\/\.bin\/cucumber-js[^\r\n]*)/gm,
    ),
  ];
  const suites: SuiteResult[] = [];
  let cucumber = { scenarios: EMPTY_COUNTS, steps: EMPTY_COUNTS };

  for (const spec of SUITES) {
    const markers = commandMarkers.filter(
      (item) => item.index !== undefined && log.startsWith(spec.marker, item.index),
    );
    if (markers.length === 0) {
      suites.push(notRun(spec));
      errors.push(`${spec.key}: suíte não foi executada`);
      continue;
    }
    if (markers.length !== 1) {
      suites.push(incomplete(spec));
      errors.push(`${spec.key}: marcador de execução duplicado`);
      continue;
    }
    const markerIndex = markers[0]?.index;
    if (markerIndex === undefined) {
      suites.push(incomplete(spec));
      errors.push(`${spec.key}: posição do marcador inválida`);
      continue;
    }
    const nextMarker = SUITES.flatMap((candidate) =>
      commandMarkers
        .filter(
          (item) =>
            item.index !== undefined &&
            item.index > markerIndex &&
            log.startsWith(candidate.marker, item.index),
        )
        .map((item) => item.index ?? Number.POSITIVE_INFINITY),
    ).sort((left, right) => left - right)[0];
    const body = sectionBetween(log, markerIndex, nextMarker ?? log.length);
    if (spec.key === 'features') {
      const parsed = cucumberSuite(body, spec);
      suites.push(parsed.result);
      errors.push(...parsed.errors);
      cucumber = parsed.cucumber;
    } else {
      const parsed = bunSuite(body, spec);
      suites.push(parsed.result);
      errors.push(...parsed.errors);
    }
  }

  const valid = errors.length === 0 && status.exitCode !== null;
  const passed =
    valid &&
    status.exitCode === 0 &&
    suites.length === SUITES.length &&
    suites.every((suite) => suite.status === 'passed');
  return {
    schemaVersion: 2,
    recordedAt: metadata.recordedAt ?? new Date().toISOString(),
    commitSha: metadata.commitSha ?? null,
    environment: metadata.environment ?? null,
    exitCode: status.exitCode,
    valid,
    passed,
    errors,
    suites,
    cucumber,
  };
}

async function recordGate(
  logPath: string,
  metadata: GateMetadata,
  outputPath: string,
): Promise<GateRecord> {
  const record = parseCheckAllLog(await readFile(logPath, 'utf8'), metadata);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const [logPath, commitSha, environment, requestedOutputPath] = process.argv.slice(2);
  if (logPath === undefined || commitSha === undefined || environment === undefined) {
    console.error(
      'Uso: bun run scripts/record-gate.ts <log-check-all> <commit-sha> <ambiente> [arquivo-json]',
    );
    process.exit(2);
  }
  try {
    const outputPath = resolve(root, requestedOutputPath ?? 'docs/gate/ultimo-gate.json');
    const record = await recordGate(logPath, { commitSha, environment }, outputPath);
    console.log(
      `Gate registrado: válido=${record.valid}, exit code=${record.exitCode ?? 'ausente'}, aprovado=${record.passed}`,
    );
    if (!record.valid || !record.passed) process.exitCode = 1;
  } catch (error) {
    console.error(
      `Falha ao registrar gate: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
