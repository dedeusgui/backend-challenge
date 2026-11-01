/**
 * Builds the static showcase into site/: one page, its style sheet and script, and the diagrams. The page reads
 * nothing at run time, so it works with the API, the database, the queue and any dashboard switched off.
 *
 * Every number on the page comes from a file in this repository or from git, and every repository link is checked
 * against the commit the page names and against the files that exist in it. The build fails rather than shipping a
 * gap or a link to nothing.
 *
 *   bun run site:build            writes site/
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The first commit of this review round: the commits listed on the page are those after it. */
export const REVIEW_BASE_COMMIT = 'f12191b';
const REPO = 'https://github.com/dedeusgui/backend-challenge';
const LOAD_CPUS = [1, 2, 4] as const;

const NODE_KINDS = ['entry', 'check', 'store', 'queue', 'outcome'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Layout: one cell per grid position. Horizontal reads columns left to right; vertical reads rows top down. */
const CELL_W = 230;
const CELL_H = 112;
const NODE_W = 196;
const NODE_H = 64;
const PAD = 16;

export interface NodeSpec {
  readonly id: string;
  readonly label: string;
  readonly col: number;
  readonly row: number;
  readonly kind: NodeKind;
  readonly summary: string;
  readonly path: string;
  readonly proof: string;
}

export interface EdgeSpec {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface DiagramSpec {
  readonly id: string;
  readonly title: string;
  readonly lead: string;
  readonly nodes: readonly NodeSpec[];
  readonly edges: readonly EdgeSpec[];
}

export interface BuildSiteOptions {
  root: string;
  outDir: string;
  builtAt: Date;
  branch?: string;
}

export interface BuildSiteResult {
  commit: string;
  files: string[];
  linksChecked: number;
}

export async function buildSite(options: BuildSiteOptions): Promise<BuildSiteResult> {
  const { root } = options;
  const git = (args: string[]) => gitOutput(root, args);
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const branch = options.branch ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const template = await readFile(join(root, 'docs/site/template.html'), 'utf8');
  const css = await readFile(join(root, 'docs/site/site.css'), 'utf8');
  const script = await readFile(join(root, 'docs/site/site.js'), 'utf8');
  const diagrams = validateDiagrams(
    parseJson(await readFile(join(root, 'docs/site/diagrams.json'), 'utf8')),
    (path) => existsSync(join(root, path)),
  );
  const gate = parseGateResults(
    parseJson(await readFile(join(root, 'docs/site/gate-results.json'), 'utf8')),
  );
  const matrixRows = countMatrixRows(
    await readFile(join(root, 'docs/REQUIREMENTS_MATRIX.md'), 'utf8'),
  );
  const openapi = countOpenApiOperations(
    parseJson(await readFile(join(root, 'docs/openapi.json'), 'utf8')),
  );
  const runs = await Promise.all(LOAD_CPUS.map((cpus) => loadRun(root, cpus, git)));
  const localRuns = await loadAllLocalRuns(root, git);
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
    GATE_COMMIT_SHORT: gate.commit.slice(0, 7),
    GATE_RUN_URL: escapeHtml(gate.ciRun),
    COUNT_UNIT: String(gate.unit),
    COUNT_INFRA: String(gate.infra),
    COUNT_INTEGRATION: String(gate.integration),
    COUNT_CONCURRENCY: String(gate.concurrency),
    COUNT_E2E: String(gate.e2e),
    MATRIX_ROWS: String(matrixRows),
    OPENAPI_OPERATIONS: String(openapi),
    FACT_CARDS: factCards(gate, matrixRows, openapi, runs, commit),
    DIAGRAMS: diagrams.map((diagram) => renderDiagramBlock(diagram, commit)).join('\n'),
    LOAD_CHART: loadChart(runs),
    LOAD_ROWS: runs.map(loadRow).join('\n                '),
    LOCAL_LOAD_ROWS: localRuns.map(localLoadRow).join('\n                '),
    COMMITS_LIST: commits.map((line) => commitItem(line)).join('\n            '),
  };
  const html = fillTemplate(template, values);
  const linksChecked = await checkRepositoryLinks(html, commit, root);

  await mkdir(join(options.outDir, 'assets'), { recursive: true });
  await mkdir(join(options.outDir, 'diagrams'), { recursive: true });
  await writeFile(join(options.outDir, 'index.html'), html);
  await writeFile(join(options.outDir, 'assets/site.css'), css);
  await writeFile(join(options.outDir, 'assets/site.js'), script);
  await writeFile(join(options.outDir, '.nojekyll'), '');
  const staticDiagrams = (await readdir(join(root, 'docs/diagrams'))).filter((name) =>
    name.endsWith('.svg'),
  );
  for (const name of staticDiagrams) {
    await copyFile(join(root, 'docs/diagrams', name), join(options.outDir, 'diagrams', name));
  }
  return {
    commit,
    linksChecked,
    files: [
      'index.html',
      'assets/site.css',
      'assets/site.js',
      '.nojekyll',
      ...staticDiagrams.map((name) => `diagrams/${name}`),
    ],
  };
}

/** Replaces every {{NAME}}. A placeholder with no value is an error, so the page cannot ship a gap. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const filled = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`site template has no value for ${match}`);
    }
    return value;
  });
  if (/\{\{[A-Z0-9_]+\}\}/.test(filled)) {
    throw new Error('site template still has a placeholder after filling');
  }
  return filled;
}

export function countMatrixRows(markdown: string): number {
  return markdown.split('\n').filter((line) => /^\| [A-Z]{2,4}-[A-Z0-9-]+ \|/.test(line)).length;
}

/** The operations of the OpenAPI document: one per path and method. */
export function countOpenApiOperations(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.paths)) {
    throw new Error('docs/openapi.json has no paths');
  }
  let count = 0;
  for (const operations of Object.values(value.paths)) {
    if (!isRecord(operations)) continue;
    count += Object.keys(operations).filter((method) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method),
    ).length;
  }
  return count;
}

/**
 * Checks the three diagrams before anything is drawn: ids are unique, every node sits on its own grid cell, every
 * edge joins two existing nodes, no node is left without an edge, and every file a component names exists in the
 * repository, with its test. The check is by the caller's `exists`, so the rules can be tested without a checkout.
 */
export function validateDiagrams(value: unknown, exists: (path: string) => boolean): DiagramSpec[] {
  if (!isRecord(value) || !Array.isArray(value.diagrams)) {
    throw new Error('docs/site/diagrams.json has no diagrams list');
  }
  const diagramIds = new Set<string>();
  return value.diagrams.map((raw) => {
    if (!isRecord(raw)) throw new Error('a diagram is not an object');
    const id = slug(raw.id, 'diagram id');
    if (diagramIds.has(id)) throw new Error(`diagram ${id} is listed twice`);
    diagramIds.add(id);
    const nodes = requireArray(raw.nodes, `${id}.nodes`).map((item) => nodeOf(item, id, exists));
    const nodeIds = new Set<string>();
    const cells = new Set<string>();
    for (const node of nodes) {
      if (nodeIds.has(node.id)) throw new Error(`${id}: node ${node.id} is listed twice`);
      nodeIds.add(node.id);
      const cell = `${node.col},${node.row}`;
      if (cells.has(cell)) throw new Error(`${id}: two nodes share the grid cell ${cell}`);
      cells.add(cell);
    }
    const edges = requireArray(raw.edges, `${id}.edges`).map((item) => edgeOf(item, id, nodeIds));
    for (const node of nodes) {
      if (!edges.some((edge) => edge.from === node.id || edge.to === node.id)) {
        throw new Error(`${id}: node ${node.id} has no edge`);
      }
    }
    return {
      id,
      title: text(raw.title, `${id}.title`, 80),
      lead: text(raw.lead, `${id}.lead`, 320),
      nodes,
      edges,
    };
  });
}

function nodeOf(raw: unknown, diagram: string, exists: (path: string) => boolean): NodeSpec {
  if (!isRecord(raw)) throw new Error(`${diagram}: a node is not an object`);
  const id = slug(raw.id, `${diagram} node id`);
  const path = repoPath(raw.path, `${diagram}/${id}.path`, exists);
  const proof = repoPath(raw.proof, `${diagram}/${id}.proof`, exists);
  return {
    id,
    label: text(raw.label, `${diagram}/${id}.label`, 60),
    col: integer(raw.col, `${diagram}/${id}.col`, 12),
    row: integer(raw.row, `${diagram}/${id}.row`, 12),
    kind: kindOf(raw.kind, `${diagram}/${id}.kind`),
    summary: text(raw.summary, `${diagram}/${id}.summary`, 260),
    path,
    proof,
  };
}

function edgeOf(raw: unknown, diagram: string, nodeIds: ReadonlySet<string>): EdgeSpec {
  if (!isRecord(raw)) throw new Error(`${diagram}: an edge is not an object`);
  const from = text(raw.from, `${diagram} edge from`, 40);
  const to = text(raw.to, `${diagram} edge to`, 40);
  for (const end of [from, to]) {
    if (!nodeIds.has(end))
      throw new Error(`${diagram}: edge ${from} -> ${to} names unknown node ${end}`);
  }
  return raw.label === undefined
    ? { from, to }
    : { from, to, label: text(raw.label, `${diagram} edge label`, 40) };
}

/** Draws one diagram in one orientation. Each node is a focusable group that the page script can select. */
export function renderDiagram(
  diagram: DiagramSpec,
  orientation: 'h' | 'v',
  commit: string,
): string {
  const position = (node: NodeSpec) => {
    const along = orientation === 'h' ? node.col : node.row;
    const across = orientation === 'h' ? node.row : node.col;
    return { x: PAD + along * CELL_W, y: PAD + across * CELL_H };
  };
  const span = (pick: (node: NodeSpec) => number) => Math.max(0, ...diagram.nodes.map(pick));
  const width =
    PAD * 2 +
    (orientation === 'h' ? span((node) => node.col) : span((node) => node.row)) * CELL_W +
    NODE_W;
  const height =
    PAD * 2 +
    (orientation === 'h' ? span((node) => node.row) : span((node) => node.col)) * CELL_H +
    NODE_H;
  const byId = new Map(diagram.nodes.map((node) => [node.id, node] as const));
  const marker = `arrow-${diagram.id}-${orientation}`;
  const edges = diagram.edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined)
      throw new Error(`${diagram.id}: unknown node in an edge`);
    const a = position(from);
    const b = position(to);
    const ca = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 };
    const cb = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 };
    const start = boxExit({ x: cb.x - ca.x, y: cb.y - ca.y });
    const end = boxExit({ x: ca.x - cb.x, y: ca.y - cb.y });
    const sx = ca.x + start.x;
    const sy = ca.y + start.y;
    const ex = cb.x + end.x;
    const ey = cb.y + end.y;
    const label =
      edge.label === undefined
        ? ''
        : `<text class="edge-label" x="${((sx + ex) / 2).toFixed(1)}" y="${((sy + ey) / 2 - 6).toFixed(1)}" text-anchor="middle">${escapeHtml(edge.label)}</text>`;
    return `<path class="edge" d="M ${sx.toFixed(1)} ${sy.toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)}" marker-end="url(#${marker})"/>${label}`;
  });
  const nodes = diagram.nodes.map((node) => {
    const p = position(node);
    const href = `${REPO}/blob/${commit}/${node.path}`;
    const proofHref = `${REPO}/blob/${commit}/${node.proof}`;
    return `<g class="node kind-${node.kind}" data-node="${escapeHtml(node.id)}" tabindex="0" role="button" aria-pressed="false" aria-label="${escapeHtml(node.label)}" data-title="${escapeHtml(node.label)}" data-summary="${escapeHtml(node.summary)}" data-path="${escapeHtml(node.path)}" data-href="${escapeHtml(href)}" data-proof="${escapeHtml(node.proof)}" data-proof-href="${escapeHtml(proofHref)}">
      <rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10"/>
      ${wrapLabel(node.label)
        .map(
          (line, index, all) =>
            `<text x="${p.x + NODE_W / 2}" y="${(p.y + NODE_H / 2 + 5 + (index - (all.length - 1) / 2) * 16).toFixed(1)}" text-anchor="middle">${escapeHtml(line)}</text>`,
        )
        .join('\n      ')}
    </g>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="group" aria-label="${escapeHtml(diagram.title)}, disposição ${orientation === 'h' ? 'horizontal' : 'vertical'}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M 0 0 L 10 5 L 0 10 z"/></marker>
    </defs>
    ${edges.join('\n    ')}
    ${nodes.join('\n    ')}
  </svg>`;
}

/** The point where a ray from a box's centre leaves the box, for a box of NODE_W by NODE_H. */
function boxExit(direction: { x: number; y: number }): { x: number; y: number } {
  const hw = NODE_W / 2;
  const hh = NODE_H / 2;
  const tx = direction.x === 0 ? Number.POSITIVE_INFINITY : hw / Math.abs(direction.x);
  const ty = direction.y === 0 ? Number.POSITIVE_INFINITY : hh / Math.abs(direction.y);
  const t = Math.min(tx, ty);
  return { x: direction.x * t, y: direction.y * t };
}

export function wrapLabel(label: string, width = 24): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of label.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length > width && current !== '') {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines.slice(0, 3);
}

function renderDiagramBlock(diagram: DiagramSpec, commit: string): string {
  const items = diagram.nodes
    .map((node) => {
      const source = `${REPO}/blob/${commit}/${node.path}`;
      const proof = `${REPO}/blob/${commit}/${node.proof}`;
      return `<li><strong>${escapeHtml(node.label)}.</strong> ${escapeHtml(node.summary)} <span class="path">Código: <a href="${escapeHtml(source)}"><code>${escapeHtml(node.path)}</code></a>. Teste: <a href="${escapeHtml(proof)}"><code>${escapeHtml(node.proof)}</code></a>.</span></li>`;
    })
    .join('\n            ');
  return `<figure class="diagram" data-diagram="${escapeHtml(diagram.id)}">
          <div class="diagram-head">
            <h3>${escapeHtml(diagram.title)}</h3>
            <p>${escapeHtml(diagram.lead)}</p>
          </div>
          <p class="scroll-hint">Role o diagrama para os lados para ver todos os componentes.</p>
          <div class="diagram-canvas diagram-canvas--wide">${renderDiagram(diagram, 'h', commit)}</div>
          <div class="diagram-canvas diagram-canvas--narrow">${renderDiagram(diagram, 'v', commit)}</div>
          <div class="legend" aria-hidden="true"><span class="k-entry">Entrada</span><span class="k-check">Verificação ou decisão</span><span class="k-store">Efeito</span><span class="k-queue">Fila</span><span class="k-outcome">Resultado</span></div>
          <aside class="detail" aria-live="polite" data-detail>
            <h4 data-detail-title>Selecione um componente</h4>
            <p data-detail-summary>Clique em um componente, ou use Tab e Enter.</p>
            <div class="links"><span>Código: <a data-detail-source href="#"></a></span><span>Teste: <a data-detail-proof href="#"></a></span></div>
          </aside>
          <details>
            <summary>Lista dos componentes</summary>
            <ol class="node-list">
            ${items}
            </ol>
          </details>
        </figure>`;
}

/** Every repository link in the page must name the commit of the page and an existing file or folder in it. */
export async function checkRepositoryLinks(
  html: string,
  commit: string,
  root: string,
): Promise<number> {
  const pattern = new RegExp(
    `${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(blob|tree|commit)/([^"\\s<>)]+)`,
    'g',
  );
  let checked = 0;
  for (const match of html.matchAll(pattern)) {
    const [, kind, rest = ''] = match;
    const [sha = '', ...pathParts] = rest.split('/');
    const path = pathParts.join('/');
    if (kind === 'commit') {
      // A commit link names another commit on purpose (the list of the round): only its hash is checked.
      if (!/^[0-9a-f]{40}$/.test(sha))
        throw new Error(`commit link without a full hash: ${match[0]}`);
      checked += 1;
      continue;
    }
    if (sha !== commit) {
      throw new Error(`repository link names ${sha}, not the page commit ${commit}: ${match[0]}`);
    }
    if (path !== '') {
      const target = join(root, path);
      if (!existsSync(target)) {
        throw new Error(`repository link to a path that is not in the commit: ${path}`);
      }
      if (kind === 'blob' && !(await isFile(target))) {
        throw new Error(`repository link names a folder as a file: ${path}`);
      }
    }
    checked += 1;
  }
  return checked;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path)).isFile();
}

export interface GateResults {
  commit: string;
  ciRun: string;
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
  // The counts are copied from one CI run of that commit, and the page links to it. A run of another repository is refused.
  if (
    typeof value.ciRun !== 'string' ||
    !/^https:\/\/github\.com\/dedeusgui\/backend-challenge\/actions\/runs\/\d+$/.test(value.ciRun)
  ) {
    throw new Error('docs/site/gate-results.json has no CI run of this repository');
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
    ciRun: value.ciRun,
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
  const parsed = parseJson(await readFile(join(root, file), 'utf8'));
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

function factCards(
  gate: GateResults,
  matrixRows: number,
  openapi: number,
  runs: readonly LoadRun[],
  commit: string,
): string {
  const total = gate.unit + gate.infra + gate.integration + gate.concurrency + gate.e2e;
  const rates = runs
    .map((run) => (run.agreedRate === null ? '—' : String(run.agreedRate)))
    .join(' · ');
  const cards: Array<[string, string, string]> = [
    [String(total), 'testes passando na CI, por suíte', gate.ciRun],
    [
      String(openapi),
      'operações HTTP no contrato OpenAPI, verificadas contra as rotas e as respostas',
      `${REPO}/blob/${commit}/docs/openapi.json`,
    ],
    [
      String(matrixRows),
      'requisitos rastreados até um teste',
      `${REPO}/blob/${commit}/docs/REQUIREMENTS_MATRIX.md`,
    ],
    [
      rates,
      'req/s acordados em 1, 2 e 4 CPUs, medidos em b34c198',
      `${REPO}/blob/${commit}/docs/LOAD_TEST_RESULTS.md`,
    ],
  ];
  return cards
    .map(
      ([figure, label, link]) =>
        `<div class="card"><div class="figure">${escapeHtml(figure)}</div><div class="label">${escapeHtml(label)}</div><a href="${escapeHtml(link)}">ver a fonte</a></div>`,
    )
    .join('\n          ');
}

/** The load runs as a chart: one bar per CPU count, from the recorded agreed rate. Each bar names its run. */
export function loadChart(runs: readonly LoadRun[]): string {
  const width = 640;
  const height = 280;
  const left = 56;
  const bottom = 40;
  const top = 24;
  const plot = height - top - bottom;
  const maxRate = Math.max(1, ...runs.map((run) => run.firstFailingRate ?? run.agreedRate ?? 0));
  const slot = (width - left - 16) / runs.length;
  const bars = runs
    .map((run, index) => {
      const x = left + index * slot + slot * 0.2;
      const barWidth = slot * 0.6;
      const agreed = run.agreedRate ?? 0;
      const h = (agreed / maxRate) * plot;
      const y = top + plot - h;
      const label = `${run.cpus} CPU: ${agreed} req/s acordados`;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" fill="#1f6f5b"><title>${escapeHtml(label)}</title></rect>
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

export interface LocalLoadRun {
  readonly scenario: string;
  readonly cpus: number;
  readonly file: string;
  readonly commit: string;
  readonly agreedRate: number | null;
  readonly firstFailingRate: number | null;
  readonly p99: number | null;
  readonly utilisation: number | null;
}

async function loadLocalRun(
  root: string,
  scenario: string,
  git: (args: string[]) => Promise<string>,
): Promise<LocalLoadRun> {
  const scenarioDir = join('docs/load/local', scenario);
  const fullScenarioDir = join(root, scenarioDir);
  const files = await readdir(fullScenarioDir);
  const jsonName = files.find((name) => name.endsWith('.json'));
  if (jsonName === undefined) {
    throw new Error(`no JSON result in ${scenarioDir}`);
  }
  const file = join(scenarioDir, jsonName);
  const parsed = parseJson(await readFile(join(root, file), 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${file} is not an object`);
  }
  const stackCpus = typeof parsed.stackCpus === 'number' ? parsed.stackCpus : 0;
  const agreedRate = typeof parsed.agreedRate === 'number' ? parsed.agreedRate : null;
  const firstFailingRate =
    typeof parsed.firstFailingRate === 'number' ? parsed.firstFailingRate : null;
  const steps = Array.isArray(parsed.steps) ? parsed.steps.filter(isRecord) : [];
  const agreed = steps.find((step) => step.rate === agreedRate);
  const p99 = agreed !== undefined && typeof agreed.p99 === 'number' ? agreed.p99 : null;

  let utilisation: number | null = null;
  if (
    agreed !== undefined &&
    isRecord(parsed.idle) &&
    isRecord(parsed.idle.cpuPercent) &&
    isRecord(agreed.cpuPercent) &&
    stackCpus > 0
  ) {
    const idleCpus = parsed.idle.cpuPercent;
    const agreedCpus = agreed.cpuPercent;
    let total = 0;
    for (const [comp, gross] of Object.entries(agreedCpus)) {
      if (typeof gross === 'number') {
        const idle = typeof idleCpus[comp] === 'number' ? idleCpus[comp] : 0;
        total += Math.max(0, gross - idle);
      }
    }
    utilisation = total / (stackCpus * 100);
  }

  const commit = (await git(['log', '-1', '--format=%h', '--', file])).trim();
  return {
    scenario,
    cpus: stackCpus,
    file,
    commit,
    agreedRate,
    firstFailingRate,
    p99,
    utilisation,
  };
}

export async function loadAllLocalRuns(
  root: string,
  git: (args: string[]) => Promise<string>,
): Promise<LocalLoadRun[]> {
  const localDir = join(root, 'docs/load/local');
  const scenarios = (await readdir(localDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(scenarios.map((scenario) => loadLocalRun(root, scenario, git)));
}

export function localLoadRow(run: LocalLoadRun): string {
  const cells = [
    `<code>${escapeHtml(run.scenario)}</code>`,
    String(run.cpus),
    run.agreedRate === null ? 'nenhuma' : String(run.agreedRate),
    run.firstFailingRate === null ? 'nenhuma no degrau' : String(run.firstFailingRate),
    run.p99 === null ? '-' : run.p99.toFixed(1),
    run.utilisation === null ? '-' : `${(run.utilisation * 100).toFixed(0)}%`,
  ];
  return `<tr>${cells.map((cell, index) => (index === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`)).join('')}</tr>`;
}

function commitItem(line: string): string {
  const [full = '', short = '', ...subject] = line.split('\t');
  return `<li><a href="${REPO}/commit/${encodeURIComponent(full)}"><code>${escapeHtml(short)}</code></a> ${escapeHtml(subject.join('\t'))}</li>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function slug(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`${what} must be a lowercase slug`);
  }
  return value;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`${what} must be a non-empty text of at most ${max} characters`);
  }
  return value;
}

function integer(value: unknown, what: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${what} must be a whole number from 0 to ${max}`);
  }
  return value;
}

function kindOf(value: unknown, what: string): NodeKind {
  for (const kind of NODE_KINDS) {
    if (kind === value) return kind;
  }
  throw new Error(`${what} must be one of ${NODE_KINDS.join(', ')}`);
}

function repoPath(value: unknown, what: string, exists: (path: string) => boolean): string {
  const path = text(value, what, 200);
  if (path.startsWith('/') || path.includes('..'))
    throw new Error(`${what} must be a path inside the repository`);
  if (!exists(path)) throw new Error(`${what}: ${path} is not in the repository`);
  return path;
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${what} must be a non-empty list`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
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
    `site: ${result.files.length} files for commit ${result.commit.slice(0, 7)} in ${outDir}, ${result.linksChecked} repository links checked\n`,
  );
}
