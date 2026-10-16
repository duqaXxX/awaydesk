/**
 * The command line of `awaydesk`. With no argument the command runs the daemon, which is what the
 * service starts; the other forms answer and end without reading `.env` or taking the
 * single-instance lock.
 */
import { homedir } from "node:os";
import { CONFIG_DIR } from "./core/config.ts";
import { type Program, programOf } from "./host/program.ts";
import { runCommand } from "./host/run.ts";
import { Launchd } from "./host/service/launchd.ts";
import { SERVICE_ACTIONS, type ServiceAction, type ServiceManager } from "./host/service/seam.ts";
import { installedVersion } from "./host/version.ts";

export const USAGE = [
  "usage: awaydesk                  run the daemon",
  `       awaydesk service <${SERVICE_ACTIONS.join("|")}>`,
  "       awaydesk --version | --help",
].join("\n");

export type Invocation =
  | { kind: "run" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "service"; action: ServiceAction }
  | { kind: "invalid"; reason: string };

function isAction(text: string | undefined): text is ServiceAction {
  return (SERVICE_ACTIONS as readonly (string | undefined)[]).includes(text);
}

/** What the arguments after the command ask for; anything else is `invalid`, with the reason. */
export function parseArguments(args: readonly string[]): Invocation {
  const [first, second, ...rest] = args;
  if (first === undefined) return { kind: "run" };
  if (first === "service") {
    if (!isAction(second)) {
      return { kind: "invalid", reason: `service needs one of: ${SERVICE_ACTIONS.join(", ")}` };
    }
    if (rest.length > 0) {
      return { kind: "invalid", reason: `unknown argument ${JSON.stringify(rest[0])}` };
    }
    return { kind: "service", action: second };
  }
  if (second !== undefined) {
    return { kind: "invalid", reason: `unknown argument ${JSON.stringify(second)}` };
  }
  if (first === "--version") return { kind: "version" };
  if (first === "--help") return { kind: "help" };
  return { kind: "invalid", reason: `unknown argument ${JSON.stringify(first)}` };
}

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

/** What `answer` needs of the machine; `machineHost` is the real one. */
export interface Host {
  /** The service manager of this system, or null where awaydesk has none. */
  service(): ServiceManager | null;
  /** The program the service is to start: this command's Node and entry. */
  program(): Program;
}

export const machineHost: Host = {
  service: () =>
    process.platform === "darwin"
      ? new Launchd({
          home: homedir(),
          uid: process.getuid?.() ?? 0,
          configDir: CONFIG_DIR,
          run: runCommand,
        })
      : null,
  program: () => programOf(process.argv[1] ?? "", process.env.PATH ?? "", process.execPath),
};

/**
 * Answers an invocation that does not run the daemon, and returns the exit status: 0, 2 for
 * arguments it does not know (with the usage on stderr), or the service action's own status.
 */
export function answer(
  invocation: Exclude<Invocation, { kind: "run" }>,
  output: Output,
  host: Host = machineHost,
): number {
  switch (invocation.kind) {
    case "version":
      output.out(`${installedVersion()}\n`);
      return 0;
    case "help":
      output.out(`${USAGE}\n`);
      return 0;
    case "invalid":
      output.err(`awaydesk: ${invocation.reason}\n${USAGE}\n`);
      return 2;
    case "service": {
      const manager = host.service();
      if (manager === null) {
        output.err("awaydesk service: awaydesk runs as a service on macOS only, for now.\n");
        return 1;
      }
      const report =
        invocation.action === "install"
          ? manager.install(host.program())
          : manager[invocation.action]();
      for (const line of report.out) output.out(`${line}\n`);
      for (const line of report.err) output.err(`${line}\n`);
      return report.code;
    }
  }
}
