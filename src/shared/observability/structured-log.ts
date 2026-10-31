export interface OperationLog {
  operation: string;
  status: string;
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  durationMs?: number;
  errorName?: string;
  errorCode?: string;
}

/**
 * The class name and the code of a thrown value. The class name is used, not `error.name`,
 * because the application's own errors do not set `name` and would all read as "Error". The
 * message is left out on purpose: it can carry a payload, and the log must never hold one.
 */
export type ErrorFields = Pick<OperationLog, 'errorName' | 'errorCode'>;

export function describeError(error: unknown): ErrorFields {
  if (!(error instanceof Error)) {
    return { errorName: 'NonError' };
  }
  const errorName = error.constructor.name;
  return 'code' in error && typeof error.code === 'string'
    ? { errorName, errorCode: error.code }
    : { errorName };
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
    'errorName',
    'errorCode',
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
