/**
 * Narrows a value read from the database to a known set. An unknown value means the
 * database and the code disagree, so it fails loudly rather than being coerced.
 */
export function oneOf<T extends string>(allowed: readonly T[], stored: string, label: string): T {
  const match = allowed.find((candidate) => candidate === stored);
  if (match === undefined) {
    throw new Error(`Unknown ${label} stored in the database: ${stored}`);
  }
  return match;
}

/** Converts a nullable numeric column into an optional value, without treating null as zero. */
export function nullableToOptional<T>(stored: T | null | undefined): T | undefined {
  return stored ?? undefined;
}
