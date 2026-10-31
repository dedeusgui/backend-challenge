import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SqsSettings } from '../../../config/app-config';

export interface ResolvedQueues {
  commandQueueUrl: string;
  deadLetterQueueUrl: string;
  eventsQueueUrl: string;
}

/**
 * Creates an SQS client. `probe` clients fail fast, so a readiness check cannot hang
 * for minutes behind the SDK's default retry policy.
 */
export function createSqsClient(
  settings: SqsSettings,
  options: { probe?: boolean } = {},
): SQSClient {
  return new SQSClient({
    region: settings.region,
    endpoint: settings.endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
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
