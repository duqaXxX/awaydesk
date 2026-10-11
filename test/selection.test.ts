/**
 * The agent and the chat are selected, never constructed: `src/main.ts` reads two names from the
 * configuration and takes each module from a registry.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");

test("main imports neither a back end nor a provider", { skip: "track 1b enables it" }, () => {
  const source = readFileSync(MAIN, "utf8");
  const modules = [...source.matchAll(/from\s+"(\.\/(?:agent\/claude|chat\/slack)\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(modules, []);
});

test("the plain agent and the memory chat, named in the configuration, run a session", {
  skip: "track 1b writes and enables it, with the two test modules of tracks 1a and 1d",
}, () => {
  assert.fail("not written yet");
});

test("a name the registry does not hold stops the start with the valid ones", {
  skip: "track 1b writes and enables it",
}, () => {
  assert.fail("not written yet");
});
