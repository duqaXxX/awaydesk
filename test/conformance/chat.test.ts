/**
 * The conformance suite of the chat seam, run against every provider: the Slack provider over
 * its fake client, and the memory chat of the tests. It includes the owner check: a message, a
 * click and a form from someone else never arrive.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("the Slack provider conforms to the chat seam", {
  skip: "track 1d writes and enables it",
}, () => {
  assert.fail("not written yet");
});

test("the memory chat conforms to the chat seam", {
  skip: "track 1d writes and enables it",
}, () => {
  assert.fail("not written yet");
});
