import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateRecord } from './record-gate';

const INK = '#1d1f1c';
const LINE = '#596158';
const BLUE = '#3973a5';
const ORANGE = '#bd5728';
const GREEN = '#28734b';
const CANVAS = '#ffffff';
const FONT = 'Arial, Helvetica, sans-serif';

export interface LoadScenario {
  readonly scenarioName: string;
  readonly agreedRate: number | null;
  readonly firstFailingRate: number | null;
  readonly p99AtAgreed: number | null;
  readonly cpuUtilisationPercent: number | null;
}

export interface ExperimentRow {
  readonly carga: string;
  readonly quantil: 'p50' | 'p95' | 'p99';
  readonly semTriggersMs: number;
  readonly comTriggersMs: number;
  readonly diffMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return character;
    }
  });
}

export function linearScale(
  value: number,
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): number {
  if (domainMax === domainMin) return rangeMin;
  return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
}

function scenarioLabel(path: string): string {
  const match = /apis(\d+)-workers(\d+)-cpus(\d+)/.exec(path);
  return match === null
    ? basename(path, '.json')
    : `${match[1]} API · ${match[2]} workers · ${match[3]} CPU`;
}

export function parseLoadScenario(source: string, name: string): LoadScenario {
  const parsed: unknown = JSON.parse(source);
  const data = object(parsed);
  if (data === undefined) throw new Error(`${name}: cenário não é um objeto JSON`);
  const agreedRate = numeric(data.agreedRate) ?? null;
  const firstFailingRate = numeric(data.firstFailingRate) ?? null;
  const stackCpus = numeric(data.stackCpus);
  const steps = Array.isArray(data.steps) ? data.steps : [];
  let agreedStep: Record<string, unknown> | undefined;
  for (const rawStep of steps) {
    const step = object(rawStep);
    if (step !== undefined && numeric(step.rate) === agreedRate && agreedRate !== null)
      agreedStep = step;
  }
  const p99AtAgreed = agreedStep === undefined ? null : (numeric(agreedStep.p99) ?? null);
  const stepCpu = object(agreedStep?.cpuPercent);
  const idle = object(data.idle);
  const idleCpu = object(idle?.cpuPercent);
  let gross = 0;
  let idleTotal = 0;
  let cpuComplete =
    stepCpu !== undefined && idleCpu !== undefined && Object.keys(stepCpu).length > 0;
  if (stepCpu !== undefined && idleCpu !== undefined) {
    for (const [container, rawPercent] of Object.entries(stepCpu)) {
      const percent = numeric(rawPercent);
      const idlePercent = numeric(idleCpu[container]);
      if (percent === undefined || idlePercent === undefined) {
        cpuComplete = false;
        break;
      }
      gross += percent;
      idleTotal += idlePercent;
    }
  }
  const cpuUtilisationPercent =
    cpuComplete && stackCpus !== undefined && stackCpus > 0
      ? Math.max(0, ((gross - idleTotal) / (stackCpus * 100)) * 100)
      : null;
  return { scenarioName: name, agreedRate, firstFailingRate, p99AtAgreed, cpuUtilisationPercent };
}

function parseMs(value: string): number | undefined {
  const match = /^\s*([+−-]?)\s*([\d]+(?:[,.][\d]+)?)\s*ms\b/.exec(value);
  if (match?.[1] === undefined) return undefined;
  const amount = match[2];
  if (amount === undefined) return undefined;
  return (
    Number.parseFloat(amount.replace(',', '.')) * (match[1] === '−' || match[1] === '-' ? -1 : 1)
  );
}

export function parseExperiment1Table(markdown: string): ExperimentRow[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const normalized = line.toLocaleLowerCase('pt-BR');
    return (
      normalized.includes('carga') &&
      normalized.includes('quantil') &&
      normalized.includes('sem triggers') &&
      normalized.includes('com triggers')
    );
  });
  if (headerIndex < 0) throw new Error('Cabeçalho da tabela do Experimento 1 não encontrado');
  const header = lines[headerIndex];
  if (header === undefined) throw new Error('Cabeçalho da tabela do Experimento 1 inválido');
  const columns = header.split('|').map((cell) => cell.trim().toLocaleLowerCase('pt-BR'));
  const loadColumn = columns.findIndex((cell) => cell === 'carga');
  const quantileColumn = columns.findIndex((cell) => cell === 'quantil');
  const withoutColumn = columns.findIndex((cell) => cell.includes('sem triggers'));
  const withColumn = columns.findIndex((cell) => cell.includes('com triggers'));
  const differenceColumn = columns.findIndex((cell) => cell.includes('diferença'));
  if (
    [loadColumn, quantileColumn, withoutColumn, withColumn, differenceColumn].some(
      (column) => column < 0,
    )
  ) {
    throw new Error('Cabeçalho do Experimento 1 não contém todas as colunas esperadas');
  }
  const rows: ExperimentRow[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith('|')) break;
    const cells = line.split('|').map((cell) => cell.trim());
    const carga = cells[loadColumn];
    const quantil = cells[quantileColumn];
    const sem = cells[withoutColumn];
    const com = cells[withColumn];
    const diff = cells[differenceColumn];
    if (
      carga === undefined ||
      quantil === undefined ||
      sem === undefined ||
      com === undefined ||
      diff === undefined
    )
      continue;
    if (quantil !== 'p50' && quantil !== 'p95' && quantil !== 'p99') continue;
    const semTriggersMs = parseMs(sem);
    const comTriggersMs = parseMs(com);
    const diffMs = parseMs(diff);
    if (semTriggersMs === undefined || comTriggersMs === undefined || diffMs === undefined)
      continue;
    rows.push({ carga, quantil, semTriggersMs, comTriggersMs, diffMs });
  }
  return rows;
}

function xmlStart(title: string, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}" font-family="${FONT}">\n<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${CANVAS}" stroke="#687066"/>\n<text x="24" y="34" font-size="20" font-weight="700" fill="${INK}">${escapeXml(title)}</text>`;
}

function text(
  x: number,
  y: number,
  label: string,
  size = 12,
  color = INK,
  anchor = 'start',
): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="${size}" fill="${color}">${escapeXml(label)}</text>`;
}

function axis(x1: number, y1: number, x2: number, y2: number): string {
  return `<path d="M ${x1} ${y1} H ${x2} M ${x1} ${y1} V ${y2}" fill="none" stroke="${LINE}" stroke-width="1.2"/>`;
}

export function renderCargaTaxaP99Svg(scenarios: readonly LoadScenario[]): string {
  const width = 1000;
  const top = 86;
  const rowHeight = 43;
  const height = top + scenarios.length * rowHeight + 58;

  const rateLabels = scenarios.map((item) =>
    item.agreedRate === null ? 'lacuna req/s' : `${item.agreedRate} req/s`,
  );
  const p99Labels = scenarios.map((item) =>
    item.p99AtAgreed === null ? 'lacuna ms' : `${item.p99AtAgreed.toFixed(1)} ms`,
  );
  const maxRateLabelLen = Math.max(1, ...rateLabels.map((l) => l.length));
  const maxP99LabelLen = Math.max(1, ...p99Labels.map((l) => l.length));
  const rateLabelWidth = Math.ceil(0.6 * 11 * maxRateLabelLen);
  const p99LabelWidth = Math.ceil(0.6 * 11 * maxP99LabelLen);

  const rightMargin = p99LabelWidth + 24;
  const p1_x0 = 220;
  const availableWidth = width - rightMargin - p1_x0;
  const gapCol = 10;
  const gapPanels = 30;
  const axisWidth = Math.floor((availableWidth - (gapCol * 2 + rateLabelWidth + gapPanels)) / 2);

  const p1_xMax = p1_x0 + axisWidth;
  const p1_valX = p1_xMax + gapCol;

  const p2_x0 = p1_valX + rateLabelWidth + gapPanels;
  const p2_xMax = p2_x0 + axisWidth;
  const p2_valX = p2_xMax + gapCol;

  const maxRate = Math.max(
    1,
    ...scenarios.flatMap((item) => (item.agreedRate === null ? [] : [item.agreedRate])),
  );
  const maxP99 = Math.max(
    1,
    ...scenarios.flatMap((item) => (item.p99AtAgreed === null ? [] : [item.p99AtAgreed])),
  );
  const body: string[] = [xmlStart('Carga acordada e p99 no passo acordado', width, height)];
  body.push(
    text(p1_x0, 61, 'Taxa acordada (req/s)', 12, BLUE),
    text(p2_x0, 61, 'p99 (ms)', 12, ORANGE),
  );
  body.push(
    axis(p1_x0, top, p1_xMax, top + scenarios.length * rowHeight),
    axis(p2_x0, top, p2_xMax, top + scenarios.length * rowHeight),
  );
  scenarios.forEach((item, index) => {
    const y = top + index * rowHeight + 24;
    body.push(text(24, y + 4, item.scenarioName, 12));
    if (item.agreedRate === null) {
      body.push(text(p1_valX, y + 4, 'lacuna req/s', 11, ORANGE));
    } else {
      const rateEnd = linearScale(item.agreedRate, 0, maxRate, p1_x0, p1_xMax);
      body.push(
        `<rect x="${p1_x0}" y="${y - 8}" width="${Math.max(1, rateEnd - p1_x0)}" height="16" fill="${BLUE}"/>`,
        text(p1_valX, y + 4, `${item.agreedRate} req/s`, 11),
      );
    }
    if (item.p99AtAgreed === null) {
      body.push(text(p2_valX, y + 4, 'lacuna ms', 11, ORANGE));
    } else {
      const markerX = linearScale(item.p99AtAgreed, 0, maxP99, p2_x0, p2_xMax);
      body.push(
        `<line x1="${p2_x0}" y1="${y}" x2="${markerX.toFixed(1)}" y2="${y}" stroke="${ORANGE}" stroke-width="1.2" stroke-dasharray="3 3"/>`,
        `<path d="M ${markerX.toFixed(1)} ${y - 10} V ${y + 10}" stroke="${ORANGE}" stroke-width="4"/>`,
        text(p2_valX, y + 4, `${item.p99AtAgreed.toFixed(1)} ms`, 11),
      );
    }
  });
  body.push('</svg>');
  return body.join('\n');
}

export function renderCargaUtilizacaoSvg(scenarios: readonly LoadScenario[]): string {
  const width = 920;
  const top = 82;
  const rowHeight = 38;
  const height = top + scenarios.length * rowHeight + 44;
  const x0 = 330;
  const xMax = width - 34;
  const max = Math.max(
    100,
    ...scenarios.flatMap((item) =>
      item.cpuUtilisationPercent === null ? [] : [item.cpuUtilisationPercent],
    ),
  );
  const ref = linearScale(100, 0, max, x0, xMax);
  const body = [
    xmlStart('Utilização de CPU por cenário', width, height),
    text(x0, 60, 'CPU utilizada (%)', 12),
    axis(x0, top, xMax, top + scenarios.length * rowHeight),
    `<path d="M ${ref.toFixed(1)} ${top} V ${top + scenarios.length * rowHeight}" stroke="${ORANGE}" stroke-dasharray="5 4"/>`,
    text(ref, top - 8, '100%', 11, ORANGE, 'middle'),
  ];
  scenarios.forEach((item, index) => {
    const y = top + index * rowHeight + 22;
    body.push(text(24, y + 4, item.scenarioName));
    if (item.cpuUtilisationPercent === null) body.push(text(x0, y + 4, 'lacuna %', 11, ORANGE));
    else {
      const end = linearScale(item.cpuUtilisationPercent, 0, max, x0, xMax);
      body.push(
        `<rect x="${x0}" y="${y - 7}" width="${Math.max(1, end - x0)}" height="14" fill="${GREEN}"/>`,
        text(end + 5, y + 4, `${item.cpuUtilisationPercent.toFixed(1)}%`, 11),
      );
    }
  });
  body.push('</svg>');
  return body.join('\n');
}

export function renderGatilhoCustoSvg(rows: readonly ExperimentRow[]): string {
  const groups = [...new Set(rows.map((row) => row.carga))];
  const width = 1040;
  const top = 105;
  const groupHeight = 92;
  const height = top + groups.length * groupHeight + 40;
  const x0 = 310;
  const rowLabels = rows.map(
    (row) =>
      `${row.semTriggersMs.toFixed(2)} / ${row.comTriggersMs.toFixed(2)} ms; Δ ${row.diffMs >= 0 ? '+' : ''}${row.diffMs.toFixed(2)} ms`,
  );
  const maxLabelLen = Math.max(1, ...rowLabels.map((l) => l.length));
  const maxLabelWidth = Math.ceil(0.6 * 10 * maxLabelLen);
  const rightMargin = maxLabelWidth + 24;
  const xMax = width - rightMargin;
  const max = Math.max(1, ...rows.flatMap((row) => [row.semTriggersMs, row.comTriggersMs]));
  const body = [
    xmlStart('Custo dos triggers por carga e quantil', width, height),
    text(x0, 65, 'Latência (ms); diferença indicada no rótulo', 12),
    axis(x0, top, xMax, top + groups.length * groupHeight),
  ];
  const colors = { p50: '#3973a5', p95: '#8b63a8', p99: '#bd5728' };
  groups.forEach((group, groupIndex) => {
    const groupRows = rows.filter((row) => row.carga === group);
    const y0 = top + groupIndex * groupHeight + 17;
    body.push(text(24, y0 + 19, group, 12));
    groupRows.forEach((row, rowIndex) => {
      const y = y0 + rowIndex * 22;
      const scale = (value: number): number => linearScale(value, 0, max, 0, xMax - x0);
      const barW = scale(row.semTriggersMs);
      const comW = scale(row.comTriggersMs);
      body.push(
        text(x0 - 12, y + 8, row.quantil, 11, INK, 'end'),
        `<rect x="${x0}" y="${y - 3}" width="${Math.max(1, barW)}" height="8" fill="${colors[row.quantil]}"/>`,
        `<rect x="${x0}" y="${y + 6}" width="${Math.max(1, comW)}" height="8" fill="${colors[row.quantil]}" opacity="0.48" stroke="${colors[row.quantil]}"/>`,
        text(
          x0 + Math.max(barW, comW) + 5,
          y + 8,
          `${row.semTriggersMs.toFixed(2)} / ${row.comTriggersMs.toFixed(2)} ms; Δ ${row.diffMs >= 0 ? '+' : ''}${row.diffMs.toFixed(2)} ms`,
          10,
        ),
      );
    });
  });
  body.push(
    text(24, height - 14, 'Barras sólidas: sem triggers · barras claras: com triggers', 11),
  );
  body.push('</svg>');
  return body.join('\n');
}

export function countBlockedScenarios(featuresDir: string): number {
  try {
    const output = execSync(`grep -ro "@bloqueado" "${featuresDir}" 2>/dev/null | wc -l`, {
      encoding: 'utf8',
    });
    const parsed = Number.parseInt(output.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function renderGateSuitesSvg(gate: GateRecord, blockedScenarios?: number): string {
  const blocked =
    blockedScenarios ??
    countBlockedScenarios(resolve(fileURLToPath(new URL('..', import.meta.url)), 'test/features'));
  const width = 780;
  const top = 90;
  const rowHeight = 42;
  const height = top + gate.suites.length * rowHeight + 56;
  const x0 = 210;
  const suiteLabels = gate.suites.map((suite) =>
    suite.key === 'features'
      ? `${gate.cucumber.scenarios.passed} cenários · ${gate.cucumber.steps.passed} passos`
      : `${suite.passed} passou · ${suite.failed} falhou`,
  );
  const maxLabelLen = Math.max(1, ...suiteLabels.map((l) => l.length));
  const maxLabelWidth = Math.ceil(0.6 * 11 * maxLabelLen);
  const rightMargin = maxLabelWidth + 24;
  const xMax = width - rightMargin;
  const max = Math.max(1, ...gate.suites.map((suite) => suite.total));
  const body = [
    xmlStart(
      `Gate ${gate.passed ? 'aprovado' : 'reprovado'} · exit code ${gate.exitCode}`,
      width,
      height,
    ),
    text(x0, 64, 'Testes por suíte (total)', 12),
    axis(x0, top, xMax, top + gate.suites.length * rowHeight),
  ];
  gate.suites.forEach((suite, index) => {
    const y = top + index * rowHeight + 22;
    body.push(text(24, y + 4, suite.name));
    const end = linearScale(suite.total, 0, max, x0, xMax);
    const color = suite.failed > 0 ? ORANGE : BLUE;
    const label = suiteLabels[index] ?? `${suite.passed} passou · ${suite.failed} falhou`;
    body.push(
      `<rect x="${x0}" y="${y - 8}" width="${Math.max(1, end - x0)}" height="16" fill="${color}"/>`,
      text(end + 6, y + 4, label, 11),
    );
  });
  body.push(
    text(24, height - 16, `${blocked} cenários marcados @bloqueado ficam fora do gate`, 11),
  );
  body.push('</svg>');
  return body.join('\n');
}

export function renderSeloGateSvg(gate: GateRecord): string {
  const label = gate.passed ? 'GATE APROVADO' : 'GATE REPROVADO';
  const color = gate.passed ? GREEN : '#a52f24';
  return `${xmlStart(label, 290, 82)}<rect x="16" y="45" width="258" height="24" rx="6" fill="${color}"/><text x="145" y="62" text-anchor="middle" font-size="13" font-weight="700" fill="#ffffff">${label} · exit ${gate.exitCode}</text></svg>`;
}

export function renderSeloCenariosSvg(gate: GateRecord): string {
  const { scenarios, steps } = gate.cucumber;
  const label = `${scenarios.passed}/${scenarios.total} cenários · ${steps.passed}/${steps.total} passos`;
  return `${xmlStart('Resultado dos cenários Gherkin', 390, 82)}<rect x="16" y="45" width="358" height="24" rx="6" fill="#dbe9f7" stroke="${LINE}"/><text x="195" y="62" text-anchor="middle" font-size="13" font-weight="700" fill="${INK}">${escapeXml(label)}</text></svg>`;
}

interface BuildOptions {
  readonly repoRoot?: string;
}

export async function buildAllGraficos(options: BuildOptions = {}): Promise<void> {
  const root = options.repoRoot ?? resolve(fileURLToPath(new URL('..', import.meta.url)));
  const loadRoot = join(root, 'docs/load/local');
  const names: string[] = [];
  for await (const name of importDirectory(loadRoot)) names.push(name);
  names.sort();
  const scenarios: LoadScenario[] = [];
  for (const path of names) {
    const filePath = join(loadRoot, path);
    scenarios.push(parseLoadScenario(await readFile(filePath, 'utf8'), scenarioLabel(path)));
  }
  const experiment = parseExperiment1Table(
    await readFile(join(root, 'docs/audit/PERFORMANCE_COMPARISON.md'), 'utf8'),
  );
  const gate: unknown = JSON.parse(
    await readFile(join(root, 'docs/gate/ultimo-gate.json'), 'utf8'),
  );
  const parsedGate = parseGateRecord(gate);
  const blockedScenarios = countBlockedScenarios(join(root, 'test/features'));
  const output = join(root, 'docs/graficos');
  await mkdir(output, { recursive: true });
  const charts: ReadonlyArray<readonly [string, string]> = [
    ['carga-taxa-p99.svg', renderCargaTaxaP99Svg(scenarios)],
    ['carga-utilizacao.svg', renderCargaUtilizacaoSvg(scenarios)],
    ['gatilho-custo.svg', renderGatilhoCustoSvg(experiment)],
    ['gate-suites.svg', renderGateSuitesSvg(parsedGate, blockedScenarios)],
    ['selo-gate.svg', renderSeloGateSvg(parsedGate)],
    ['selo-cenarios.svg', renderSeloCenariosSvg(parsedGate)],
  ];
  for (const [name, svg] of charts) await writeFile(join(output, name), `${svg}\n`, 'utf8');
}

function parseGateRecord(value: unknown): GateRecord {
  const data = object(value);
  if (
    data === undefined ||
    typeof data.exitCode !== 'number' ||
    typeof data.passed !== 'boolean' ||
    !Array.isArray(data.suites)
  ) {
    throw new Error('docs/gate/ultimo-gate.json tem formato inválido');
  }
  const suites = data.suites.filter((item): item is GateRecord['suites'][number] => {
    const suite = object(item);
    return (
      suite !== undefined &&
      typeof suite.key === 'string' &&
      typeof suite.name === 'string' &&
      typeof suite.passed === 'number' &&
      typeof suite.failed === 'number' &&
      typeof suite.total === 'number'
    );
  });
  const cucumberData = object(data.cucumber);
  const scenarios = object(cucumberData?.scenarios);
  const steps = object(cucumberData?.steps);
  if (cucumberData === undefined || scenarios === undefined || steps === undefined)
    throw new Error('Registro do gate sem contagens Gherkin');
  const scenarioTotal = numeric(scenarios.total);
  const scenarioPassed = numeric(scenarios.passed);
  const scenarioFailed = numeric(scenarios.failed);
  const stepTotal = numeric(steps.total);
  const stepPassed = numeric(steps.passed);
  const stepFailed = numeric(steps.failed);
  const stepSkipped = numeric(steps.skipped);
  if (
    scenarioTotal === undefined ||
    scenarioPassed === undefined ||
    scenarioFailed === undefined ||
    stepTotal === undefined ||
    stepPassed === undefined ||
    stepFailed === undefined ||
    stepSkipped === undefined
  )
    throw new Error('Registro do gate contém contagem inválida');
  return {
    recordedAt: typeof data.recordedAt === 'string' ? data.recordedAt : '',
    exitCode: data.exitCode,
    passed: data.passed,
    suites,
    cucumber: {
      scenarios: { total: scenarioTotal, passed: scenarioPassed, failed: scenarioFailed },
      steps: { total: stepTotal, passed: stepPassed, failed: stepFailed, skipped: stepSkipped },
    },
  };
}

async function* importDirectory(path: string): AsyncGenerator<string> {
  const { readdir } = await import('node:fs/promises');
  for (const directory of await readdir(path, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const file of await readdir(join(path, directory.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.json')) yield join(directory.name, file.name);
    }
  }
}

if (import.meta.main) {
  try {
    await buildAllGraficos();
    console.log('Gráficos SVG gerados em docs/graficos/');
  } catch (error) {
    console.error(
      `Falha ao gerar gráficos: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
