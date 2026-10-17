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
  Launchd,
  labelOf,
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
const LABEL = labelOf(null);
const DEV_LABEL = labelOf("dev");
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

function manager(path: string, run: Run, instance: string | null = null): Launchd {
  const configDir = join(path, ".config", instance === null ? "awaydesk" : `awaydesk-${instance}`);
  return new Launchd({ home: path, uid: UID, instance, configDir, run });
}

/** A copy of the package under `path`, as npm installs it: `dist/main.js` and a `package.json`. */
function copyIn(path: string, version: string | null): Program {
  const copy = join(path, "lib", "node_modules", "awaydesk");
  mkdirSync(join(copy, "dist"), { recursive: true });
  if (version !== null) writeFileSync(join(copy, "package.json"), JSON.stringify({ version }));
  return { ...PROGRAM, main: join(copy, "dist", "main.js") };
}

// What 0.1.1 writes for the default instance, for this program and this log. A copy of 0.1.x and a
// copy with instances must agree on it byte for byte: the one that did not install it still reads
// it back to compare (`install` over a loaded job), and `service list` reads both.
const LOG = "/Us" + "ers/alice/Library/Logs/awaydesk/awaydesk.log";
const PLIST_OF_0_1_1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.awaydesk</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${PROGRAM.main}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:${PROGRAM.npmBin}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
`;

test("the default instance's plist is byte for byte the one 0.1.1 writes", () => {
  assert.equal(plistFor(PROGRAM, LOG), PLIST_OF_0_1_1);
  assert.equal(plistFor(PROGRAM, LOG, null), PLIST_OF_0_1_1);
});

test("a named instance has a label, program arguments and log of its own, the rest the same", () => {
  const log = "/l/dev.log";
  const text = plistFor(PROGRAM, log, "dev");
  const expected = PLIST_OF_0_1_1.replace(
    "<string>local.awaydesk</string>",
    "<string>local.awaydesk.dev</string>",
  )
    .replace(
      `<string>${PROGRAM.main}</string>\n`,
      `<string>${PROGRAM.main}</string>\n    <string>--instance</string>\n    <string>dev</string>\n`,
    )
    .replaceAll(LOG, log);
  assert.equal(text, expected);
});

test("the label, the plist and the log derive from the instance", () => {
  assert.equal(LABEL, "local.awaydesk");
  assert.equal(DEV_LABEL, "local.awaydesk.dev");
  const path = join("/h", "alice");
  assert.equal(
    plistPath(path, null),
    join(path, "Library", "LaunchAgents", "local.awaydesk.plist"),
  );
  assert.equal(
    plistPath(path, "dev"),
    join(path, "Library", "LaunchAgents", "local.awaydesk.dev.plist"),
  );
  assert.equal(logPath(path, null), join(path, "Library", "Logs", "awaydesk", "awaydesk.log"));
  assert.equal(logPath(path, "dev"), join(path, "Library", "Logs", "awaydesk", "dev.log"));
});

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
  assert.deepEqual(listedJob(RUNNING, LABEL), { pid: 4242, lastExit: 0 });
  assert.deepEqual(listedJob(STOPPED, LABEL), { pid: null, lastExit: 78 });
  assert.deepEqual(listedJob(`-\t-15\t${LABEL}`, LABEL), { pid: null, lastExit: -15 });
  assert.equal(listedJob(ABSENT, LABEL), null);
  assert.equal(listedJob(`1\t0\t${LABEL}.other`, LABEL), null);
});

test("the job read is the instance's own, and no other", () => {
  const both = `PID\tStatus\tLabel\n11\t0\t${LABEL}\n22\t0\t${DEV_LABEL}\n`;
  assert.deepEqual(listedJob(both, LABEL), { pid: 11, lastExit: 0 });
  assert.deepEqual(listedJob(both, DEV_LABEL), { pid: 22, lastExit: 0 });
  assert.equal(listedJob(`11\t0\t${LABEL}`, DEV_LABEL), null);
});

test("install writes the plist, lints it and bootstraps it in the user's domain", (t) => {
  const path = home(t);
  const run = fakeRun(ABSENT);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 0);
  assert.equal(readFileSync(plistPath(path, null), "utf8"), plistFor(PROGRAM, logPath(path, null)));
  assert.ok(existsSync(join(logPath(path, null), "..")), "the log folder exists");
  assert.deepEqual(
    run.calls.map((call) => [call.command, ...call.args]),
    [
      ["launchctl", "list"],
      ["plutil", "-lint", plistPath(path, null)],
      ["launchctl", "bootstrap", `gui/${UID}`, plistPath(path, null)],
    ],
  );
  assert.deepEqual(report.out, [
    `Wrote ${plistPath(path, null)}.`,
    `Loaded ${LABEL}: awaydesk starts now and at every login.`,
    `Log: ${logPath(path, null)}`,
    `Runs the copy in ${join(PROGRAM.main, "..", "..")}, whose package.json cannot be read.`,
  ]);
});

test("install names the copy the plist starts and its version", (t) => {
  const path = home(t);
  const program = copyIn(path, "0.1.1");
  const report = manager(path, fakeRun(ABSENT)).install(program);
  assert.equal(report.code, 0);
  assert.equal(
    report.out.at(-1),
    `Runs the copy in ${join(path, "lib", "node_modules", "awaydesk")}, version 0.1.1.`,
  );
});

test("install of a named instance writes and loads the plist of its own label", (t) => {
  const path = home(t);
  const run = fakeRun(ABSENT);
  const report = manager(path, run, "dev").install(PROGRAM);
  assert.equal(report.code, 0);
  assert.equal(
    readFileSync(plistPath(path, "dev"), "utf8"),
    plistFor(PROGRAM, logPath(path, "dev"), "dev"),
  );
  assert.ok(!existsSync(plistPath(path, null)));
  assert.deepEqual(
    run.calls.map((call) => [call.command, ...call.args]),
    [
      ["launchctl", "list"],
      ["plutil", "-lint", plistPath(path, "dev")],
      ["launchctl", "bootstrap", `gui/${UID}`, plistPath(path, "dev")],
    ],
  );
  assert.deepEqual(report.out.slice(0, 3), [
    `Wrote ${plistPath(path, "dev")}.`,
    `Loaded ${DEV_LABEL}: awaydesk starts now and at every login.`,
    `Log: ${logPath(path, "dev")}`,
  ]);
});

test("a loaded default instance does not stand in the way of installing a named one", (t) => {
  const path = home(t);
  const both = `PID\tStatus\tLabel\n11\t0\t${LABEL}\n`;
  const report = manager(path, fakeRun(both), "dev").install(PROGRAM);
  assert.equal(report.code, 0);
});

test("install over a loaded named job points at the commands of that instance", (t) => {
  const path = home(t);
  mkdirSync(join(plistPath(path, "dev"), ".."), { recursive: true });
  writeFileSync(plistPath(path, "dev"), "hand-written");
  const listing = `PID\tStatus\tLabel\n22\t0\t${DEV_LABEL}\n`;
  const report = manager(path, fakeRun(listing), "dev").install(PROGRAM);
  assert.equal(report.code, 1);
  assert.equal(
    report.err[0],
    `${DEV_LABEL} is loaded with another definition (${plistPath(path, "dev")}).`,
  );
  assert.match(
    report.err[1] as string,
    /`awaydesk service uninstall --instance dev` then `awaydesk service install --instance dev`/,
  );
});

test("install over a loaded job with the same plist changes nothing", (t) => {
  const path = home(t);
  mkdirSync(join(plistPath(path, null), ".."), { recursive: true });
  writeFileSync(plistPath(path, null), plistFor(PROGRAM, logPath(path, null)));
  const run = fakeRun(RUNNING);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 0);
  assert.deepEqual(report.out, [`${LABEL} is already installed and loaded.`]);
  assert.equal(run.calls.length, 1);
});

test("install over a loaded job with another plist refuses and writes nothing", (t) => {
  const path = home(t);
  mkdirSync(join(plistPath(path, null), ".."), { recursive: true });
  writeFileSync(plistPath(path, null), "hand-written");
  const run = fakeRun(RUNNING);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 1);
  assert.match(report.err.join("\n"), /loaded with another definition/);
  assert.match(
    report.err.join("\n"),
    /`awaydesk service uninstall` then `awaydesk service install`/,
  );
  assert.equal(readFileSync(plistPath(path, null), "utf8"), "hand-written");
  assert.equal(run.calls.length, 1);
});

test("install over a loaded job whose plist is gone says so and writes nothing", (t) => {
  const path = home(t);
  const run = fakeRun(RUNNING);
  const report = manager(path, run).install(PROGRAM);
  assert.equal(report.code, 1);
  assert.equal(
    report.err[0],
    `${LABEL} is loaded, and its plist ${plistPath(path, null)} is gone.`,
  );
  assert.ok(!existsSync(plistPath(path, null)));
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
  assert.deepEqual(report.err, [`plutil refused ${plistPath(path, null)}: bad plist`]);
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
  mkdirSync(join(plistPath(path, null), ".."), { recursive: true });
  writeFileSync(plistPath(path, null), "x");
  const run = fakeRun(RUNNING);
  const report = manager(path, run).uninstall();
  assert.equal(report.code, 0);
  assert.ok(!existsSync(plistPath(path, null)));
  assert.deepEqual(run.calls[1], {
    command: "launchctl",
    args: ["bootout", `gui/${UID}/${LABEL}`],
  });
  assert.deepEqual(report.out, [
    `Stopped ${LABEL}.`,
    `Removed ${plistPath(path, null)}.`,
    `Left in place: ${join(path, ".config", "awaydesk")} (.env, state.json) and ${join(logPath(path, null), "..")}.`,
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
  mkdirSync(join(plistPath(path, null), ".."), { recursive: true });
  writeFileSync(plistPath(path, null), "x");
  const run = fakeRun(ABSENT);
  const report = manager(path, run).uninstall();
  assert.equal(report.code, 0);
  assert.ok(!existsSync(plistPath(path, null)));
  assert.ok(!run.calls.some((call) => call.args[0] === "bootout"));
});

test("status answers 0 with the pid while the daemon runs, 3 otherwise", (t) => {
  const path = home(t);
  assert.deepEqual(manager(path, fakeRun(RUNNING)).status(), {
    code: 0,
    out: [`${LABEL} is running, pid 4242.`, `Log: ${logPath(path, null)}`],
    err: [],
  });
  assert.deepEqual(manager(path, fakeRun(STOPPED)).status().out, [
    `${LABEL} is loaded and not running; its last exit status was 78.`,
    `Log: ${logPath(path, null)}`,
  ]);
  assert.equal(manager(path, fakeRun(STOPPED)).status().code, 3);
  assert.deepEqual(manager(path, fakeRun(ABSENT)).status(), {
    code: 3,
    out: [`${LABEL} is not installed.`],
    err: [],
  });
  mkdirSync(join(plistPath(path, null), ".."), { recursive: true });
  writeFileSync(plistPath(path, null), "x");
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

test("uninstall, status and restart of a named instance act on its label alone", (t) => {
  const path = home(t);
  const listing = `PID\tStatus\tLabel\n11\t0\t${LABEL}\n22\t0\t${DEV_LABEL}\n`;
  mkdirSync(join(plistPath(path, "dev"), ".."), { recursive: true });
  writeFileSync(plistPath(path, "dev"), "x");

  const restart = fakeRun(listing);
  assert.equal(manager(path, restart, "dev").restart().code, 0);
  assert.deepEqual(restart.calls[1], {
    command: "launchctl",
    args: ["kill", "TERM", `gui/${UID}/${DEV_LABEL}`],
  });

  assert.deepEqual(manager(path, fakeRun(listing), "dev").status(), {
    code: 0,
    out: [`${DEV_LABEL} is running, pid 22.`, `Log: ${logPath(path, "dev")}`],
    err: [],
  });

  const uninstall = fakeRun(listing);
  const report = manager(path, uninstall, "dev").uninstall();
  assert.deepEqual(uninstall.calls[1], {
    command: "launchctl",
    args: ["bootout", `gui/${UID}/${DEV_LABEL}`],
  });
  assert.deepEqual(report.out, [
    `Stopped ${DEV_LABEL}.`,
    `Removed ${plistPath(path, "dev")}.`,
    `Left in place: ${join(path, ".config", "awaydesk-dev")} (.env, state.json) and ${join(logPath(path, "dev"), "..")}.`,
  ]);
});

test("a named instance that is not installed or not loaded says its own command", (t) => {
  const path = home(t);
  assert.deepEqual(manager(path, fakeRun(ABSENT), "dev").status().out, [
    `${DEV_LABEL} is not installed.`,
  ]);
  mkdirSync(join(plistPath(path, "dev"), ".."), { recursive: true });
  writeFileSync(plistPath(path, "dev"), "x");
  assert.equal(
    manager(path, fakeRun(ABSENT), "dev").status().out[0],
    `${DEV_LABEL} is installed and not loaded: \`awaydesk service install --instance dev\` loads it.`,
  );
  assert.equal(
    manager(path, fakeRun(ABSENT), "dev").restart().err[0],
    `${DEV_LABEL} is not loaded: \`awaydesk service install --instance dev\` starts it.`,
  );
});

// ---- service list

/** The JSON `plutil -convert json -o -` prints for a plist that starts `main`, with `extra` args. */
function converted(main: string, extra: string[] = []): string {
  return JSON.stringify({ Label: "x", ProgramArguments: ["/n/node", main, ...extra] });
}

/**
 * A `Run` for `service list`: `launchctl list` answers `listing`, and `plutil -convert` answers by
 * the plist it is given, the file's name being the key.
 */
function listingRun(
  listing: string,
  plists: Record<string, { status?: number; stdout?: string }>,
): Run & { calls: Call[] } {
  const calls: Call[] = [];
  const run = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    if (command === "launchctl" && args[0] === "list") {
      return { status: 0, stdout: listing, stderr: "" };
    }
    assert.equal(command, "plutil");
    assert.deepEqual(args.slice(0, 3), ["-convert", "json", "-o"]);
    assert.equal(args[3], "-");
    const file = String(args[4]).split("/").at(-1) as string;
    const answer = plists[file] ?? { status: 1 };
    return { status: answer.status ?? 0, stdout: answer.stdout ?? "", stderr: "" };
  }) as Run & { calls: Call[] };
  run.calls = calls;
  return run;
}

function agents(path: string, names: string[]): void {
  mkdirSync(join(path, "Library", "LaunchAgents"), { recursive: true });
  for (const name of names) writeFileSync(join(path, "Library", "LaunchAgents", name), "x");
}

test("service list shows every awaydesk plist: instance, state, copy and version", (t) => {
  const path = home(t);
  const release = copyIn(join(path, "release"), "0.1.1");
  const development = copyIn(join(path, "development"), "0.2.0");
  agents(path, [
    "local.awaydesk.plist",
    "local.awaydesk.dev.plist",
    "local.awaydesk.work.plist",
    "com.example.other.plist",
    "local.awaydeskish.plist",
  ]);
  const listing = `PID\tStatus\tLabel\n4242\t0\t${LABEL}\n-\t78\t${DEV_LABEL}\n`;
  const run = listingRun(listing, {
    "local.awaydesk.plist": { stdout: converted(release.main) },
    "local.awaydesk.dev.plist": { stdout: converted(development.main, ["--instance", "dev"]) },
    "local.awaydesk.work.plist": { stdout: converted(development.main, ["--instance", "work"]) },
  });
  const report = manager(path, run).list();
  assert.equal(report.code, 0);
  assert.deepEqual(report.err, []);
  const copyOfRelease = join(path, "release", "lib", "node_modules", "awaydesk");
  const copyOfDevelopment = join(path, "development", "lib", "node_modules", "awaydesk");
  assert.deepEqual(cells(report.out), [
    ["INSTANCE", "STATE", "COPY", "VERSION"],
    ["default", "running, pid 4242", copyOfRelease, "0.1.1"],
    ["dev", "loaded, not running", copyOfDevelopment, "0.2.0"],
    ["work", "not loaded", copyOfDevelopment, "0.2.0"],
  ]);
  // The columns line up, whatever each cell holds.
  const starts = report.out.map((line) => line.indexOf(line.split(/ {2,}/)[2] as string));
  assert.equal(new Set(starts).size, 1);
  // One `launchctl list`, then one reading of each plist, in the order listed.
  assert.deepEqual(
    run.calls.map((call) => [call.command, call.args[0], String(call.args[4]).split("/").at(-1)]),
    [
      ["launchctl", "list", "undefined"],
      ["plutil", "-convert", "local.awaydesk.plist"],
      ["plutil", "-convert", "local.awaydesk.dev.plist"],
      ["plutil", "-convert", "local.awaydesk.work.plist"],
    ],
  );
});

/** The cells of the table `service list` prints: two spaces or more between columns. */
function cells(lines: readonly string[]): string[][] {
  return lines.map((line) => line.split(/ {2,}/));
}

test("service list names a plist it cannot read, and a copy whose package.json is gone", (t) => {
  const path = home(t);
  const gone = copyIn(path, null);
  agents(path, [
    "local.awaydesk.plist",
    "local.awaydesk.bad.plist",
    "local.awaydesk.json.plist",
    "local.awaydesk.noargs.plist",
  ]);
  const run = listingRun(`PID\tStatus\tLabel\n7\t0\t${LABEL}\n`, {
    "local.awaydesk.plist": { stdout: converted(gone.main) },
    "local.awaydesk.bad.plist": { status: 1 },
    "local.awaydesk.json.plist": { stdout: "not json" },
    "local.awaydesk.noargs.plist": { stdout: JSON.stringify({ ProgramArguments: ["/n/node"] }) },
  });
  const report = manager(path, run).list();
  assert.equal(report.code, 0);
  assert.deepEqual(cells(report.out), [
    ["INSTANCE", "STATE", "COPY", "VERSION"],
    ["default", "running, pid 7", join(path, "lib", "node_modules", "awaydesk"), "unknown"],
    ["bad", "not loaded", "unreadable plist", "-"],
    ["json", "not loaded", "unreadable plist", "-"],
    ["noargs", "not loaded", "unreadable plist", "-"],
  ]);
});

test("service list with no plist says so, and fails when launchctl does", (t) => {
  const path = home(t);
  const none = manager(path, listingRun(ABSENT, {})).list();
  assert.deepEqual(none, { code: 0, out: ["No awaydesk service is installed."], err: [] });
  agents(path, ["local.awaydesk.plist"]);
  const run: Run = () => ({ status: 1, stdout: "", stderr: "Could not connect\n" });
  assert.deepEqual(manager(path, run).list(), {
    code: 1,
    out: [],
    err: ["launchctl list failed: Could not connect"],
  });
});
