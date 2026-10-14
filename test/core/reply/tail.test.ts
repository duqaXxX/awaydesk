/** Where a thread's list of what still runs sits, as a pure function of the order. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLast, isOvertaken, type TailEntry, tails } from "../../../src/core/reply/tail.ts";

const entry = (key: string, at: number, resting: boolean): TailEntry<string> => ({
  key,
  at,
  resting,
});

test("one resting reply holds the list", () => {
  assert.deepEqual(tails([entry("a", 5, true)]).get("a"), { running: true });
});

test("two resting replies: the lower holds the list", () => {
  const result = tails([entry("a", 5, true), entry("b", 9, true)]);
  assert.deepEqual(result.get("a"), { running: false });
  assert.deepEqual(result.get("b"), { running: true });
});

test("the order of the entries does not matter, only where their messages sit", () => {
  const result = tails([entry("b", 9, true), entry("a", 5, true)]);
  assert.deepEqual(result.get("a"), { running: false });
  assert.deepEqual(result.get("b"), { running: true });
});

test("a lower reply that is not resting leaves the list on the upper one", () => {
  const result = tails([entry("a", 5, true), entry("b", 9, false)]);
  assert.deepEqual(result.get("a"), { running: true });
  assert.deepEqual(result.get("b"), { running: false });
});

test("no resting reply yields no list", () => {
  const result = tails([entry("a", 5, false), entry("b", 9, false)]);
  assert.deepEqual(result.get("a"), { running: false });
  assert.deepEqual(result.get("b"), { running: false });
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
  assert.equal(tails([]).size, 0);
});
