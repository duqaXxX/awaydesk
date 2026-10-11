/**
 * Step 3 of the scenario the memory chat carries: the agent asks permission, the owner approves
 * and the tool runs; then one the owner denies. The plain agent and the memory chat are selected through the
 * configuration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("the owner approves a permission and the tool runs", {
  skip: "track 2b writes and enables it",
}, () => {
  assert.fail("not written yet");
});

test("the owner denies a permission and the tool does not run", {
  skip: "track 2b writes and enables it",
}, () => {
  assert.fail("not written yet");
});
