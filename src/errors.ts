/** A mistake on the command line. Exits 64, never 1, so scripts can tell it from a failed run. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}
