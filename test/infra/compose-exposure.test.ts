import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

/**
 * What the merged Compose files publish on the host, read from `docker compose config`, which is the
 * configuration Compose actually runs. No container is started, so this needs only the Compose CLI.
 * A published port with no host address binds every interface of the machine, so it fails here.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_MODE = ['docker-compose.yml'];
const PROTECTED_MODE = ['docker-compose.yml', 'docker-compose.protected.yml'];
const LOOPBACK = '127.0.0.1';

interface HostPort {
  service: string;
  hostIp: string | undefined;
  published: string;
}

async function publishedPorts(files: readonly string[]): Promise<HostPort[]> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A caller's own bind setting must not change what the default files publish.
    if (value !== undefined && key !== 'PUBLISH_HOST') {
      env[key] = value;
    }
  }
  const child = Bun.spawn(
    ['docker', 'compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'],
    { cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker compose config failed: ${stderr}`);
  }
  return hostPortsOf(JSON.parse(stdout) as unknown);
}

function hostPortsOf(config: unknown): HostPort[] {
  if (!isRecord(config) || !isRecord(config.services)) {
    throw new Error('docker compose config has no services');
  }
  const ports: HostPort[] = [];
  for (const [service, definition] of Object.entries(config.services)) {
    if (!isRecord(definition) || !Array.isArray(definition.ports)) {
      continue;
    }
    for (const port of definition.ports) {
      if (isRecord(port) && port.published !== undefined) {
        ports.push({
          service,
          hostIp: typeof port.host_ip === 'string' ? port.host_ip : undefined,
          published: String(port.published),
        });
      }
    }
  }
  return ports;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('default mode publishes only on loopback', () => {
  test('no published port binds every interface', async () => {
    const ports = await publishedPorts(DEFAULT_MODE);
    expect(ports.map((port) => port.service).sort()).toEqual(['api', 'localstack', 'postgres']);
    for (const port of ports) {
      expect({ service: port.service, hostIp: port.hostIp }).toEqual({
        service: port.service,
        hostIp: LOOPBACK,
      });
    }
  });

  test('PostgreSQL and LocalStack are reachable from the host only through loopback', async () => {
    const ports = await publishedPorts(DEFAULT_MODE);
    expect(ports.find((port) => port.service === 'postgres')).toMatchObject({
      hostIp: LOOPBACK,
      published: '5432',
    });
    expect(ports.find((port) => port.service === 'localstack')).toMatchObject({
      hostIp: LOOPBACK,
      published: '4566',
    });
  });
});

describe('protected mode exposes only the edge, and only on loopback', () => {
  test('PostgreSQL, LocalStack and the API publish no port', async () => {
    const ports = await publishedPorts(PROTECTED_MODE);
    expect(ports.map((port) => port.service)).toEqual(['edge']);
  });

  test('the edge publishes the public port on loopback', async () => {
    const ports = await publishedPorts(PROTECTED_MODE);
    expect(ports).toEqual([{ service: 'edge', hostIp: LOOPBACK, published: '3000' }]);
  });
});
