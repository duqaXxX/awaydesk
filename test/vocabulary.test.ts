/**
 * The words of one module stay in that module. Outside the modules (a directory under
 * `src/agent/` or `src/chat/`) and the registry, no identifier and no string of the source names
 * an agent, a chat or what only one of them has: the core and the seams are written for any agent
 * and any chat. A module's own name is one of the words, and its directory one of the homes, from
 * the directories themselves. Comments are exempt: they may say what was measured, and on what.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { blank } from "./support/source-scan.ts";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * The directories of the modules under a `src/` folder, as `agent/<name>/` and `chat/<name>/`
 * with forward slashes.
 */
export function moduleDirectories(src: string): string[] {
  return ["agent", "chat"].flatMap((layer) =>
    readdirSync(join(src, layer), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${layer}/${entry.name}/`),
  );
}

// What only one module has, besides its name: its libraries and what its chat or agent calls things.
const MODULE_WORDS = ["anthropic", "bolt", "threadTs", "mrkdwn", "modal", "ephemeral", "emoji"];

/** The words of the modules under `src`: the name of each, and `MODULE_WORDS`. */
export function wordsOf(src: string): string[] {
  const names = moduleDirectories(src).map((home) => home.split("/")[1] as string);
  return [...names, ...MODULE_WORDS];
}

// Matched whatever the case, anywhere in an identifier or a string.
export const WORDS = wordsOf(SRC);

/** Where the words belong: a path under `src/` with forward slashes, or a folder of it. */
export const HOMES = [...moduleDirectories(SRC), "registry.ts"];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Each word of `WORDS` in `source` outside a comment, as `line: word`. */
export function named(source: string, words: readonly string[] = WORDS): string[] {
  const found: string[] = [];
  const lines = blank(source, { keepText: true }).toLowerCase().split("\n");
  for (const [index, line] of lines.entries()) {
    for (const word of words) {
      if (line.includes(word.toLowerCase())) found.push(`${index + 1}: ${word}`);
    }
  }
  return found;
}

test("the scan finds a word in an identifier and in a string, and not in a comment", () => {
  assert.deepEqual(named("const threadTs = 1;"), ["1: threadTs"]);
  assert.deepEqual(named('say("Opened in Slack");'), ["1: slack"]);
  // A template's expression is code: the word is found there too.
  assert.deepEqual(named(["say(`a $", "{modalTitle} b`);"].join("")), ["1: modal"]);
  assert.deepEqual(named("// Slack limits a block\nconst limit = 50; /* an emoji */"), []);
  assert.deepEqual(named('const url = "https://example.test"; // claude'), []);
});

test("the homes and the words come from the module directories, whatever their names", () => {
  const src = mkdtempSync(join(tmpdir(), "awaydesk-vocabulary-"));
  for (const directory of ["agent/codex", "agent/claude", "chat/discord", "core"]) {
    mkdirSync(join(src, directory), { recursive: true });
  }
  writeFileSync(join(src, "agent", "seam.ts"), "");
  writeFileSync(join(src, "chat", "seam.ts"), "");
  assert.deepEqual(moduleDirectories(src).toSorted(), [
    "agent/claude/",
    "agent/codex/",
    "chat/discord/",
  ]);
  const words = wordsOf(src);
  for (const name of ["codex", "claude", "discord"]) assert.ok(words.includes(name), name);
  assert.deepEqual(named("const discordThread = 1; const codexSession = 2;", words), [
    "1: codex",
    "1: discord",
  ]);
  assert.deepEqual(named("const thread = 1;", words), []);
});

test("the directories of this repository are the modules it has", () => {
  assert.deepEqual(HOMES.slice(-1), ["registry.ts"]);
  assert.ok(HOMES.includes("agent/claude/") && HOMES.includes("chat/slack/"));
  assert.ok(WORDS.includes("claude") && WORDS.includes("slack"));
});

test("no source file outside the modules and the registry names an agent or a chat", () => {
  const found: string[] = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).split(sep).join("/");
    if (HOMES.some((home) => file === home || file.startsWith(home))) continue;
    for (const hit of named(readFileSync(path, "utf8"))) found.push(`${file}:${hit}`);
  }
  assert.deepEqual(found, []);
});
