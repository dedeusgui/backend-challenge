/**
 * Builds the static showcase: one HTML page, and the diagrams it links to. The page reads nothing at run time, so it
 * works with no API, database, queue or dashboard. Every number on it comes from a file in this repository, or from
 * git, and the build fails if a placeholder is left unfilled.
 *
 *   bun run site:build            writes site/
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The first commit of this review round: the commits listed on the page are those after it. */
export const REVIEW_BASE_COMMIT = 'f12191b';
const LOAD_CPUS = [1, 2, 4] as const;

export interface BuildSiteOptions {
  root: string;
  outDir: string;
  builtAt: Date;
  branch?: string;
}

export interface BuildSiteResult {
  commit: string;
  files: string[];
}

export async function buildSite(options: BuildSiteOptions): Promise<BuildSiteResult> {
  const git = (args: string[]) => gitOutput(options.root, args);
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const branch = options.branch ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const template = await readFile(join(options.root, 'docs/site/template.html'), 'utf8');
  const gate = parseGateResults(
    JSON.parse(await readFile(join(options.root, 'docs/site/gate-results.json'), 'utf8')),
  );
  const matrixRows = countMatrixRows(
    await readFile(join(options.root, 'docs/REQUIREMENTS_MATRIX.md'), 'utf8'),
  );
  const runs = await Promise.all(LOAD_CPUS.map((cpus) => loadRun(options.root, cpus, git)));
  const commits = (
    await git(['log', '--reverse', '--format=%H%x09%h%x09%s', `${REVIEW_BASE_COMMIT}..HEAD`])
  )
    .split('\n')
    .filter((line) => line.trim() !== '');

  const values: Record<string, string> = {
    COMMIT_FULL: commit,
    COMMIT_SHORT: commit.slice(0, 7),
    BRANCH: escapeHtml(branch),
    BUILT_AT: options.builtAt.toISOString(),
    GATE_COMMIT: gate.commit,
    COUNT_UNIT: String(gate.unit),
    COUNT_INFRA: String(gate.infra),
    COUNT_INTEGRATION: String(gate.integration),
    COUNT_CONCURRENCY: String(gate.concurrency),
    COUNT_E2E: String(gate.e2e),
    MATRIX_ROWS: String(matrixRows),
    LOAD_CHART: loadChart(runs),
    LOAD_ROWS: runs.map(loadRow).join('\n            '),
    COMMITS_LIST: commits.map((line) => commitItem(line)).join('\n        '),
  };
  const html = fillTemplate(template, values);

  await mkdir(join(options.outDir, 'diagrams'), { recursive: true });
  await writeFile(join(options.outDir, 'index.html'), html);
  await writeFile(join(options.outDir, '.nojekyll'), '');
  const diagrams = (await readdir(join(options.root, 'docs/diagrams'))).filter((name) =>
    name.endsWith('.svg'),
  );
  for (const name of diagrams) {
    await copyFile(
      join(options.root, 'docs/diagrams', name),
      join(options.outDir, 'diagrams', name),
    );
  }
  return {
    commit,
    files: ['index.html', '.nojekyll', ...diagrams.map((name) => `diagrams/${name}`)],
  };
}

/** Replaces every {{NAME}}. A placeholder with no value is an error, so the page cannot ship a gap. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`site template has no value for ${match}`);
    }
    return value;
  });
}

export function countMatrixRows(markdown: string): number {
  return markdown.split('\n').filter((line) => /^\| [A-Z]{2,4}-[A-Z0-9-]+ \|/.test(line)).length;
}

interface GateResults {
  commit: string;
  unit: number;
  infra: number;
  integration: number;
  concurrency: number;
  e2e: number;
}

export function parseGateResults(value: unknown): GateResults {
  if (!isRecord(value) || typeof value.commit !== 'string') {
    throw new Error('docs/site/gate-results.json has no commit');
  }
  const count = (key: string): number => {
    const found = value[key];
    if (typeof found !== 'number' || !Number.isSafeInteger(found) || found < 0) {
      throw new Error(`docs/site/gate-results.json: ${key} is not a count`);
    }
    return found;
  };
  return {
    commit: value.commit,
    unit: count('unit'),
    infra: count('infra'),
    integration: count('integration'),
    concurrency: count('concurrency'),
    e2e: count('e2e'),
  };
}

interface LoadRun {
  cpus: number;
  file: string;
  commit: string;
  generatedAt: string;
  cpuModel: string;
  memoryGiB: number;
  hostLogicalCpus: number;
  pinned: boolean;
  agreedRate: number | null;
  firstFailingRate: number | null;
  agreedStep: { p50: number; p95: number; p99: number; errorRate: number } | undefined;
}

async function loadRun(
  root: string,
  cpus: number,
  git: (args: string[]) => Promise<string>,
): Promise<LoadRun> {
  const file = `docs/load/results/cpus-${cpus}.json`;
  const parsed: unknown = JSON.parse(await readFile(join(root, file), 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.environment)) {
    throw new Error(`${file} has no environment`);
  }
  const env = parsed.environment;
  const steps = Array.isArray(parsed.steps) ? parsed.steps.filter(isRecord) : [];
  const agreedRate = typeof parsed.agreedRate === 'number' ? parsed.agreedRate : null;
  const agreed = steps.find((step) => step.rate === agreedRate);
  const agreedStep =
    agreed !== undefined &&
    typeof agreed.p50 === 'number' &&
    typeof agreed.p95 === 'number' &&
    typeof agreed.p99 === 'number' &&
    typeof agreed.errorRate === 'number'
      ? { p50: agreed.p50, p95: agreed.p95, p99: agreed.p99, errorRate: agreed.errorRate }
      : undefined;
  return {
    cpus,
    file,
    commit: (await git(['log', '-1', '--format=%h', '--', file])).trim(),
    generatedAt: String(parsed.generatedAt),
    cpuModel: String(env.cpuModel),
    memoryGiB: Number(env.memoryGiB),
    hostLogicalCpus: Number(parsed.hostLogicalCpus),
    pinned: parsed.pinned === true,
    agreedRate,
    firstFailingRate: typeof parsed.firstFailingRate === 'number' ? parsed.firstFailingRate : null,
    agreedStep,
  };
}

function loadRow(run: LoadRun): string {
  const cells = [
    String(run.cpus),
    run.agreedRate === null ? 'nenhuma' : String(run.agreedRate),
    run.firstFailingRate === null ? 'nenhuma no degrau' : String(run.firstFailingRate),
    run.agreedStep ? run.agreedStep.p50.toFixed(1) : '-',
    run.agreedStep ? run.agreedStep.p95.toFixed(1) : '-',
    run.agreedStep ? run.agreedStep.p99.toFixed(1) : '-',
    run.agreedStep ? `${(run.agreedStep.errorRate * 100).toFixed(2)}%` : '-',
    `${escapeHtml(run.cpuModel)}, ${run.hostLogicalCpus} CPUs lógicas, ${run.memoryGiB.toFixed(1)} GiB${run.pinned ? '' : ', sem fixação'}`,
    `<code>${run.commit}</code>, <code>${escapeHtml(run.file)}</code>`,
  ];
  return `<tr>${cells.map((cell, index) => (index === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`)).join('')}</tr>`;
}

/** An inline SVG bar chart of the agreed rate per CPU count, with its own labels and the first failing rate. */
export function loadChart(runs: readonly LoadRun[]): string {
  const width = 640;
  const height = 280;
  const left = 56;
  const bottom = 40;
  const top = 24;
  const plot = height - top - bottom;
  const maxRate = Math.max(1, ...runs.map((run) => run.firstFailingRate ?? run.agreedRate ?? 0));
  const scale = (rate: number) => (rate / maxRate) * plot;
  const slot = (width - left - 16) / runs.length;
  const bars = runs
    .map((run, index) => {
      const x = left + index * slot + slot * 0.2;
      const barWidth = slot * 0.6;
      const agreed = run.agreedRate ?? 0;
      const h = scale(agreed);
      const y = top + plot - h;
      const label = `${run.cpus} CPU: ${agreed} req/s acordados`;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" fill="#1f6f5b"><title>${label}</title></rect>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="13" fill="currentColor">${agreed}</text>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 16}" text-anchor="middle" font-size="13" fill="currentColor">${run.cpus} CPU${run.cpus === 1 ? '' : 's'}</text>`;
    })
    .join('\n      ');
  const axis = `<line x1="${left}" y1="${top + plot}" x2="${width - 8}" y2="${top + plot}" stroke="currentColor" stroke-opacity="0.4"/>`;
  const summary = runs
    .map((run) => `${run.cpus} CPU: ${run.agreedRate ?? 'nenhuma'} req/s`)
    .join('; ');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="load-chart-title load-chart-desc" xmlns="http://www.w3.org/2000/svg">
      <title id="load-chart-title">Taxa acordada por número de CPUs da pilha</title>
      <desc id="load-chart-desc">${escapeHtml(summary)}. Valores de docs/load/results.</desc>
      ${axis}
      ${bars}
    </svg>`;
}

function commitItem(line: string): string {
  const [full = '', short = '', ...subject] = line.split('\t');
  return `<li><a href="https://github.com/dedeusgui/backend-challenge/commit/${encodeURIComponent(full)}"><code>${escapeHtml(short)}</code></a> ${escapeHtml(subject.join('\t'))}</li>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
  return stdout;
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outDir = join(root, 'site');
  const result = await buildSite({
    root,
    outDir,
    builtAt: new Date(),
    branch: process.env.SITE_BRANCH ?? process.env.GITHUB_REF_NAME,
  });
  process.stdout.write(
    `site: ${result.files.length} files for commit ${result.commit.slice(0, 7)} in ${outDir}\n`,
  );
}
