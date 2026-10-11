import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { relativeTo } from "../../../../src/chat/slack/openfile/paths.ts";

test("a path is relative to a root when it lies under it, the root itself included", () => {
  // Built with the system's separator: the answer is a path of this system.
  const root = resolve("a", "b");
  assert.equal(relativeTo(root, join(root, "c", "d")), join("c", "d"));
  assert.equal(relativeTo(root, root), "");
  assert.equal(relativeTo(root, `${root}c`), null);
  assert.equal(relativeTo(root, resolve("a")), null);
  assert.equal(relativeTo(root, join(root, "..hidden")), "..hidden");
});
