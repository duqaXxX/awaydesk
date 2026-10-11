/**
 * Step 5 of the scenario the memory chat carries: the daemon's words, typed as messages. The plain agent and the memory chat are selected through the
 * configuration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("!status, !stop and !help answer where they were typed", {
  skip: "track 2a writes and enables it",
}, () => {
  assert.fail("not written yet");
});

test("!bypass is refused by an agent with one permission mode", {
  skip: "track 2a writes and enables it",
}, () => {
  assert.fail("not written yet");
});

test("!bind binds the channel and !resume resumes a session", {
  skip: "track 2c writes and enables it",
}, () => {
  assert.fail("not written yet");
});
