import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { installedVersion } from "../../src/host/version.ts";

test("the version is the one package.json holds", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(installedVersion(), manifest.version);
});
