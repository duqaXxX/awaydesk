/**
 * Values nobody typed: what a parser returned and what a `catch` caught. Read by what they are
 * at run time, never by a cast. Any layer imports this.
 */

/** Whether `value` is a JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON objects of a list; none for anything that is no list. */
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The errno code of a system error (`ENOENT`, `EACCES`); undefined for anything else. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** The name a log line gives a failure: the errno code of a system error, else the error's name. */
export function errorName(error: unknown): string {
  return error instanceof Error ? (errorCode(error) ?? error.name) : typeof error;
}
