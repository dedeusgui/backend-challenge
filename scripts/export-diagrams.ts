/**
 * Draws the three static diagrams of the README, docs/diagrams/<id>.svg, from docs/site/diagrams.json.
 *
 * GitHub shows an SVG inside an <img>. That ignores the site's stylesheet, so the Mermaid drawings had dark
 * grey lines on GitHub's dark page. Each file here carries its own opaque light canvas, explicit colours and a
 * legend, and uses no class or <style>. After a change to the spec, run `bun run diagrams:export`.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DiagramSpec,
  type NodeKind,
  type NodeSpec,
  escapeHtml,
  validateDiagrams,
  wrapLabel,
} from './build-site';

// The spec's grid, drawn top to bottom: `row` runs left to right and `col` runs down. The gap between columns
// leaves room for the longest horizontal edge label.
const CELL_W = 300;
const CELL_H = 116;
const NODE_W = 200;
const NODE_H = 64;
const PAD = 24;
const LEGEND_H = 56;
const WRAP = 22;
const CANVAS = '#ffffff';
const INK = '#1d1f1c';
const LINE = '#3d4238';
const FONT = 'Arial, Helvetica, sans-serif';

// The light palette of docs/site/site.css, so the static drawing matches the page.
const FILL: Record<NodeKind, string> = {
  entry: '#dbe9f7',
  check: '#fdf3d7',
  store: '#e2f3e6',
  queue: '#ece4f7',
  outcome: '#efefee',
};
const LEGEND: ReadonlyArray<readonly [NodeKind, string]> = [
  ['entry', 'Entrada'],
  ['check', 'Verificação ou decisão'],
  ['store', 'Efeito'],
  ['queue', 'Fila'],
  ['outcome', 'Resultado'],
];

interface Point {
  readonly x: number;
  readonly y: number;
}

export function renderStaticSvg(diagram: DiagramSpec): string {
  const maxRow = Math.max(...diagram.nodes.map((node) => node.row));
  const maxCol = Math.max(...diagram.nodes.map((node) => node.col));
  const width = PAD * 2 + maxRow * CELL_W + NODE_W;
  const bodyHeight = PAD * 2 + maxCol * CELL_H + NODE_H;
  const height = bodyHeight + LEGEND_H;
  const byId = new Map(diagram.nodes.map((node) => [node.id, node] as const));

  const edges = diagram.edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined)
      throw new Error(`${diagram.id}: unknown node in an edge`);
    const a = centre(from);
    const b = centre(to);
    const start = offset(a, exitOf(b.x - a.x, b.y - a.y));
    const end = offset(b, exitOf(a.x - b.x, a.y - b.y));
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 6 };
    const path = `<path d="M ${coord(start.x)} ${coord(start.y)} L ${coord(end.x)} ${coord(end.y)}" fill="none" stroke="${LINE}" stroke-width="1.8" marker-end="url(#arrow)"/>`;
    const label =
      edge.label === undefined
        ? ''
        : `<text x="${coord(middle.x)}" y="${coord(middle.y)}" text-anchor="middle" font-size="13" fill="${INK}" stroke="${CANVAS}" stroke-width="4" stroke-linejoin="round" paint-order="stroke">${escapeHtml(edge.label)}</text>`;
    return { path, label };
  });

  const nodes = diagram.nodes.map((node) => {
    const c = centre(node);
    const lines = wrapLabel(node.label, WRAP);
    const rect = `<rect x="${coord(c.x - NODE_W / 2)}" y="${coord(c.y - NODE_H / 2)}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="${FILL[node.kind]}" stroke="${LINE}" stroke-width="1.2"${dashOf(node.kind)}/>`;
    const texts = lines.map(
      (line, index) =>
        `<text x="${coord(c.x)}" y="${coord(c.y + (index - (lines.length - 1) / 2) * 17 + 5)}" text-anchor="middle" font-size="14" fill="${INK}">${escapeHtml(line)}</text>`,
    );
    return [rect, ...texts].join('\n  ');
  });

  const legend: string[] = [];
  let x = PAD;
  for (const [kind, name] of LEGEND) {
    legend.push(
      `<rect x="${x}" y="${bodyHeight + 14}" width="18" height="18" rx="4" fill="${FILL[kind]}" stroke="${LINE}" stroke-width="1.2"${dashOf(kind)}/>`,
      `<text x="${x + 26}" y="${bodyHeight + 28}" font-size="13" fill="${INK}">${escapeHtml(name)}</text>`,
    );
    x += 26 + name.length * 7 + 24;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(diagram.title)}" font-family="${FONT}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${LINE}"/></marker>
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${CANVAS}" stroke="#8a8f85"/>
  ${edges.map((edge) => edge.path).join('\n  ')}
  ${nodes.join('\n  ')}
  ${edges.map((edge) => edge.label).join('\n  ')}
  ${legend.join('\n  ')}
</svg>`;
}

/** Check nodes are dashed, as in the site's legend, so the kind is readable without colour. */
function dashOf(kind: NodeKind): string {
  return kind === 'check' ? ' stroke-dasharray="5 3"' : '';
}

function centre(node: NodeSpec): Point {
  return { x: PAD + NODE_W / 2 + node.row * CELL_W, y: PAD + NODE_H / 2 + node.col * CELL_H };
}

function offset(origin: Point, delta: Point): Point {
  return { x: origin.x + delta.x, y: origin.y + delta.y };
}

/** The vector from a box's centre to the point where a ray in `direction` leaves the box. */
function exitOf(dx: number, dy: number): Point {
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : NODE_W / 2 / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : NODE_H / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: dx * t, y: dy * t };
}

function coord(value: number): string {
  return value.toFixed(1);
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const spec: unknown = JSON.parse(await readFile(join(root, 'docs/site/diagrams.json'), 'utf8'));
  for (const diagram of validateDiagrams(spec, (path) => existsSync(join(root, path)))) {
    await writeFile(
      join(root, 'docs/diagrams', `${diagram.id}.svg`),
      `${renderStaticSvg(diagram)}\n`,
    );
  }
}
