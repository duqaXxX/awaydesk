/**
 * The command line of `awaydesk`. With no argument the command runs the daemon, which is what the
 * LaunchAgent of `docs/setup.md` starts; the other forms answer and end without reading `.env` or
 * taking the single-instance lock.
 */
import { installedVersion } from "./host/version.ts";

export const USAGE = "usage: awaydesk [--version | --help]";

export type Invocation =
  | { kind: "run" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "unknown"; argument: string };

/** What the arguments after the command ask for; anything not recognised is `unknown`. */
export function parseArguments(args: readonly string[]): Invocation {
  const [first, ...rest] = args;
  if (first === undefined) return { kind: "run" };
  if (rest.length > 0) return { kind: "unknown", argument: rest[0] as string };
  if (first === "--version") return { kind: "version" };
  if (first === "--help") return { kind: "help" };
  return { kind: "unknown", argument: first };
}

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

/**
 * Answers an invocation that does not run the daemon, and returns the exit status: 0, or 2 for
 * an argument it does not know (the usage goes to stderr then).
 */
export function answer(invocation: Exclude<Invocation, { kind: "run" }>, output: Output): number {
  switch (invocation.kind) {
    case "version":
      output.out(`${installedVersion()}\n`);
      return 0;
    case "help":
      output.out(`${USAGE}\n`);
      return 0;
    case "unknown":
      output.err(`awaydesk: unknown argument ${JSON.stringify(invocation.argument)}\n${USAGE}\n`);
      return 2;
  }
}
