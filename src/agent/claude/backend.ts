/**
 * The Claude back end: what the core asks of an agent, answered over the Agent SDK and over
 * Claude Code's own records on disk. The only module a caller builds; the trust gate for a
 * session's start is the core's (`folderTrusted` is its question to ask), not this class's.
 */
import { homedir } from "node:os";
import type { Clock } from "../../clock.ts";
import { shellQuote } from "../../text.ts";
import type {
  AgentBackend,
  AgentSession,
  AgentWords,
  ListedSession,
  Repository,
  RequestHandler,
  StartOptions,
  UsageLimits,
} from "../seam.ts";
import { CAPABILITIES } from "./capabilities.ts";
import { chromeEnabled } from "./chrome.ts";
import { aliveSessions, byLastActivity, directorySessions, projectsDir } from "./listing.ts";
import { ClaudeSession, type QueryFunction } from "./session.ts";
import { trustedRepository, workspaceTrusted } from "./trust.ts";
import { type BareStart, UsageProbe } from "./usage-probe.ts";

export const NAME = "Claude Code";

/** The shell line that forks a session in a terminal; `environment` is what precedes `claude`. */
function terminalWith(environment: string): string {
  return `cd {directory} && ${environment}claude --resume {session} --fork-session`;
}

export const WORDS: AgentWords = Object.freeze({
  author: "Claude",
  command: "claude",
  examples: "`!compact`, `!model opus`",
  // `/clear` starts a new session under any of its names (aliases `/reset` and `/new`: commands
  // reference, code.claude.com/docs/en/commands, read 2026-10-02, and the list SDK 0.2.163
  // reports); `/login` and `/logout` act on the host's own login.
  newSession: ["clear", "reset", "new"],
  login: "login",
  logout: "logout",
  terminal: terminalWith(""),
});

/**
 * `WORDS` for a back end whose sessions use the login in `configDir`: the line that continues a
 * session in a terminal names that folder, since a terminal reads `~/.claude` without it. The
 * folder is quoted for a shell as `{directory}` is; a brace in it is kept out of reach of the
 * template's fields, `'"{"'` being the same word to a shell.
 */
function wordsFor(configDir: string | undefined): AgentWords {
  if (configDir === undefined) return WORDS;
  const folder = shellQuote(configDir).replaceAll("{", `'"{"'`);
  return Object.freeze({ ...WORDS, terminal: terminalWith(`CLAUDE_CONFIG_DIR=${folder} `) });
}

export interface ClaudeBackendOptions {
  /** The SDK's `query`; a test passes a fake. */
  readonly query?: QueryFunction;
  /** The owner's home, where Claude Code keeps its record of trust and of Chrome. */
  readonly home?: string;
  /**
   * The folder of a login with its own (`CLAUDE_CONFIG_DIR`), absolute: the records and the
   * transcripts are read there. Absent, the daemon's environment's, else the owner's home. The
   * SDK's listing reads the environment alone, so a caller that gives a folder here has it there
   * too (the module writes it).
   */
  readonly configDir?: string;
  /** How the usage probe starts its session: `startBare`, unless a test gives another. */
  readonly bareStart?: BareStart;
  /** Every wait of the usage probe; the system clock when absent. */
  readonly clock?: Clock;
  /** The owner's own variables for Claude Code, which a thread's session is started with. */
  readonly variables?: Readonly<Record<string, string>>;
}

export class ClaudeBackend implements AgentBackend {
  readonly name = NAME;
  readonly words: AgentWords;
  readonly capabilities = CAPABILITIES;
  readonly #query: QueryFunction | undefined;
  readonly #home: string;
  readonly #variables: Readonly<Record<string, string>>;
  readonly #configDir: string | undefined;
  readonly #projects: string;
  readonly #probe: UsageProbe;

  constructor(options: ClaudeBackendOptions = {}) {
    this.#query = options.query;
    this.#home = options.home ?? homedir();
    this.#variables = options.variables ?? {};
    // An empty variable is no folder, as Claude Code reads it.
    this.#configDir = options.configDir ?? (process.env.CLAUDE_CONFIG_DIR || undefined);
    this.#projects = projectsDir(this.#configDir, this.#home);
    this.words = wordsFor(this.#configDir);
    const bare = options.bareStart ?? ((folder, requests) => this.startBare(folder, requests));
    this.#probe = new UsageProbe(this.#home, bare, { clock: options.clock });
  }

  /**
   * Starts Claude Code and returns once it answered. Rejects with `ResumeRefused` when it
   * refuses to resume `options.resume`, and with the failure itself when it cannot start.
   * Whether the owner trusted the folder is the caller's to check first (`folderTrusted`).
   */
  async start(options: StartOptions, requests: RequestHandler): Promise<AgentSession> {
    // Read at every start, so a change in `/chrome` holds from a session's next start.
    const chrome = await chromeEnabled(this.#home, this.#configDir);
    const session = new ClaudeSession(
      { ...options, chrome, variables: this.#variables },
      requests,
      this.#query,
    );
    await session.ready();
    return session;
  }

  /**
   * Starts a session for the daemon's own use, the usage probe's: the folder and no setting
   * source, without the permission to bypass and without the Chrome flag, which only a thread's
   * session is given. Fails as `start` does.
   */
  async startBare(folder: string, requests: RequestHandler): Promise<AgentSession> {
    const session = new ClaudeSession(
      {
        folder,
        resume: null,
        settingsSources: [],
        model: null,
        effort: null,
        chrome: false,
        bare: true,
      },
      requests,
      this.#query,
    );
    await session.ready();
    return session;
  }

  /** The sessions of `folder` alone, newest first by their files' times. */
  listSessions(folder: string): Promise<readonly ListedSession[]> {
    return directorySessions(folder);
  }

  /**
   * `sessions` of `folder` by their last message, newest first, as the terminal's picker shows
   * them. Dating reads files, so a caller that shows only some of a folder's sessions passes
   * those alone.
   */
  datedSessions(folder: string, sessions: readonly ListedSession[]): Promise<ListedSession[]> {
    return byLastActivity(folder, sessions, { projects: this.#projects });
  }

  /** The session ids alive in `folder`, or null when it cannot tell (the pruning keeps them). */
  aliveSessions(folder: string): Promise<ReadonlySet<string> | null> {
    return aliveSessions(folder, this.#projects);
  }

  folderTrusted(folder: string): Promise<boolean> {
    return workspaceTrusted(folder, this.#home, this.#configDir);
  }

  trustedRepository(folder: string): Promise<Repository | null> {
    return trustedRepository(folder, this.#home, this.#configDir);
  }

  /** The limits `/usage` reports now, read by a session of the back end's own. */
  usageLimits(): Promise<UsageLimits> {
    return this.#probe.read();
  }

  /** Stops the usage probe: its session is closed and no read starts another. */
  close(): Promise<void> {
    return this.#probe.stop();
  }
}
