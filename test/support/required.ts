/**
 * A value a test needs from its fixture. When it is absent, the fixture is broken: a row was not written, a
 * process did not start, a key was not created. The test fails there, with the name of what is missing, instead
 * of going on with an empty string that fails later with a message about something else.
 */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`test fixture is missing ${what}`);
  }
  return value;
}
