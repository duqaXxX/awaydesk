/**
 * The Node floor. Below 22.18 `import.meta.main` is undefined, so `main` never ran and the
 * command ended with status 0 and no output (measured on 2026-10-11 with Node 22.17.0): the entry
 * refuses an older Node by its version, which every Node reports.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MINIMUM_NODE, nodeRefusal } from "../src/node-version.ts";

const ROOT = join(import.meta.dirname, "..");

test("the minimum is the one package.json asks npm for", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  };
  assert.equal(manifest.engines.node, `>=${MINIMUM_NODE}`);
});

test("a version below the minimum is refused with both versions named", () => {
  assert.equal(
    nodeRefusal("22.17.0"),
    `awaydesk needs Node ${MINIMUM_NODE} or later and this is Node 22.17.0; see docs/setup.md, Requirements`,
  );
});

test("the minimum and every version above it are accepted", () => {
  for (const version of ["22.18.0", "22.18.1", "22.19.0", "22.23.1", "23.0.0", "26.5.1"]) {
    assert.equal(nodeRefusal(version), null, version);
  }
});

test("versions are compared as numbers, not as text", () => {
  // As text "22.9.0" sorts after "22.18.0"; as numbers it is below.
  assert.notEqual(nodeRefusal("22.9.0"), null);
  assert.notEqual(nodeRefusal("22.2.5"), null);
  assert.equal(nodeRefusal("100.0.0"), null);
});

test("a lower major is refused whatever its minor", () => {
  for (const version of ["20.19.5", "21.7.3", "18.20.4", "9.99.99"]) {
    assert.notEqual(nodeRefusal(version), null, version);
  }
});

test("a pre-release of a supported version is accepted", () => {
  assert.equal(nodeRefusal("22.18.0-rc.1"), null);
  assert.equal(nodeRefusal("24.0.0-nightly20260101"), null);
});

test("a version it cannot read is not refused", () => {
  assert.equal(nodeRefusal("unknown"), null);
  assert.equal(nodeRefusal(""), null);
});

/** `file` run by this Node with `process.versions.node` set to `version` before it loads. */
function runAs(version: string, file: string, home: string) {
  const fake = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${version}"})`;
  return spawnSync(process.execPath, ["--import", fake, join(ROOT, "src", file)], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
}

test("the entry on an old Node prints one refusal and exits 1, before its imports run", (t) => {
  // `HOME` holds no `.env`: were `main` reached, the line would be about the missing file.
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runAs("22.17.0", "main.ts", home);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} ERROR awaydesk\.main: awaydesk needs Node 22\.18\.0 or later and this is Node 22\.17\.0; see docs\/setup\.md, Requirements\n$/,
  );
});

test("importing the guard on a supported Node prints nothing and leaves the process alone", (t) => {
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runAs("22.18.0", "require-node.ts", home);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});
