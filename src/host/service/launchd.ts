/**
 * The service on macOS: a user LaunchAgent, `local.awaydesk`, loaded in the owner's login session,
 * where Claude Code's credentials are (the Keychain). The plist is the one `docs/setup.md` wrote by
 * hand before this command existed: same label, keys and log. A named instance has a service of its
 * own, `local.awaydesk.<name>`, started with `--instance <name>`; the default instance's plist is
 * the one 0.1.x writes, byte for byte, so a copy with instances and a copy without agree on it.
 * The instance reaches this layer as its name (null for the default): the host layer imports
 * nothing of the core.
 *
 * Whether the job is loaded and its pid come from `launchctl list`, whose three columns (pid or
 * `-`, last exit status, label) `man launchctl` documents; `launchctl print` would say more, but
 * its man page calls its output "NOT API in any sense at all".
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyOf, copyVersion, type Program, servicePath } from "../program.ts";
import type { Report, Run, ServiceManager } from "./seam.ts";

const DEFAULT_LABEL = "local.awaydesk";

// The rule of an instance's name (`core/instance.ts`, `parseInstanceName`), kept here because the
// host layer imports nothing of the core; `test/host/service/launchd.test.ts` holds the two
// together. `service list` reads plists it did not write, so it checks the name itself.
const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_NAMES = ["default", "awaydesk"];

/** Whether `name` is a name an instance may have. */
export function isInstanceName(name: string): boolean {
  return INSTANCE_NAME.test(name) && !RESERVED_NAMES.includes(name);
}

/** The service's label: `local.awaydesk` for the default instance, `local.awaydesk.<name>` else. */
export function labelOf(instance: string | null): string {
  return instance === null ? DEFAULT_LABEL : `${DEFAULT_LABEL}.${instance}`;
}

// After `ExitTimeOut` seconds launchd kills a job that `bootout` stopped; macOS 27.0 caps it at
// 60 (measured 2026-09-26, `docs/setup.md`, Restarts and shutdown).
export const EXIT_TIMEOUT_SECONDS = 60;

// Folders a session's commands find as a terminal's do, after Node's and npm's (`servicePath`).
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export interface LaunchdOptions {
  home: string;
  uid: number;
  /** The instance's name, null for the default instance. `list` ignores it. */
  instance: string | null;
  /** The instance's configuration folder, named by `uninstall` as what it leaves. */
  configDir: string;
  run: Run;
}

function agentsDir(home: string): string {
  return join(home, "Library", "LaunchAgents");
}

/** The plist's path for the instance of the user whose home is `home`. */
export function plistPath(home: string, instance: string | null): string {
  return join(agentsDir(home), `${labelOf(instance)}.plist`);
}

/** The file launchd writes the instance's stdout and stderr to. */
export function logPath(home: string, instance: string | null): string {
  return join(home, "Library", "Logs", "awaydesk", `${instance ?? "awaydesk"}.log`);
}

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The plist that starts `program` at login, keeps it alive and writes its output to `log`. The
 * default instance (`instance` null) passes no argument, as 0.1.x does.
 */
export function plistFor(program: Program, log: string, instance: string | null = null): string {
  const argument =
    instance === null
      ? ""
      : `\n    <string>--instance</string>\n    <string>${xml(instance)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${labelOf(instance)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program.node)}</string>
    <string>${xml(program.main)}</string>${argument}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(servicePath(program, SYSTEM_PATH))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>${EXIT_TIMEOUT_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export interface ListedJob {
  pid: number | null;
  lastExit: number | null;
}

/** The jobs `launchctl list` prints, one per row of three columns; the header and noise are skipped. */
function listedRows(output: string): Array<ListedJob & { label: string }> {
  const number = (text: string): number | null => (/^-?\d+$/.test(text) ? Number(text) : null);
  return output.split("\n").flatMap((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length !== 3) return [];
    return [
      {
        label: columns[2] as string,
        pid: number(columns[0] as string),
        lastExit: number(columns[1] as string),
      },
    ];
  });
}

/** The job `label` in the output of `launchctl list`, or null when it is not loaded. */
export function listedJob(output: string, label: string): ListedJob | null {
  const row = listedRows(output).find((job) => job.label === label);
  return row === undefined ? null : { pid: row.pid, lastExit: row.lastExit };
}

/**
 * The instances of awaydesk that `launchctl list` shows loaded: the default instance as null, the
 * others by name. A label is one when it is `local.awaydesk` or `local.awaydesk.<name>` with a
 * name the rule allows, exactly as `listedJob` matches one.
 */
function listedInstances(output: string): Array<string | null> {
  const found: Array<string | null> = [];
  for (const { label } of listedRows(output)) {
    if (label === DEFAULT_LABEL) found.push(null);
    else if (label.startsWith(`${DEFAULT_LABEL}.`)) {
      const name = label.slice(DEFAULT_LABEL.length + 1);
      if (isInstanceName(name)) found.push(name);
    }
  }
  return found;
}

class LaunchctlError extends Error {}

const ok = (out: string[]): Report => ({ code: 0, out, err: [] });
const failed = (code: number, err: string[]): Report => ({ code, out: [], err });

/** The cells of one row of the table `list` prints. */
type Row = readonly [instance: string, state: string, copy: string, version: string];

/** The columns of `rows` padded to their widest cell, two spaces apart; the last is not padded. */
function table(rows: readonly Row[]): string[] {
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => (row[column] as string).length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => (column < 3 ? cell.padEnd((widths[column] as number) + 2) : cell))
      .join(""),
  );
}

// The files that may be an awaydesk service: `local.awaydesk.plist` and `local.awaydesk.<...>.plist`.
// Which instance one is comes from what it says inside (`inspected`), not from this name.
const OWN_PLIST = /^local\.awaydesk(?:\..+)?\.plist$/;

const NOT_MANAGEABLE = "not an awaydesk instance it can manage";

/** What `service list` reads of a plist: its Label (null when it has none) and its arguments. */
interface PlistFacts {
  label: string | null;
  args: string[];
}

/** The Label and program arguments of the plist at `file`, or null when `plutil` cannot read them. */
function plistFacts(run: Run, file: string): PlistFacts | null {
  const result = run("plutil", ["-convert", "json", "-o", "-", file]);
  if (result.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null) return null;
    const args = "ProgramArguments" in parsed ? parsed.ProgramArguments : null;
    if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) return null;
    const label = "Label" in parsed && typeof parsed.Label === "string" ? parsed.Label : null;
    return { label, args };
  } catch {
    return null;
  }
}

/** The instance a plist starts and its entry file, or the reason it is not one `file` can manage. */
function inspected(
  file: string,
  facts: PlistFacts | null,
): { instance: string | null; main: string | undefined } | { reason: string } {
  if (facts === null) return { reason: "its plist cannot be read" };
  const [, main, ...rest] = facts.args;
  let instance: string | null = null;
  if (rest.length === 1 && rest[0] === "--instance") {
    return { reason: "its program arguments end with --instance and no name" };
  }
  if (rest.length === 2 && rest[0] === "--instance") instance = rest[1] as string;
  else if (rest.length !== 0) {
    return {
      reason:
        "its program arguments are the entry file alone, or the entry file and --instance <name>",
    };
  }
  if (instance !== null && !isInstanceName(instance)) {
    return {
      reason: `${JSON.stringify(instance)} is not an instance name: 1 to 32 characters of a-z, 0-9 and "-", starting with a letter or a digit, and not "default" or "awaydesk"`,
    };
  }
  const expected = labelOf(instance);
  const named = instance === null ? "the default instance" : `instance ${JSON.stringify(instance)}`;
  if (facts.label === null) return { reason: "it has no Label" };
  if (facts.label !== expected) {
    return {
      reason: `its Label is ${facts.label}, but its program arguments start ${named} (Label ${expected})`,
    };
  }
  if (file !== `${expected}.plist`) {
    return {
      reason: `its file name says another instance than its program arguments, which name ${named} (${expected}.plist)`,
    };
  }
  return { instance, main };
}

/** The launchd implementation of `ServiceManager`. */
export class Launchd implements ServiceManager {
  readonly #options: LaunchdOptions;

  constructor(options: LaunchdOptions) {
    this.#options = options;
  }

  get #label(): string {
    return labelOf(this.#options.instance);
  }

  get #plist(): string {
    return plistPath(this.#options.home, this.#options.instance);
  }

  get #log(): string {
    return logPath(this.#options.home, this.#options.instance);
  }

  get #target(): string {
    return `gui/${this.#options.uid}/${this.#label}`;
  }

  /** A command of this instance as the owner types it: `--instance` is part of it when named. */
  #command(action: string): string {
    const { instance } = this.#options;
    return `\`awaydesk service ${action}${instance === null ? "" : ` --instance ${instance}`}\``;
  }

  #launchctl(args: readonly string[]): string {
    const result = this.#options.run("launchctl", args);
    if (result.status !== 0) {
      const said = (result.stderr || result.stdout).trim();
      throw new LaunchctlError(`launchctl ${args[0]} failed${said === "" ? "" : `: ${said}`}`);
    }
    return result.stdout;
  }

  #job(): ListedJob | null {
    return listedJob(this.#launchctl(["list"]), this.#label);
  }

  #guarded(action: () => Report): Report {
    try {
      return action();
    } catch (error) {
      if (error instanceof LaunchctlError) return failed(1, [error.message]);
      // A file it could not read or write, such as a folder it may not create: Node's message
      // names the path and the reason.
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        return failed(1, [error.message]);
      }
      throw error;
    }
  }

  install(program: Program): Report {
    return this.#guarded(() => {
      const text = plistFor(program, this.#log, this.#options.instance);
      const written = existsSync(this.#plist) ? readFileSync(this.#plist, "utf8") : null;
      if (this.#job() !== null) {
        if (written === text) return ok([`${this.#label} is already installed and loaded.`]);
        return failed(1, [
          written === null
            ? `${this.#label} is loaded, and its plist ${this.#plist} is gone.`
            : `${this.#label} is loaded with another definition (${this.#plist}).`,
          `${this.#command("uninstall")} then ${this.#command("install")} replaces it; the uninstall ends turns still running after ${EXIT_TIMEOUT_SECONDS} seconds.`,
        ]);
      }
      mkdirSync(dirname(this.#plist), { recursive: true });
      mkdirSync(dirname(this.#log), { recursive: true });
      writeFileSync(this.#plist, text);
      const lint = this.#options.run("plutil", ["-lint", this.#plist]);
      if (lint.status !== 0) {
        return failed(1, [`plutil refused ${this.#plist}: ${(lint.stdout || lint.stderr).trim()}`]);
      }
      this.#launchctl(["bootstrap", `gui/${this.#options.uid}`, this.#plist]);
      const copy = copyOf(program.main);
      const version = copyVersion(copy);
      return ok([
        `Wrote ${this.#plist}.`,
        `Loaded ${this.#label}: awaydesk starts now and at every login.`,
        `Log: ${this.#log}`,
        version === null
          ? `Runs the copy in ${copy}, whose package.json cannot be read.`
          : `Runs the copy in ${copy}, version ${version}.`,
      ]);
    });
  }

  uninstall(): Report {
    return this.#guarded(() => {
      const loaded = this.#job() !== null;
      const present = existsSync(this.#plist);
      if (!loaded && !present) return ok([`${this.#label} is not installed.`]);
      const out: string[] = [];
      if (loaded) {
        // Returns once the daemon has exited: its drain is cut at `ExitTimeOut`.
        this.#launchctl(["bootout", this.#target]);
        out.push(`Stopped ${this.#label}.`);
      }
      if (present) {
        rmSync(this.#plist);
        out.push(`Removed ${this.#plist}.`);
      }
      out.push(
        `Left in place: ${this.#options.configDir} (.env, state.json) and ${dirname(this.#log)}.`,
      );
      return ok(out);
    });
  }

  status(): Report {
    return this.#guarded(() => {
      const job = this.#job();
      if (job === null) {
        const line = existsSync(this.#plist)
          ? `${this.#label} is installed and not loaded: ${this.#command("install")} loads it.`
          : `${this.#label} is not installed.`;
        return { code: 3, out: [line], err: [] };
      }
      if (job.pid !== null) {
        return ok([`${this.#label} is running, pid ${job.pid}.`, `Log: ${this.#log}`]);
      }
      const exit = job.lastExit === null ? "" : `; its last exit status was ${job.lastExit}`;
      return {
        code: 3,
        out: [`${this.#label} is loaded and not running${exit}.`, `Log: ${this.#log}`],
        err: [],
      };
    });
  }

  restart(): Report {
    return this.#guarded(() => {
      const job = this.#job();
      if (job === null) {
        return failed(1, [`${this.#label} is not loaded: ${this.#command("install")} starts it.`]);
      }
      if (job.pid === null) {
        return failed(1, [
          `${this.#label} is not running; launchd starts it again on its own. Its log says why it stopped: ${this.#log}`,
        ]);
      }
      // Only sends the signal: the daemon lets running turns finish, exits, and `KeepAlive` starts
      // it again. `bootout` or `kickstart -k` would kill it after `ExitTimeOut`.
      this.#launchctl(["kill", "TERM", this.#target]);
      return ok([
        `Sent SIGTERM to ${this.#label} (pid ${job.pid}): running turns finish first, then launchd starts it again.`,
      ]);
    });
  }

  list(): Report {
    return this.#guarded(() => {
      const directory = agentsDir(this.#options.home);
      const files = existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => OWN_PLIST.test(name))
            .sort()
        : [];
      const listing = this.#launchctl(["list"]);
      // A job can outlive its plist (the file removed by hand): launchd keeps it loaded, and only
      // `launchctl list` knows. A loaded instance whose plist file is not there is listed as such.
      const gone = listedInstances(listing).filter(
        (instance) => !files.includes(`${labelOf(instance)}.plist`),
      );
      if (files.length === 0 && gone.length === 0) {
        return ok(["No awaydesk service is installed."]);
      }
      const found = files.map((file) => ({
        file,
        what: inspected(file, plistFacts(this.#options.run, join(directory, file))),
      }));
      const instances = [
        ...found.flatMap(({ what }) => ("reason" in what ? [] : [{ ...what, gone: false }])),
        ...gone.map((instance) => ({ instance, main: undefined, gone: true })),
      ]
        // The default instance first, then the others by name.
        .sort((a, b) => (a.instance ?? "").localeCompare(b.instance ?? ""));
      const rows: Row[] = instances.map(({ instance, main, gone: plistGone }) => {
        const job = listedJob(listing, labelOf(instance));
        const state =
          job === null
            ? "not loaded"
            : job.pid === null
              ? "loaded, not running"
              : `running, pid ${job.pid}`;
        // Not a name to type: `--instance default` is refused.
        const name = instance ?? "(default)";
        if (plistGone) return [name, `${state}; its plist is gone`, "-", "-"];
        if (main === undefined) return [name, state, "unreadable plist", "-"];
        const copy = copyOf(main);
        return [name, state, copy, copyVersion(copy) ?? "unknown"];
      });
      // What no command of an instance could find or remove is named, not listed as one.
      const refused = found.flatMap(({ file, what }) =>
        "reason" in what ? [`${file}: ${NOT_MANAGEABLE}: ${what.reason}`] : [],
      );
      return ok([
        ...(rows.length === 0 ? [] : table([["INSTANCE", "STATE", "COPY", "VERSION"], ...rows])),
        ...refused,
      ]);
    });
  }
}
