/** Where a thread's footer and its list of what still runs sit, as a pure function of the order. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLast, isOvertaken, type TailEntry, tails } from "../../../src/core/reply/tail.ts";

const entry = (
  key: string,
  at: number,
  resting: boolean,
  footer: string | null = `f-${key}`,
): TailEntry<string, string> => ({ key, at, resting, footer });

test("one resting reply holds its own footer and the list", () => {
  const result = tails([entry("a", 5, true)], []);
  assert.deepEqual(result.get("a"), { footer: "f-a", running: true });
});

test("two resting replies in one stretch: the lower holds the footer and the list", () => {
  const result = tails([entry("a", 5, true), entry("b", 9, true)], []);
  assert.deepEqual(result.get("a"), { footer: null, running: false });
  assert.deepEqual(result.get("b"), { footer: "f-b", running: true });
});

test("an owner mark between two resting replies: both hold a footer, only the lower the list", () => {
  const result = tails([entry("a", 5, true), entry("b", 9, true)], [7]);
  assert.deepEqual(result.get("a"), { footer: "f-a", running: false });
  assert.deepEqual(result.get("b"), { footer: "f-b", running: true });
});

test("a lower reply that is not resting leaves the footer and the list on the upper one", () => {
  const result = tails([entry("a", 5, true), entry("b", 9, false)], []);
  assert.deepEqual(result.get("a"), { footer: "f-a", running: true });
  assert.deepEqual(result.get("b"), { footer: null, running: false });
});

test("a lower resting reply with no footer shows the upper one's footer", () => {
  const result = tails([entry("a", 5, true), entry("b", 9, true, null)], []);
  assert.deepEqual(result.get("a"), { footer: null, running: false });
  assert.deepEqual(result.get("b"), { footer: "f-a", running: true });
});

test("three replies where the middle has the only footer: the lowest shows it", () => {
  const result = tails(
    [entry("a", 3, true, null), entry("b", 6, true), entry("c", 9, true, null)],
    [],
  );
  assert.deepEqual(result.get("a"), { footer: null, running: false });
  assert.deepEqual(result.get("b"), { footer: null, running: false });
  assert.deepEqual(result.get("c"), { footer: "f-b", running: true });
});

test("a stretch with no resting entry yields no footer and no list", () => {
  const result = tails([entry("a", 5, false), entry("b", 9, false)], []);
  assert.deepEqual(result.get("a"), { footer: null, running: false });
  assert.deepEqual(result.get("b"), { footer: null, running: false });
});

test("isLast is false with an owner mark below, false with a reply below, true otherwise", () => {
  assert.equal(isLast(5, [], [8]), false);
  assert.equal(isLast(5, [8], []), false);
  assert.equal(isLast(5, [2], [3]), true);
  assert.equal(isLast(5, [], []), true);
});

test("isOvertaken is true only with a reply below", () => {
  assert.equal(isOvertaken(5, [8]), true);
  assert.equal(isOvertaken(5, [2]), false);
  assert.equal(isOvertaken(5, []), false);
});

test("an empty input returns an empty map", () => {
  assert.equal(tails([], [3]).size, 0);
});
