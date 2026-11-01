/**
 * Persistence for load run records (cpus-<N>.json) on disk.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPhaseSummary, type PhaseSummary } from './metrics';
import { isRunRecord, type RunRecord } from './records';

export const RUN_FILE_PATTERN = /^cpus-\d+\.json$/;

/** The phases of a run, each read with its unit. Undefined for a run made before the phases were measured. */
function readPhases(phases: unknown): Record<string, PhaseSummary> | undefined {
  if (phases === undefined) return undefined;
  if (typeof phases !== 'object' || phases === null)
    throw new Error('phases of a run are not an object');
  return Object.fromEntries(
    Object.entries(phases).map(([name, value]) => [name, readPhaseSummary(name, value)]),
  );
}

/** Reads every run record of a directory, in order of the CPUs given to the stack. A file that is not a run record is an error. */
export async function readRuns(directory: string): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const runs: RunRecord[] = [];
  for (const name of names.filter((candidate) => RUN_FILE_PATTERN.test(candidate)).sort()) {
    const value: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (!isRunRecord(value)) throw new Error(`${name} is not a load run record of this version`);
    runs.push({ ...value, phases: readPhases(value.phases) });
  }
  return runs.sort((left, right) => left.stackCpus - right.stackCpus);
}

export async function writeRun(directory: string, run: RunRecord): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `cpus-${run.stackCpus}.json`);
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}
