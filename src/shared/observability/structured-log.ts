export interface OperationLog {
  operation: string;
  status: string;
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  durationMs?: number;
}

/**
 * One JSON object per line. Only the fields declared above can be written, so a
 * payload or an amount cannot leak into the log by accident.
 */
export function formatOperationLog(entry: OperationLog, at: Date = new Date()): string {
  const line: Record<string, string | number> = {
    time: at.toISOString(),
    level: 'info',
    operation: entry.operation,
    status: entry.status,
  };
  for (const key of [
    'correlationId',
    'messageId',
    'transactionId',
    'walletId',
    'providerId',
    'durationMs',
  ] as const) {
    const value = entry[key];
    if (value !== undefined) {
      line[key] = value;
    }
  }
  return JSON.stringify(line);
}

export function logOperation(entry: OperationLog): void {
  process.stdout.write(`${formatOperationLog(entry)}\n`);
}

/** Receives operation logs. The production process writes them to stdout; tests use the silent logger. */
export type OperationLogger = (entry: OperationLog) => void;

export const SILENT_LOGGER: OperationLogger = () => undefined;

export const STDOUT_LOGGER: OperationLogger = (entry) => logOperation(entry);

export const OPERATION_LOGGER = Symbol('OPERATION_LOGGER');
