import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../../integration/support/test-database';
import {
  createTestQueues,
  SQS_ENDPOINT,
  testSqsClient,
  type TestQueues,
} from '../../integration/support/sqs-test-queues';

const ROOT = `${import.meta.dir}/../../..`;

export interface ManagedProcess {
  name: string;
  process: ReturnType<typeof Bun.spawn>;
  recentOutput(): string;
}

/**
 * A cluster of independent Bun processes that share one PostgreSQL database and one
 * LocalStack. Nothing is shared in memory: each process opens its own pools and clients.
 */
export class ProcessCluster {
  readonly processes: ManagedProcess[] = [];
  readonly apiUrls: string[] = [];
  private constructor(
    readonly database: TestDatabase,
    readonly queues: TestQueues,
    readonly queueNames: { command: string; deadLetter: string; events: string },
    /** A taskset CPU list. When set, every process of the cluster is pinned to it. */
    private readonly cpus: string | undefined,
  ) {}

  static async create(options: { cpus?: string } = {}): Promise<ProcessCluster> {
    const database = await createTestDatabase();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const queueNames = {
      command: `commands-${suffix}.fifo`,
      deadLetter: `dead-letter-${suffix}.fifo`,
      events: `events-${suffix}.fifo`,
    };
    const queues = await createTestQueues(testSqsClient(), queueNames);
    return new ProcessCluster(database, queues, queueNames, options.cpus);
  }

  /** Environment shared by every process of this cluster. */
  private environment(extra: Record<string, string>): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: this.database.url,
      AWS_REGION: 'us-east-1',
      SQS_ENDPOINT,
      SQS_COMMAND_QUEUE: this.queueNames.command,
      SQS_COMMAND_DLQ: this.queueNames.deadLetter,
      SQS_EVENTS_QUEUE: this.queueNames.events,
      ...extra,
    };
  }

  private spawn(name: string, script: string, env: Record<string, string>): ManagedProcess {
    // taskset execs the command, so the process keeps the pid that the load test measures.
    const command = [
      ...(this.cpus === undefined ? [] : ['taskset', '-c', this.cpus]),
      'bun',
      'run',
      `${ROOT}/${script}`,
    ];
    const child = Bun.spawn(command, {
      env: this.environment(env),
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: ROOT,
    });
    const output: string[] = [];
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        output.push(new TextDecoder().decode(chunk));
        if (output.length > 200) output.shift();
      }
    };
    void capture(child.stdout);
    void capture(child.stderr);
    const managed: ManagedProcess = { name, process: child, recentOutput: () => output.join('') };
    this.processes.push(managed);
    return managed;
  }

  /**
   * Starts an HTTP process on a free port and waits until its readiness endpoint answers 200.
   * The port is reserved by the kernel and released before the child binds it, so another
   * process can take it in between. A child that exits before it is ready is retried on a new port.
   */
  async startApi(name: string): Promise<string> {
    const attempts = 3;
    for (let attempt = 1; ; attempt++) {
      const port = freePort();
      const managed = this.spawn(name, 'src/main.ts', { PORT: String(port) });
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        await waitUntilReady(baseUrl, managed);
        this.apiUrls.push(baseUrl);
        return baseUrl;
      } catch (error) {
        if (managed.process.exitCode === null || attempt === attempts) throw error;
      }
    }
  }

  startWorker(
    name: string,
    script = 'src/worker.ts',
    extra: Record<string, string> = {},
  ): ManagedProcess {
    return this.spawn(name, script, extra);
  }

  async close(): Promise<void> {
    for (const managed of this.processes) {
      if (managed.process.exitCode === null) {
        managed.process.kill('SIGKILL');
      }
      await managed.process.exited;
    }
    await this.database.drop();
  }
}

/** Asks the kernel for a port that is free at this moment. */
function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/** Polls readiness until it answers 200. Fails with the process output if the process exits first. */
export async function waitUntilReady(
  baseUrl: string,
  managed: ManagedProcess,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managed.process.exitCode !== null) {
      throw new Error(
        `${managed.name} exited with ${managed.process.exitCode}:\n${managed.recentOutput()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${managed.name} was not ready within ${timeoutMs} ms:\n${managed.recentOutput()}`,
  );
}
