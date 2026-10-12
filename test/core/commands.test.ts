import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandInfo } from "../../src/agent/seam.ts";
import {
  type Command,
  commandParts,
  helpText,
  hostOnly,
  parseBang,
  refusedInThread,
  WORD,
} from "../../src/core/commands.ts";
import { guideText } from "../../src/core/guide.ts";
import * as texts from "../../src/core/texts.ts";
import { sdkJson } from "../support/fixtures.ts";
import { EVERYTHING_OFFERED } from "../support/guide-offer.ts";
import { NAMES } from "../support/names.ts";
import { PLAIN_NAMES } from "./flows/messages-world.ts";

const CLEARS = NAMES.newSession;

/**
 * The chat provider's markdown escape, which the core takes as a parameter: the same characters
 * as `MARKDOWN_INLINE` in `src/chat/slack/reply/escape.ts` (Slack's markdown block reference,
 * read 2026-09-25).
 */
function markdownEscape(text: string): string {
  return text.replace(/([\\`*_{}[\]()&~])/g, "\\$1");
}

function helpOf(commands: readonly CommandInfo[] | null, query = ""): string {
  return helpText(commands, query, markdownEscape, NAMES);
}

/** A command as the session's list holds it: what the agent module makes of the SDK's raw entry. */
function command(
  name: string,
  description: string,
  extra: Partial<Omit<CommandInfo, "name" | "description">> = {},
): CommandInfo {
  return { name, description, argumentHint: "", aliases: [], ...extra };
}

/** The recorded server info's commands (SDK 0.2.163), as the session's list holds them. */
function recordedCommands(): CommandInfo[] {
  const info = sdkJson("server-info") as { commands: Record<string, unknown>[] };
  return info.commands.map((raw) =>
    command(String(raw.name), String(raw.description ?? ""), {
      argumentHint: String(raw.argumentHint ?? ""),
      aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String) : [],
    }),
  );
}

const parseCases: [string, Command | null][] = [
  ["!help", { kind: "help", query: "" }],
  ["!help Comp", { kind: "help", query: "comp" }],
  ["!bind ~/code/app", { kind: "bind", path: "~/code/app" }],
  ["!bind  /a b", { kind: "bind", path: "/a b" }],
  ["!bind", { kind: "bind", path: "" }], // alone: the folders a session can start in
  ["!bypass on", { kind: "bypass", on: true }],
  ["!bypass OFF", { kind: "bypass", on: false }],
  ["!open", { kind: "open", target: "" }], // alone: the picker
  ["!OPEN  setup ", { kind: "open", target: "setup" }],
  ["!open docs/my file.md", { kind: "open", target: "docs/my file.md" }],
  ["!bypass", { kind: "invalid" }],
  ["!bypass maybe", { kind: "invalid" }],
  ["!status", { kind: "status" }],
  ["  !stop", { kind: "stop" }],
  ["!compact", { kind: "passthrough", text: "compact" }],
  ["!status now", { kind: "passthrough", text: "status now" }],
  ["!important: read this", { kind: "passthrough", text: "important: read this" }],
  ["hello", null],
  ["!", null],
  ["! compact", null],
  ["!compact\nnotes", { kind: "passthrough", text: "compact notes" }], // the word ends at a line break too
  ["!stop\n", { kind: "stop" }],
  ["!model  opus ", { kind: "passthrough", text: "model opus" }],
];

for (const [text, expected] of parseCases) {
  test(`parse bang [${JSON.stringify(text)}]`, () => {
    assert.deepEqual(parseBang(text), expected);
  });
}

test("help lists the daemon words and every session command", () => {
  const commands = recordedCommands();
  const text = helpOf(commands);
  for (const word of ["!help", "!status", "!stop", "!bind", "!bypass", "!open"]) {
    assert.ok(text.includes(`\`${word}`), word);
  }
  assert.ok(commands.filter((c) => c.name !== "clear").every((c) => text.includes(`\`!${c.name}`)));
});

test("help leaves out the words the agent or the chat cannot serve", () => {
  const all = helpText(null, "", (text) => text, NAMES);
  const fewer = helpText(null, "", (text) => text, NAMES, true, new Set(["bypass", "open"]));
  assert.ok(all.includes("`!bypass on|off`") && all.includes("`!open [file]`"));
  assert.ok(!fewer.includes("`!bypass on|off`") && !fewer.includes("`!open [file]`"));
  // Every other line is there, as written.
  assert.deepEqual(
    all.split("\n").filter((line) => !line.startsWith("`!bypass") && !line.startsWith("`!open")),
    fewer.split("\n"),
  );
});

test("help speaks of trust in the !bind line only for an agent that keeps a record of it", () => {
  const bindLine = (text: string): string =>
    text.split("\n").find((line) => line.startsWith("`!bind")) ?? "";
  const trusting = helpText(null, "", (text) => text, NAMES);
  const open = helpText(null, "", (text) => text, NAMES, true, new Set(), false);
  assert.ok(bindLine(trusting).includes("trusts"));
  assert.ok(bindLine(open) !== "" && !bindLine(open).includes("trust"));
  assert.deepEqual(
    trusting.split("\n").filter((line) => !line.startsWith("`!bind")),
    open.split("\n").filter((line) => !line.startsWith("`!bind")),
  );
});

test("help says how a command is told from a text", () => {
  const commands = recordedCommands();
  for (const listed of [null, commands]) {
    // in the channel and inside a session's thread
    assert.equal(helpOf(listed).split("\n")[1], texts.HELP_RULE);
    assert.ok(!helpOf(listed, "status").includes(texts.HELP_RULE)); // a search lists matches only
  }
  assert.ok(texts.HELP_RULE.includes("`\\!goal`"));
});

test("help leaves out clear which a thread refuses", () => {
  // Issue #76: a session's commands are listed inside its thread only, where `!clear` is
  // refused. The recorded list (SDK 0.2.163) does carry it.
  const commands = recordedCommands();
  assert.ok(commands.some((c) => c.name === "clear"));
  assert.ok(!helpOf(commands).includes("`!clear"));
  assert.ok(helpOf(commands).includes("`!compact"));
});

test("a thread refuses clear and its aliases before the session lists them", () => {
  // A session rebuilt after a restart has listed no command until it connects.
  for (const listed of [[], null]) {
    const refused = refusedInThread(listed, CLEARS);
    for (const name of ["clear", "reset", "new"]) assert.ok(refused.has(name), name);
  }
});

test("a thread refuses an alias of clear the session adds", () => {
  const commands = [
    command("clear", "d", { aliases: ["reset", "new", "wipe"] }),
    command("rename", "d", { aliases: ["name"] }),
  ];
  const refused = refusedInThread(commands, CLEARS);
  assert.ok(refused.has("wipe"));
  assert.ok(!refused.has("name") && !refused.has("rename"));
});

test("help before binding says where the commands come from", () => {
  const text = helpOf(null);
  assert.ok(text.includes("`!bind") && !text.includes("`!compact"));
});

test("help filters by name or description", () => {
  const commands = [
    command("compact", "Free up context"),
    command("model", "Set the model", { argumentHint: "[model]" }),
  ];
  const text = helpOf(commands, "CONTEXT");
  assert.ok(text.includes("`!compact`") && !text.includes("`!model"));
  assert.ok(!text.includes("`!status`")); // daemon words are filtered too
  assert.ok(helpOf(commands, "stop").includes("`!stop`"));
});

test("help says when nothing matches", () => {
  const text = helpOf([command("compact", "x")], "zzz");
  assert.ok(text.includes(texts.fill(texts.HELP_NO_MATCH, { query: "zzz" })));
});

test("the guide and the help explain every word of the daemon", () => {
  // A word added without its line in the guide and in !help fails here, so neither goes stale.
  const words: string[] = Object.values(WORD);
  for (const expected of ["help", "guide", "bind", "bypass", "status", "stop", "resume", "open"]) {
    assert.ok(words.includes(expected), expected);
  }
  // A WORD the parser does not answer would document a word that reaches Claude instead.
  for (const word of words) assert.notEqual(parseBang(`!${word}`)?.kind, "passthrough", word);
  const guide = guideText(NAMES, EVERYTHING_OFFERED);
  const helpLines = texts.HELP_WORDS.map((line) => texts.named(line, NAMES)).join("\n");
  for (const word of words) {
    assert.ok(guide.includes(`\`!${word}`), word);
    assert.ok(helpLines.includes(`\`!${word}`), word);
  }
});

test("guide parses", () => {
  assert.deepEqual(parseBang("!guide"), { kind: "guide" });
  assert.deepEqual(parseBang("!GUIDE"), { kind: "guide" });
});

test("the help titles are bold in a markdown block", () => {
  // `!help` goes out as a markdown block, where bold is **text** and *text* is italic
  // (markdown block reference, read 2026-09-25).
  const text = helpOf([], "");
  assert.ok(text.startsWith("**awaydesk**") && text.includes("**Claude Code**"));
});

// /doctor's description in the bundled CLI 2.1.280, read 2026-09-25: the 100-character cut falls
// inside its code span.
const DOCTOR =
  "Health-check the user's Claude Code setup and fix issues: diagnose installation health " +
  "— what the `claude doctor` terminal diagnostics cover — from local data";

test("a description cannot leave formatting open", () => {
  const commands = [command("doctor", DOCTOR), command("model", "*x_")];
  const lines = helpOf(commands).split("\n");
  const doctor = lines.find((line) => line.startsWith("`!doctor`")) as string;
  const unescaped = doctor.slice("`!doctor`".length).match(/(?<!\\)[`*_]/g) ?? [];
  assert.deepEqual(unescaped, []); // shown as the terminal's menu shows it: plain text
  assert.equal(
    lines.find((line) => line.startsWith("`!model`")),
    "`!model` \\*x\\_",
  );
});

test("the filter reads the description as written", () => {
  const commands = [command("remote", "run a_b")];
  assert.ok(helpOf(commands, "a_b").includes("`!remote`"));
});

test("a hint with a backtick cannot break the line", () => {
  // A code span cannot hold a backtick: such a usage is shown escaped, as plain text.
  const text = helpOf([command("x", "d", { argumentHint: "[`file`]" })]);
  assert.ok(text.split("\n").includes("!x \\[\\`file\\`\\] d"));
});

test("a description is cut by code points, never inside an emoji", () => {
  const [, description] = commandParts(command("x", `${"a".repeat(98)}😀😀😀`), markdownEscape);
  assert.equal(description, `${"a".repeat(98)}😀…`);
});

test("login and logout are answered on the host, whatever their case", () => {
  assert.equal(
    hostOnly({ kind: "passthrough", text: "login" }, NAMES),
    texts.named(texts.LOGIN_ON_HOST, NAMES),
  );
  assert.equal(
    hostOnly({ kind: "passthrough", text: "LOGOUT now" }, NAMES),
    texts.named(texts.LOGOUT_ON_HOST, NAMES),
  );
  assert.equal(hostOnly({ kind: "passthrough", text: "compact" }, NAMES), null);
});

test("an agent with no commands of its own has none listed, refused or run on the host", () => {
  const listed = recordedCommands().slice(0, 2);
  const help = helpText(listed, "", markdownEscape, NAMES, false);
  // The daemon's own words and the rule that tells them from a text, and nothing of the agent's.
  assert.ok(help.includes(texts.HELP_OWN) && help.includes(texts.HELP_RULE));
  assert.ok(!help.includes(texts.named(texts.HELP_AGENT, NAMES)));
  assert.ok(listed.every((entry) => !help.includes(`!${entry.name}`)));
  assert.ok(
    !helpText(null, "", markdownEscape, NAMES, false).includes(
      texts.named(texts.HELP_UNBOUND, NAMES),
    ),
  );
  assert.deepEqual([...refusedInThread(null, CLEARS, false)], []);
  assert.equal(hostOnly({ kind: "passthrough", text: "login" }, NAMES, false), null);
  // The same calls for an agent that has them are as before.
  assert.ok(refusedInThread(null, CLEARS).has("clear"));
  assert.notEqual(hostOnly({ kind: "passthrough", text: "login" }, NAMES), null);
});

test("an agent's own new-session name is refused in a thread, with the aliases its list gives it", () => {
  const own = PLAIN_NAMES.newSession;
  assert.deepEqual([...refusedInThread(null, own)], ["restart"]);
  const listed = [command("restart", "d", { aliases: ["Again"] })];
  assert.deepEqual([...refusedInThread(listed, own)].sort(), ["again", "restart"]);
  // Claude Code's names mean nothing to an agent that does not declare them.
  assert.ok(!refusedInThread(null, own).has("clear"));
  assert.deepEqual([...refusedInThread(null, [])], []);
});

test("an agent's own login and logout are answered on the host, and Claude Code's are not its words", () => {
  assert.equal(
    hostOnly({ kind: "passthrough", text: "SignIn now" }, PLAIN_NAMES),
    texts.named(texts.LOGIN_ON_HOST, PLAIN_NAMES),
  );
  assert.equal(
    hostOnly({ kind: "passthrough", text: "signout" }, PLAIN_NAMES),
    texts.named(texts.LOGOUT_ON_HOST, PLAIN_NAMES),
  );
  assert.equal(hostOnly({ kind: "passthrough", text: "login" }, PLAIN_NAMES), null);
  assert.equal(hostOnly({ kind: "passthrough", text: "logout" }, PLAIN_NAMES), null);
});

test("an agent with no login or logout gets no host-only answer for that word", () => {
  const none = { ...PLAIN_NAMES, login: null, logout: null };
  assert.equal(hostOnly({ kind: "passthrough", text: "signin" }, none), null);
  assert.equal(hostOnly({ kind: "passthrough", text: "signout" }, none), null);
});

test("the host-only texts and the login failure name the agent's own commands", () => {
  const login = texts.named(texts.LOGIN_ON_HOST, PLAIN_NAMES);
  assert.ok(login.includes("`/signin`") && !login.includes("/login"));
  assert.ok(texts.named(texts.LOGOUT_ON_HOST, PLAIN_NAMES).includes("`/signout`"));
  assert.ok(texts.named(texts.AUTH_FAILED, PLAIN_NAMES).includes("`/signin`"));
  const none = { ...PLAIN_NAMES, login: null, logout: null };
  assert.ok(!texts.named(texts.AUTH_FAILED_NO_LOGIN, none).includes("/"));
});

test("the guide names the agent's own new-session commands, and leaves the sentence out with none", () => {
  const guide = guideText(PLAIN_NAMES, EVERYTHING_OFFERED);
  assert.ok(guide.includes("`!restart` is refused inside a thread"));
  assert.ok(!guide.includes("!clear"));
  const several = guideText({ ...PLAIN_NAMES, newSession: ["a", "b", "c"] }, EVERYTHING_OFFERED);
  assert.ok(several.includes("`!a` (`!b`, `!c`) is refused inside a thread"));
  const none = guideText({ ...PLAIN_NAMES, newSession: [] }, EVERYTHING_OFFERED);
  assert.ok(!none.includes("refused inside a thread"));
  assert.ok(none.includes("filters the list;"));
});
