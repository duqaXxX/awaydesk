/**
 * Step 8 of the scenario the memory chat carries: a message, a click and a form from another
 * user never reach the core. The plain agent and the memory chat are selected through the
 * configuration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("a message, a click and a form from another user never reach the core", {
  skip: "track 1d writes and enables it",
}, () => {
  assert.fail("not written yet");
});
