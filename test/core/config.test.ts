import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { inspect } from "node:util";
import {
  ConfigError,
  type Env,
  expandEnv,
  loadConfig,
  type Modules,
} from "../../src/core/config.ts";
import { REGISTRY } from "../../src/registry.ts";

const POSIX_ONLY = { skip: process.platform === "win32" };

const BOT = `${"xox"}b-000-fake`;
const APP = `${"xap"}p-000-fake`;

const made: string[] = [];

/** `loadConfig` over the registry the daemon ships: the Slack and Claude variables. */
function load(directory: string, env?: Env) {
  return loadConfig(REGISTRY, directory, env);
}

function scratch(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "awd-config-")));
  made.push(directory);
  return directory;
}

after(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

/** Writes `.env` in `directory`; an empty override leaves its variable out. */
function writeEnv(
  directory: string,
  root: string,
  overrides: Record<string, string> = {},
  mode = 0o600,
): string {
  const values: Record<string, string> = {
    SLACK_BOT_TOKEN: BOT,
    SLACK_APP_TOKEN: APP,
    SLACK_OWNER_USER_ID: "U000ALICE",
    ALLOWED_ROOT: root,
    ...overrides,
  };
  const env = join(directory, ".env");
  writeFileSync(
    env,
    Object.entries(values)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  chmodSync(env, mode);
  return env;
}

test("loads a private env", () => {
  const directory = scratch();
  writeEnv(directory, directory);
  const config = load(directory);
  assert.equal(config.chatVariables.SLACK_OWNER_USER_ID, "U000ALICE");
  assert.equal(config.allowedRoot, directory);
  assert.equal(config.configDir, directory);
});

test("reads an env that starts with a byte order mark", () => {
  // Some editors write one, and python-dotenv, whose reading the loader follows, strips it.
  const directory = scratch();
  const env = writeEnv(directory, directory);
  writeFileSync(env, `\ufeff${readFileSync(env, "utf8")}`, { mode: 0o600 });
  assert.equal(load(directory).chatVariables.SLACK_BOT_TOKEN, BOT);
});

test("a value is stripped as Python strips it", () => {
  // U+001C is whitespace to Python and U+FEFF is not: `\u001c` alone is no value, and the
  // byte order mark inside a value stays.
  const directory = scratch();
  writeEnv(directory, directory, {
    SLACK_OWNER_USER_ID: "\u001cU000ALICE\u001c",
    SLACK_USER_TOKEN: "\u001c",
  });
  const config = load(directory);
  assert.equal(config.chatVariables.SLACK_OWNER_USER_ID, "U000ALICE");
  assert.equal(config.chatVariables.SLACK_USER_TOKEN, undefined);
  writeEnv(directory, directory, { SLACK_OWNER_USER_ID: "U000ALICE\ufeff" });
  assert.equal(load(directory).chatVariables.SLACK_OWNER_USER_ID, "U000ALICE\ufeff");
});

test("the owner s user token is optional and never shown", () => {
  const directory = scratch();
  writeEnv(directory, directory);
  assert.equal(load(directory).chatVariables.SLACK_USER_TOKEN, undefined);
  const user = `${"xox"}p-000-fake`;
  writeEnv(directory, directory, { SLACK_USER_TOKEN: user });
  const config = load(directory);
  assert.equal(config.chatVariables.SLACK_USER_TOKEN, user);
  assert.ok(!inspect(config).includes(user));
});

for (const mode of [0o640, 0o604, 0o660, 0o644]) {
  test(
    `refuses an env readable by others [${mode.toString(8).padStart(4, "0")}]`,
    POSIX_ONLY,
    () => {
      const directory = scratch();
      writeEnv(directory, directory, {}, mode);
      assert.throws(
        () => load(directory),
        (error: unknown) => error instanceof ConfigError && /chmod 600/.test(error.message),
      );
    },
  );
}

test("refuses an env owned by another user", POSIX_ONLY, (t) => {
  const directory = scratch();
  writeEnv(directory, directory);
  // A test cannot chown a file without root: the file stays ours and the process answers with
  // another uid, which is the same inequality `loadConfig` checks.
  // `getuid` is optional in the types (absent on Windows); POSIX_ONLY keeps this off there.
  const posix = process as { getuid(): number };
  const own = posix.getuid();
  t.mock.method(posix, "getuid", () => own + 1);
  assert.throws(
    () => load(directory),
    (error: unknown) =>
      error instanceof ConfigError &&
      /must belong to the user running awaydesk/.test(error.message),
  );
});

test("refuses a symlinked env", POSIX_ONLY, () => {
  const directory = scratch();
  const real = writeEnv(directory, directory);
  const linkDirectory = join(directory, "link");
  mkdirSync(linkDirectory);
  symlinkSync(real, join(linkDirectory, ".env"));
  assert.throws(
    () => load(linkDirectory),
    (error: unknown) => error instanceof ConfigError && /regular file/.test(error.message),
  );
});

test("missing env points to the setup guide", () => {
  assert.throws(
    () => load(scratch()),
    (error: unknown) => error instanceof ConfigError && /docs\/setup\.md/.test(error.message),
  );
});

test("names every missing variable", () => {
  const directory = scratch();
  writeEnv(directory, directory, { SLACK_APP_TOKEN: "", SLACK_OWNER_USER_ID: "" });
  assert.throws(
    () => load(directory),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("SLACK_APP_TOKEN, SLACK_OWNER_USER_ID"),
  );
});

test("expands a tilde root", POSIX_ONLY, () => {
  // `os.homedir()` reads $HOME on POSIX, as Python's `Path.home()` does.
  const directory = scratch();
  mkdirSync(join(directory, "code"));
  const home = process.env.HOME;
  process.env.HOME = directory;
  try {
    writeEnv(directory, "~/code");
    assert.equal(load(directory).allowedRoot, join(directory, "code"));
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

test("rejects a root that is not a directory", () => {
  const directory = scratch();
  writeEnv(directory, join(directory, "nowhere"));
  assert.throws(
    () => load(directory),
    (error: unknown) => error instanceof ConfigError && /ALLOWED_ROOT/.test(error.message),
  );
});

// Review round 2026-10-11: a relative `ALLOWED_ROOT` was read from the working directory, which
// is the terminal's folder at Checkpoint 2 and `/` under launchd.

test("a relative root is refused whatever the working directory", POSIX_ONLY, () => {
  const directory = scratch();
  mkdirSync(join(directory, "proj"));
  writeEnv(directory, "proj");
  const before = process.cwd();
  try {
    // Once from the folder that holds `proj`, where it used to load, once from `/`.
    for (const cwd of [directory, "/"]) {
      process.chdir(cwd);
      assert.throws(
        () => load(directory),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message ===
            'ALLOWED_ROOT must be an absolute path, or one starting with ~/; it is "proj"',
      );
    }
  } finally {
    process.chdir(before);
  }
});

test("a root that names another user or the current folder is refused", POSIX_ONLY, () => {
  const directory = scratch();
  for (const value of ["./proj", "../proj", ".", "~alice/proj"]) {
    writeEnv(directory, value);
    assert.throws(
      () => load(directory),
      (error: unknown) =>
        error instanceof ConfigError && error.message.endsWith(`; it is "${value}"`),
      value,
    );
  }
});

test("a tilde root and an absolute root still load", POSIX_ONLY, () => {
  const directory = scratch();
  mkdirSync(join(directory, "proj"));
  writeEnv(directory, join(directory, "proj"));
  assert.equal(load(directory).allowedRoot, join(directory, "proj"));
  const home = process.env.HOME;
  process.env.HOME = directory;
  try {
    writeEnv(directory, "~/proj");
    assert.equal(load(directory).allowedRoot, join(directory, "proj"));
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

test("repr never shows a token", () => {
  // The closest ways a TypeScript object reaches a log line: `inspect` and JSON.
  const directory = scratch();
  writeEnv(directory, directory);
  const config = load(directory);
  for (const text of [inspect(config), JSON.stringify(config), `${JSON.stringify(config)}`]) {
    assert.ok(!text.includes(BOT) && !text.includes(APP));
  }
  assert.equal(config.chatVariables.SLACK_BOT_TOKEN, BOT);
  assert.equal(config.chatVariables.SLACK_APP_TOKEN, APP);
});

test("does not touch the process environment", () => {
  const directory = scratch();
  writeEnv(directory, directory);
  load(directory);
  assert.ok(!("SLACK_BOT_TOKEN" in process.env));
});

// Review round 2026-10-10: `ALLOWED_ROOT` is made absolute as text and resolved on the disk, so a
// `..` after a link is followed from where the link leads, as Python's `Path.resolve()` does.

/** `root/link` leads to `elsewhere/deep`; Python resolves `root/link/..` to `elsewhere`. */
function linkLayout(): string {
  const directory = scratch();
  mkdirSync(join(directory, "root"));
  mkdirSync(join(directory, "elsewhere", "deep"), { recursive: true });
  symlinkSync(join("..", "elsewhere", "deep"), join(directory, "root", "link"));
  return directory;
}

test("a root with dot dot after a link is followed from the link s target", POSIX_ONLY, () => {
  const directory = linkLayout();
  // Written as text: `join` would fold the `..` before the disk is asked.
  writeEnv(directory, `${directory}/root/link/..`);
  assert.equal(load(directory).allowedRoot, join(directory, "elsewhere"));
});

test(
  "a tilde root with dot dot after a link is followed from the link s target",
  POSIX_ONLY,
  () => {
    const directory = linkLayout();
    const home = process.env.HOME;
    process.env.HOME = join(directory, "root");
    try {
      writeEnv(directory, "~/link/..");
      assert.equal(load(directory).allowedRoot, join(directory, "elsewhere"));
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  },
);

test("a root whose tail does not exist keeps the link s target", POSIX_ONLY, () => {
  // Python: `root/link/../nothere` resolves to `elsewhere/nothere`; that folder is absent, so the
  // root is refused with the resolved path in the message.
  const directory = linkLayout();
  writeEnv(directory, `${directory}/root/link/../nothere`);
  assert.throws(
    () => load(directory),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        `ALLOWED_ROOT is not a directory: ${join(directory, "elsewhere", "nothere")}`,
  );
});

test("a root whose missing part is followed by dot dot folds it as Python does", POSIX_ONLY, () => {
  // Python: `root/missing/../deep` resolves to `root/deep`.
  const directory = linkLayout();
  mkdirSync(join(directory, "root", "deep"));
  writeEnv(directory, `${directory}/root/missing/../deep`);
  assert.equal(load(directory).allowedRoot, join(directory, "root", "deep"));
});

// Review round 2026-10-10: python-dotenv, whose reading the loader follows, expands `${NAME}` and
// `${NAME:-default}` by default. The sample below is a scratch file read by python-dotenv 1.2.4
// (`dotenv_values`, interpolate on) with the process environment set to PROC below; each expected
// value is what it returned. A name resolves from the file's earlier values, then the process
// environment, then its default, then to nothing; a `$` that is not `${...}` stays.
const PROC: Record<string, string> = {
  HOME: "/h",
  EMPTY_PROC: "",
  PROC_ONLY: "fromproc",
  EARLIER: "procearlier",
  LATER: "proclater",
};

const DOTENV_SAMPLE = `A_HOME=\${HOME}/code
EARLIER=one
USES_EARLIER=\${EARLIER}-x
USES_LATER=\${LATER}-y
LATER=two
UNSET=\${NOPE_NOT_SET}|
DEF=\${NOPE_NOT_SET:-d}|
DEF_SET=\${EARLIER:-d}|
DEF_EMPTY=\${EMPTY_PROC:-d}|
NOBRACE=$HOME/x
DOLLAR=tok$en$
DOLLAR2=a$
SQ='\${HOME}/sq'
DQ="\${HOME}/dq"
BADCOLON=\${HOME:x}
NESTED=\${A:-\${HOME}}
EMPTYNAME=\${}|
EMPTYDEFNAME=\${:-zz}|
SELF=\${SELF}x
PROTO=\${constructor}|\${__proto__}|\${toString:-t}|
MULTI=\${HOME}\${HOME}
SPACE= \${HOME} 
ESC=\\\${HOME}
FROM_PROC=\${PROC_ONLY}!\${EARLIER}
export EXPORTED=\${HOME}/e
LAST_KEY=\${HOME}
`;

const DOTENV_EXPECTED: Record<string, string> = {
  A_HOME: "/h/code",
  EARLIER: "one",
  USES_EARLIER: "one-x",
  USES_LATER: "proclater-y",
  LATER: "two",
  UNSET: "|",
  DEF: "d|",
  DEF_SET: "one|",
  DEF_EMPTY: "|",
  NOBRACE: "$HOME/x",
  DOLLAR: "tok$en$",
  DOLLAR2: "a$",
  SQ: "/h/sq",
  DQ: "/h/dq",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${...}` of a .env value
  BADCOLON: "${HOME:x}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${...}` of a .env value
  NESTED: "${HOME}",
  EMPTYNAME: "|",
  EMPTYDEFNAME: "zz|",
  SELF: "x",
  PROTO: "||t|",
  MULTI: "/h/h",
  SPACE: "/h",
  ESC: "\\/h",
  FROM_PROC: "fromproc!one",
  EXPORTED: "/h/e",
  LAST_KEY: "/h",
};

for (const [key, expected] of Object.entries(DOTENV_EXPECTED)) {
  test(`an env value is expanded as python-dotenv does [${key}]`, () => {
    assert.equal(expandEnv(DOTENV_SAMPLE, PROC)[key], expected);
  });
}

// The reading is Node's `util.parseEnv`, and `docs/setup.md` and the comment of `expandEnv` state
// where it differs from python-dotenv 1.2.1 (measured 2026-10-11 on Node 26.5.1).
const NODE_READS: ReadonlyArray<readonly [name: string, text: string, expected: string]> = [
  ["a # with no space before it starts a comment", "A=a#b", "a"],
  ["a value that is only a comment is empty", "A= # note", ""],
  ["a backslash and a t in double quotes stay two characters", 'A="x\\ty"', "x\\ty"],
  ["two backslashes in double quotes stay two", 'A="x\\\\y"', "x\\\\y"],
  ["a backslash in single quotes is kept", "A='x\\ny'", "x\\ny"],
  ["a quote after a backslash still ends the value", 'A="a\\"b"', "a\\"],
  ["\\n in double quotes is a line break", 'A="x\\ny"', "x\ny"],
];

for (const [name, text, expected] of NODE_READS) {
  test(`the file is read as Node reads it: ${name}`, () => {
    assert.equal(expandEnv(text, {}).A, expected);
  });
}

test("a name with a space, text after a quote and an unclosed quote are read, not skipped", () => {
  assert.equal(expandEnv("KEY WITH SPACE=1", {})["KEY WITH SPACE"], "1");
  assert.equal(expandEnv('B="p"q', {}).B, "p");
  assert.equal(expandEnv('A="open\nB=2', {}).A, '"open');
});

test("an env is expanded to the keys python-dotenv returned", () => {
  assert.deepEqual(expandEnv(DOTENV_SAMPLE, PROC), DOTENV_EXPECTED);
});

test("the root is read from the process environment by default", POSIX_ONLY, () => {
  const directory = scratch();
  mkdirSync(join(directory, "code"));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${...}` of a .env value
  writeEnv(directory, "${HOME}/code");
  assert.equal(load(directory, { HOME: directory }).allowedRoot, join(directory, "code"));
});

test("a root named by a variable defined earlier in the file", () => {
  const directory = scratch();
  mkdirSync(join(directory, "code"));
  const env = writeEnv(directory, directory);
  writeFileSync(env, `BASE=${directory}\n${readFileSync(env, "utf8")}`, { mode: 0o600 });
  writeFileSync(
    env,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${...}` of a .env value
    readFileSync(env, "utf8").replace(/^ALLOWED_ROOT=.*$/m, "ALLOWED_ROOT=${BASE}/code"),
  );
  assert.equal(load(directory, {}).allowedRoot, join(directory, "code"));
});

test("expanding an env never touches the process environment", () => {
  const before = { ...process.env };
  expandEnv(DOTENV_SAMPLE, PROC);
  assert.deepEqual({ ...process.env }, before);
});

// The agent and the chat are selected by name, and each gets only the variables it names.

const MODULES: Modules = {
  defaults: { agent: "alpha", chat: "delta" },
  agents: {
    alpha: { required: ["ALPHA_KEY"], optional: ["ALPHA_EXTRA"] },
    beta: { required: [], optional: [] },
  },
  chats: {
    delta: { required: ["DELTA_KEY", "DELTA_USER"], optional: ["DELTA_EXTRA"] },
    gamma: { required: ["GAMMA_KEY"], optional: [] },
  },
};

/** Writes a private `.env` holding `lines` and returns the directory (its own ALLOWED_ROOT). */
function envWith(...lines: string[]): string {
  const directory = scratch();
  const env = join(directory, ".env");
  writeFileSync(env, `${lines.join("\n")}\n`);
  chmodSync(env, 0o600);
  return directory;
}

/** What the file holds for the two modules `MODULES` selects by default. */
function defaultLines(directory = "/", ...more: string[]): string[] {
  return [
    `ALLOWED_ROOT=${directory}`,
    "ALPHA_KEY=a-secret",
    "DELTA_KEY=d-secret",
    "DELTA_USER=d-user",
    ...more,
  ];
}

test("absent selection variables mean the registry's defaults", () => {
  const config = loadConfig(MODULES, envWith(...defaultLines()));
  assert.equal(config.agent, "alpha");
  assert.equal(config.chat, "delta");
});

test("the selection variables pick the modules and each gets only its own variables", () => {
  const directory = envWith(
    ...defaultLines("/", "AWAYDESK_AGENT=beta", "AWAYDESK_CHAT=gamma", "GAMMA_KEY=g-secret"),
  );
  const config = loadConfig(MODULES, directory);
  assert.equal(config.agent, "beta");
  assert.equal(config.chat, "gamma");
  assert.equal(config.chatVariables.GAMMA_KEY, "g-secret");
  assert.equal(config.chatVariables.DELTA_KEY, undefined);
  assert.equal(config.agentVariables.ALPHA_KEY, undefined); // beta reads none
});

test("a blank selection variable counts as absent", () => {
  const config = loadConfig(MODULES, envWith(...defaultLines("/", "AWAYDESK_AGENT=  ")));
  assert.equal(config.agent, "alpha");
});

test("a name the registry does not hold stops the start with the variable, the value and the valid names", () => {
  const refusal = (line: string): string => {
    try {
      loadConfig(MODULES, envWith(...defaultLines("/", line)));
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      return error.message;
    }
    return assert.fail("the start was not refused");
  };
  assert.equal(
    refusal("AWAYDESK_AGENT=zeta"),
    'AWAYDESK_AGENT is "zeta", which this daemon does not hold; the valid names are: alpha, beta',
  );
  assert.equal(
    refusal("AWAYDESK_CHAT=toString"),
    'AWAYDESK_CHAT is "toString", which this daemon does not hold; the valid names are: delta, gamma',
  );
});

test("a missing module variable is named with the chat's first, then the agent's, then the root", () => {
  const directory = envWith("AWAYDESK_CHAT=delta");
  assert.throws(
    () => loadConfig(MODULES, directory),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        `missing in ${join(directory, ".env")}: DELTA_KEY, DELTA_USER, ALPHA_KEY, ALLOWED_ROOT`,
  );
});

test("the shipped registry misses its variables in the order of the old messages", () => {
  const directory = envWith("# nothing set");
  assert.throws(
    () => load(directory),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        `missing in ${join(directory, ".env")}: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_OWNER_USER_ID, ALLOWED_ROOT`,
  );
});

test("a module's variables give their value on lookup and show nothing otherwise", () => {
  const config = loadConfig(MODULES, envWith(...defaultLines("/", "ALPHA_EXTRA=a-extra")));
  for (const [variables, name, value] of [
    [config.agentVariables, "ALPHA_KEY", "a-secret"],
    [config.agentVariables, "ALPHA_EXTRA", "a-extra"],
    [config.chatVariables, "DELTA_KEY", "d-secret"],
    [config.chatVariables, "DELTA_USER", "d-user"],
  ] as const) {
    assert.equal(variables[name], value);
    assert.deepEqual(Object.keys(variables), []);
    assert.deepEqual(Object.entries({ ...variables }), []);
    assert.equal(JSON.stringify(variables), "{}");
    assert.ok(!inspect(variables).includes(value));
    assert.ok(!inspect(variables, { depth: null }).includes(value));
  }
  // Nor does the object they hang on show them, in any of the ways a log line reaches it.
  for (const text of [inspect(config), JSON.stringify(config), JSON.stringify({ ...config })]) {
    for (const secret of ["a-secret", "a-extra", "d-secret", "d-user"]) {
      assert.ok(!text.includes(secret), `${secret} is shown`);
    }
  }
});

test("a variable the module did not name is not handed to it", () => {
  const config = loadConfig(MODULES, envWith(...defaultLines("/", "GAMMA_KEY=g-secret")));
  assert.equal(config.chatVariables.GAMMA_KEY, undefined);
  assert.equal(config.agentVariables.DELTA_KEY, undefined);
});
