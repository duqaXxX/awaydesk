/**
 * `ClaudeSession` on a fake `query()`, scripted from the recordings under `test/fixtures/sdk/`.
 * `test/support/fake-query.ts` scripts the fake: batches, injected turns, permission calls, hook
 * runs, an end of stream and a failing stream.
 *
 * The SDK's option names are those of the TypeScript SDK 0.3.296 (`sdk.d.ts`).
 * `allow-dangerously-skip-permissions` is the SDK's own option `allowDangerouslySkipPermissions`,
 * which writes the same flag on the command line.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
  ClaudeSession,
  logger,
  SessionClosedError,
  type SessionConfig,
} from "../../../src/agent/claude/session.ts";
import { Translator } from "../../../src/agent/claude/translate.ts";
import type {
  PermissionAnswer,
  PermissionRequest,
  Prompt,
  QuestionAnswer,
  QuestionRequest,
  RequestHandler,
  SessionEvent,
} from "../../../src/agent/seam.ts";
import { ResumeRefused } from "../../../src/agent/seam.ts";
import {
  ask,
  type Batch,
  END,
  type FakeQuery,
  type FakeScript,
  FakeSdk,
  fail,
  hook,
} from "../../support/fake-query.ts";
import { type JsonObject, sdkJson, sdkRecords } from "../../support/fixtures.ts";

const LIMIT = { timeout: 10_000 };
const FOLDER = "/srv/alice/app";
const CONFIG: SessionConfig = {
  folder: FOLDER,
  resume: null,
  settingsSources: ["user", "project", "local"],
  model: null,
  effort: null,
  chrome: false,
};
const PROMPT: Prompt = { id: "00000000-0000-4000-8000-0000000000b1", content: "Say ok" };
const TOOLS = sdkRecords("tools");
const STOP = sdkJson("stop-hook") as JsonObject;
const POST_TOOL_USE = sdkJson("post-tool-use-hook") as JsonObject;
const ASK = sdkJson("ask-can-use-tool") as JsonObject;
const BASH = { command: "echo ok", description: "Print ok" };
const EXITED = "the Claude Code process exited";

// The record of the `tools` turn that holds its first tool call, and the one that answers it.
const FIRST_CALL = TOOLS.findIndex((record) => record.type === "assistant" && hasToolUse(record));

function hasToolUse(record: JsonObject): boolean {
  const message = record.message as JsonObject | undefined;
  const content = message?.content;
  return (
    Array.isArray(content) && content.some((block) => (block as JsonObject).type === "tool_use")
  );
}

/** A handler that records what it is asked and answers with `permission` and `question`. */
function handlerOf(
  permission: PermissionAnswer = { allow: true },
  question: QuestionAnswer = { answered: false, message: "skipped" },
): RequestHandler & { asked: (PermissionRequest | QuestionRequest)[] } {
  const asked: (PermissionRequest | QuestionRequest)[] = [];
  return {
    asked,
    permission: async (request) => {
      asked.push(request);
      return permission;
    },
    question: async (request) => {
      asked.push(request);
      return question;
    },
  };
}

interface Started {
  readonly session: ClaudeSession;
  readonly query: FakeQuery;
  readonly events: AsyncIterator<SessionEvent>;
}

/** A session on a fake query, ready, closed when the test ends. */
async function started(
  t: TestContext,
  script: FakeScript = {},
  config: Partial<SessionConfig> = {},
  requests: RequestHandler = handlerOf(),
): Promise<Started> {
  const sdk = new FakeSdk(script);
  const session = new ClaudeSession({ ...CONFIG, ...config }, requests, sdk.query);
  t.after(() => session.close());
  await session.ready();
  return { session, query: sdk.only, events: session.events[Symbol.asyncIterator]() };
}

/** The events up to and including the first of `type`, or all of them when the stream ends. */
async function until(
  events: AsyncIterator<SessionEvent>,
  type: SessionEvent["type"],
): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for (;;) {
    const next = await events.next();
    if (next.done) return seen;
    seen.push(next.value);
    if (next.value.type === type) return seen;
  }
}

async function drain(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type);
}

// Options.

test(
  "a new session starts Claude Code in its folder with the owner's settings",
  LIMIT,
  async (t) => {
    const { query } = await started(t);
    const { options } = query;
    assert.equal(options.cwd, FOLDER);
    assert.deepEqual(options.settingSources, ["user", "project", "local"]);
    assert.equal(options.includePartialMessages, true);
    // Makes bypass possible, not active.
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.deepEqual(options.extraArgs, { "replay-user-messages": null });
    assert.deepEqual(Object.keys(options).sort(), [
      "allowDangerouslySkipPermissions",
      "canUseTool",
      "cwd",
      "env",
      "extraArgs",
      "hooks",
      "includePartialMessages",
      "settingSources",
      "stderr",
      "systemPrompt",
    ]);
    assert.deepEqual(Object.keys(options.hooks ?? {}).sort(), ["PostToolUse", "Stop"]);
  },
);

// What an interactive session has by default and a session of the SDK does not (measured
// 2026-10-13 on the first request of both, Claude Code 2.1.296, issue #300).

test("a session works under Claude Code's own system prompt", LIMIT, async (t) => {
  const { query } = await started(t);
  assert.deepEqual(query.options.systemPrompt, { type: "preset", preset: "claude_code" });
});

test("a session starts with the defaults of an interactive one", LIMIT, async (t) => {
  const { query } = await started(t);
  const env = query.options.env ?? {};
  assert.equal(env.CLAUDE_CODE_FORK_SUBAGENT, "1");
  assert.equal(env.CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR, "100");
  // `env` replaces the inherited environment: without the daemon's own, no PATH and no HOME.
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
});

test("a variable the daemon's environment sets wins over a default", LIMIT, async (t) => {
  const before = process.env.CLAUDE_CODE_FORK_SUBAGENT;
  process.env.CLAUDE_CODE_FORK_SUBAGENT = "0";
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
    else process.env.CLAUDE_CODE_FORK_SUBAGENT = before;
  });
  const { query } = await started(t);
  assert.equal(query.options.env?.CLAUDE_CODE_FORK_SUBAGENT, "0");
});

test(
  "the owner's variables reach Claude Code as written, over the environment",
  LIMIT,
  async (t) => {
    const before = process.env.BASH_DEFAULT_TIMEOUT_MS;
    process.env.BASH_DEFAULT_TIMEOUT_MS = "1";
    t.after(() => {
      if (before === undefined) delete process.env.BASH_DEFAULT_TIMEOUT_MS;
      else process.env.BASH_DEFAULT_TIMEOUT_MS = before;
    });
    const { query } = await started(t, {}, { variables: { BASH_DEFAULT_TIMEOUT_MS: "21600000" } });
    assert.equal(query.options.env?.BASH_DEFAULT_TIMEOUT_MS, "21600000");
  },
);

test("a session of the daemon's own keeps the SDK's defaults", LIMIT, async (t) => {
  const { query } = await started(t, {}, { bare: true, settingsSources: [] });
  assert.equal("systemPrompt" in query.options, false);
  assert.equal("env" in query.options, false);
});

test("a resumed session passes the stored id, effort and model", LIMIT, async (t) => {
  const { query } = await started(
    t,
    {},
    {
      resume: "68da9311-0000-4000-8000-0000000000aa",
      effort: "high",
      model: "haiku",
    },
  );
  const { options } = query;
  assert.equal(options.resume, "68da9311-0000-4000-8000-0000000000aa");
  assert.equal(options.effort, "high");
  assert.equal(options.model, "haiku");
});

test("the settings sources are those the seam gives", LIMIT, async (t) => {
  const { query } = await started(t, {}, { settingsSources: [] });
  assert.deepEqual(query.options.settingSources, []);
});

test("Chrome adds its flag to the extra arguments, and nothing else", LIMIT, async (t) => {
  const { query } = await started(t, {}, { chrome: true });
  assert.deepEqual(query.options.extraArgs, { "replay-user-messages": null, chrome: null });
});

test("the process's stderr is counted and never logged", LIMIT, async (t) => {
  const lines: string[] = [];
  t.mock.method(logger, "debug", (message: string) => lines.push(message));
  const { query } = await started(t);
  query.options.stderr?.("the conversation, quoted");
  assert.deepEqual(lines, ["claude stderr: 24 chars"]);
});

// Events.

test("a recorded turn gives the events its records give, in order", LIMIT, async (t) => {
  const { session, events } = await started(t, { turns: [TOOLS] });
  await session.send(PROMPT);
  const seen = await until(events, "turn_ended");
  const expected = new Translator();
  const records = TOOLS.flatMap((record) => expected.translate(record));
  // Claude Code's replay of the prompt comes with the turn and is the only addition.
  assert.deepEqual(
    seen.filter((event) => event.type !== "prompt_taken"),
    records,
  );
  assert.equal(seen[0]?.type, "session_started");
  assert.equal(seen.filter((event) => event.type === "turn_ended").length, 1);
  const calls = types(seen).filter((type) => type === "call_started" || type === "call_ended");
  assert.ok(calls.length >= 2);
  assert.equal(calls[0], "call_started");
});

test("a prompt that comes back is prompt_taken, before the words of its turn", LIMIT, async (t) => {
  const { session, query, events } = await started(t, { turns: [TOOLS] });
  await session.send(PROMPT);
  const seen = await until(events, "turn_ended");
  const taken = seen.filter((event) => event.type === "prompt_taken");
  assert.deepEqual(taken, [{ type: "prompt_taken", promptId: PROMPT.id }]);
  assert.ok(types(seen).indexOf("prompt_taken") < types(seen).indexOf("message_started"));
  // The SDK was given one user message, under the prompt's id.
  assert.equal(query.sent.length, 1);
  assert.equal(query.sent[0]?.uuid, PROMPT.id);
  assert.equal(query.sent[0]?.message.content, "Say ok");
  assert.equal(query.sent[0]?.parent_tool_use_id, null);
});

test("a batch nobody asked for gives its events at once", LIMIT, async (t) => {
  const { query, events } = await started(t);
  query.inject(TOOLS);
  const seen = await until(events, "turn_ended");
  assert.equal(seen.at(-1)?.type, "turn_ended");
  assert.equal(
    seen.some((event) => event.type === "prompt_taken"),
    false,
  );
});

test("two prompts get one batch each, in the order they were sent", LIMIT, async (t) => {
  const first = sdkRecords("usage");
  const { session, events } = await started(t, { turns: [first, TOOLS] });
  await session.send({ id: "00000000-0000-4000-8000-0000000000b2", content: "/usage" });
  const one = await until(events, "turn_ended");
  await session.send(PROMPT);
  const two = await until(events, "turn_ended");
  assert.equal(one.find((event) => event.type === "turn_ended")?.type, "turn_ended");
  assert.ok(two.some((event) => event.type === "call_started"));
  assert.ok(two.some((event) => event.type === "prompt_taken"));
});

// Requests.

test("a permission request reaches the handler and an allow is passed on", LIMIT, async (t) => {
  const handler = handlerOf({ allow: true });
  const batch: Batch = [
    ...TOOLS.slice(0, FIRST_CALL + 1),
    ask({
      toolName: "Bash",
      input: BASH,
      toolUseID: "toolu_000",
      description: "Print ok",
    }),
    ...TOOLS.slice(FIRST_CALL + 1),
  ];
  const { session, query, events } = await started(t, { turns: [batch] }, {}, handler);
  await session.send(PROMPT);
  const seen = await until(events, "turn_ended");
  assert.deepEqual(handler.asked, [
    {
      type: "permission",
      callId: "toolu_000",
      toolName: "Bash",
      input: BASH,
      title: null,
      description: "Print ok",
    },
  ]);
  // The SDK's result, field by field.
  assert.deepEqual(query.permissionResults, [{ behavior: "allow", updatedInput: BASH }]);
  // The turn went on after the answer: the call and the end are both there.
  assert.ok(types(seen).includes("call_started"));
  assert.equal(seen.at(-1)?.type, "turn_ended");
});

// Invariant 2: the project owns no permission rule, so no tool is answered without the owner.
// Found by a mutation run of 2026-10-11: a callback that allowed `Read` by itself failed nothing,
// since only `Bash` was ever asked about.
const CALLS: readonly { readonly toolName: string; readonly input: Record<string, unknown> }[] = [
  { toolName: "Read", input: { file_path: `${FOLDER}/notes.txt` } },
  { toolName: "Bash", input: BASH },
  { toolName: "Edit", input: { file_path: `${FOLDER}/a.ts`, old_string: "a", new_string: "b" } },
  { toolName: "Write", input: { file_path: `${FOLDER}/b.ts`, content: "b" } },
  { toolName: "Glob", input: { pattern: "*.ts" } },
  { toolName: "mcp__alice-server__lookup", input: { term: "ok" } },
  { toolName: "ToolNobodyHasSeen", input: { anything: 1 } },
];

for (const { toolName, input } of CALLS) {
  for (const answer of [
    { allow: true },
    { allow: false, message: "No: the owner refused." },
  ] satisfies PermissionAnswer[]) {
    test(
      `a call of ${toolName} is asked once and the owner's ${answer.allow ? "allow" : "deny"} is the result`,
      LIMIT,
      async (t) => {
        const handler = handlerOf(answer);
        const { session, query, events } = await started(
          t,
          { turns: [[...TOOLS.slice(0, 2), ask({ toolName, input }), ...TOOLS.slice(-1)]] },
          {},
          handler,
        );
        await session.send(PROMPT);
        await until(events, "turn_ended");
        assert.equal(handler.asked.length, 1, "the owner is asked, once");
        assert.equal(handler.asked[0]?.toolName, toolName);
        assert.deepEqual(
          query.permissionResults,
          answer.allow
            ? [{ behavior: "allow", updatedInput: input }]
            : [{ behavior: "deny", message: answer.message }],
        );
      },
    );
  }
}

test("the stream waits for an answer the owner has not given", LIMIT, async (t) => {
  let answer: (value: PermissionAnswer) => void = () => undefined;
  const handler: RequestHandler = {
    permission: () => new Promise<PermissionAnswer>((resolve) => (answer = resolve)),
    question: async () => ({ answered: false, message: "" }),
  };
  const batch: Batch = [
    ...TOOLS.slice(0, FIRST_CALL + 1),
    ask({ toolName: "Bash", input: BASH }),
    TOOLS[78] as JsonObject,
  ];
  const { session, query, events } = await started(t, { turns: [batch] }, {}, handler);
  await session.send(PROMPT);
  const before = await until(events, "call_started");
  assert.equal(before.at(-1)?.type, "call_started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(query.permissionResults, []);
  answer({ allow: true });
  const after = await until(events, "turn_ended");
  assert.equal(after.at(-1)?.type, "turn_ended");
  assert.equal(query.permissionResults.length, 1);
});

test(
  "a question is answered through the updated input, a multi-select with a list",
  LIMIT,
  async (t) => {
    const input = ASK.input as Record<string, unknown>;
    const answers = {
      "Which colour do you prefer?": "Red",
      "Do you also like green?": ["Yes", "No"],
    };
    const handler = handlerOf({ allow: true }, { answered: true, answers });
    const { session, query, events } = await started(
      t,
      {
        turns: [
          [
            ...TOOLS.slice(0, 2),
            ask({ toolName: "AskUserQuestion", input, toolUseID: "toolu_001" }),
            ...TOOLS.slice(-1),
          ],
        ],
      },
      {},
      handler,
    );
    await session.send(PROMPT);
    await until(events, "turn_ended");
    const [request] = handler.asked;
    assert.equal(request?.type, "question");
    assert.equal(request?.callId, "toolu_001");
    assert.deepEqual(query.permissionResults, [
      { behavior: "allow", updatedInput: { questions: input.questions, answers } },
    ]);
  },
);

test("a question the owner skips is a deny with what the agent is told", LIMIT, async (t) => {
  const input = ASK.input as Record<string, unknown>;
  const handler = handlerOf({ allow: true }, { answered: false, message: "The owner skipped it." });
  const { session, query, events } = await started(
    t,
    {
      turns: [
        [...TOOLS.slice(0, 2), ask({ toolName: "AskUserQuestion", input }), ...TOOLS.slice(-1)],
      ],
    },
    {},
    handler,
  );
  await session.send(PROMPT);
  await until(events, "turn_ended");
  assert.deepEqual(query.permissionResults, [
    { behavior: "deny", message: "The owner skipped it." },
  ]);
});

test("the handler's signal is the SDK's, and fires when the SDK's does", LIMIT, async (t) => {
  const signals: AbortSignal[] = [];
  const handler: RequestHandler = {
    permission: (_request, signal) => {
      signals.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ allow: false, message: "gone" }), {
          once: true,
        });
      });
    },
    question: async () => ({ answered: false, message: "" }),
  };
  const sdk = new AbortController();
  const { session, query, events } = await started(
    t,
    {
      turns: [
        [
          ...TOOLS.slice(0, 2),
          ask({ toolName: "Bash", input: BASH, abort: sdk }),
          ...TOOLS.slice(-1),
        ],
      ],
    },
    {},
    handler,
  );
  await session.send(PROMPT);
  while (signals.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals[0]?.aborted, false);
  sdk.abort();
  assert.equal(signals[0]?.aborted, true);
  await until(events, "turn_ended");
  assert.deepEqual(query.permissionResults, [{ behavior: "deny", message: "gone" }]);
});

// The review round of 2026-10-10: a request that cannot be answered is a deny, never a rejection.
// SDK 0.3.296 answers a callback that rejects with a `control_response` of subtype `error`
// (`handleControlRequest`, sdk.mjs), which is not a deny.

const UNSHOWN = "awaydesk could not show this request to the owner, so nobody approved it.";
const SECRET = "a secret sentence from the tool's input";

/** One Bash call against `handler`, with the error log recorded; what the SDK was answered. */
async function askBash(t: TestContext, handler: RequestHandler, errors: string[]) {
  t.mock.method(logger, "error", (message: string) => errors.push(message));
  const { session, query, events } = await started(
    t,
    { turns: [[...TOOLS.slice(0, 2), ask({ toolName: "Bash", input: BASH }), ...TOOLS.slice(-1)]] },
    {},
    handler,
  );
  await session.send(PROMPT);
  await until(events, "turn_ended");
  return query.permissionResults;
}

test(
  "a handler that rejects is a deny, and the log has the error's name alone",
  LIMIT,
  async (t) => {
    const errors: string[] = [];
    const failure = Object.assign(new Error(SECRET), { name: "SlackDown" });
    const handler: RequestHandler = {
      permission: async () => {
        throw failure;
      },
      question: async () => ({ answered: false, message: "" }),
    };
    assert.deepEqual(await askBash(t, handler, errors), [{ behavior: "deny", message: UNSHOWN }]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0]?.includes("SlackDown"));
    assert.ok(!errors[0]?.includes(SECRET));
  },
);

test("a handler that throws at once is a deny", LIMIT, async (t) => {
  const errors: string[] = [];
  const handler: RequestHandler = {
    permission: () => {
      throw new TypeError(SECRET);
    },
    question: async () => ({ answered: false, message: "" }),
  };
  assert.deepEqual(await askBash(t, handler, errors), [{ behavior: "deny", message: UNSHOWN }]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes("TypeError"));
  assert.ok(!errors[0]?.includes(SECRET));
});

test("a question whose input cannot be read is a deny", LIMIT, async (t) => {
  const errors: string[] = [];
  t.mock.method(logger, "error", (message: string) => errors.push(message));
  const handler = handlerOf();
  const { session, query, events } = await started(
    t,
    {
      turns: [
        [
          ...TOOLS.slice(0, 2),
          ask({ toolName: "AskUserQuestion", input: null as never }),
          ...TOOLS.slice(-1),
        ],
      ],
    },
    {},
    handler,
  );
  await session.send(PROMPT);
  await until(events, "turn_ended");
  assert.deepEqual(query.permissionResults, [{ behavior: "deny", message: UNSHOWN }]);
  assert.deepEqual(handler.asked, []);
  assert.deepEqual(errors, ["could not ask the owner about a call: TypeError"]);
});

// Hooks.

test(
  "the Stop hook gives the effort and the folder, where it ran in the stream",
  LIMIT,
  async (t) => {
    const batch: Batch = [...TOOLS.slice(0, -1), hook("Stop", STOP), TOOLS.at(-1) as JsonObject];
    const { session, events } = await started(t, { turns: [batch] });
    await session.send(PROMPT);
    const seen = await until(events, "turn_ended");
    const tail = seen.slice(-3);
    assert.deepEqual(tail, [
      { type: "effort_observed", level: "medium" },
      { type: "folder_changed", folder: "/home/dev/project" },
      seen.at(-1),
    ]);
    assert.equal(seen.at(-1)?.type, "turn_ended");
  },
);

test("the PostToolUse hook gives the folder alone", LIMIT, async (t) => {
  const batch: Batch = [...TOOLS.slice(0, 3), hook("PostToolUse", POST_TOOL_USE)];
  const { session, events } = await started(t, { turns: [batch] });
  await session.send(PROMPT);
  const seen = await until(events, "folder_changed");
  assert.deepEqual(seen.at(-1), { type: "folder_changed", folder: "/home/dev/project" });
  assert.equal(
    seen.some((event) => event.type === "effort_observed"),
    false,
  );
});

// The end of the process.

test("a stream that ends gives process_lost, then ends", LIMIT, async (t) => {
  const errors: string[] = [];
  t.mock.method(logger, "error", (message: string) => errors.push(message));
  const { session, events } = await started(t, { turns: [[...TOOLS.slice(0, 3), END]] });
  await session.send(PROMPT);
  const seen = await until(events, "process_lost");
  assert.deepEqual(seen.at(-1), { type: "process_lost", reason: EXITED });
  assert.deepEqual(await events.next(), { done: true, value: undefined });
  assert.deepEqual(errors, [`session stopped: ${EXITED}`]);
});

test("a stream that throws gives process_lost with the error's name", LIMIT, async (t) => {
  const errors: string[] = [];
  t.mock.method(logger, "error", (message: string) => errors.push(message));
  const failure = Object.assign(new Error("exit 1: a secret sentence"), {
    name: "ProcessExitError",
  });
  const { session, events } = await started(t, { turns: [[...TOOLS.slice(0, 3), fail(failure)]] });
  await session.send(PROMPT);
  const seen = await until(events, "process_lost");
  assert.deepEqual(seen.at(-1), { type: "process_lost", reason: "ProcessExitError" });
  // The name, never the message.
  assert.deepEqual(errors, ["session stopped: ProcessExitError"]);
});

// The three messages the SDK's troubleshooting page gives for a process that ended, each with
// what follows it there: the CLI's stderr, or its error report.
for (const [message, name] of [
  ["Claude Code process exited with code 1. stderr: a secret sentence", "ProcessExited"],
  ["Claude Code process exited with code 137", "ProcessExited"],
  ["Claude Code process terminated by signal SIGKILL. stderr: a secret sentence", "ProcessKilled"],
  ["Claude Code returned an error result: a secret sentence", "ErrorResult"],
] as const) {
  test(
    `a process the SDK reports as a plain error is named for how it ended [${message.slice(0, 44)}]`,
    LIMIT,
    async (t) => {
      // Issue #238: the SDK gives these no class and no code, so the owner read `Error`.
      const errors: string[] = [];
      t.mock.method(logger, "error", (line: string) => errors.push(line));
      const { session, events } = await started(t, { turns: [[fail(new Error(message))]] });
      await session.send(PROMPT);
      const seen = await until(events, "process_lost");
      assert.deepEqual(seen.at(-1), { type: "process_lost", reason: name });
      // The name, never the message.
      assert.deepEqual(errors, [`session stopped: ${name}`]);
    },
  );
}

test(
  "a plain error with other words, and a named one with these words, keep their own name",
  LIMIT,
  async (t) => {
    t.mock.method(logger, "error", () => {});
    const other = await started(t, {
      turns: [[fail(new Error("Cannot write to terminated process"))]],
    });
    await other.session.send(PROMPT);
    assert.deepEqual((await until(other.events, "process_lost")).at(-1), {
      type: "process_lost",
      reason: "Error",
    });
    const inside = await started(t, {
      turns: [[fail(new Error("it said: Claude Code process exited with code 1"))]],
    });
    await inside.session.send(PROMPT);
    assert.deepEqual((await until(inside.events, "process_lost")).at(-1), {
      type: "process_lost",
      reason: "Error",
    });
    const named = Object.assign(new Error("Claude Code process exited with code 1"), {
      name: "AbortError",
    });
    const own = await started(t, { turns: [[fail(named)]] });
    await own.session.send(PROMPT);
    assert.deepEqual((await until(own.events, "process_lost")).at(-1), {
      type: "process_lost",
      reason: "AbortError",
    });
  },
);

test("a session that was closed gives no process_lost", LIMIT, async (t) => {
  const { session, events, query } = await started(t, { turns: [TOOLS.slice(0, 3)] });
  await session.send(PROMPT);
  await until(events, "prompt_taken");
  await session.close();
  assert.equal(query.closed, true);
  const rest = await drain(session.events);
  assert.equal(
    rest.some((event) => event.type === "process_lost"),
    false,
  );
});

test("a prompt sent after the process was lost, or after close, is refused", LIMIT, async (t) => {
  t.mock.method(logger, "error", () => undefined);
  const lost = await started(t, { start: [END] });
  await until(lost.events, "process_lost");
  await assert.rejects(lost.session.send(PROMPT), SessionClosedError);
  const closed = await started(t);
  await closed.session.close();
  await assert.rejects(closed.session.send(PROMPT), SessionClosedError);
});

test("close ends the input and resolves only once the stream has ended", LIMIT, async (t) => {
  const { session, query } = await started(t, { holdClose: true });
  let resolved = false;
  const closing = session.close().then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(query.inputEnded, true);
  assert.equal(query.closed, true);
  assert.equal(resolved, false);
  query.finishClose();
  await closing;
  assert.equal(resolved, true);
});

test("close is idempotent: the query is closed once", LIMIT, async (t) => {
  const { session, query } = await started(t);
  await session.close();
  await session.close();
  assert.equal(query.calls.filter((call) => call.method === "close").length, 1);
});

// Commands.

test("interrupt and stop_task reach Claude Code", LIMIT, async (t) => {
  const { session, query } = await started(t);
  await session.interrupt();
  await session.stopTask("task-1");
  assert.deepEqual(query.calls, [
    { method: "interrupt" },
    { method: "stopTask", taskId: "task-1" },
  ]);
});

test(
  "a permission mode reaches Claude Code, and one it does not know is refused",
  LIMIT,
  async (t) => {
    const { session, query } = await started(t);
    await session.setPermissionMode("bypassPermissions");
    await session.setPermissionMode("auto");
    await assert.rejects(session.setPermissionMode("everything"), RangeError);
    assert.deepEqual(query.calls, [
      { method: "setPermissionMode", mode: "bypassPermissions" },
      { method: "setPermissionMode", mode: "auto" },
    ]);
  },
);

test("a model reaches Claude Code, none meaning its default", LIMIT, async (t) => {
  const { session, query } = await started(t);
  await session.setModel("haiku");
  await session.setModel(null);
  assert.deepEqual(query.calls, [
    { method: "setModel", model: "haiku" },
    { method: "setModel", model: undefined },
  ]);
});

test("an effort level is applied to the live session, none clearing it", LIMIT, async (t) => {
  const { session, query } = await started(t);
  await session.setEffort("high");
  await session.setEffort(null);
  await assert.rejects(session.setEffort("turbo"), RangeError);
  assert.deepEqual(query.calls, [
    { method: "applyFlagSettings", effortLevel: "high" },
    { method: "applyFlagSettings", effortLevel: null },
  ]);
});

test("a command Claude Code refuses rejects with its error", LIMIT, async (t) => {
  const refusal = new Error("auto mode is not available on this model");
  const { session } = await started(t, { rejects: { setPermissionMode: refusal } });
  await assert.rejects(session.setPermissionMode("auto"), (error) => error === refusal);
});

test(
  "a mode the owner's settings start a session in is taken, and an unknown one refused",
  LIMIT,
  async (t) => {
    // A bypass switched off hands back the mode the session started in, which is none of the
    // three roles the capabilities declare when the owner's `defaultMode` says so.
    const { session, query } = await started(t);
    for (const mode of ["acceptEdits", "plan", "dontAsk"]) await session.setPermissionMode(mode);
    assert.deepEqual(
      query.calls.map((call) => (call.method === "setPermissionMode" ? call.mode : null)),
      ["acceptEdits", "plan", "dontAsk"],
    );
    await assert.rejects(session.setPermissionMode("anything"), RangeError);
  },
);

test("the context usage is the model and the share of its window in use", LIMIT, async (t) => {
  const { session, query } = await started(t);
  assert.deepEqual(await session.contextUsage(), {
    model: "claude-haiku-4-5-20251001",
    percentage: 7,
  });
  assert.deepEqual(query.calls, [{ method: "getContextUsage" }]);
});

test(
  "the info holds the models, the commands with their aliases and the mode",
  LIMIT,
  async (t) => {
    const { session } = await started(t);
    const info = await session.info();
    assert.equal(info.permissionMode, "bypassPermissions");
    assert.ok(info.models.length > 0);
    assert.ok(info.models.every((model) => model.value !== ""));
    assert.ok(info.commands.length > 0);
    assert.ok(info.commands.some((command) => command.aliases.length > 0));
  },
);

// Start.

test(
  "a resume Claude Code refuses is ResumeRefused, and the process is closed",
  LIMIT,
  async () => {
    const failure = new Error("Claude Code returned an error result: No conversation found");
    const refusal = sdkRecords("interrupt").at(-1) as JsonObject;
    assert.equal(refusal.type, "result");
    const sdk = new FakeSdk({
      initError: failure,
      start: [{ ...refusal, is_error: true }, fail(failure)],
    });
    const session = new ClaudeSession(
      { ...CONFIG, resume: "68da9311-0000-4000-8000-0000000000aa" },
      handlerOf(),
      sdk.query,
    );
    await assert.rejects(session.ready(), (error) => {
      assert.ok(error instanceof ResumeRefused);
      assert.equal(error.cause, failure);
      return true;
    });
    assert.equal(sdk.only.closed, true);
  },
);

test("a start that fails with no session to resume rethrows the failure", LIMIT, async () => {
  const failure = new Error("Claude Code returned an error result: something");
  const refusal = sdkRecords("interrupt").at(-1) as JsonObject;
  const sdk = new FakeSdk({
    initError: failure,
    start: [{ ...refusal, is_error: true }, fail(failure)],
  });
  const session = new ClaudeSession(CONFIG, handlerOf(), sdk.query);
  // Issue #238: under the name of how the process ended, the SDK's error as its cause.
  await assert.rejects(
    session.ready(),
    (error) => error instanceof Error && error.name === "ErrorResult" && error.cause === failure,
  );
  assert.equal(sdk.only.closed, true);
});

test("a start that fails with other words rethrows the failure itself", LIMIT, async () => {
  const failure = new Error("Claude Code executable not found at /nowhere");
  const sdk = new FakeSdk({ initError: failure, start: [fail(failure)] });
  const session = new ClaudeSession(CONFIG, handlerOf(), sdk.query);
  await assert.rejects(session.ready(), (error) => error === failure);
});

test(
  "a request the SDK rejects because the process ended fails under that name",
  LIMIT,
  async (t) => {
    // Not measured on a real process: which message a request on a dead process is rejected with.
    const failure = new Error("Claude Code process exited with code 1. stderr: a secret sentence");
    const { session } = await started(t, {
      rejects: { setModel: failure, interrupt: failure, getContextUsage: failure },
    });
    for (const request of [
      () => session.setModel("haiku"),
      () => session.interrupt(),
      () => session.contextUsage(),
    ]) {
      await assert.rejects(request(), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ProcessExited");
        assert.equal(error.message.includes("secret"), false);
        assert.equal(error.cause, failure);
        return true;
      });
    }
  },
);

test(
  "a resume that fails to start with no error result is not a refused resume",
  LIMIT,
  async () => {
    const failure = new Error("spawn claude ENOENT");
    const sdk = new FakeSdk({ initError: failure, start: [fail(failure)] });
    const session = new ClaudeSession(
      { ...CONFIG, resume: "68da9311-0000-4000-8000-0000000000aa" },
      handlerOf(),
      sdk.query,
    );
    await assert.rejects(session.ready(), (error) => error === failure);
  },
);

test("a query whose close throws does not make the pump reject", LIMIT, async (t) => {
  const errors: string[] = [];
  t.mock.method(logger, "error", (message: string) => errors.push(message));
  const failure = Object.assign(new Error(SECRET), { name: "KillFailed" });
  const { session, events } = await started(t, {
    turns: [[...TOOLS.slice(0, 3), END]],
    closeThrows: failure,
  });
  await session.send(PROMPT);
  await until(events, "process_lost");
  assert.deepEqual(await events.next(), { done: true, value: undefined });
  await assert.doesNotReject(session.close());
  assert.ok(errors.some((line) => line.includes("KillFailed")));
  assert.ok(!errors.some((line) => line.includes(SECRET)));
});

test("a query whose close throws does not make a close of the session reject", LIMIT, async (t) => {
  const errors: string[] = [];
  t.mock.method(logger, "error", (message: string) => errors.push(message));
  const failure = Object.assign(new Error(SECRET), { name: "KillFailed" });
  const { session } = await started(t, { turns: [], closeThrows: failure });
  await assert.doesNotReject(session.close());
  assert.ok(errors.some((line) => line.includes("KillFailed")));
  assert.ok(!errors.some((line) => line.includes(SECRET)));
});
