/** Keeps controllers independent of Express types. */
export interface StatusSetter {
  status(code: number): unknown;
}
