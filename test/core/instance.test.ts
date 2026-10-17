/**
 * The instance: a name or none, the rule a name follows, and the folders that derive from it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  configDirOf,
  DEFAULT_INSTANCE,
  INSTANCE_VARIABLE,
  parseInstanceName,
  scratchDirOf,
} from "../../src/core/instance.ts";

const HOME = join("/h", "alice");
const TMP = join("/t", "alice");

test("a name is lowercase letters, digits and hyphens, starting with a letter or digit", () => {
  for (const name of ["dev", "work", "a", "0", "2nd-login", "a-b-c", "x".repeat(32)]) {
    assert.deepEqual(parseInstanceName(name), { name }, name);
  }
});

test("a name that breaks the rule is refused with a sentence that states the rule", () => {
  for (const name of ["", "Work", "-dev", "dev_1", "dev.1", "a b", "é", "x".repeat(33), "../x"]) {
    const parsed = parseInstanceName(name);
    assert.ok("refusal" in parsed, JSON.stringify(name));
    assert.match(parsed.refusal, /1 to 32 characters/);
    assert.ok(parsed.refusal.includes(JSON.stringify(name)), parsed.refusal);
  }
});

test("the name default is refused: it would read as the default instance", () => {
  const parsed = parseInstanceName("default");
  assert.ok("refusal" in parsed);
  assert.match(parsed.refusal, /"default"/);
  assert.match(parsed.refusal, /the default instance/);
});

test("the default instance keeps today's folders", () => {
  assert.equal(configDirOf(DEFAULT_INSTANCE, HOME), join(HOME, ".config", "awaydesk"));
  assert.equal(scratchDirOf(DEFAULT_INSTANCE, TMP), join(TMP, "awaydesk"));
});

test("a named instance has folders of its own beside the default's", () => {
  const work = { name: "work" };
  assert.equal(configDirOf(work, HOME), join(HOME, ".config", "awaydesk-work"));
  assert.equal(scratchDirOf(work, TMP), join(TMP, "awaydesk-work"));
});

test("the variable that selects an instance is AWAYDESK_INSTANCE", () => {
  assert.equal(INSTANCE_VARIABLE, "AWAYDESK_INSTANCE");
});
