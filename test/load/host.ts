/**
 * The host side of a pinned load run: which CPUs exist, which CPUs the stack and the generator get, and
 * the cpuset of the PostgreSQL and LocalStack containers. Linux only for pinning; the rest of the load
 * test runs anywhere.
 */
import { availableParallelism } from 'node:os';
import { parseCpuList } from './metrics';

export interface PinningPlan {
  /** Whether the stack and the containers are pinned at all. False off Linux. */
  pinned: boolean;
  hostLogicalCpus: number;
  /** Every CPU the host allows this process, in order. */
  allowed: number[];
  stack: number[];
  /** Empty when the stack has every CPU, and the generator then shares them. */
  generator: number[];
}

/** Splits the allowed CPUs: the stack takes the first `stackCount`, the generator the rest. */
export function planPinning(input: {
  allowed: readonly number[];
  stackCount: number;
  pinnable: boolean;
}): PinningPlan {
  if (!Number.isInteger(input.stackCount) || input.stackCount < 1) {
    throw new Error('the stack needs at least one CPU');
  }
  if (input.stackCount > input.allowed.length) {
    throw new Error(
      `the stack asks for ${input.stackCount} CPUs, but this process may use ${input.allowed.length}`,
    );
  }
  return {
    pinned: input.pinnable,
    hostLogicalCpus: input.allowed.length,
    allowed: [...input.allowed],
    // Without pinning, nothing is restricted: the stack is every allowed CPU, whatever was asked.
    stack: input.pinnable ? input.allowed.slice(0, input.stackCount) : [...input.allowed],
    generator: input.pinnable ? input.allowed.slice(input.stackCount) : [],
  };
}

/** The CPUs this process may run on, from /proc on Linux. Elsewhere, every logical CPU. */
export async function allowedCpus(): Promise<number[]> {
  const list = await affinityOf(process.pid);
  if (list !== undefined) return parseCpuList(list);
  return Array.from({ length: availableParallelism() }, (_, cpu) => cpu);
}

/** The Cpus_allowed_list of a process, as /proc/<pid>/status writes it. Undefined where /proc is absent. */
export async function affinityOf(pid: number): Promise<string | undefined> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const line = status.split('\n').find((candidate) => candidate.startsWith('Cpus_allowed_list:'));
    return line?.split(':')[1]?.trim();
  } catch {
    return undefined;
  }
}

export interface Container {
  id: string;
  name: string;
}

/** The running containers of one compose service, found by its label. */
export async function containersOf(service: string): Promise<Container[]> {
  const text = await run([
    'docker',
    'ps',
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.ID}}\t{{.Names}}',
  ]);
  return text
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '')
    .map(([id, name]) => ({ id, name }));
}

export async function cpusetOf(container: Container): Promise<string> {
  return (
    await run(['docker', 'inspect', '-f', '{{.HostConfig.CpusetCpus}}', container.id])
  ).trim();
}

/**
 * Sets the cpuset of a container. Docker cannot return a container to "no cpuset" with `docker update`,
 * so an empty original is restored as the full list of the host, which is the same thing for it.
 */
export async function setCpuset(container: Container, list: string): Promise<void> {
  await run(['docker', 'update', `--cpuset-cpus=${list}`, container.id]);
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [text, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (status !== 0) {
    const detail = await new Response(child.stderr).text();
    throw new Error(`${command.join(' ')} exited with ${status}: ${detail.trim()}`);
  }
  return text;
}
