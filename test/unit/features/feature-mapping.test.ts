import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const areaTags = ['@financeiro', '@idempotencia', '@concorrencia', '@mensageria'];
export function validateFeatureText(content: string): boolean {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*Scenario(?: Outline)?:/.test(lines[index] ?? '')) continue;
    const tags = (
      lines
        .slice(0, index)
        .reverse()
        .find((line) => /^\s*@/.test(line)) ?? ''
    ).split(/\s+/);
    if (tags.filter((tag) => areaTags.includes(tag)).length !== 1) return false;
    if (!tags.some((tag) => tag.startsWith('@edge:') || tag.startsWith('@cenario:'))) return false;
  }
  return true;
}

describe('feature mapping', () => {
  const featureDirectory = join(root, 'test/features');
  const features = readdirSync(featureDirectory).filter((name) => name.endsWith('.feature'));
  const matrix = readFileSync(join(root, 'docs/audit/EDGE_CASE_MATRIX.md'), 'utf8');
  test('every scenario has exactly one area tag and a trace tag', () => {
    for (const file of features)
      expect(validateFeatureText(readFileSync(join(featureDirectory, file), 'utf8'))).toBe(true);
  });
  test('every edge ID exists in the matrix', () => {
    for (const file of features) {
      const content = readFileSync(join(featureDirectory, file), 'utf8');
      for (const match of content.matchAll(/@edge:([A-Z]+-\d+)/g))
        expect(matrix).toMatch(new RegExp(`\\|\\s*${match[1]}\\s*\\|`));
    }
  });
  test('step files do not contain test doubles', () => {
    const stepDirectory = join(featureDirectory, 'steps');
    for (const file of readdirSync(stepDirectory))
      expect(readFileSync(join(stepDirectory, file), 'utf8')).not.toMatch(/mock|spyOn/i);
  });
  test('the checker rejects a scenario without an area tag', () => {
    expect(validateFeatureText('Scenario: caso sem área\n  Given algo')).toBe(false);
  });
});
