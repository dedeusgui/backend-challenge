import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Metric labels must stay at a few fixed values. A label that carries an identifier (a transaction, a
 * wallet, a provider, a message) makes one time series per identifier, which no monitoring system can
 * hold. This reads the source, so a new metric with such a label fails here, before it ships.
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

/** The label names written in calls to increment() and observe(), with the file that writes them. */
export function labelNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const call of text.matchAll(/\.(?:increment|observe)\(([^;]*?)\)\s*;/gs)) {
    for (const label of call[1]?.matchAll(/\{\s*([A-Za-z_]\w*)\s*:/g) ?? []) {
      names.push(label[1] ?? '');
    }
  }
  return names;
}

const IDENTIFIER_LABELS = [
  'transactionId',
  'walletId',
  'providerId',
  'playerId',
  'externalTransactionId',
  'messageId',
  'idempotencyKey',
  'correlationId',
  'eventId',
  'aggregateId',
];

describe('metric label cardinality', () => {
  test('no metric is labelled with an identifier', () => {
    const offending = sourceFiles(SRC).flatMap((file) =>
      labelNamesIn(readFileSync(file, 'utf8'))
        .filter((label) => IDENTIFIER_LABELS.includes(label))
        .map((label) => `${file} labels ${label}`),
    );

    expect(offending).toEqual([]);
  });

  test('the scan sees the labels that exist, so an empty result means none is an identifier', () => {
    const labels = sourceFiles(SRC).flatMap((file) => labelNamesIn(readFileSync(file, 'utf8')));

    expect(labels).toContain('status');
    expect(labels).toContain('result');
  });

  test('the scan finds an identifier label written on a multi-line call', () => {
    const sample =
      "this.metrics.increment(\n  'transactions_total',\n  { walletId: wallet.id },\n);";

    expect(labelNamesIn(sample)).toEqual(['walletId']);
  });
});
