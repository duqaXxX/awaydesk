import assert from "node:assert/strict";
import { test } from "node:test";
import { plainWords } from "../../../../src/chat/slack/reply/markdown.ts";

// The pattern `plainWords` read a labelled link with until issue #241, kept here as the
// definition of the result: quadratic on a run of `<`, and right on every input.
const LABELLED_BEFORE = /<[^|>]*\|([^>]*)>/g;

/** Every string of `length` characters over `alphabet`. */
function* strings(alphabet: string, length: number): Generator<string> {
  if (length === 0) {
    yield "";
    return;
  }
  for (const head of strings(alphabet, length - 1)) {
    for (const char of alphabet) yield head + char;
  }
}

test("a labelled link reads as its label, on every arrangement of its three marks", () => {
  // A label kept, dropped or cut shows in the words. Seven characters reach two links in a
  // row, a link in a link and a mark left open. With these six characters the words of a text
  // are its runs of letters, which is all the rest of `plainWords` has to do here.
  const alphabet = "<|>a b";
  let differing: string | null = null;
  for (let length = 0; length <= 7 && differing === null; length += 1) {
    for (const text of strings(alphabet, length)) {
      const words = text.replace(LABELLED_BEFORE, "$1").match(/[ab]+/g) ?? [];
      if (plainWords(text) !== words.join(" ")) {
        differing = text;
        break;
      }
    }
  }
  assert.equal(differing, null);
});

test("a link reads as its label and the text around it stays", () => {
  assert.equal(plainWords("see <https://example.com/a|the page> now"), "see the page now");
  assert.equal(plainWords("<a|>b"), "b"); // an empty label
  assert.equal(plainWords("x <a<b|label> y"), "x label y"); // the first `<` opens the link
  assert.equal(plainWords("one <two|three"), plainWords("one two three")); // never closed
});

for (const [name, text] of [
  ["a run of <", "<".repeat(200_000)],
  ["a run of <|", "<|".repeat(100_000)],
  ["a run of < closed once", `${"<".repeat(200_000)}>`],
  ["a run of <| closed once", `${"<|".repeat(100_000)}>`],
] as const) {
  test(`a text read back takes a time linear in its length [${name}]`, () => {
    // Issue #241, measured 2026-10-11 on Node 26.5.1: 62 ms at 12,000 `<` and 660 ms at 40,000,
    // on the event loop every thread shares. At this length the pattern of then takes seconds.
    const began = performance.now();
    plainWords(text);
    assert.ok(performance.now() - began < 500);
  });
}
