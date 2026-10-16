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
import { answer, type Host, type Output, parseArguments, USAGE } from "../src/cli.ts";
import type { Report, ServiceManager } from "../src/host/service/seam.ts";

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

test("any other argument, or a second one, is invalid and named", () => {
  assert.deepEqual(parseArguments(["-v"]), { kind: "invalid", reason: 'unknown argument "-v"' });
  assert.deepEqual(parseArguments(["version"]), {
    kind: "invalid",
    reason: 'unknown argument "version"',
  });
  assert.deepEqual(parseArguments(["--version", "x"]), {
    kind: "invalid",
    reason: 'unknown argument "x"',
  });
});

test("service takes exactly one of its four actions", () => {
  for (const action of ["install", "uninstall", "status", "restart"] as const) {
    assert.deepEqual(parseArguments(["service", action]), { kind: "service", action });
  }
  const needs = {
    kind: "invalid",
    reason: "service needs one of: install, uninstall, status, restart",
  };
  assert.deepEqual(parseArguments(["service"]), needs);
  assert.deepEqual(parseArguments(["service", "start"]), needs);
  assert.deepEqual(parseArguments(["service", "status", "now"]), {
    kind: "invalid",
    reason: 'unknown argument "now"',
  });
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

test("an invalid invocation prints its reason and the usage on stderr and answers 2", () => {
  const output = captured();
  assert.equal(answer({ kind: "invalid", reason: 'unknown argument "servce"' }, output), 2);
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, `awaydesk: unknown argument "servce"\n${USAGE}\n`);
});

const PROGRAM = { node: "/n/node", main: "/m/main.js", npmBin: null };

/** A host whose service manager records the calls and answers `report`. */
function fakeHost(report: Report): Host & { calls: string[] } {
  const calls: string[] = [];
  const answering = (name: string) => (): Report => {
    calls.push(name);
    return report;
  };
  const service: ServiceManager = {
    install: (program) => {
      calls.push(`install ${program.main}`);
      return report;
    },
    uninstall: answering("uninstall"),
    status: answering("status"),
    restart: answering("restart"),
  };
  return { calls, service: () => service, program: () => PROGRAM };
}

test("a service action runs on the manager, prints its lines and answers its status", () => {
  const host = fakeHost({ code: 3, out: ["one", "two"], err: ["three"] });
  const output = captured();
  assert.equal(answer({ kind: "service", action: "status" }, output, host), 3);
  assert.equal(output.stdout, "one\ntwo\n");
  assert.equal(output.stderr, "three\n");
  assert.deepEqual(host.calls, ["status"]);
});

test("install hands the manager the program of this command", () => {
  const host = fakeHost({ code: 0, out: [], err: [] });
  assert.equal(answer({ kind: "service", action: "install" }, captured(), host), 0);
  assert.deepEqual(host.calls, ["install /m/main.js"]);
});

test("a system with no service manager refuses service with status 1", () => {
  const output = captured();
  const host: Host = { service: () => null, program: () => PROGRAM };
  assert.equal(answer({ kind: "service", action: "install" }, output, host), 1);
  assert.match(output.stderr, /macOS only/);
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
