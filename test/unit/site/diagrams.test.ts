import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDiagram, validateDiagrams } from '../../../scripts/build-site';
import { renderStaticSvg } from '../../../scripts/export-diagrams';

/**
 * The interactive diagrams of the showcase. The validator refuses a diagram that would point at nothing: a
 * component with a file or a test that is not in the repository, an edge to a missing node, two nodes on one
 * grid cell, or a node with no edge. The renderer draws the two orientations from the same data.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const everything = () => true;

function node(id: string, col: number, row: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    label: `Componente ${id}`,
    col,
    row,
    kind: 'check',
    summary: 'Faz uma coisa verificável.',
    path: 'src/modules/wagering/http/wagering.controller.ts',
    proof: 'test/e2e/wagering-http.test.ts',
    ...extra,
  };
}

function diagrams(nodes: unknown[], edges: unknown[]) {
  return {
    diagrams: [{ id: 'teste', title: 'Teste', lead: 'Um diagrama de teste.', nodes, edges }],
  };
}

describe('the validator accepts a sound diagram', () => {
  test('two nodes joined by an edge, both with a file and a test that exist', () => {
    const data = diagrams(
      [node('a', 0, 0), node('b', 1, 0)],
      [{ from: 'a', to: 'b', label: 'sim' }],
    );
    const [valid] = validateDiagrams(data, everything);
    expect(valid?.nodes.map((item) => item.id)).toEqual(['a', 'b']);
    expect(valid?.edges).toEqual([{ from: 'a', to: 'b', label: 'sim' }]);
  });

  test('the shipped diagrams are sound against the repository', async () => {
    const data: unknown = JSON.parse(await readFile(join(ROOT, 'docs/site/diagrams.json'), 'utf8'));
    const shipped = validateDiagrams(data, (path) => Bun.file(join(ROOT, path)).size > 0);
    expect(shipped.map((item) => item.id)).toEqual([
      'bet-over-http',
      'queued-command',
      'outcome-entities',
    ]);
    for (const diagram of shipped) expect(diagram.nodes.length).toBeGreaterThan(5);
  });
});

describe('the validator refuses a diagram that would point at nothing', () => {
  test('a component whose file is not in the repository', () => {
    const data = diagrams(
      [node('a', 0, 0, { path: 'src/nao-existe.ts' }), node('b', 1, 0)],
      [{ from: 'a', to: 'b' }],
    );
    expect(() => validateDiagrams(data, (path) => path !== 'src/nao-existe.ts')).toThrow(
      'not in the repository',
    );
  });

  test('a component whose test is not in the repository', () => {
    const data = diagrams(
      [node('a', 0, 0, { proof: 'test/nao-existe.test.ts' }), node('b', 1, 0)],
      [{ from: 'a', to: 'b' }],
    );
    expect(() => validateDiagrams(data, (path) => path !== 'test/nao-existe.test.ts')).toThrow(
      'not in the repository',
    );
  });

  test('an edge to a node that does not exist', () => {
    const data = diagrams([node('a', 0, 0), node('b', 1, 0)], [{ from: 'a', to: 'fantasma' }]);
    expect(() => validateDiagrams(data, everything)).toThrow('unknown node fantasma');
  });

  test('two nodes on the same grid cell', () => {
    const data = diagrams([node('a', 0, 0), node('b', 0, 0)], [{ from: 'a', to: 'b' }]);
    expect(() => validateDiagrams(data, everything)).toThrow('share the grid cell 0,0');
  });

  test('a node with no edge', () => {
    const data = diagrams(
      [node('a', 0, 0), node('b', 1, 0), node('solto', 2, 0)],
      [{ from: 'a', to: 'b' }],
    );
    expect(() => validateDiagrams(data, everything)).toThrow('node solto has no edge');
  });

  test('a kind the page does not draw', () => {
    const data = diagrams(
      [node('a', 0, 0, { kind: 'magico' }), node('b', 1, 0)],
      [{ from: 'a', to: 'b' }],
    );
    expect(() => validateDiagrams(data, everything)).toThrow('must be one of');
  });

  test('a path that tries to leave the repository', () => {
    const data = diagrams(
      [node('a', 0, 0, { path: '../segredo' }), node('b', 1, 0)],
      [{ from: 'a', to: 'b' }],
    );
    expect(() => validateDiagrams(data, everything)).toThrow('inside the repository');
  });

  test('an id that is not a slug', () => {
    const data = diagrams(
      [node('Com Espaco', 0, 0), node('b', 1, 0)],
      [{ from: 'Com Espaco', to: 'b' }],
    );
    expect(() => validateDiagrams(data, everything)).toThrow('lowercase slug');
  });
});

describe('the renderer draws both orientations from the same data', () => {
  const [parsed] = validateDiagrams(
    diagrams(
      [node('a', 0, 0), node('b', 1, 0, { label: 'Texto com <script>' })],
      [{ from: 'a', to: 'b', label: 'sim' }],
    ),
    everything,
  );
  if (parsed === undefined) throw new Error('the fixture must validate to one diagram');
  const diagram = parsed;
  const commit = 'b0529472a1bf46e9f6bbdd9cce7eb628559c2a9d';

  test('each node is a focusable group that carries its text, file and test', () => {
    const markup = renderDiagram(diagram, 'h', commit);
    expect(markup.match(/data-node="a"/g)?.length).toBe(1);
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('role="button"');
    expect(markup).toContain(
      `data-href="https://github.com/dedeusgui/backend-challenge/blob/${commit}/src/modules/wagering/http/wagering.controller.ts"`,
    );
  });

  test('the text of a node is escaped, so a label cannot add markup', () => {
    const markup = renderDiagram(diagram, 'h', commit);
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('Texto com &lt;script&gt;');
  });

  test('the two orientations differ in their layout, and carry the same nodes and edges', () => {
    const horizontal = renderDiagram(diagram, 'h', commit);
    const vertical = renderDiagram(diagram, 'v', commit);
    expect(horizontal).not.toEqual(vertical);
    for (const markup of [horizontal, vertical]) {
      expect(markup.match(/class="node /g)?.length).toBe(2);
      expect(markup.match(/class="edge"/g)?.length).toBe(1);
      expect(markup).toContain('class="edge-label"');
    }
  });

  test('the arrow of an edge ends at the border of the target, not at its centre', () => {
    const markup = renderDiagram(diagram, 'h', commit);
    const path = /class="edge" d="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)"/.exec(markup);
    expect(path).not.toBeNull();
    const endX = Number(path?.[3]);
    const targetLeft = 16 + 1 * 230;
    expect(endX).toBeLessThanOrEqual(targetLeft);
    expect(endX).toBeGreaterThan(targetLeft - 10);
  });
});

describe('the static SVG files that the README shows on GitHub', () => {
  const [parsed] = validateDiagrams(
    diagrams(
      [node('a', 0, 0), node('b', 1, 0, { label: 'Texto com <script>' })],
      [{ from: 'a', to: 'b', label: 'sim' }],
    ),
    everything,
  );
  if (parsed === undefined) throw new Error('the fixture must validate to one diagram');
  const diagram = parsed;

  test('the drawing has its own light canvas and no stylesheet, so GitHub dark mode cannot erase it', () => {
    const svg = renderStaticSvg(diagram);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).not.toContain('class="');
    expect(svg).not.toContain('<style');
  });

  test('each edge is drawn once, with its arrow and its label', () => {
    const svg = renderStaticSvg(diagram);
    expect(svg.match(/marker-end="url\(#arrow\)"/g)?.length).toBe(1);
    expect(svg).toContain('>sim<');
  });

  test('the text of a node is escaped, so a label cannot add markup', () => {
    const svg = renderStaticSvg(diagram);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('Texto com &lt;script&gt;');
  });

  test('the shipped SVG files are the export of the spec, so they cannot drift', async () => {
    const data: unknown = JSON.parse(await readFile(join(ROOT, 'docs/site/diagrams.json'), 'utf8'));
    const shipped = validateDiagrams(data, (path) => Bun.file(join(ROOT, path)).size > 0);
    for (const item of shipped) {
      const file = await readFile(join(ROOT, 'docs/diagrams', `${item.id}.svg`), 'utf8');
      expect(file).toBe(`${renderStaticSvg(item)}\n`);
    }
  });
});
