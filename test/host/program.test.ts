import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { findOnPath, programOf, servicePath } from "../../src/host/program.ts";

// Executable bits and symlinks: not on Windows, where the service does not exist yet.
const POSIX = { skip: process.platform === "win32" };

function folder(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "awaydesk-program-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function executable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

test("the first executable node on PATH is found, skipping a file that cannot run", POSIX, (t) => {
  const root = folder(t);
  writeFileSync(join(root, "node"), "not executable");
  chmodSync(join(root, "node"), 0o644);
  mkdirSync(join(root, "dir", "node"), { recursive: true });
  executable(join(root, "a", "node"));
  executable(join(root, "b", "node"));
  const path = [
    root,
    "",
    join(root, "missing"),
    join(root, "dir"),
    join(root, "a"),
    join(root, "b"),
  ].join(delimiter);
  assert.equal(findOnPath("node", path), join(root, "a", "node"));
  assert.equal(findOnPath("node", join(root, "missing")), null);
});

test("a global install names npm's bin folder and the real entry", POSIX, (t) => {
  const prefix = folder(t);
  const main = join(prefix, "lib", "node_modules", "awaydesk", "dist", "main.js");
  executable(main);
  mkdirSync(join(prefix, "bin"));
  symlinkSync(main, join(prefix, "bin", "awaydesk"));
  executable(join(prefix, "node-bin", "node"));
  const program = programOf(join(prefix, "bin", "awaydesk"), join(prefix, "node-bin"), "/x/node");
  assert.equal(program.node, join(prefix, "node-bin", "node"));
  assert.equal(program.main, realpathSync(main));
  assert.equal(program.npmBin, join(realpathSync(prefix), "bin"));
});

test("a run from a checkout has no npm bin, and Node falls back to the running one", POSIX, (t) => {
  const root = folder(t);
  const main = join(root, "awaydesk", "src", "main.ts");
  executable(main);
  const program = programOf(main, join(root, "nowhere"), "/usr/local/bin/node");
  assert.equal(program.npmBin, null);
  assert.equal(program.node, "/usr/local/bin/node");
});

test("the service PATH starts with Node's folder, then npm's, without repeats", () => {
  const program = { node: "/opt/homebrew/bin/node", main: "/m.js", npmBin: "/u/.local/bin" };
  assert.equal(
    servicePath(program, ["/opt/homebrew/bin", "/usr/bin"]),
    "/opt/homebrew/bin:/u/.local/bin:/usr/bin",
  );
  assert.equal(
    servicePath({ ...program, npmBin: null }, ["/usr/bin"]),
    "/opt/homebrew/bin:/usr/bin",
  );
});
