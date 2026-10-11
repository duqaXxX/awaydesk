/**
 * The words of one module stay in that module. Outside the Claude back end, the Slack provider
 * and the registry, no identifier and no string of the source names an agent, a chat or what
 * only one of them has: the core and the seams are written for any agent and any chat.
 * Comments are exempt: they may say what was measured, and on what.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { blank } from "./support/source-scan.ts";

const SRC = join(import.meta.dirname, "..", "src");

// Matched whatever the case, anywhere in an identifier or a string.
export const WORDS = [
  "claude",
  "anthropic",
  "slack",
  "bolt",
  "threadTs",
  "mrkdwn",
  "modal",
  "ephemeral",
  "emoji",
];

/** Where the words belong: a path under `src/` with forward slashes, or a folder of it. */
export const HOMES = ["agent/claude/", "chat/slack/", "registry.ts"];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Each word of `WORDS` in `source` outside a comment, as `line: word`. */
export function named(source: string): string[] {
  const found: string[] = [];
  const lines = blank(source, { keepText: true }).toLowerCase().split("\n");
  for (const [index, line] of lines.entries()) {
    for (const word of WORDS) {
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

test("no source file outside the two modules and the registry names an agent or a chat", {
  skip: "stage 3 enables it, once every flow and every text has moved",
}, () => {
  const found: string[] = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).split(sep).join("/");
    if (HOMES.some((home) => file === home || file.startsWith(home))) continue;
    for (const hit of named(readFileSync(path, "utf8"))) found.push(`${file}:${hit}`);
  }
  assert.deepEqual(found, []);
});
