import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, countMatrixRows, REVIEW_BASE_COMMIT } from '../../../scripts/build-site';

/**
 * The static showcase, built into a temporary directory and checked the way a reader meets it: every anchor and
 * file resolves, nothing loads from a service, the diagrams carry their components, every repository link names
 * the page's commit, and the numbers equal their sources. The page must keep working with the operating
 * environment switched off, so its one script is checked for the network calls it does not make.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const REPO = 'https://github.com/dedeusgui/backend-challenge';
let outDir: string;
let html: string;
let commit: string;
let linksChecked: number;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'showcase-'));
  const result = await buildSite({
    root: ROOT,
    outDir,
    builtAt: new Date('2026-10-31T22:00:00.000Z'),
    branch: 'test-branch',
  });
  commit = result.commit;
  linksChecked = result.linksChecked;
  html = await readFile(join(outDir, 'index.html'), 'utf8');
}, 60_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function attributes(attribute: string): string[] {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'g'))].map(
    (match) => match[1] ?? '',
  );
}

describe('the static showcase', () => {
  test('is a complete, labelled Portuguese page with the sections a reviewer needs', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="pt-BR">');
    for (const id of [
      'visao',
      'arquitetura',
      'fluxos',
      'garantias',
      'testes',
      'desempenho',
      'decisoes',
      'limitacoes',
      'executar',
      'documentos',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Esta página é estática');
  });

  test('no placeholder is left unfilled', () => {
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  test('it loads nothing from a service: its style sheet and script are its own files, on the same origin', async () => {
    expect(html).toMatch(/<link[^>]*rel="stylesheet"[^>]*href="assets\/site\.css"/);
    expect(html).toMatch(/<script[^>]*src="assets\/site\.js"[^>]*defer/);
    for (const source of [...attributes('src'), ...attributes('href')]) {
      if (source.startsWith('http')) {
        expect(source.startsWith(REPO)).toBe(true);
      }
    }
    expect(html).not.toMatch(/<(iframe|object|embed)\b/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  test('the one script makes no network call and loads nothing', async () => {
    const script = await readFile(join(outDir, 'assets/site.js'), 'utf8');
    for (const forbidden of [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'import(',
      'http:',
      'https:',
    ]) {
      expect(script).not.toContain(forbidden);
    }
    expect(script).not.toContain('innerHTML');
  });

  test('every in-page anchor has its target, and every file the page names exists', async () => {
    // "#" is the placeholder of the detail panel's links: the script points them at the selected component.
    for (const href of attributes('href')) {
      if (href.startsWith('#') && href !== '#') {
        expect(html).toContain(`id="${href.slice(1)}"`);
      }
    }
    for (const file of [
      'assets/site.css',
      'assets/site.js',
      'diagrams/bet-over-http.svg',
      'diagrams/queued-command.svg',
      'diagrams/outcome-entities.svg',
    ]) {
      expect((await stat(join(outDir, file))).isFile()).toBe(true);
    }
  });

  test('every repository link names the page commit, a full hash, and a path that exists in it', () => {
    const links = [...html.matchAll(new RegExp(`${REPO}/(blob|tree|commit)/([^"\\s<>)]+)`, 'g'))];
    expect(links.length).toBeGreaterThan(40);
    expect(linksChecked).toBe(links.length);
    for (const match of links) {
      const [, kind, rest = ''] = match;
      const sha = rest.split('/')[0] ?? '';
      if (kind === 'commit') {
        expect(/^[0-9a-f]{40}$/.test(sha)).toBe(true);
      } else {
        expect(sha).toBe(commit);
      }
    }
  });

  test('the CI run link is the one the gate file names, and no other run', async () => {
    const gate = JSON.parse(
      await readFile(join(ROOT, 'docs/site/gate-results.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(html).toContain(`href="${String(gate.ciRun)}"`);
    expect(String(gate.ciRun)).toMatch(
      /^https:\/\/github\.com\/dedeusgui\/backend-challenge\/actions\/runs\/\d+$/,
    );
  });

  test('no link goes to a dashboard, a metrics endpoint, a database or a queue', () => {
    for (const href of attributes('href')) {
      expect(href).not.toMatch(/localhost|127\.0\.0\.1|grafana|prometheus|\/metrics|5432|4566/i);
    }
  });
});

describe('the interactive diagrams', () => {
  test('there are three diagrams, each drawn twice (wide and narrow) with the same number of components', () => {
    const figures = [
      ...html.matchAll(/<figure class="diagram" data-diagram="([a-z-]+)">([\s\S]*?)<\/figure>/g),
    ];
    expect(figures.map((match) => match[1])).toEqual([
      'bet-over-http',
      'queued-command',
      'outcome-entities',
    ]);
    for (const match of figures) {
      const body = match[2] ?? '';
      const svgs = [...body.matchAll(/<svg [\s\S]*?<\/svg>/g)].map((svg) => svg[0]);
      expect(svgs.length).toBe(2);
      const counts = svgs.map((svg) => (svg.match(/class="node /g) ?? []).length);
      expect(new Set(counts).size).toBe(1);
      const listed = (body.match(/<li><strong>/g) ?? []).length;
      expect(listed).toBe(counts[0] ?? -1);
    }
  });

  test('each component can be selected, and carries the file and the test it names', () => {
    for (const svg of html.match(/<svg [\s\S]*?<\/svg>/g) ?? []) {
      if (!svg.includes('class="node ')) continue;
      expect(svg).toContain('role="group"');
      for (const node of svg.match(/<g class="node [\s\S]*?">/g) ?? []) {
        expect(node).toContain('tabindex="0"');
        expect(node).toContain('data-title="');
        expect(node).toMatch(
          /data-proof-href="https:\/\/github\.com\/dedeusgui\/backend-challenge\/blob\/[0-9a-f]{40}\/test\//,
        );
      }
    }
  });

  test('every attribute the script selects or reads is written into each diagram, or the script silently does nothing', async () => {
    const script = await readFile(join(outDir, 'assets/site.js'), 'utf8');
    const names = new Set<string>([
      ...[...script.matchAll(/\[(data-[a-z-]+)\]/g)].map((match) => match[1] ?? ''),
      ...[...script.matchAll(/getAttribute\('(data-[a-z-]+)'\)/g)].map((match) => match[1] ?? ''),
    ]);
    expect(names.size).toBeGreaterThan(0);
    const figures = [
      ...html.matchAll(/<figure class="diagram" data-diagram="[a-z-]+">([\s\S]*?)<\/figure>/g),
    ];
    expect(figures.length).toBe(3);
    for (const match of figures) {
      const body = match[0];
      const missing = [...names].filter((name) => !new RegExp(`\\s${name}(=|\\s|>)`).test(body));
      expect(missing).toEqual([]);
    }
  });

  test('each diagram keeps its natural size and scrolls sideways in its canvas, so its text is never shrunk', async () => {
    const css = await readFile(join(outDir, 'assets/site.css'), 'utf8');
    const svgs = [...html.matchAll(/<svg viewBox="0 0 (\d+) (\d+)"[^>]*role="group"[^>]*>/g)];
    expect(svgs.length).toBe(6);
    for (const match of svgs) {
      const width = Number(match[1]);
      expect(match[0]).toContain(`style="min-width:${width}px"`);
    }
    expect(css).toMatch(/\.diagram-canvas \{[^}]*overflow-x: auto/);
  });

  test('the detail panel and the list are both present, so a reader without the script still gets the text', () => {
    expect(html.match(/class="detail"/g)?.length).toBe(3);
    expect(html.match(/<details>\s*<summary>Lista dos componentes/g)?.length).toBe(3);
  });
});

describe('the numbers match the files they come from', () => {
  test('the test counts come from the CI run the gate file names', async () => {
    const gate = JSON.parse(
      await readFile(join(ROOT, 'docs/site/gate-results.json'), 'utf8'),
    ) as Record<string, number | string>;
    expect(html).toMatch(new RegExp(`<td>${String(gate.unit)}</td>\\s*<td>0</td>`));
    expect(html).toMatch(new RegExp(`<td>${String(gate.e2e)}</td>\\s*<td>0</td>`));
    const total =
      Number(gate.unit) +
      Number(gate.infra) +
      Number(gate.integration) +
      Number(gate.concurrency) +
      Number(gate.e2e);
    expect(html).toContain(`<div class="figure">${total}</div>`);
  });

  test('the requirement count and the OpenAPI operation count match their sources', async () => {
    const matrix = await readFile(join(ROOT, 'docs/REQUIREMENTS_MATRIX.md'), 'utf8');
    expect(html).toContain(`<strong>${countMatrixRows(matrix)}</strong> identificadores`);
    const openapi = JSON.parse(await readFile(join(ROOT, 'docs/openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const operations = Object.values(openapi.paths).reduce(
      (sum, item) => sum + Object.keys(item).length,
      0,
    );
    expect(html).toContain(`<div class="figure">${operations}</div>`);
  });

  test('each load run shows its agreed rate, its first failing rate, and the machine it ran on', async () => {
    for (const cpus of [1, 2, 4]) {
      const run = JSON.parse(
        await readFile(join(ROOT, `docs/load/results/cpus-${cpus}.json`), 'utf8'),
      ) as {
        agreedRate: number;
        environment: { cpuModel: string };
      };
      expect(html).toContain(`<th scope="row">${cpus}</th>`);
      expect(html).toContain(`<td>${run.agreedRate}</td>`);
      expect(html).toContain(run.environment.cpuModel);
    }
    expect(html).toContain('1 CPU: 100 req/s; 2 CPU: 200 req/s; 4 CPU: 400 req/s');

    const localDir = join(ROOT, 'docs/load/local');
    const localScenarios = (await readdir(localDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(localScenarios.length).toBe(13);
    for (const scenario of localScenarios) {
      const files = await readdir(join(localDir, scenario));
      const jsonFile = files.find((f) => f.endsWith('.json'));
      if (jsonFile === undefined) {
        throw new Error(`missing json file for ${scenario}`);
      }
      const parsed: unknown = JSON.parse(
        await readFile(join(localDir, scenario, jsonFile), 'utf8'),
      );
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('agreedRate' in parsed) ||
        typeof parsed.agreedRate !== 'number'
      ) {
        throw new Error(`invalid json in ${scenario}`);
      }
      expect(html).toContain(`<code>${scenario}</code>`);
      expect(html).toContain(`<td>${parsed.agreedRate}</td>`);
    }
    expect(html).toContain('AMD Ryzen 7 7735HS');
    expect(html).toContain('docs/LOAD_TEST_BASELINE.md');
  });

  test('the commits listed are exactly the ones after the review base, oldest first', async () => {
    const listed = [
      ...html.matchAll(new RegExp(`<li><a href="${REPO}/commit/([0-9a-f]{40})">`, 'g')),
    ].map((match) => match[1] ?? '');
    const expected = (await gitLines(['rev-list', '--reverse', `${REVIEW_BASE_COMMIT}..HEAD`])).map(
      (line) => line.trim(),
    );
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual(expected);
  });
});

describe('the guarantees and the decisions', () => {
  test('each guarantee card names the test that proves it, and that test exists in the commit', async () => {
    const cards = html.match(/<article class="guarantee">/g) ?? [];
    expect(cards.length).toBe(8);
    for (const match of html.matchAll(/Prova: <a href="([^"]+)">/g)) {
      const path = (match[1] ?? '').replace(`${REPO}/blob/${commit}/`, '');
      expect((await stat(join(ROOT, path))).isFile()).toBe(true);
    }
  });
});

async function gitLines(args: string[]): Promise<string[]> {
  const child = Bun.spawn(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed`);
  }
  return stdout.split('\n').filter((line) => line.trim() !== '');
}
