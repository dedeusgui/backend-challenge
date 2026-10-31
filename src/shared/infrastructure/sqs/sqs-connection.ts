import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { SqsSettings } from '../../../config/app-config';

export interface ResolvedQueues {
  commandQueueUrl: string;
  deadLetterQueueUrl: string;
  eventsQueueUrl: string;
}

/** Destroys the SQS clients when the application shuts down, so their sockets are released. */
export class SqsClientLifecycle implements OnApplicationShutdown {
  constructor(private readonly clients: readonly Pick<SQSClient, 'destroy'>[]) {}

  onApplicationShutdown(): void {
    for (const client of this.clients) {
      client.destroy();
    }
  }
}

/** The fixed pair that an emulator accepts. It is never sent to AWS. */
const EMULATOR_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };

/**
 * Creates an SQS client. `probe` clients fail fast, so a readiness check cannot hang
 * for minutes behind the SDK's default retry policy.
 *
 * With an emulator endpoint the fixed pair is used. Without one the SDK's default chain resolves
 * the credentials: environment, shared profile, or the task or instance role.
 */
export function createSqsClient(
  settings: SqsSettings,
  options: { probe?: boolean } = {},
): SQSClient {
  return new SQSClient({
    region: settings.region,
    endpoint: settings.endpoint,
    credentials: settings.endpoint === undefined ? undefined : EMULATOR_CREDENTIALS,
    maxAttempts: options.probe ? 1 : 3,
    requestHandler: options.probe ? { connectionTimeout: 1_000, requestTimeout: 2_000 } : undefined,
  });
}

/**
 * With an emulator endpoint the queue URL is built from the endpoint, because the URL
 * returned by the emulator may use a host name this process cannot resolve. Against AWS
 * the URL comes from GetQueueUrl.
 */
export async function resolveQueues(
  client: SQSClient,
  settings: SqsSettings,
): Promise<ResolvedQueues> {
  const urlFor = async (name: string): Promise<string> => {
    if (settings.endpoint !== undefined) {
      return `${settings.endpoint}/000000000000/${name}`;
    }
    const found = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (found.QueueUrl === undefined) {
      throw new Error(`Queue ${name} does not exist`);
    }
    return found.QueueUrl;
  };
  return {
    commandQueueUrl: await urlFor(settings.commandQueueName),
    deadLetterQueueUrl: await urlFor(settings.deadLetterQueueName),
    eventsQueueUrl: await urlFor(settings.eventsQueueName),
  };
}
