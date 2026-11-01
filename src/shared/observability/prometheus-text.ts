import type { MetricsRegistry } from './metrics';

export type MetricsSnapshot = ReturnType<MetricsRegistry['snapshot']>;

interface SeriesKey {
  readonly name: string;
  readonly labels: string;
}

function splitSeriesKey(key: string): SeriesKey {
  const braceIndex = key.indexOf('{');
  if (braceIndex === -1) {
    return { name: key, labels: '' };
  }
  return {
    name: key.slice(0, braceIndex),
    labels: key.slice(braceIndex),
  };
}

/**
 * Converts an in-memory MetricsRegistry snapshot into Prometheus text exposition format (0.0.4).
 * Emits `# TYPE` declarations and groups metric series by base name.
 */
export function toPrometheusText(snapshot: MetricsSnapshot): string {
  const lines = [...formatCounters(snapshot.counters), ...formatSummaries(snapshot.summaries)];
  return assemblePrometheusText(lines);
}

function formatCounters(counters: MetricsSnapshot['counters']): string[] {
  const lines: string[] = [];
  const counterGroups = new Map<string, Array<{ key: string; value: number }>>();
  for (const [key, value] of Object.entries(counters)) {
    const { name } = splitSeriesKey(key);
    const existing = counterGroups.get(name);
    if (existing !== undefined) {
      existing.push({ key, value });
      continue;
    }
    counterGroups.set(name, [{ key, value }]);
  }

  for (const [name, series] of counterGroups) {
    lines.push(`# TYPE ${name} counter`);
    for (const item of series) {
      lines.push(`${item.key} ${item.value}`);
    }
  }
  return lines;
}

function formatSummaries(summaries: MetricsSnapshot['summaries']): string[] {
  const lines: string[] = [];
  const summaryGroups = new Map<
    string,
    Array<{ labels: string; summary: { count: number; sum: number; max: number } }>
  >();
  for (const [key, summary] of Object.entries(summaries)) {
    const { name, labels } = splitSeriesKey(key);
    const existing = summaryGroups.get(name);
    if (existing !== undefined) {
      existing.push({ labels, summary });
      continue;
    }
    summaryGroups.set(name, [{ labels, summary }]);
  }

  for (const [name, series] of summaryGroups) {
    lines.push(`# TYPE ${name} summary`);
    for (const item of series) {
      lines.push(`${name}_sum${item.labels} ${item.summary.sum}`);
      lines.push(`${name}_count${item.labels} ${item.summary.count}`);
    }
  }
  return lines;
}

function assemblePrometheusText(lines: readonly string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.join('\n')}\n`;
}
