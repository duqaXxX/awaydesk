/**
 * Step 7 of the scenario the memory chat carries: the daemon stops with a turn running and starts
 * again, and the thread says what was not sent. The plain agent and the memory chat are selected through the
 * configuration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("after a stop with a turn running, the next start says in the thread what was not sent", {
  skip: "track 2d writes and enables it",
}, () => {
  assert.fail("not written yet");
});
