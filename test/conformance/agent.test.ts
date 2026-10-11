/**
 * The conformance suite of the agent seam, run against every back end: the Claude back end over
 * its fake query, and the plain agent of the tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("the Claude back end conforms to the agent seam", {
  skip: "track 1a writes and enables it",
}, () => {
  assert.fail("not written yet");
});

test("the plain agent conforms to the agent seam", {
  skip: "track 1a writes and enables it",
}, () => {
  assert.fail("not written yet");
});
