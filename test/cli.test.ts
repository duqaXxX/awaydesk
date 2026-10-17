/**
 * The command line: no argument runs the daemon, `--version` and `--help` answer and end, anything
 * else is refused with the usage, so a mistyped argument never starts a daemon. `--instance` (or
 * `AWAYDESK_INSTANCE`) picks which of the machine's daemons a command is about.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answer, type Host, type Output, parseArguments, USAGE } from "../src/cli.ts";
import { DEFAULT_INSTANCE } from "../src/core/instance.ts";
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

const DEV = { name: "dev" };

test("no argument runs the default instance's daemon", () => {
  assert.deepEqual(parseArguments([]), { kind: "run", instance: DEFAULT_INSTANCE });
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

test("service takes exactly one of its five actions", () => {
  for (const action of ["install", "uninstall", "status", "restart", "list"] as const) {
    assert.deepEqual(parseArguments(["service", action]), {
      kind: "service",
      action,
      instance: DEFAULT_INSTANCE,
    });
  }
  const needs = {
    kind: "invalid",
    reason: "service needs one of: install, uninstall, status, restart, list",
  };
  assert.deepEqual(parseArguments(["service"]), needs);
  assert.deepEqual(parseArguments(["service", "start"]), needs);
  assert.deepEqual(parseArguments(["service", "status", "now"]), {
    kind: "invalid",
    reason: 'unknown argument "now"',
  });
});

test("--instance names the instance of the daemon and of every service action but list", () => {
  assert.deepEqual(parseArguments(["--instance", "dev"]), { kind: "run", instance: DEV });
  for (const action of ["install", "uninstall", "status", "restart"] as const) {
    const expected = { kind: "service", action, instance: DEV };
    assert.deepEqual(parseArguments(["service", action, "--instance", "dev"]), expected);
    assert.deepEqual(parseArguments(["--instance", "dev", "service", action]), expected);
  }
});

test("AWAYDESK_INSTANCE selects the instance when the flag is absent, and the flag wins", () => {
  const env = { AWAYDESK_INSTANCE: "work" };
  assert.deepEqual(parseArguments([], env), { kind: "run", instance: { name: "work" } });
  assert.deepEqual(parseArguments(["service", "status"], env), {
    kind: "service",
    action: "status",
    instance: { name: "work" },
  });
  assert.deepEqual(parseArguments(["--instance", "dev"], env), { kind: "run", instance: DEV });
  assert.deepEqual(parseArguments([], { AWAYDESK_INSTANCE: "" }), {
    kind: "run",
    instance: DEFAULT_INSTANCE,
  });
});

test("a bad name is refused by its source, from the flag or from the variable", () => {
  const flag = parseArguments(["--instance", "Work"]);
  assert.equal(flag.kind, "invalid");
  assert.match((flag as { reason: string }).reason, /^--instance: "Work" is not an instance name/);
  const variable = parseArguments(["service", "status"], { AWAYDESK_INSTANCE: "a_b" });
  assert.equal(variable.kind, "invalid");
  assert.match(
    (variable as { reason: string }).reason,
    /^AWAYDESK_INSTANCE: "a_b" is not an instance name/,
  );
  const named = parseArguments(["--instance", "default"]);
  assert.match((named as { reason: string }).reason, /^--instance: the instance name "default"/);
});

test("--instance without a name, given twice or in a place it has no meaning is invalid", () => {
  assert.deepEqual(parseArguments(["--instance"]), {
    kind: "invalid",
    reason: "--instance needs a name",
  });
  assert.deepEqual(parseArguments(["--instance", "a", "--instance", "b"]), {
    kind: "invalid",
    reason: "--instance is given twice",
  });
  assert.deepEqual(parseArguments(["--instance", "dev", "status"]), {
    kind: "invalid",
    reason: 'unknown argument "status"',
  });
});

test("--version and --help take no instance, and the variable does not touch them", () => {
  assert.deepEqual(parseArguments(["--version", "--instance", "dev"]), {
    kind: "invalid",
    reason: "--version takes no instance",
  });
  assert.deepEqual(parseArguments(["--instance", "dev", "--help"]), {
    kind: "invalid",
    reason: "--help takes no instance",
  });
  const env = { AWAYDESK_INSTANCE: "Bad Name" };
  assert.deepEqual(parseArguments(["--version"], env), { kind: "version" });
  assert.deepEqual(parseArguments(["--help"], env), { kind: "help" });
});

test("service list is about every instance: it takes no --instance and ignores the variable", () => {
  assert.deepEqual(parseArguments(["service", "list", "--instance", "dev"]), {
    kind: "invalid",
    reason: "service list takes no instance: it lists them all",
  });
  assert.deepEqual(parseArguments(["service", "list"], { AWAYDESK_INSTANCE: "Bad Name" }), {
    kind: "service",
    action: "list",
    instance: DEFAULT_INSTANCE,
  });
});

test("the usage names --instance and service list", () => {
  assert.match(USAGE, /--instance <name>/);
  assert.match(USAGE, /service <install\|uninstall\|status\|restart\|list>/);
  assert.match(USAGE, /AWAYDESK_INSTANCE/);
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
    list: answering("list"),
  };
  return {
    calls,
    service: (instance) => {
      calls.push(`service ${instance.name ?? "default"}`);
      return service;
    },
    program: () => PROGRAM,
  };
}

test("a service action runs on the manager, prints its lines and answers its status", () => {
  const host = fakeHost({ code: 3, out: ["one", "two"], err: ["three"] });
  const output = captured();
  const invocation = { kind: "service", action: "status", instance: DEFAULT_INSTANCE } as const;
  assert.equal(answer(invocation, output, host), 3);
  assert.equal(output.stdout, "one\ntwo\n");
  assert.equal(output.stderr, "three\n");
  assert.deepEqual(host.calls, ["service default", "status"]);
});

test("a service action is made on the manager of the instance it names", () => {
  const host = fakeHost({ code: 0, out: [], err: [] });
  answer({ kind: "service", action: "restart", instance: DEV }, captured(), host);
  answer({ kind: "service", action: "list", instance: DEFAULT_INSTANCE }, captured(), host);
  assert.deepEqual(host.calls, ["service dev", "restart", "service default", "list"]);
});

test("install hands the manager the program of this command", () => {
  const host = fakeHost({ code: 0, out: [], err: [] });
  const invocation = { kind: "service", action: "install", instance: DEFAULT_INSTANCE } as const;
  assert.equal(answer(invocation, captured(), host), 0);
  assert.deepEqual(host.calls, ["service default", "install /m/main.js"]);
});

test("a system with no service manager refuses service with status 1", () => {
  const output = captured();
  const host: Host = { service: () => null, program: () => PROGRAM };
  const invocation = { kind: "service", action: "install", instance: DEFAULT_INSTANCE } as const;
  assert.equal(answer(invocation, output, host), 1);
  assert.match(output.stderr, /macOS only/);
});

/** The entry run as a command, with a `HOME` that holds no `.env`. */
function runEntry(args: string[], home: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(ROOT, "src", "main.ts"), ...args], {
    env: { HOME: home, PATH: process.env.PATH ?? "", ...extra },
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

test("the entry refuses a bad instance name with status 2 and starts nothing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const flag = runEntry(["--instance", "Work"], home);
  assert.equal(flag.status, 2);
  assert.equal(flag.stdout, "");
  assert.match(flag.stderr, /^awaydesk: --instance: "Work" is not an instance name/);
  const variable = runEntry([], home, { AWAYDESK_INSTANCE: "Work" });
  assert.equal(variable.status, 2);
  assert.match(variable.stderr, /^awaydesk: AWAYDESK_INSTANCE: "Work" is not an instance name/);
});

test("the entry answers --version whatever AWAYDESK_INSTANCE holds", (t) => {
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runEntry(["--version"], home, { AWAYDESK_INSTANCE: "Work" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${VERSION}\n`);
});

test("a named instance looks for its .env in its own folder", (t) => {
  const home = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = runEntry(["--instance", "dev"], home);
  assert.equal(result.status, 1);
  const missing = join(home, ".config", "awaydesk-dev", ".env");
  assert.ok((result.stdout + result.stderr).includes(`${missing} does not exist`));
  const viaVariable = runEntry([], home, { AWAYDESK_INSTANCE: "dev" });
  assert.ok((viaVariable.stdout + viaVariable.stderr).includes(`${missing} does not exist`));
});
