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

/**
 * The name of a failure, all a log line or a reply may say of it, never its words: the code of
 * a system error (`EACCES`), else the name the error gives itself (a `ChatError` is named by
 * the chat's code), else its class, as Python's `type(exc).__name__` named it.
 */
export function errorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return errorCode(error) ?? (error.name !== "Error" ? error.name : error.constructor.name);
}
