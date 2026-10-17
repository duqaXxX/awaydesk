/**
 * The Claude module's own variable, `CLAUDE_CONFIG_DIR`: read from the daemon's file, expanded,
 * checked, given to every place that reads Claude Code's folders, and written into the daemon's
 * environment once, for the SDK's listing, which reads nothing else.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { claudeAgent, VARIABLES } from "../../../src/agent/claude/module.ts";
import {
  AgentConfigError,
  type RequestHandler,
  type StartOptions,
} from "../../../src/agent/seam.ts";
import { systemClock } from "../../../src/clock.ts";
import { FakeSdk } from "../../support/fake-query.ts";

const LIMIT = { timeout: 10_000 };
const START: StartOptions = {
  folder: "/srv/alice/app",
  resume: null,
  settingsSources: ["user", "project", "local"],
  model: null,
  effort: null,
};
const NO_REQUESTS: RequestHandler = {
  permission: async () => ({ allow: true }),
  question: async () => ({ answered: false, message: "" }),
};

let tmp = "";
let home = "";
let previous: string | undefined;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "awaydesk-module-")));
  home = join(tmp, "home");
  await mkdir(home);
  await writeFile(join(home, ".claude.json"), JSON.stringify({}));
  previous = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  await rm(tmp, { recursive: true, force: true });
});

test("the module declares CLAUDE_CONFIG_DIR as an optional variable", () => {
  assert.ok(VARIABLES.includes("CLAUDE_CONFIG_DIR"));
  assert.deepEqual(claudeAgent().required, []);
  assert.ok(claudeAgent().optional.includes("CLAUDE_CONFIG_DIR"));
});

test("the folder of the file reaches a thread's session", LIMIT, async () => {
  const config = join(tmp, "second-login");
  const sdk = new FakeSdk();
  const backend = claudeAgent({ query: sdk.query, home }).build({
    variables: { CLAUDE_CONFIG_DIR: config },
    clock: systemClock,
  });
  const session = await backend.start(START, NO_REQUESTS);
  assert.equal(sdk.only.options.env?.CLAUDE_CONFIG_DIR, config);
  await session.close();
  await backend.close();
});

test("the terminal line names the folder of the file, and is today's without one", () => {
  const config = join(tmp, "second-login");
  const own = claudeAgent({ home }).build({
    variables: { CLAUDE_CONFIG_DIR: config },
    clock: systemClock,
  });
  assert.equal(
    own.words.terminal,
    `cd {directory} && CLAUDE_CONFIG_DIR=${config} claude --resume {session} --fork-session`,
  );
  delete process.env.CLAUDE_CONFIG_DIR;
  const plain = claudeAgent({ home }).build({ variables: {}, clock: systemClock });
  assert.equal(plain.words.terminal, "cd {directory} && claude --resume {session} --fork-session");
});

test(
  "past the tilde the folder is kept as written, since the Keychain entry follows the string",
  LIMIT,
  () => {
    claudeAgent({ query: new FakeSdk().query, home }).build({
      variables: { CLAUDE_CONFIG_DIR: "~/./work//" },
      clock: systemClock,
    });
    assert.equal(process.env.CLAUDE_CONFIG_DIR, `${home}/./work//`);
  },
);

test(
  "a tilde in the folder is the owner's home, and the session gets the expanded path",
  LIMIT,
  async () => {
    const sdk = new FakeSdk();
    const backend = claudeAgent({ query: sdk.query, home }).build({
      variables: { CLAUDE_CONFIG_DIR: "~/.claude-work" },
      clock: systemClock,
    });
    const session = await backend.start(START, NO_REQUESTS);
    assert.equal(sdk.only.options.env?.CLAUDE_CONFIG_DIR, join(home, ".claude-work"));
    assert.equal(process.env.CLAUDE_CONFIG_DIR, join(home, ".claude-work"));
    await session.close();
    await backend.close();
  },
);

test("a lone tilde is the home itself", () => {
  claudeAgent({ home }).build({ variables: { CLAUDE_CONFIG_DIR: "~" }, clock: systemClock });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, home);
});

for (const written of ["relative/folder", "./folder", "folder", "~other/folder"]) {
  test(`a folder that is not absolute is refused [${written}]`, () => {
    assert.throws(
      () =>
        claudeAgent({ home }).build({
          variables: { CLAUDE_CONFIG_DIR: written },
          clock: systemClock,
        }),
      (error: unknown) =>
        error instanceof AgentConfigError &&
        error.message ===
          `CLAUDE_CONFIG_DIR must be an absolute path, or one starting with ~/; it is "${written}"`,
    );
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  });
}

// The SDK's listing of a folder's sessions has no option for Claude Code's folder and reads the
// daemon's environment (`ListSessionsOptions`, sdk.d.ts 0.3.301): the value of the file is
// written there, once, when the module builds.
test("the environment is written when the file sets the folder", () => {
  const config = join(tmp, "second-login");
  claudeAgent({ home }).build({ variables: { CLAUDE_CONFIG_DIR: config }, clock: systemClock });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, config);
});

test("the file's folder wins over the environment's", () => {
  const inherited = join(tmp, "inherited");
  const config = join(tmp, "second-login");
  process.env.CLAUDE_CONFIG_DIR = inherited;
  claudeAgent({ home }).build({ variables: { CLAUDE_CONFIG_DIR: config }, clock: systemClock });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, config);
});

test("the environment is left alone when the file does not set the folder", () => {
  claudeAgent({ home }).build({ variables: {}, clock: systemClock });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  const inherited = join(tmp, "inherited");
  process.env.CLAUDE_CONFIG_DIR = inherited;
  claudeAgent({ home }).build({ variables: {}, clock: systemClock });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, inherited);
});

// The environment's folder follows the file's rule: the daemon started from a shell with the
// variable set would otherwise read a relative path from its working directory.
for (const inherited of ["relative/folder", "./folder", "~other/folder"]) {
  test(`an inherited folder that is not absolute is refused [${inherited}]`, () => {
    process.env.CLAUDE_CONFIG_DIR = inherited;
    assert.throws(
      () => claudeAgent({ home }).build({ variables: {}, clock: systemClock }),
      (error: unknown) =>
        error instanceof AgentConfigError &&
        error.message ===
          `CLAUDE_CONFIG_DIR, set in the daemon's environment and not in .env, must be an absolute path, or one starting with ~/; it is "${inherited}"`,
    );
  });
}

test(
  "an inherited folder starting with a tilde is the owner's home, in both places",
  LIMIT,
  async () => {
    process.env.CLAUDE_CONFIG_DIR = "~/.claude-work";
    const sdk = new FakeSdk();
    const backend = claudeAgent({ query: sdk.query, home }).build({
      variables: {},
      clock: systemClock,
    });
    const session = await backend.start(START, NO_REQUESTS);
    assert.equal(sdk.only.options.env?.CLAUDE_CONFIG_DIR, join(home, ".claude-work"));
    assert.equal(process.env.CLAUDE_CONFIG_DIR, join(home, ".claude-work"));
    await session.close();
    await backend.close();
  },
);

test("an empty inherited folder is no folder", () => {
  process.env.CLAUDE_CONFIG_DIR = "";
  claudeAgent({ home }).build({ variables: {}, clock: systemClock });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, "");
});

test("the file's folder is not judged by the environment's", () => {
  process.env.CLAUDE_CONFIG_DIR = "relative/folder";
  const config = join(tmp, "second-login");
  claudeAgent({ home }).build({ variables: { CLAUDE_CONFIG_DIR: config }, clock: systemClock });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, config);
});

test("the trust and Chrome records are the folder's, not the home's", LIMIT, async () => {
  const config = join(tmp, "second-login");
  const project = join(tmp, "project");
  await mkdir(config);
  await mkdir(project);
  await writeFile(
    join(config, ".claude.json"),
    JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }),
  );
  const backend = claudeAgent({ home }).build({
    variables: { CLAUDE_CONFIG_DIR: config },
    clock: systemClock,
  });
  assert.equal(await backend.folderTrusted(project), true);
  await backend.close();
});

test("with no folder set anywhere the records are the home's", LIMIT, async () => {
  const project = join(tmp, "project");
  await mkdir(project);
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }),
  );
  const backend = claudeAgent({ home }).build({ variables: {}, clock: systemClock });
  assert.equal(await backend.folderTrusted(project), true);
  await backend.close();
});

test("the environment's folder serves when the file sets none", LIMIT, async () => {
  const config = join(tmp, "inherited");
  const project = join(tmp, "project");
  await mkdir(config);
  await mkdir(project);
  await writeFile(
    join(config, ".claude.json"),
    JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }),
  );
  process.env.CLAUDE_CONFIG_DIR = config;
  const backend = claudeAgent({ home }).build({ variables: {}, clock: systemClock });
  assert.equal(await backend.folderTrusted(project), true);
  await backend.close();
});
