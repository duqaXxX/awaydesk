/**
 * Step 6 of the scenario the memory chat carries: a second thread in the same folder while the
 * first works is held, then released. The plain agent and the memory chat are selected through the
 * configuration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("a second thread in the same folder is held, then released", {
  skip: "track 2c writes and enables it",
}, () => {
  assert.fail("not written yet");
});
