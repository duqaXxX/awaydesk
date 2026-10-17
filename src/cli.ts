/**
 * The command line of `awaydesk`. With no argument the command runs the daemon, which is what the
 * service starts; the other forms answer and end without reading `.env` or taking the
 * single-instance lock. `--instance <name>`, or `AWAYDESK_INSTANCE` when the flag is absent, picks
 * which of the machine's daemons a command is about (`core/instance.ts`); this file is the only
 * reader of the variable.
 */
import { homedir } from "node:os";
import {
  configDirOf,
  DEFAULT_INSTANCE,
  INSTANCE_VARIABLE,
  type Instance,
  parseInstanceName,
} from "./core/instance.ts";
import { type Program, programOf } from "./host/program.ts";
import { runCommand } from "./host/run.ts";
import { Launchd } from "./host/service/launchd.ts";
import { SERVICE_ACTIONS, type ServiceAction, type ServiceManager } from "./host/service/seam.ts";
import { installedVersion } from "./version.ts";

export const USAGE = [
  "usage: awaydesk [--instance <name>]                    run the daemon",
  `       awaydesk service <${SERVICE_ACTIONS.join("|")}> [--instance <name>]`,
  "       awaydesk --version | --help",
  "",
  `--instance picks one of the machine's daemons; ${INSTANCE_VARIABLE} does the same when the flag`,
  "is absent. `service list` shows every instance and takes no --instance.",
].join("\n");

export type Invocation =
  | { kind: "run"; instance: Instance }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "service"; action: ServiceAction; instance: Instance }
  | { kind: "invalid"; reason: string };

type Invalid = Extract<Invocation, { kind: "invalid" }>;

function isAction(text: string | undefined): text is ServiceAction {
  return (SERVICE_ACTIONS as readonly (string | undefined)[]).includes(text);
}

const invalid = (reason: string): Invalid => ({ kind: "invalid", reason });

/** The arguments without `--instance <name>`, and the name when it was given. */
function takeInstanceFlag(
  args: readonly string[],
): { rest: string[]; flag: string | undefined } | Invalid {
  const rest: string[] = [];
  let flag: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument !== "--instance") {
      rest.push(argument);
      continue;
    }
    if (flag !== undefined) return invalid("--instance is given twice");
    const value = args[index + 1];
    if (value === undefined) return invalid("--instance needs a name");
    flag = value;
    index += 1;
  }
  return { rest, flag };
}

/** The instance the flag names, else the variable, else the default; the refusal says which. */
function instanceOf(flag: string | undefined, env: Env): Instance | Invalid {
  const variable = env[INSTANCE_VARIABLE];
  const named =
    flag !== undefined
      ? { source: "--instance", text: flag }
      : variable !== undefined && variable !== ""
        ? { source: INSTANCE_VARIABLE, text: variable }
        : null;
  if (named === null) return DEFAULT_INSTANCE;
  const parsed = parseInstanceName(named.text);
  return "refusal" in parsed
    ? invalid(`${named.source}: ${parsed.refusal}`)
    : { name: parsed.name };
}

/** The variables the command line reads; `process.env` in the entry. */
export type Env = Readonly<Record<string, string | undefined>>;

/** What the arguments after the command ask for; anything else is `invalid`, with the reason. */
export function parseArguments(args: readonly string[], env: Env = {}): Invocation {
  const taken = takeInstanceFlag(args);
  if ("kind" in taken) return taken;
  const { rest: positional, flag } = taken;
  const [first, second, ...rest] = positional;
  if (first === undefined) {
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "run", instance };
  }
  if (first === "service") {
    if (!isAction(second)) {
      return invalid(`service needs one of: ${SERVICE_ACTIONS.join(", ")}`);
    }
    if (rest.length > 0) return invalid(`unknown argument ${JSON.stringify(rest[0])}`);
    if (second === "list") {
      return flag === undefined
        ? { kind: "service", action: second, instance: DEFAULT_INSTANCE }
        : invalid("service list takes no instance: it lists them all");
    }
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "service", action: second, instance };
  }
  if (second !== undefined) return invalid(`unknown argument ${JSON.stringify(second)}`);
  if (first === "--version" || first === "--help") {
    if (flag !== undefined) return invalid(`${first} takes no instance`);
    return { kind: first === "--version" ? "version" : "help" };
  }
  return invalid(`unknown argument ${JSON.stringify(first)}`);
}

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

/** What `answer` needs of the machine; `machineHost` is the real one. */
export interface Host {
  /** The service manager of this system for `instance`, or null where awaydesk has none. */
  service(instance: Instance): ServiceManager | null;
  /** The program the service is to start: this command's Node and entry. */
  program(): Program;
}

export const machineHost: Host = {
  service: (instance) =>
    process.platform === "darwin"
      ? new Launchd({
          home: homedir(),
          uid: process.getuid?.() ?? 0,
          instance: instance.name,
          configDir: configDirOf(instance, homedir()),
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
      const manager = host.service(invocation.instance);
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
