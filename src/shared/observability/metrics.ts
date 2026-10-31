type Labels = Record<string, string>;

interface Summary {
  count: number;
  sum: number;
  max: number;
}

/**
 * In-process metrics for one process. Each process reports its own counters; no
 * shared state exists between processes, so the numbers are per process by design.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly summaries = new Map<string, Summary>();

  increment(name: string, labels: Labels = {}): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = seriesKey(name, labels);
    const current = this.summaries.get(key) ?? { count: 0, sum: 0, max: 0 };
    this.summaries.set(key, {
      count: current.count + 1,
      sum: current.sum + value,
      max: Math.max(current.max, value),
    });
  }

  snapshot(): { counters: Record<string, number>; summaries: Record<string, Summary> } {
    return {
      counters: Object.fromEntries(this.counters),
      summaries: Object.fromEntries(this.summaries),
    };
  }
}

/** Used where a caller does not need metrics (for example, a unit test). It records nothing. */
export const NO_METRICS: Pick<MetricsRegistry, 'increment' | 'observe'> = {
  increment: () => undefined,
  observe: () => undefined,
};

function seriesKey(name: string, labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length === 0) {
    return name;
  }
  return `${name}{${entries.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
}

/** The part of the registry that instrumented code is allowed to touch. */
export type MetricsSink = Pick<MetricsRegistry, 'increment' | 'observe'>;

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');
