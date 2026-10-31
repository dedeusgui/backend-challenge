import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Architectural boundaries, checked by reading the source. The rules are the ones in CLAUDE.md and
 * ARCHITECTURE section 1. The check is a plain text scan, so it can be read and run anywhere.
 */

const SRC = join(import.meta.dir, '..', '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** The module specifiers a source text imports or re-exports. */
export function importsIn(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1] ?? '');
  }
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1] ?? '');
  }
  return specifiers;
}

function violationsOf(
  files: readonly string[],
  forbidden: (specifier: string) => boolean,
): string[] {
  return files.flatMap((file) => {
    const bad = importsIn(readFileSync(file, 'utf8')).filter(forbidden);
    return bad.map((specifier) => `${relative(SRC, file)} imports ${specifier}`);
  });
}

const FRAMEWORK = (specifier: string): boolean =>
  specifier.startsWith('@nestjs/') ||
  specifier.startsWith('@mikro-orm/') ||
  specifier.startsWith('@aws-sdk/');

const isDomainFile = (file: string): boolean =>
  file.includes('/domain/') || file.endsWith('/domain');
const isApplicationFile = (file: string): boolean => file.includes('/application/');
const isController = (file: string): boolean => file.endsWith('.controller.ts');

describe('architectural boundaries', () => {
  const files = sourceFiles(SRC);

  test('the detector sees every form of import, so an empty result means no violation', () => {
    const sample = [
      "import { A } from '@nestjs/common';",
      "import {\n  B,\n} from '@mikro-orm/core';",
      "export { C } from '@aws-sdk/client-sqs';",
      "import './side-effect';",
    ].join('\n');

    expect(importsIn(sample)).toEqual([
      '@nestjs/common',
      '@mikro-orm/core',
      '@aws-sdk/client-sqs',
      './side-effect',
    ]);
  });

  test('domain code imports no NestJS, MikroORM or AWS package', () => {
    expect(violationsOf(files.filter(isDomainFile), FRAMEWORK)).toEqual([]);
  });

  test('domain code does not depend on HTTP or infrastructure', () => {
    const toOutside = (specifier: string) =>
      specifier.includes('/http/') || specifier.includes('/infrastructure/');
    expect(violationsOf(files.filter(isDomainFile), toOutside)).toEqual([]);
  });

  test('application code depends on ports, not on framework packages or adapters', () => {
    const toAdapter = (specifier: string) =>
      FRAMEWORK(specifier) ||
      specifier.includes('/infrastructure/') ||
      specifier.includes('/http/');
    expect(violationsOf(files.filter(isApplicationFile), toAdapter)).toEqual([]);
  });

  test('controllers parse and present, and never reach the database or the broker directly', () => {
    const controllers = files.filter(isController);
    expect(controllers.length).toBeGreaterThan(0);
    const reachesStorage = (specifier: string) =>
      specifier.startsWith('@mikro-orm/') || specifier.includes('/infrastructure/');
    expect(violationsOf(controllers, reachesStorage)).toEqual([]);

    // Direct ORM or connection access, or a SQL statement written in the controller. A call to a use
    // case named `execute` is not SQL, so it is not matched.
    const sqlLike =
      /\bgetConnection\(|\bnativeUpdate\(|\bnativeInsert\(|\bem\.(find|persist|flush)\b|\b(SELECT|INSERT INTO|DELETE FROM)\b/;
    const withSql = controllers.filter((file) => sqlLike.test(readFileSync(file, 'utf8')));
    expect(withSql.map((file) => relative(SRC, file))).toEqual([]);
  });
});
