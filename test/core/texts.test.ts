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
