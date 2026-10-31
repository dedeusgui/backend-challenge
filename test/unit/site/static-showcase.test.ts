import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, countMatrixRows, REVIEW_BASE_COMMIT } from '../../../scripts/build-site';

/**
 * The static showcase is built into a temporary directory and checked as a reader would meet it: every link
 * resolves, every figure is labelled, nothing loads from a service, and the numbers are the ones the
 * repository holds. It is a page that must keep working with the operating environment switched off.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
let outDir: string;
let html: string;
let commit: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'showcase-'));
  const result = await buildSite({ root: ROOT, outDir, builtAt: new Date('2026-10-31T22:00:00.000Z'), branch: 'test-branch' });
  commit = result.commit;
  html = await readFile(join(outDir, 'index.html'), 'utf8');
}, 60_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function attributes(attribute: string): string[] {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'g'))].map((match) => match[1] ?? '');
}

describe('the static showcase', () => {
  test('is a complete, labelled Portuguese page with the sections a reviewer needs', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="pt-BR">');
    for (const id of ['visao', 'arquitetura', 'fluxos', 'garantias', 'testes', 'desempenho', 'decisoes', 'limitacoes', 'executar', 'documentos']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Esta página é estática');
  });

  test('no placeholder is left unfilled', () => {
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  test('it loads nothing from a service: no script, no external style sheet, no external image', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    for (const source of attributes('src')) {
      expect(source.startsWith('http')).toBe(false);
    }
  });

  test('every in-page anchor has its target, and every image file exists', async () => {
    for (const href of attributes('href')) {
      if (href.startsWith('#')) {
        expect(html).toContain(`id="${href.slice(1)}"`);
      }
    }
    for (const source of attributes('src')) {
      expect((await stat(join(outDir, source))).isFile()).toBe(true);
    }
  });

  test('every figure has alt text, and every chart has a title and a description', () => {
    const images = [...html.matchAll(/<img [^>]*>/g)].map((match) => match[0]);
    expect(images.length).toBe(3);
    for (const image of images) {
      expect(image).toMatch(/alt="[^"]{10,}"/);
    }
    expect(html).toContain('<title id="load-chart-title">');
    expect(html).toContain('<desc id="load-chart-desc">');
  });

  test('links to files and trees point at this exact commit; links to a listed commit name a full hash', () => {
    const links = attributes('href').filter((href) => href.includes('github.com/dedeusgui/backend-challenge'));
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      const match = /backend-challenge\/(blob|tree|commit)\/([0-9a-f]+)/.exec(link);
      const reference = match?.[2];
      if (match?.[1] === 'commit') {
        expect({ link, fullHash: /^[0-9a-f]{40}$/.test(reference ?? '') }).toEqual({ link, fullHash: true });
      } else {
        expect({ link, pinned: reference }).toEqual({ link, pinned: commit });
      }
    }
  });

  test('no link goes to a dashboard, a metrics endpoint, a database or a queue', () => {
    for (const href of attributes('href')) {
      expect(href).not.toMatch(/localhost|127\.0\.0\.1|grafana|prometheus|\/metrics|5432|4566/i);
    }
  });

  test('the numbers match the files they come from', async () => {
    const gate = JSON.parse(await readFile(join(ROOT, 'docs/site/gate-results.json'), 'utf8')) as Record<string, unknown>;
    expect(html).toContain(`<td>${String(gate.unit)}</td><td>0</td>`);
    expect(html).toContain(`<td>${String(gate.e2e)}</td><td>0</td>`);
    const matrix = await readFile(join(ROOT, 'docs/REQUIREMENTS_MATRIX.md'), 'utf8');
    expect(html).toContain(`<strong>${countMatrixRows(matrix)}</strong> identificadores`);
  });

  test('each load run shows its agreed rate, its first failing rate, and the machine it ran on', async () => {
    for (const cpus of [1, 2, 4]) {
      const run = JSON.parse(await readFile(join(ROOT, `docs/load/results/cpus-${cpus}.json`), 'utf8')) as {
        agreedRate: number;
        environment: { cpuModel: string };
      };
      expect(html).toContain(`<th scope="row">${cpus}</th>`);
      expect(html).toContain(`<td>${run.agreedRate}</td>`);
      expect(html).toContain(run.environment.cpuModel);
    }
    expect(html).toContain('1 CPU: 100 req/s; 2 CPU: 200 req/s; 4 CPU: 400 req/s');
  });

  test('the commits listed are exactly the ones after the review base, oldest first', async () => {
    const listed = [...html.matchAll(/<li><a href="https:\/\/github\.com\/dedeusgui\/backend-challenge\/commit\/([0-9a-f]{40})">/g)].map(
      (match) => match[1] ?? '',
    );
    const range = `${REVIEW_BASE_COMMIT}..HEAD`;
    const expected = (await gitLines(['rev-list', '--reverse', range])).map((line) => line.trim());

    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual(expected);
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
