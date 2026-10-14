/**
 * The plain agent's own behaviour: what it declares, and how a test scripts it. The seam's
 * promises are checked against it in `test/conformance/agent.test.ts`; here, only what is the
 * plain agent's to say.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  AgentSession,
  PermissionAnswer,
  Prompt,
  QuestionAnswer,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../../src/agent/seam.ts";
import { ResumeRefused } from "../../src/agent/seam.ts";
import {
  call,
  die,
  PLAIN_CAPABILITIES,
  PLAIN_COMMANDS,
  PLAIN_MODE,
  PlainAgent,
  type PlainSession,
  PlainSessionClosed,
  PlainStore,
  say,
  whole,
} from "./plain-agent.ts";

const LIMIT = { timeout: 5_000 };
const FOLDER = "/srv/alice/app";
const START: StartOptions = {
  folder: FOLDER,
  resume: null,
  settingsSources: ["user", "project", "local"],
  model: null,
  effort: null,
};
let counter = 0;

function prompt(content: string): Prompt {
  counter += 1;
  return { id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, content };
}

function handler(
  permission: PermissionAnswer = { allow: true },
  asked: QuestionAnswer = { answered: false, message: "skipped" },
): RequestHandler {
  return { permission: async () => permission, question: async () => asked };
}

/** The events of the next turn, up to its `turn_ended`. */
async function turnOf(
  iterator: AsyncIterator<SessionEvent>,
  type: SessionEvent["type"] = "turn_ended",
): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false, "the events ended early");
    if (next.done) return seen;
    seen.push(next.value);
    if (next.value.type === type) return seen;
  }
}

async function started(agent: PlainAgent, requests = handler()) {
  const session = (await agent.start(START, requests)) as PlainSession;
  return { session, events: session.events[Symbol.asyncIterator]() };
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type);
}

test("the plain agent declares what the plan's table lists", () => {
  const agent = new PlainAgent();
  assert.deepEqual(agent.capabilities, PLAIN_CAPABILITIES);
  assert.equal(agent.capabilities.effortLevels.length, 2);
  assert.equal(agent.capabilities.liveEffort, false);
  assert.deepEqual(agent.capabilities.permissionModes, {
    default: PLAIN_MODE,
    auto: null,
    bypass: null,
  });
  const lacks = ["subagents", "backgroundTasks", "compaction", "usageLimits", "models"] as const;
  for (const capability of [
    ...lacks,
    "promptDuringTurn",
    "folderTrust",
    "declaredState",
  ] as const) {
    assert.equal(agent.capabilities[capability], false, capability);
  }
  for (const capability of ["questions", "commands", "sessionListing"] as const) {
    assert.equal(agent.capabilities[capability], true, capability);
  }
  assert.equal("usageLimits" in agent, false);
  assert.equal(PLAIN_COMMANDS.length, 2);
  assert.ok(!/claude|anthropic/i.test(`${agent.name} ${JSON.stringify(agent.words)}`));
});

test("the plain agent imports the seam and nothing else of the daemon", () => {
  const source = readFileSync(new URL("./plain-agent.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)], ["../../src/agent/seam.ts"]);
});

test(
  "a turn per prompt, in the order scripted, and a plain ok past the script",
  LIMIT,
  async () => {
    const agent = new PlainAgent().next(say("One.")).next(whole("Two."));
    const { session, events } = await started(agent);
    const texts: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      await session.send(prompt("go"));
      const turn = await turnOf(events);
      texts.push(
        turn
          .flatMap((e) => (e.type === "text_delta" || e.type === "text" ? [e.text] : []))
          .join(""),
      );
    }
    assert.deepEqual(texts, ["One.", "Two.", "ok"]);
    assert.equal(session.prompts.length, 3);
  },
);

test("the session is named with its first prompt, not before, as Claude's is", LIMIT, async () => {
  // The core takes a stored session id for a session that ran (`ThreadSession.neverRan`), and
  // resumes it when a setup needs a fresh client: an id announced earlier has no transcript.
  const agent = new PlainAgent().next(say("One."));
  const { session, events } = await started(agent);
  assert.equal(agent.store.has(FOLDER, session.id), false);
  const first = events.next();
  const early = await Promise.race([
    first.then(() => "an event"),
    new Promise<string>((resolve) => setImmediate(() => resolve("nothing"))),
  ]);
  assert.equal(early, "nothing");
  await session.send(prompt("go"));
  const named = await first;
  assert.ok(!named.done && named.value.type === "session_started");
  await turnOf(events);
  assert.equal(agent.store.has(FOLDER, session.id), true);
});

test("say writes deltas of one message, whole writes one text", LIMIT, async () => {
  const agent = new PlainAgent().next(say("Two words")).next(whole("  Whole.  "));
  const { session, events } = await started(agent);
  await session.send(prompt("a"));
  const first = await turnOf(events);
  assert.deepEqual(types(first), [
    "session_started",
    "message_started",
    "text_started",
    "text_delta",
    "text_delta",
    "message_ended",
    "effort_observed",
    "turn_ended",
  ]);
  await session.send(prompt("b"));
  const second = await turnOf(events);
  assert.deepEqual(
    second.filter((e) => e.type === "text").map((e) => e.type === "text" && e.text),
    ["Whole."],
  );
  const end = second.at(-1);
  assert.ok(end?.type === "turn_ended" && end.finalText === "Whole." && end.steps === 1);
});

test("a handler that throws is a denial", LIMIT, async () => {
  const agent = new PlainAgent().next(call("Shell", {}, { permission: true }));
  const throwing: RequestHandler = {
    permission: () => {
      throw new Error("down");
    },
    question: async () => ({ answered: false, message: "" }),
  };
  const { session, events } = await started(agent, throwing);
  await session.send(prompt("a"));
  const turn = await turnOf(events);
  assert.ok(turn.some((e) => e.type === "call_ended" && e.isError));
});

test("die loses the process: process_lost last, and a send is refused", LIMIT, async () => {
  const agent = new PlainAgent().next(say("Half"), die());
  const { session, events } = await started(agent);
  await session.send(prompt("a"));
  const seen = await turnOf(events, "process_lost");
  assert.equal(seen.at(-1)?.type, "process_lost");
  assert.deepEqual(await events.next(), { done: true, value: undefined });
  await assert.rejects(session.send(prompt("b")), PlainSessionClosed);
  await session.close();
  assert.equal(agent.running.length, 0);
});

test("a command runs without a turn of the script, by its name or its alias", LIMIT, async () => {
  const agent = new PlainAgent().next(say("Scripted."));
  const { session, events } = await started(agent);
  const outputs: string[] = [];
  for (const text of ["/echo hi there", "/say again", "/count a b c", "/nope"]) {
    await session.send(prompt(text));
    const turn = await turnOf(events);
    outputs.push(turn.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""));
    const end = turn.at(-1);
    assert.ok(end?.type === "turn_ended" && end.steps === 0 && end.tokens !== undefined);
  }
  assert.deepEqual(outputs, ["hi there", "again", "3 words", "Unknown command: /nope"]);
  assert.equal(agent.turns.length, 1, "the scripted turn is still waiting");
});

test("the store outlives the agent: a new agent resumes, lists and refuses", LIMIT, async () => {
  const store = new PlainStore();
  const first = new PlainAgent({ store });
  const { session, events } = await started(first);
  await session.send(prompt("Name this one"));
  await turnOf(events);
  await session.close();
  const again = new PlainAgent({ store });
  const [listed] = await again.listSessions(FOLDER);
  assert.deepEqual(
    { id: listed?.id, title: listed?.title },
    { id: session.id, title: "Name this one" },
  );
  assert.deepEqual(await again.aliveSessions(FOLDER), new Set([session.id]));
  assert.deepEqual(await again.listSessions("/srv/alice/other"), []);
  const resumed = await again.start({ ...START, resume: session.id }, handler());
  assert.equal((resumed as PlainSession).id, session.id);
  await resumed.close();
  await assert.rejects(
    again.start({ ...START, resume: "plain-session-99" }, handler()),
    ResumeRefused,
  );
  await assert.rejects(
    again.start({ ...START, folder: "/srv/alice/other", resume: session.id }, handler()),
    ResumeRefused,
  );
});

test(
  "close ends a turn that waits on the owner, and a second close is harmless",
  LIMIT,
  async () => {
    const agent = new PlainAgent().next(call("Shell", {}, { permission: true }));
    const pending: RequestHandler = {
      permission: () => new Promise<PermissionAnswer>(() => undefined),
      question: async () => ({ answered: false, message: "" }),
    };
    const { session, events } = await started(agent, pending);
    await session.send(prompt("a"));
    await turnOf(events, "call_started");
    await session.close();
    await session.close();
    assert.deepEqual(await events.next(), { done: true, value: undefined });
  },
);

test("what a live session cannot do, it refuses", LIMIT, async () => {
  const { session } = (await started(new PlainAgent())) as { session: AgentSession };
  await assert.rejects(session.setEffort("full"));
  await assert.rejects(session.stopTask("task-1"));
  await assert.rejects(session.setModel("some-model"));
  await session.setModel(null);
  await session.setPermissionMode(PLAIN_MODE);
  await assert.rejects(session.setPermissionMode("auto"), RangeError);
  const info = await session.info();
  assert.deepEqual([info.models, info.commands.length, info.permissionMode], [[], 2, PLAIN_MODE]);
  await session.close();
});
