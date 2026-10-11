import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";

test("fill takes a number for a field", () => {
  assert.equal(
    texts.fill(texts.UPLOAD_TOO_MANY, { count: 12, limit: 5 }),
    "Nothing was sent to Claude: the message has 12 images, over the 5 one message takes.",
  );
  assert.equal(texts.fill("{count} of {count}", { count: 3 }), "3 of 3");
});

test("fill refuses a field with no value, as format raised a KeyError", () => {
  assert.throws(() => texts.fill(texts.BIND_LIST, {}), /\{root\}/);
});

test("fill leaves a value that holds braces alone", () => {
  assert.equal(texts.fill("{a}{b}", { a: "{b}", b: "x" }), "{b}x");
});
