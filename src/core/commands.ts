/**
 * Commands typed as messages: `!word`. A few words are awaydesk's own; any other
 * `!name args` is a Claude Code command, so a command a new Claude Code release adds works at once.
 *
 * Slack never delivers a message that starts with `/` to the bot (measured 2026-09-23), so
 * Claude Code's own slash is replaced by `!`, as the official Claude app for Slack does with its
 * `@Claude !word` commands.
 */
import type { CommandInfo } from "../agent/seam.ts";
import { compareCodePoints, PY_SPACE, strip } from "../text.ts";
import * as texts from "./texts.ts";

export interface Help {
  readonly kind: "help";
  /** Lowercase; empty lists everything. */
  readonly query: string;
}

export interface Bind {
  readonly kind: "bind";
  readonly path: string;
}

export interface Bypass {
  readonly kind: "bypass";
  readonly on: boolean;
}

export interface Status {
  readonly kind: "status";
}

export interface Stop {
  readonly kind: "stop";
}

export interface Resume {
  readonly kind: "resume";
  /** A session id or name; empty lists the sessions. */
  readonly target: string;
}

export interface Open {
  readonly kind: "open";
  /** A path or words in one; empty offers a picker. */
  readonly target: string;
}

export interface Guide {
  readonly kind: "guide";
}

export interface Passthrough {
  readonly kind: "passthrough";
  readonly text: string;
}

export interface Invalid {
  readonly kind: "invalid";
}

// The daemon's own words, answered without Claude Code; a Passthrough goes to the session.
// `WORD` names each one, and test/core/commands.test.ts checks that the guide (`!guide`) and
// `!help` explain every one: a new word cannot ship without its line in both.
export type Word = Help | Guide | Bind | Bypass | Status | Stop | Resume | Open | Invalid;
export type Command = Word | Passthrough;

/** The word each of the daemon's own commands is typed as; a new kind of `Word` fails to compile here. */
export const WORD = {
  help: "help",
  guide: "guide",
  bind: "bind",
  bypass: "bypass",
  status: "status",
  stop: "stop",
  resume: "resume",
  open: "open",
} as const satisfies Record<Exclude<Word["kind"], "invalid">, string>;

export const DESCRIPTION_LIMIT = 100;

// Claude Code's `/clear` starts a new session under any of its names (aliases `/reset` and `/new`:
// commands reference, code.claude.com/docs/en/commands, read 2026-10-02, and the list SDK 0.2.163
// reports), and one thread is one session: the daemon refuses each of them inside a thread, which
// is also the only place a session's commands are listed. Named here because a session rebuilt
// after a restart lists no command until it connects (`refusedInThread`).
export const NEW_SESSION_NAMES: ReadonlySet<string> = new Set(["clear", "reset", "new"]);

// Claude Code's `/login` and `/logout` act on the host's own login, which the daemon and every
// session run on: neither is ever sent to Claude Code, from the channel or from a thread, and
// each is answered with where it is done instead (`hostOnly`).
export const HOST_ONLY: ReadonlyMap<string, texts.Named> = new Map([
  ["login", texts.LOGIN_ON_HOST],
  ["logout", texts.LOGOUT_ON_HOST],
]);

// Python's whitespace, which `strip` and `split` follow, is not JavaScript's `\s` (`text.ts`).
const TRAILING = new RegExp(`[${PY_SPACE}]+$`);
const STARTS_WITH_SPACE = new RegExp(`^[${PY_SPACE}]`);
const WORD_AND_REST = new RegExp(`^([^${PY_SPACE}]+)(?:[${PY_SPACE}]+([\\s\\S]*))?$`);
const RUNS_OF_SPACE = new RegExp(`[${PY_SPACE}]+`);

/**
 * Map a `!word` message to the daemon's own command or a Claude Code passthrough; null when the
 * message is not a command at all.
 */
export function parseBang(text: string): Command | null {
  const stripped = strip(text);
  if (!stripped.startsWith("!")) return null;
  const body = stripped.slice(1);
  if (body === "" || STARTS_WITH_SPACE.test(body)) return null;
  // The word ends at any whitespace: a line break after it (a code block that follows the
  // word, a second line) separates it from its arguments as a space does.
  const split = WORD_AND_REST.exec(body);
  const word = split?.[1] ?? "";
  const rest = strip(split?.[2] ?? "");
  switch (word.toLowerCase()) {
    case "help":
      return { kind: "help", query: rest.toLowerCase() };
    case "guide":
      if (rest === "") return { kind: "guide" };
      break;
    case "bind":
      return { kind: "bind", path: rest }; // alone, it lists the folders a session can start in
    case "bypass":
      switch (rest.toLowerCase()) {
        case "on":
          return { kind: "bypass", on: true };
        case "off":
          return { kind: "bypass", on: false };
        default:
          return { kind: "invalid" };
      }
    case "status":
      if (rest === "") return { kind: "status" };
      break;
    case "stop":
      if (rest === "") return { kind: "stop" };
      break;
    case "resume":
      return { kind: "resume", target: rest };
    case "open":
      return { kind: "open", target: rest };
  }
  return { kind: "passthrough", text: strip(`${word} ${rest}`) };
}

/**
 * The daemon's words, then every command the session offers now (null: not bound yet) except
 * those its thread refuses (`refusedInThread`), keeping only the lines whose name or description
 * contains `query`, ignoring case. With no query, the rule that tells a command from a text comes
 * first. `escapeMarkdown` is the chat provider's escape for a markdown block; `names` fill the
 * texts that name the agent and the chat. An agent with no commands of its own
 * (`agentCommands` false) has none listed, and no line about where they are listed.
 */
export function helpText(
  commands: readonly CommandInfo[] | null,
  query: string,
  escapeMarkdown: (text: string) => string,
  names: texts.Names,
  agentCommands = true,
): string {
  const keep = (line: string): boolean => line.toLowerCase().includes(query.toLowerCase());
  const own = texts.HELP_WORDS.map((word) => texts.named(word, names)).filter(keep);
  const refused = refusedInThread(commands, agentCommands);
  const offered = (commands ?? []).filter((c) => !refused.has(c.name.toLowerCase()));
  const session = offered
    .toSorted((a, b) => compareCodePoints(a.name, b.name))
    .map((command) => commandParts(command, escapeMarkdown))
    .filter(([usage, description]) => keep(`${usage} ${description}`))
    .map(([usage, description]) => `${usage} ${escapeMarkdown(description)}`.replace(TRAILING, ""));
  // The rule heads the whole list; a search shows its matches alone.
  const lines = [texts.HELP_OWN, ...(query ? [] : [texts.HELP_RULE]), ...own];
  if (agentCommands && commands === null) {
    lines.push(texts.named(texts.HELP_UNBOUND, names));
  } else if (agentCommands) {
    lines.push(texts.named(texts.HELP_AGENT, names), ...session);
  }
  if (query && own.length === 0 && session.length === 0) {
    lines.push(texts.fill(texts.HELP_NO_MATCH, { query }));
  }
  return lines.join("\n");
}

/**
 * The answer to a command that is only ever run on the host (`HOST_ONLY`), or null for any other,
 * and for every one when the agent has no commands of its own (`agentCommands` false): the caller
 * sends that answer and nothing to Claude Code.
 */
export function hostOnly(
  command: Passthrough,
  names: texts.Names,
  agentCommands = true,
): string | null {
  if (!agentCommands) return null; // no command is the agent's, so none is run on the host
  const answer = HOST_ONLY.get((command.text.split(" ", 1)[0] as string).toLowerCase());
  return answer === undefined ? null : texts.named(answer, names);
}

/**
 * The command names a thread refuses, lowercase: `NEW_SESSION_NAMES`, with every alias the
 * session's own list (`commands`, null or empty before it connects) gives one of them. None
 * for an agent with no commands of its own (`agentCommands` false).
 */
export function refusedInThread(
  commands: readonly CommandInfo[] | null,
  agentCommands = true,
): ReadonlySet<string> {
  if (!agentCommands) return new Set(); // an agent with no commands of its own has none to refuse
  const aliases = (commands ?? [])
    .filter((command) => NEW_SESSION_NAMES.has(command.name.toLowerCase()))
    .flatMap((command) => command.aliases.map((alias) => alias.toLowerCase()));
  return new Set([...NEW_SESSION_NAMES, ...aliases]);
}

/**
 * `!name hint` and the description as written, cut to one short line; not escaped. The
 * description is third-party text, and a cut can fall inside its own code span: the caller
 * escapes it before showing it (`helpText`).
 */
export function commandParts(
  command: CommandInfo,
  escapeMarkdown: (text: string) => string,
): [usage: string, description: string] {
  const plain = `!${command.name} ${command.argumentHint}`.replace(TRAILING, "");
  // A code span cannot hold a backtick: such a usage is plain text, escaped.
  const usage = plain.includes("`") ? escapeMarkdown(plain) : `\`${plain}\``;
  let description = command.description
    .split(RUNS_OF_SPACE)
    .filter((word) => word !== "")
    .join(" ");
  // The cut counts code points: a unit-wise cut could split an emoji.
  const points = Array.from(description);
  if (points.length > DESCRIPTION_LIMIT) {
    description = `${points.slice(0, DESCRIPTION_LIMIT - 1).join("")}…`;
  }
  return [usage, description];
}
