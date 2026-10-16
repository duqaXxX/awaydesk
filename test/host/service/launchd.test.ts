/**
 * The LaunchAgent: what `awaydesk service` writes and which `launchctl` calls it makes, with
 * `launchctl` and `plutil` faked at `Run` and the plist written under a temporary home. The
 * plist itself is checked by the real `plutil` where it exists.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Program } from "../../../src/host/program.ts";
import { runCommand } from "../../../src/host/run.ts";
import {
  LABEL,
  Launchd,
  listedJob,
  logPath,
  plistFor,
  plistPath,
} from "../../../src/host/service/launchd.ts";
import type { Run } from "../../../src/host/service/seam.ts";

const PROGRAM: Program = {
  node: "/opt/homebrew/bin/node",
  main: "/Us" + "ers/alice/.local/lib/node_modules/awaydesk/dist/main.js",
  npmBin: "/Us" + "ers/alice/.local/bin",
};
const UID = 501;
// Folder modes, and root ignores them: not on Windows, nor as root.
const POSIX = { skip: process.platform === "win32" || process.getuid?.() === 0 };
const RUNNING = `PID\tStatus\tLabel\n123\t0\tcom.apple.x\n4242\t0\t${LABEL}\n`;
const STOPPED = `PID\tStatus\tLabel\n-\t78\t${LABEL}\n`;
const ABSENT = "PID\tStatus\tLabel\n123\t0\tcom.apple.x\n";

interface Call {
  command: string;
  args: readonly string[];
}

/** A `Run` that answers `launchctl list` with `listing` and records every call. */
function fakeRun(
  listing: string,
  answers: Record<string, { status: number; stdout?: string; stderr?: string }> = {},
): Run & { calls: Call[] } {
  const calls: Call[] = [];
  const run = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const key = `${command} ${args[0]}`;
    if (key === "launchctl list") return { status: 0, stdout: listing, stderr: "" };
    const answer = answers[key] ?? { status: 0 };
    return { status: answer.status, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  }) as Run & { calls: Call[] };
  run.calls = calls;
  return run;
}

function home(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "awaydesk-home-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function manager(path: string, run: Run): Launchd {
  return new Launchd({ home: path, uid: UID, configDir: join(path, ".config", "awaydesk"), run });
}

test("the plist names the program, its PATH, the log, and keeps the daemon alive", () => {
  const text = plistFor(PROGRAM, "/l/awaydesk.log");
  for (const piece of [
    `<string>${LABEL}</string>`,
    `<string>${PROGRAM.node}</string>\n    <string>${PROGRAM.main}</string>`,
    `<string>/opt/homebrew/bin:${PROGRAM.npmBin}:/usr/local/bin:/usr/bin:/bin</string>`,
    "<key>RunAtLoad</key>\n  <true/>",
    "<key>KeepAlive</key>\n  <true/>",
    "<key>ExitTimeOut</key>\n  <integer>60</integer>",
    "<key>StandardOutPath</key>\n  <string>/l/awaydesk.log</string>",
    "<key>StandardErrorPath</key>\n  <string>/l/awaydesk.log</string>",
  ]) {
    assert.ok(text.includes(piece), piece);
  }
});

test("a path with XML's special characters is escaped in the plist", () => {
  const text = plistFor({ ...PROGRAM, main: "/a&b/<c>/main.js" }, "/l.log");
  assert.ok(text.includes("<string>/a&amp;b/&lt;c&gt;/main.js</string>"));
});

test("plutil accepts the plist", { skip: process.platform !== "darwin" }, (t) => {
  const path = join(home(t), `${LABEL}.plist`);
  writeFileSync(path, plistFor({ ...PROGRAM, main: "/a&b/main.js" }, "/l.log"));
  const result = runCommand("plutil", ["-lint", path]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("launchctl list is read by its three columns", () => {
  assert.deepEqual(listedJob(RUNNING), { pid: 4242, lastExit: 0 });
  assert.deepEqual(listedJob(STOPPED), { pid: null, lastExit: 78 });
  assert.deepEqual(listedJob(`-\t-15\t${LABEL}`), { pid: null, lastExit: -15 });
  assert.equal(listedJob(ABSENT), null);
  assert.equal(listedJob(`1\t0\t${LABEL}.other`), null);
});

test("install writes the plist, lints it and bootstraps it in the user's domain", (t) => {
  const path = home(t);
  const run = fakeRun(ABSENT);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 0);
  assert.equal(readFileSync(plistPath(path), "utf8"), plistFor(PROGRAM, logPath(path)));
  assert.ok(existsSync(join(logPath(path), "..")), "the log folder exists");
  assert.deepEqual(
    run.calls.map((call) => [call.command, ...call.args]),
    [
      ["launchctl", "list"],
      ["plutil", "-lint", plistPath(path)],
      ["launchctl", "bootstrap", `gui/${UID}`, plistPath(path)],
    ],
  );
  assert.deepEqual(report.out, [
    `Wrote ${plistPath(path)}.`,
    `Loaded ${LABEL}: awaydesk starts now and at every login.`,
    `Log: ${logPath(path)}`,
  ]);
});

test("install over a loaded job with the same plist changes nothing", (t) => {
  const path = home(t);
  mkdirSync(join(plistPath(path), ".."), { recursive: true });
  writeFileSync(plistPath(path), plistFor(PROGRAM, logPath(path)));
  const run = fakeRun(RUNNING);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 0);
  assert.deepEqual(report.out, [`${LABEL} is already installed and loaded.`]);
  assert.equal(run.calls.length, 1);
});

test("install over a loaded job with another plist refuses and writes nothing", (t) => {
  const path = home(t);
  mkdirSync(join(plistPath(path), ".."), { recursive: true });
  writeFileSync(plistPath(path), "hand-written");
  const run = fakeRun(RUNNING);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 1);
  assert.match(report.err.join("\n"), /loaded with another definition/);
  assert.match(
    report.err.join("\n"),
    /`awaydesk service uninstall` then `awaydesk service install`/,
  );
  assert.equal(readFileSync(plistPath(path), "utf8"), "hand-written");
  assert.equal(run.calls.length, 1);
});

test("install over a loaded job whose plist is gone says so and writes nothing", (t) => {
  const path = home(t);
  const run = fakeRun(RUNNING);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 1);
  assert.equal(report.err[0], `${LABEL} is loaded, and its plist ${plistPath(path)} is gone.`);
  assert.ok(!existsSync(plistPath(path)));
});

test("a file install cannot write fails the action with Node's reason", POSIX, (t) => {
  const path = home(t);
  mkdirSync(join(path, "Library"));
  // Empty, so the home's removal can still delete it.
  chmodSync(join(path, "Library"), 0o500);
  const report = manager(path, fakeRun(ABSENT)).install(PROGRAM);
  assert.equal(report.code, 1);
  assert.match(report.err[0] as string, /^EACCES: permission denied/);
});

test("install stops when plutil refuses the plist, and loads nothing", (t) => {
  const path = home(t);
  const run = fakeRun(ABSENT, { "plutil -lint": { status: 1, stdout: "bad plist" } });
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 1);
  assert.deepEqual(report.err, [`plutil refused ${plistPath(path)}: bad plist`]);
  assert.ok(!run.calls.some((call) => call.args[0] === "bootstrap"));
});

test("a failed bootstrap is reported with what launchctl said", (t) => {
  const path = home(t);
  const run = fakeRun(ABSENT, {
    "launchctl bootstrap": { status: 5, stderr: "Bootstrap failed: 5: Input/output error\n" },
  });
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 1);
  assert.deepEqual(report.err, [
    "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error",
  ]);
});

test("uninstall boots the job out, removes the plist and names what it leaves", (t) => {
  const path = home(t);
  mkdirSync(join(plistPath(path), ".."), { recursive: true });
  writeFileSync(plistPath(path), "x");
  const run = fakeRun(RUNNING);
  const report = manager(path, run).uninstall();
  assert.equal(report.code, 0);
  assert.ok(!existsSync(plistPath(path)));
  assert.deepEqual(run.calls[1], {
    command: "launchctl",
    args: ["bootout", `gui/${UID}/${LABEL}`],
  });
  assert.deepEqual(report.out, [
    `Stopped ${LABEL}.`,
    `Removed ${plistPath(path)}.`,
    `Left in place: ${join(path, ".config", "awaydesk")} (.env, state.json) and ${join(logPath(path), "..")}.`,
  ]);
});

test("uninstall with nothing installed says so and calls nothing but the list", (t) => {
  const run = fakeRun(ABSENT);
  const report = manager(home(t), run).uninstall();
  assert.deepEqual(report, { code: 0, out: [`${LABEL} is not installed.`], err: [] });
  assert.equal(run.calls.length, 1);
});

test("uninstall of a plist that is not loaded only removes the file", (t) => {
  const path = home(t);
  mkdirSync(join(plistPath(path), ".."), { recursive: true });
  writeFileSync(plistPath(path), "x");
  const run = fakeRun(ABSENT);
  const report = manager(path, run).uninstall();
  assert.equal(report.code, 0);
  assert.ok(!existsSync(plistPath(path)));
  assert.ok(!run.calls.some((call) => call.args[0] === "bootout"));
});

test("status answers 0 with the pid while the daemon runs, 3 otherwise", (t) => {
  const path = home(t);
  assert.deepEqual(manager(path, fakeRun(RUNNING)).status(), {
    code: 0,
    out: [`${LABEL} is running, pid 4242.`, `Log: ${logPath(path)}`],
    err: [],
  });
  assert.deepEqual(manager(path, fakeRun(STOPPED)).status().out, [
    `${LABEL} is loaded and not running; its last exit status was 78.`,
    `Log: ${logPath(path)}`,
  ]);
  assert.equal(manager(path, fakeRun(STOPPED)).status().code, 3);
  assert.deepEqual(manager(path, fakeRun(ABSENT)).status(), {
    code: 3,
    out: [`${LABEL} is not installed.`],
    err: [],
  });
  mkdirSync(join(plistPath(path), ".."), { recursive: true });
  writeFileSync(plistPath(path), "x");
  assert.match(
    manager(path, fakeRun(ABSENT)).status().out[0] as string,
    /installed and not loaded/,
  );
});

test("restart sends TERM to the running job, which is the stop that lets turns finish", (t) => {
  const run = fakeRun(RUNNING);
  const report = manager(home(t), run).restart();
  assert.equal(report.code, 0);
  assert.deepEqual(run.calls[1], {
    command: "launchctl",
    args: ["kill", "TERM", `gui/${UID}/${LABEL}`],
  });
  assert.ok(!run.calls.some((call) => ["bootout", "kickstart"].includes(call.args[0] as string)));
});

test("restart of a job that is not loaded or not running sends nothing", (t) => {
  for (const listing of [ABSENT, STOPPED]) {
    const run = fakeRun(listing);
    assert.equal(manager(home(t), run).restart().code, 1);
    assert.equal(run.calls.length, 1);
  }
});

test("a failing launchctl list fails the action with its words", (t) => {
  const run: Run = () => ({ status: 1, stdout: "", stderr: "Could not connect\n" });
  assert.deepEqual(manager(home(t), run).status(), {
    code: 1,
    out: [],
    err: ["launchctl list failed: Could not connect"],
  });
});
