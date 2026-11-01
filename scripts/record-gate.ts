import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SuiteResult {
  readonly key: string;
  readonly name: string;
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

export interface GateRecord {
  readonly recordedAt: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly suites: readonly SuiteResult[];
  readonly cucumber: {
    readonly scenarios: {
      readonly total: number;
      readonly passed: number;
      readonly failed: number;
    };
    readonly steps: {
      readonly total: number;
      readonly passed: number;
      readonly failed: number;
      readonly skipped: number;
    };
  };
}

interface SuiteSpec {
  readonly key: string;
  readonly name: string;
  readonly marker: string;
}

const SUITES: readonly SuiteSpec[] = [
  { key: 'unit', name: 'Unitária', marker: '$ bun test test/unit' },
  { key: 'infra', name: 'Infraestrutura', marker: '$ bun test test/infra' },
  { key: 'integration', name: 'Integração', marker: '$ bun test test/integration' },
  { key: 'concurrency', name: 'Concorrência', marker: '$ bun test test/concurrency' },
  { key: 'e2e', name: 'E2E', marker: '$ bun test test/e2e' },
];

function numericMatch(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  const value = match?.[1];
  return value === undefined ? 0 : Number.parseInt(value, 10);
}

function sectionBetween(log: string, start: number, end: number): string {
  return log.slice(start, end);
}

export function parseCheckAllLog(log: string, recordedAt = new Date().toISOString()): GateRecord {
  const commandMarkers = [
    ...log.matchAll(
      /^\$ bun (?:test test\/[^\r\n]+|--bun node_modules\/\.bin\/cucumber-js[^\r\n]*)/gm,
    ),
  ];
  const suites: SuiteResult[] = [];
  for (const suite of SUITES) {
    const marker = commandMarkers.find(
      (item) => item.index !== undefined && log.startsWith(suite.marker, item.index),
    );
    if (marker === undefined || marker.index === undefined) continue;
    const markerIndex = marker.index;
    const next = commandMarkers.find(
      (item) => item.index !== undefined && item.index > markerIndex,
    );
    const body = sectionBetween(log, markerIndex, next?.index ?? log.length);
    const passed = numericMatch(body, /(?:^|\n)\s*(\d+) pass\b/m);
    const failed = numericMatch(body, /(?:^|\n)\s*(\d+) fail\b/m);
    suites.push({ key: suite.key, name: suite.name, passed, failed, total: passed + failed });
  }

  const scenarios = log.match(/(\d+) scenarios?\s*\(([^)]*)\)/i);
  const steps = log.match(/(\d+) steps?\s*\(([^)]*)\)/i);
  const scenarioTotal = scenarios?.[1] === undefined ? 0 : Number.parseInt(scenarios[1], 10);
  const scenarioDetail = scenarios?.[2] ?? '';
  const scenarioPassed = numericMatch(scenarioDetail, /(\d+) passed/);
  const scenarioFailed = numericMatch(scenarioDetail, /(\d+) failed/);
  const stepTotal = steps?.[1] === undefined ? 0 : Number.parseInt(steps[1], 10);
  const stepDetail = steps?.[2] ?? '';
  const stepPassed = numericMatch(stepDetail, /(\d+) passed/);
  const stepFailed = numericMatch(stepDetail, /(\d+) failed/);
  const stepSkipped = numericMatch(stepDetail, /(\d+) skipped/);
  suites.push({
    key: 'features',
    name: 'Cenários Gherkin',
    passed: scenarioPassed,
    failed: scenarioFailed,
    total: scenarioTotal,
  });

  const explicitExit = log.match(/check:all exit=(\d+)/);
  const failedExit = log.match(/error:\s*script\s*"check:all"\s*exited with code\s*(\d+)/);
  const exitCode =
    explicitExit?.[1] !== undefined
      ? Number.parseInt(explicitExit[1], 10)
      : failedExit?.[1] !== undefined
        ? Number.parseInt(failedExit[1], 10)
        : suites.some((suite) => suite.failed > 0)
          ? 1
          : 0;

  return {
    recordedAt,
    exitCode,
    passed: exitCode === 0,
    suites,
    cucumber: {
      scenarios: { total: scenarioTotal, passed: scenarioPassed, failed: scenarioFailed },
      steps: { total: stepTotal, passed: stepPassed, failed: stepFailed, skipped: stepSkipped },
    },
  };
}

export async function recordGate(logPath: string, outputPath: string): Promise<GateRecord> {
  const record = parseCheckAllLog(await readFile(logPath, 'utf8'));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const logPath = process.argv[2];
  const outputPath = process.argv[3] ?? resolve(root, 'docs/gate/ultimo-gate.json');
  if (logPath === undefined) {
    console.error('Uso: bun run scripts/record-gate.ts <log-check-all> [arquivo-json]');
    process.exit(2);
  }
  try {
    const record = await recordGate(logPath, outputPath);
    console.log(`Gate registrado: exit code ${record.exitCode}, aprovado: ${record.passed}`);
  } catch (error) {
    console.error(
      `Falha ao registrar gate: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
