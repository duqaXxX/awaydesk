/**
 * The service on macOS: a user LaunchAgent, `local.awaydesk`, loaded in the owner's login session,
 * where Claude Code's credentials are (the Keychain). The plist is the one `docs/setup.md` wrote by
 * hand before this command existed: same label, keys and log.
 *
 * Whether the job is loaded and its pid come from `launchctl list`, whose three columns (pid or
 * `-`, last exit status, label) `man launchctl` documents; `launchctl print` would say more, but
 * its man page calls its output "NOT API in any sense at all".
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Program, servicePath } from "../program.ts";
import type { Report, Run, ServiceManager } from "./seam.ts";

export const LABEL = "local.awaydesk";

// After `ExitTimeOut` seconds launchd kills a job that `bootout` stopped; macOS 27.0 caps it at
// 60 (measured 2026-09-26, `docs/setup.md`, Restarts and shutdown).
export const EXIT_TIMEOUT_SECONDS = 60;

// Folders a session's commands find as a terminal's do, after Node's and npm's (`servicePath`).
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export interface LaunchdOptions {
  home: string;
  uid: number;
  /** awaydesk's configuration folder, named by `uninstall` as what it leaves. */
  configDir: string;
  run: Run;
}

/** The plist's path for the user whose home is `home`. */
export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** The file launchd writes the daemon's stdout and stderr to. */
export function logPath(home: string): string {
  return join(home, "Library", "Logs", "awaydesk", "awaydesk.log");
}

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The plist that starts `program` at login, keeps it alive and writes its output to `log`. */
export function plistFor(program: Program, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program.node)}</string>
    <string>${xml(program.main)}</string>
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

/** The job `LABEL` in the output of `launchctl list`, or null when it is not loaded. */
export function listedJob(output: string): ListedJob | null {
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length !== 3 || columns[2] !== LABEL) continue;
    const number = (text: string): number | null => (/^-?\d+$/.test(text) ? Number(text) : null);
    return { pid: number(columns[0] as string), lastExit: number(columns[1] as string) };
  }
  return null;
}

class LaunchctlError extends Error {}

const ok = (out: string[]): Report => ({ code: 0, out, err: [] });
const failed = (code: number, err: string[]): Report => ({ code, out: [], err });

/** The launchd implementation of `ServiceManager`. */
export class Launchd implements ServiceManager {
  readonly #options: LaunchdOptions;

  constructor(options: LaunchdOptions) {
    this.#options = options;
  }

  get #plist(): string {
    return plistPath(this.#options.home);
  }

  get #log(): string {
    return logPath(this.#options.home);
  }

  get #target(): string {
    return `gui/${this.#options.uid}/${LABEL}`;
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
    return listedJob(this.#launchctl(["list"]));
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
      const text = plistFor(program, this.#log);
      const written = existsSync(this.#plist) ? readFileSync(this.#plist, "utf8") : null;
      if (this.#job() !== null) {
        if (written === text) return ok([`${LABEL} is already installed and loaded.`]);
        return failed(1, [
          written === null
            ? `${LABEL} is loaded, and its plist ${this.#plist} is gone.`
            : `${LABEL} is loaded with another definition (${this.#plist}).`,
          `\`awaydesk service uninstall\` then \`awaydesk service install\` replaces it; the uninstall ends turns still running after ${EXIT_TIMEOUT_SECONDS} seconds.`,
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
      return ok([
        `Wrote ${this.#plist}.`,
        `Loaded ${LABEL}: awaydesk starts now and at every login.`,
        `Log: ${this.#log}`,
      ]);
    });
  }

  uninstall(): Report {
    return this.#guarded(() => {
      const loaded = this.#job() !== null;
      const present = existsSync(this.#plist);
      if (!loaded && !present) return ok([`${LABEL} is not installed.`]);
      const out: string[] = [];
      if (loaded) {
        // Returns once the daemon has exited: its drain is cut at `ExitTimeOut`.
        this.#launchctl(["bootout", this.#target]);
        out.push(`Stopped ${LABEL}.`);
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
          ? `${LABEL} is installed and not loaded: \`awaydesk service install\` loads it.`
          : `${LABEL} is not installed.`;
        return { code: 3, out: [line], err: [] };
      }
      if (job.pid !== null) {
        return ok([`${LABEL} is running, pid ${job.pid}.`, `Log: ${this.#log}`]);
      }
      const exit = job.lastExit === null ? "" : `; its last exit status was ${job.lastExit}`;
      return {
        code: 3,
        out: [`${LABEL} is loaded and not running${exit}.`, `Log: ${this.#log}`],
        err: [],
      };
    });
  }

  restart(): Report {
    return this.#guarded(() => {
      const job = this.#job();
      if (job === null) {
        return failed(1, [`${LABEL} is not loaded: \`awaydesk service install\` starts it.`]);
      }
      if (job.pid === null) {
        return failed(1, [
          `${LABEL} is not running; launchd starts it again on its own. Its log says why it stopped: ${this.#log}`,
        ]);
      }
      // Only sends the signal: the daemon lets running turns finish, exits, and `KeepAlive` starts
      // it again. `bootout` or `kickstart -k` would kill it after `ExitTimeOut`.
      this.#launchctl(["kill", "TERM", this.#target]);
      return ok([
        `Sent SIGTERM to ${LABEL} (pid ${job.pid}): running turns finish first, then launchd starts it again.`,
      ]);
    });
  }
}
