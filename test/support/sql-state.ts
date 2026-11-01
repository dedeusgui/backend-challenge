/**
 * Resolves the SQLSTATE error code from a database driver or ORM error,
 * or runs an asynchronous action and returns the SQLSTATE it raised.
 */
export function findSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return current.code;
    }
    if ('cause' in current && current.cause !== undefined) {
      current = current.cause;
    } else if ('driverError' in current && current.driverError !== undefined) {
      current = current.driverError;
    } else {
      break;
    }
  }
  return undefined;
}

/** Runs `action` and returns the SQLSTATE it raised, or 'NO_ERROR'. */
export async function sqlStateOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return findSqlState(error) ?? `UNEXPECTED: ${String(error)}`;
  }
  return 'NO_ERROR';
}
