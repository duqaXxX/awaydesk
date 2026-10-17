/**
 * The Node floor, and the entry that enforces it. An ES module graph is linked whole before any
 * module runs, so a named import an old Node lacks (`parseEnv` of `node:util` on Node 18) fails at
 * link time, before any guard in the graph can run (measured on 2026-10-17, Node 18.19.0). The
 * entry, `main.ts`, therefore has no static import, and the modules it loads before it knows the
 * Node is new enough import nothing a Node 18 lacks.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { MINIMUM_NODE, nodeRefusal } from "../src/node-version.ts";
import { SETUP_SECTIONS, setupGuide } from "../src/version.ts";
import { blank } from "./support/source-scan.ts";

const ROOT = join(import.meta.dirname, "..");

test("the minimum is the one package.json asks npm for", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  };
  assert.equal(manifest.engines.node, `>=${MINIMUM_NODE}`);
});

test("a version below the minimum is refused with both versions named", () => {
  assert.equal(
    nodeRefusal("18.19.0"),
    `awaydesk needs Node ${MINIMUM_NODE} or later and this is Node 18.19.0; to run it on a newer Node without changing this one, see ${setupGuide(SETUP_SECTIONS.nodeOfItsOwn)}`,
  );
});

test("the minimum and every version above it are accepted", () => {
  for (const version of [MINIMUM_NODE, "22.11.1", "22.18.0", "22.23.1", "23.0.0", "26.5.1"]) {
    assert.equal(nodeRefusal(version), null, version);
  }
});

test("versions are compared as numbers, not as text", () => {
  // As text "100.0.0" sorts before "22.11.0"; as numbers it is above.
  assert.equal(nodeRefusal("100.0.0"), null);
  assert.equal(nodeRefusal("22.100.0"), null);
  assert.notEqual(nodeRefusal("22.9.0"), null);
  assert.notEqual(nodeRefusal("22.10.9"), null);
});

test("a lower major is refused whatever its minor", () => {
  for (const version of ["21.7.3", "20.19.5", "18.20.4", "9.99.99"]) {
    assert.notEqual(nodeRefusal(version), null, version);
  }
});

test("a pre-release of a supported version is accepted", () => {
  assert.equal(nodeRefusal("22.11.0-rc.1"), null);
  assert.equal(nodeRefusal("24.0.0-nightly20260101"), null);
});

test("a version it cannot read is not refused", () => {
  assert.equal(nodeRefusal("unknown"), null);
  assert.equal(nodeRefusal(""), null);
});

/** The entry run by this Node with `process.versions.node` set to `version` before it loads. */
function runAs(version: string, home: string) {
  const fake = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${version}"})`;
  return spawnSync(process.execPath, ["--import", fake, join(ROOT, "src", "main.ts")], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
}

test("the entry on an old Node prints one refusal and exits 1, before the daemon loads", (t) => {
  // `HOME` holds no `.env`: were the daemon reached, the line would be about the missing file.
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runAs("18.19.0", home);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3} ERROR awaydesk\\.main: awaydesk needs Node ${MINIMUM_NODE.replaceAll(".", "\\.")} or later and this is Node 18\\.19\\.0; to run it on a newer Node without changing this one, see https://github\\.com/duqaXxX/awaydesk/blob/v\\d+\\.\\d+\\.\\d+/docs/setup\\.md#a-node-of-its-own\\n$`,
    ),
  );
  assert.equal(result.stdout, "");
});

test("the entry on the minimum Node goes on to the daemon", (t) => {
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runAs(MINIMUM_NODE, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env does not exist/);
});

/** The specifiers a source text imports or re-exports statically (a `import(` call is not one). */
function staticImports(source: string): string[] {
  const code = blank(source, { keepText: true });
  const pattern = /^[ \t]*(?:import\s*|(?:import|export)\b[^;'"`]*?\bfrom\s*)["']([^"']+)["']/gm;
  return [...code.matchAll(pattern)].map((match) => match[1] as string);
}

test("the scan reads a static import and a re-export, and not a call or a type alias", () => {
  const source = [
    'import a from "one";',
    'import type { B } from "two";',
    'import { c,\n  d } from "three";',
    'import "four";',
    'export { e } from "five";',
    'export type Level = "DEBUG" | "INFO";',
    'const f = await import("six");',
  ].join("\n");
  assert.deepEqual(staticImports(source), ["one", "two", "three", "four", "five"]);
});

test("the entry has no static import", () => {
  const source = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
  assert.deepEqual(staticImports(source), []);
});

test("what the entry loads before it knows the Node is new enough links on Node 18", () => {
  // `node-version.ts`, `version.ts` and `log.ts` are loaded on every Node. Their whole static
  // graph may name `node:fs` and each other: a named import of anything a Node 18 lacks would
  // fail at link time, which is the defect the entry exists to avoid.
  const allowed = new Set(["node:fs"]);
  const seen = new Set<string>();
  const queue = ["node-version.ts", "log.ts"].map((file) => join(ROOT, "src", file));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        assert.ok(existsSync(target), `${specifier} from ${file}`);
        queue.push(target);
      } else {
        assert.ok(allowed.has(specifier), `${file} imports ${specifier}, which a Node 18 may lack`);
      }
    }
  }
  assert.deepEqual([...seen].map((file) => file.slice(ROOT.length + 5)).sort(), [
    "log.ts",
    "node-version.ts",
    "version.ts",
  ]);
});
