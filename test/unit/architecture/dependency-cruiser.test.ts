import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const DEPENDENCY_CRUISER = resolve(
  REPOSITORY_ROOT,
  'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
);
const temporaryProjects: string[] = [];

async function fixtureProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dependency-cruiser-fixture-'));
  temporaryProjects.push(root);
  await cp(join(REPOSITORY_ROOT, '.dependency-cruiser.cjs'), join(root, '.dependency-cruiser.cjs'));
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' } }),
  );
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

async function runDependencyCruiser(root: string): Promise<{
  readonly exitCode: number;
  readonly output: string;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      DEPENDENCY_CRUISER,
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'err',
      'src',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('dependency-cruiser rules', () => {
  test('rejects an import from domain into the application layer', async () => {
    const root = await fixtureProject({
      'src/modules/wallet/domain/value.ts': "export { useCase } from '../application/use-case';\n",
      'src/modules/wallet/application/use-case.ts': 'export const useCase = true;\n',
    });

    const result = await runDependencyCruiser(root);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('domain-no-other-layers');
  });

  test('rejects a circular import between source files', async () => {
    const root = await fixtureProject({
      'src/first.ts': "import './second';\nexport const first = true;\n",
      'src/second.ts': "import './first';\nexport const second = true;\n",
    });

    const result = await runDependencyCruiser(root);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('no-circular');
  });
});
