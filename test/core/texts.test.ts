import assert from "node:assert/strict";
import { test } from "node:test";
import * as slackTexts from "../../src/chat/slack/texts.ts";
import * as texts from "../../src/core/texts.ts";
import { NAMES } from "../support/names.ts";

test("fill takes a number for a field", () => {
  assert.equal(
    texts.fill(texts.named(slackTexts.UPLOAD_TOO_MANY, NAMES), { count: 12, limit: 5 }),
    "Nothing was sent to Claude: the message has 12 images, over the 5 one message takes.",
  );
  assert.equal(texts.fill("{count} of {count}", { count: 3 }), "3 of 3");
});

test("fill refuses a field with no value, as format raised a KeyError", () => {
  assert.throws(() => texts.fill(texts.named(texts.BIND_LIST, NAMES), {}), /\{root\}/);
});

test("fill leaves a value that holds braces alone", () => {
  assert.equal(texts.fill("{a}{b}", { a: "{b}", b: "x" }), "{b}x");
});

// What an agent that keeps a record of trust reads is quoted in docs/setup.md: these are the
// words as the owner sees them with Claude.
test("the notice of an unbound channel and the !bind help line keep their words for an agent with trust", () => {
  assert.equal(
    texts.fill(texts.named(texts.UNBOUND, NAMES), { root: "/work" }),
    "This channel is not bound to a folder yet. Send `!bind` to choose one of the folders " +
      "Claude Code trusts, or `!bind <folder>` with the folder's path relative to `/work`, for " +
      "example `!bind my-project`. `!guide` explains how awaydesk works.",
  );
  const bind = texts.HELP_WORDS.map((word) => texts.named(word, NAMES)).find((line) =>
    line.startsWith("`!bind"),
  );
  assert.equal(
    bind,
    "`!bind [folder]` the folders Claude Code trusts, or bind this channel to one, its path " +
      "relative to the allowed root; in the channel, refused inside a thread",
  );
});

test("for an agent with no record of trust the same two texts say nothing of trust", () => {
  const unbound = texts.fill(texts.UNBOUND_ANY, { root: "/work" });
  assert.ok(unbound.includes("the folders under `/work`") && !unbound.includes("trust"));
  const words = texts.HELP_WORDS_ANY.map((word) => texts.named(word, NAMES));
  assert.equal(words.length, texts.HELP_WORDS.length);
  assert.ok(!words.some((line) => line.includes("trust")));
  // Only the `!bind` line differs.
  const claude = texts.HELP_WORDS.map((word) => texts.named(word, NAMES));
  assert.deepEqual(
    words.filter((line, at) => line !== claude[at]),
    [
      "`!bind [folder]` the folders under the allowed root, or bind this channel to one, its path relative to that root; in the channel, refused inside a thread",
    ],
  );
});
