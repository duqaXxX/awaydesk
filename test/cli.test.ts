/**
 * The command line: no argument runs the daemon, `--version` and `--help` answer and end, anything
 * else is refused with the usage, so a mistyped argument never starts a daemon.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answer, type Output, parseArguments, USAGE } from "../src/cli.ts";

const ROOT = join(import.meta.dirname, "..");
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;

function captured(): Output & { stdout: string; stderr: string } {
  const output = {
    stdout: "",
    stderr: "",
    out: (text: string) => {
      output.stdout += text;
    },
    err: (text: string) => {
      output.stderr += text;
    },
  };
  return output;
}

test("no argument runs the daemon", () => {
  assert.deepEqual(parseArguments([]), { kind: "run" });
});

test("--version and --help are read, alone", () => {
  assert.deepEqual(parseArguments(["--version"]), { kind: "version" });
  assert.deepEqual(parseArguments(["--help"]), { kind: "help" });
});

test("any other argument, or a second one, is unknown", () => {
  assert.deepEqual(parseArguments(["-v"]), { kind: "unknown", argument: "-v" });
  assert.deepEqual(parseArguments(["version"]), { kind: "unknown", argument: "version" });
  assert.deepEqual(parseArguments(["--version", "x"]), { kind: "unknown", argument: "x" });
});

test("--version prints the version alone on stdout and answers 0", () => {
  const output = captured();
  assert.equal(answer({ kind: "version" }, output), 0);
  assert.equal(output.stdout, `${VERSION}\n`);
  assert.equal(output.stderr, "");
});

test("--help prints the usage on stdout and answers 0", () => {
  const output = captured();
  assert.equal(answer({ kind: "help" }, output), 0);
  assert.equal(output.stdout, `${USAGE}\n`);
});

test("an unknown argument names it, prints the usage on stderr and answers 2", () => {
  const output = captured();
  assert.equal(answer({ kind: "unknown", argument: "servce" }, output), 2);
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, `awaydesk: unknown argument "servce"\n${USAGE}\n`);
});

/** The entry run as a command, with a `HOME` that holds no `.env`. */
function runEntry(args: string[], home: string) {
  return spawnSync(process.execPath, [join(ROOT, "src", "main.ts"), ...args], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
}

test("the entry answers --version without reading .env", (t) => {
  // Were the daemon started, it would end with 1 on the missing `.env`.
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runEntry(["--version"], home);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${VERSION}\n`);
  assert.equal(result.stderr, "");
});

test("the entry refuses an unknown argument with status 2 and starts nothing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runEntry(["status"], home);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `awaydesk: unknown argument "status"\n${USAGE}\n`);
});
