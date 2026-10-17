/**
 * The dependency rule of the three layers, read off the imports, written by layer so that it holds
 * for a module that does not exist yet. A module is a directory under `src/agent/` or
 * `src/chat/`. The core imports no module; a module imports no other module; only `daemon.ts`
 * imports `registry.ts`, which is the one file outside a module that imports one; only `main.ts`
 * imports `daemon.ts`, and nothing imports `main.ts`; a package is imported only by the module
 * that lists it in `LIBRARIES`. The host layer (`src/host/`: the machine the daemon is installed
 * on) imports none of the layers, and none of them imports it: the entry files above the layers
 * do.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { test } from "node:test";
import { blank } from "./support/source-scan.ts";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * The packages each module imports, as the start of a specifier. This is the one table that is
 * per module by nature: a new module adds its line, and an import of a package no line lists is
 * refused.
 */
export const LIBRARIES: Readonly<Record<string, readonly string[]>> = {
  "agent/claude": ["@anthropic-ai/claude-agent-sdk"],
  "chat/slack": ["@slack/"],
};

const AGENT_SDK = "@anthropic-ai/claude-agent-sdk";

// A static import or re-export, or a call of `import(` or `require(` whose specifier is a plain
// string or a template with nothing in it.
const IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|(?<![.\w$])(?:import|require)\s*\(\s*(?:["']([^"']+)["']|`([^`$]+)`)\s*\)/g;

/** The module specifiers a source text imports, re-exports or loads. */
export function imported(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((match) => (match[1] ?? match[2] ?? match[3]) as string);
}

const LOADER_CALL = /(?<![.\w$])(?:import|require)\s*\(/g;
const LITERAL_ARGUMENT = /^\s*(?:"[^"\\\n]*"|'[^'\\\n]*'|`[^`$\\]*`)\s*\)/;

/**
 * What a source text does that the scan cannot read: a call of `import(` or `require(` whose
 * specifier is not a literal, and `createRequire` anywhere. Comments are exempt.
 */
export function unreadable(source: string): string[] {
  const code = blank(source, { keepText: true });
  const found: string[] = [];
  for (const call of code.matchAll(LOADER_CALL)) {
    const rest = code.slice((call.index ?? 0) + call[0].length);
    if (!LITERAL_ARGUMENT.test(rest))
      found.push(`${call[0].trim()}...: the specifier is not a literal`);
  }
  if (/\bcreateRequire\b/.test(code)) found.push("createRequire loads what the scan cannot read");
  return found;
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The module a path under `src/` belongs to (`agent/claude`), or null for any other file. */
function moduleOf(path: string): string | null {
  return /^((?:agent|chat)\/[^/]+)\//.exec(path)?.[1] ?? null;
}

/** `file`, a path under `src/` with forward slashes, may import `specifier`: null, or why not. */
export function refusal(file: string, specifier: string): string | null {
  const own = moduleOf(file);
  if (!specifier.startsWith(".")) {
    if (specifier.startsWith("node:")) return null;
    const listed =
      own !== null && (LIBRARIES[own] ?? []).some((name) => specifier.startsWith(name));
    return listed ? null : "a package is imported only by the module that lists it in LIBRARIES";
  }
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  const there = moduleOf(target);
  if (there !== null && there !== own && file !== "registry.ts") {
    return "a module is imported by itself and by the registry alone";
  }
  if (target === "registry.ts" && file !== "daemon.ts") {
    return "only daemon.ts imports the registry";
  }
  if (target === "daemon.ts" && file !== "main.ts") return "only main.ts imports daemon.ts";
  if (target === "main.ts") return "nothing imports main.ts";
  if (file.startsWith("agent/") && /^(chat|core)\//.test(target)) {
    return "the agent module imports neither the chat module nor the core";
  }
  if (file.startsWith("host/") && /^(agent|chat|core)\//.test(target)) {
    return "the host layer imports no module, no seam and nothing of the core";
  }
  if (/^(agent|chat|core)\//.test(file) && target.startsWith("host/")) {
    return "the host layer is imported by the entry files alone";
  }
  if (/^(agent|chat)\/seam\.ts$/.test(file) && target.startsWith("core/")) {
    return "a seam imports nothing of the core";
  }
  if (file.startsWith("chat/") && target.startsWith("core/") && target !== "core/port.ts") {
    return "a chat provider imports the core's port, and nothing else of the core";
  }
  return null;
}

test("the scan reads every form of import", () => {
  const source = [
    'import a from "one";',
    'import type { B } from "two";',
    'import { c,\n  d } from "three";',
    'import "four";',
    'export { e } from "five";',
    'export * from "six";',
    'const f = await import("seven");',
    'const g = require("eight");',
    "const h = await import(`nine`);",
    'const text = "import nothing";',
  ].join("\n");
  assert.deepEqual(imported(source), [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
  ]);
});

test("the scan fails on a load whose specifier it cannot read", () => {
  assert.deepEqual(unreadable('const a = await import("./one.ts"); const b = require(`two`);'), []);
  assert.equal(unreadable("const a = await import(name);").length, 1);
  // A template with an expression in it is no literal.
  assert.equal(unreadable(["const a = await import(`../$", "{name}.ts`);"].join("")).length, 1);
  assert.equal(unreadable('const a = await import("./" + name);').length, 1);
  assert.equal(unreadable("const a = require(path);").length, 1);
  assert.equal(unreadable('import { createRequire } from "node:module";').length, 1);
  assert.equal(unreadable("const load = createRequire(import.meta.url);").length, 1);
  // A comment may name them; a method of another name or a type is no load.
  assert.deepEqual(unreadable("// import(name) and createRequire\nconst a = x.import(name);"), []);
  assert.deepEqual(unreadable("const a = reimport(name) + importance(1);"), []);
});

test("the rule refuses a library outside the module that lists it", () => {
  assert.ok(refusal("core/sessions.ts", AGENT_SDK));
  assert.ok(refusal("core/sessions.ts", "@slack/web-api"));
  assert.ok(refusal("chat/slack/app.ts", AGENT_SDK));
  assert.ok(refusal("agent/claude/session.ts", "@slack/bolt"));
  assert.ok(refusal("daemon.ts", `${AGENT_SDK}/sdk-tools`));
  assert.ok(refusal("agent/seam.ts", AGENT_SDK));
});

test("the rule refuses a package of a module that has no line in the table", () => {
  assert.ok(refusal("agent/codex/session.ts", "@openai/codex-sdk"));
  assert.ok(refusal("chat/discord/thread.ts", "discord.js"));
  assert.ok(refusal("chat/discord/thread.ts", "@slack/web-api"));
  assert.ok(refusal("core/state.ts", "left-pad"));
});

test("the rule lets a module import its own library, and any file a built-in", () => {
  assert.equal(refusal("agent/claude/session.ts", AGENT_SDK), null);
  assert.equal(refusal("agent/claude/session.ts", `${AGENT_SDK}/sdk-tools`), null);
  assert.equal(refusal("chat/slack/app.ts", "@slack/bolt"), null);
  assert.equal(refusal("chat/slack/app/requests.ts", "@slack/web-api"), null);
  assert.equal(refusal("core/state.ts", "node:fs"), null);
  assert.equal(refusal("daemon.ts", "node:path"), null);
});

test("the core imports no module, whichever it is", () => {
  assert.ok(refusal("core/sessions/session.ts", "../../agent/claude/session.ts"));
  assert.ok(refusal("core/sessions/session.ts", "../../agent/codex/session.ts"));
  assert.ok(refusal("core/reply/renderer.ts", "../../chat/slack/reply/sinks.ts"));
  assert.ok(refusal("core/sessions/session.ts", "../../chat/discord/thread.ts"));
});

test("a module imports no other module, of its layer or of the other", () => {
  assert.ok(refusal("agent/codex/session.ts", "../claude/trust.ts"));
  assert.ok(refusal("chat/discord/thread.ts", "../slack/reply/sinks.ts"));
  assert.ok(refusal("chat/discord/thread.ts", "../../agent/codex/session.ts"));
  assert.ok(refusal("chat/slack/app.ts", "../../agent/claude/session.ts"));
  assert.ok(refusal("agent/claude/session.ts", "../../chat/slack/thread.ts"));
  assert.ok(refusal("agent/seam.ts", "./claude/session.ts"));
  assert.ok(refusal("daemon.ts", "./agent/claude/backend.ts"));
});

test("the host layer and the other layers do not import each other", () => {
  assert.ok(refusal("host/program.ts", "../core/config.ts"));
  assert.ok(refusal("host/service/launchd.ts", "../../agent/seam.ts"));
  assert.ok(refusal("host/program.ts", "../chat/slack/module.ts"));
  assert.ok(refusal("core/flows/words.ts", "../../host/program.ts"));
  assert.ok(refusal("chat/slack/home.ts", "../../host/program.ts"));
  assert.ok(refusal("agent/claude/session.ts", "../../host/program.ts"));
  assert.ok(refusal("host/program.ts", "left-pad"));
  assert.equal(refusal("cli.ts", "./host/program.ts"), null);
  assert.equal(refusal("daemon.ts", "./host/program.ts"), null);
  assert.equal(refusal("host/service/launchd.ts", "../program.ts"), null);
  assert.equal(refusal("host/program.ts", "node:fs"), null);
  // The version file is above the layers: any of them may read it.
  assert.equal(refusal("host/service/launchd.ts", "../../version.ts"), null);
});

test("only daemon.ts imports the registry, only main.ts imports daemon.ts, nothing imports main.ts", () => {
  assert.ok(refusal("core/sessions/session.ts", "../../registry.ts"));
  assert.ok(refusal("chat/slack/thread.ts", "../../registry.ts"));
  assert.ok(refusal("agent/claude/session.ts", "../../registry.ts"));
  assert.ok(refusal("core/sessions/session.ts", "../../main.ts"));
  assert.ok(refusal("registry.ts", "./main.ts"));
  assert.ok(refusal("main.ts", "./registry.ts"));
  assert.ok(refusal("cli.ts", "./daemon.ts"));
  assert.ok(refusal("registry.ts", "./daemon.ts"));
  assert.equal(refusal("main.ts", "./daemon.ts"), null);
  assert.equal(refusal("main.ts", "./node-version.ts"), null);
  assert.ok(refusal("chat/slack/module.ts", "../../main.ts"));
  assert.equal(refusal("daemon.ts", "./registry.ts"), null);
});

test("the registry imports the modules, and a module its own files and the seams", () => {
  assert.equal(refusal("registry.ts", "./agent/claude/module.ts"), null);
  assert.equal(refusal("registry.ts", "./chat/slack/module.ts"), null);
  assert.equal(refusal("registry.ts", "./agent/codex/module.ts"), null);
  assert.equal(refusal("agent/claude/session.ts", "./translate.ts"), null);
  assert.equal(refusal("chat/slack/app/requests.ts", "../reply/errors.ts"), null);
  assert.equal(refusal("core/sessions.ts", "../agent/seam.ts"), null);
  assert.equal(refusal("core/sessions.ts", "../chat/seam.ts"), null);
  assert.equal(refusal("chat/slack/requests.ts", "../../agent/seam.ts"), null);
  assert.equal(refusal("chat/discord/thread.ts", "../../agent/seam.ts"), null);
  assert.equal(refusal("chat/slack/app.ts", "../../core/port.ts"), null);
});

test("the agent module, the seams and a chat provider keep to what they may import of the core", () => {
  assert.ok(refusal("agent/claude/session.ts", "../../core/state.ts"));
  assert.ok(refusal("agent/codex/session.ts", "../../chat/seam.ts"));
  assert.ok(refusal("chat/slack/app.ts", "../../core/state.ts"));
  assert.ok(refusal("chat/discord/thread.ts", "../../core/state.ts"));
  assert.ok(refusal("chat/slack/home.ts", "../../core/port/home.ts"));
  assert.ok(refusal("chat/seam.ts", "../core/port.ts"));
});

test("every source file keeps the dependency rule", () => {
  const files = sources(SRC);
  assert.ok(files.length > 0);
  const broken: string[] = [];
  for (const path of files) {
    const file = relative(SRC, path).split(sep).join("/");
    const source = readFileSync(path, "utf8");
    for (const specifier of imported(source)) {
      const why = refusal(file, specifier);
      if (why !== null) broken.push(`${file} imports ${specifier}: ${why}`);
    }
    for (const why of unreadable(source)) broken.push(`${file}: ${why}`);
  }
  assert.deepEqual(broken, []);
});

test("a relative import names its file with the .ts extension", () => {
  // Node runs the sources as they are, and resolves no extension by itself.
  const bare: string[] = [];
  for (const path of [...sources(SRC), ...sources(dirname(import.meta.filename))]) {
    for (const specifier of imported(readFileSync(path, "utf8"))) {
      if (specifier.startsWith(".") && !/\.(ts|json)$/.test(specifier)) {
        bare.push(`${relative(SRC, path)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(bare, []);
});
