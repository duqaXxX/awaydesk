/**
 * The agent and the chat are selected, never constructed: `src/main.ts` reads two names from the
 * configuration and takes each module from a registry.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AgentEntry } from "../src/agent/seam.ts";
import { ConfigError } from "../src/core/config.ts";
import type { ChatEntry } from "../src/core/port.ts";
import { run } from "../src/main.ts";
import type { Registry } from "../src/registry.ts";
import { World } from "./scenario/world.ts";
import { say } from "./support/plain-agent.ts";
import { FakeAgentBackend } from "./support/sessions.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");

test("main imports neither a back end nor a provider", () => {
  const source = readFileSync(MAIN, "utf8");
  const modules = [...source.matchAll(/from\s+"(\.\/(?:agent\/claude|chat\/slack)\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(modules, []);
});

test("the plain agent and the memory chat, named in the configuration, run a session", async (t) => {
  // Four entries, and the registry's defaults point at the two that must not be built: only the
  // `.env` of the config folder (`AWAYDESK_AGENT=plain`, `AWAYDESK_CHAT=memory`) can choose.
  const built: string[] = [];
  const world = World.make(t, {
    defaults: { agent: "other-agent", chat: "other-chat" },
    more: {
      agents: {
        "other-agent": {
          required: [],
          optional: [],
          build: () => {
            built.push("other-agent");
            throw new Error("an agent the configuration did not name was built");
          },
        },
      },
      chats: {
        "other-chat": {
          required: [],
          optional: [],
          build: async () => {
            built.push("other-chat");
            throw new Error("a chat the configuration did not name was built");
          },
        },
      },
    },
  });
  assert.deepEqual(
    [Object.keys(world.registry.agents), Object.keys(world.registry.chats)],
    [
      ["plain", "other-agent"],
      ["memory", "other-chat"],
    ],
  );
  const env = readFileSync(join(world.config, ".env"), "utf8");
  assert.match(env, /^AWAYDESK_AGENT=plain$/m);
  assert.match(env, /^AWAYDESK_CHAT=memory$/m);

  await world.start();
  world.script(say("Hello from the plain agent."));
  const thread = await world.open("one message");
  await world.ended(thread);

  assert.deepEqual(built, []);
  assert.equal(world.entry.built.length, 1);
  assert.deepEqual(world.prompts(), ["one message"]);
  assert.equal(world.shown(thread).at(-1), `Hello from the plain agent.\nfull · ${world.folder}`);
  await world.finish();
  // The names the run wrote are the two it was given.
  const written = JSON.parse(readFileSync(world.state, "utf8")) as Record<string, unknown>;
  assert.deepEqual([written.agent, written.chat], ["plain", "memory"]);
});

/** A configuration directory whose `.env` holds `lines` and `ALLOWED_ROOT` (mode 600). */
function configDirectory(t: TestContext, ...lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "awaydesk-selection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = join(dir, ".env");
  writeFileSync(env, [`ALLOWED_ROOT=${dir}`, ...lines].join("\n"));
  chmodSync(env, 0o600);
  return dir;
}

/** What a registry of fakes saw: each entry built, as its name and the value of its required variable. */
interface Built {
  readonly agents: Array<readonly [name: string, value: string | undefined]>;
  readonly chats: Array<readonly [name: string, value: string | undefined]>;
}

const STOPPED = new Error("the fake chat ends the start");

/**
 * Two agents and two chats. The agents build the scripted fake back end; the chats refuse to be
 * built, so `run` ends once both were chosen. `first` and `one` are the defaults; `second` and
 * `two` each require one variable.
 */
function registryOf(built: Built): Registry {
  const agent = (name: string, key?: string): AgentEntry => ({
    required: key === undefined ? [] : [key],
    optional: [],
    build: ({ variables }) => {
      built.agents.push([name, key === undefined ? undefined : variables[key]]);
      return new FakeAgentBackend([]);
    },
  });
  const chat = (name: string, key?: string): ChatEntry => ({
    required: key === undefined ? [] : [key],
    optional: [],
    build: async ({ variables }) => {
      built.chats.push([name, key === undefined ? undefined : variables[key]]);
      throw STOPPED;
    },
  });
  return {
    agents: { first: agent("first"), second: agent("second", "SECOND_KEY") },
    chats: { one: chat("one"), two: chat("two", "TWO_KEY") },
    defaults: { agent: "first", chat: "one" },
  };
}

test("absent variables select the registry's defaults", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(t);
  await assert.rejects(run({ configDir: dir, registry: registryOf(built) }), STOPPED);
  assert.deepEqual(built, { agents: [["first", undefined]], chats: [["one", undefined]] });
});

test("the two variables select the modules and each gets its own variables", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(
    t,
    "AWAYDESK_AGENT=second",
    "AWAYDESK_CHAT=two",
    "SECOND_KEY=agent-value",
    "TWO_KEY=chat-value",
  );
  await assert.rejects(run({ configDir: dir, registry: registryOf(built) }), STOPPED);
  assert.deepEqual(built, {
    agents: [["second", "agent-value"]],
    chats: [["two", "chat-value"]],
  });
});

test("a variable a module requires and the file lacks stops the start before it is built", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(t, "AWAYDESK_AGENT=second", "AWAYDESK_CHAT=two");
  await assert.rejects(
    run({ configDir: dir, registry: registryOf(built) }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === `missing in ${join(dir, ".env")}: TWO_KEY, SECOND_KEY`,
  );
  assert.deepEqual(built, { agents: [], chats: [] });
});

test("a name the registry does not hold stops the start with the valid ones", async (t) => {
  for (const [line, message] of [
    [
      "AWAYDESK_AGENT=third",
      'AWAYDESK_AGENT is "third", which this daemon does not hold; the valid names are: first, second',
    ],
    [
      "AWAYDESK_CHAT=three",
      'AWAYDESK_CHAT is "three", which this daemon does not hold; the valid names are: one, two',
    ],
  ] as const) {
    const built: Built = { agents: [], chats: [] };
    const dir = configDirectory(t, line);
    await assert.rejects(
      run({ configDir: dir, registry: registryOf(built) }),
      (error: unknown) => error instanceof ConfigError && error.message === message,
    );
    assert.deepEqual(built, { agents: [], chats: [] });
  }
});

test("a state.json written for other modules stops the start naming both pairs", async (t) => {
  const built: Built = { agents: [], chats: [] };
  const dir = configDirectory(t, "AWAYDESK_AGENT=second", "SECOND_KEY=x");
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ version: 3, agent: "first", chat: "one", channels: {} }));
  await assert.rejects(
    run({ configDir: dir, registry: registryOf(built) }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "StateError" &&
      error.message.includes("belongs to other modules") &&
      error.message.includes('agent "first"') &&
      error.message.includes('agent "second"') &&
      error.message.includes('chat "one"'),
  );
  assert.deepEqual(built, { agents: [], chats: [] });
});
