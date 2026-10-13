/**
 * The turn renderer on session events. A recording reaches it through the Claude back end's
 * `Translator` (`test/support/replay.ts`), as in a live session. Where a case needs a message no
 * recording holds:
 *
 * - a message built from a wire literal (a stream event, a whole assistant message, a
 *   `compact_boundary`) is that wire record, translated;
 * - a recorded message altered on a field of the wire (an error message's content, a result's
 *   text or terminal reason) is the recorded wire record with that field altered, translated;
 * - a message altered to see the renderer react (a tool's name, a task frame under another
 *   task's id) is the event, altered.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEvent } from "../../../src/agent/seam.ts";
import type { TaskUpdate } from "../../../src/chat/seam.ts";
import {
  endedLine,
  formatDuration,
  resultSummary,
  type Sink,
  TurnRenderer,
  taskTitle,
  terminalStatus,
} from "../../../src/core/reply/renderer.ts";
import { BACKGROUND, STOPPED } from "../../../src/core/reply/words.ts";
import * as texts from "../../../src/core/texts.ts";
import { type JsonObject, sdkRecords } from "../../support/fixtures.ts";
import { NAMES } from "../../support/names.ts";
import {
  type EventOf,
  eventsOf,
  recordedEvents,
  splitTurns,
  translated,
} from "../../support/replay.ts";

const ALLOWED = new Set(["pending", "in_progress", "complete", "error"]);

class RecordingSink implements Sink<string> {
  texts: string[] = [];
  tasks: TaskUpdate[] = [];
  finished: readonly TaskUpdate[] | null = null;
  notices: string[] = [];
  endings: string[] = [];
  closedOut: boolean | string | null = false;
  /** The footer the last `finish` was given. */
  footer: string | null = null;

  async text(
    markdown: string,
    options: { readonly notice?: boolean; readonly ending?: boolean } = {},
  ): Promise<void> {
    this.texts.push(markdown);
    if (options.notice) this.notices.push(markdown);
    if (options.ending) this.endings.push(markdown);
  }

  async task(update: TaskUpdate): Promise<void> {
    this.tasks.push(update);
  }

  async finish(closing: readonly TaskUpdate[], footer: string | null): Promise<void> {
    this.finished = closing;
    this.footer = footer;
  }

  async closeOut(): Promise<boolean> {
    this.closedOut = this.footer;
    return true;
  }

  async waitLanded(): Promise<boolean> {
    return true;
  }

  async settle(): Promise<boolean> {
    return true;
  }
}

async function render(
  events: readonly SessionEvent[],
  footer: string | null = "footer",
): Promise<[RecordingSink, TurnRenderer<string>]> {
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  for (const event of events) await renderer.feed(event);
  await renderer.close(footer);
  await renderer.closeOut();
  return [sink, renderer];
}

function topLevelToolIds(events: readonly SessionEvent[]): string[] {
  return eventsOf(events, "call_started")
    .filter((event) => event.parentCallId === null)
    .map((event) => event.callId);
}

/** The last state each line reached, by its id. */
function finals(updates: readonly TaskUpdate[]): Map<string, TaskUpdate> {
  return new Map(updates.map((update) => [update.id, update]));
}

function ids(updates: readonly TaskUpdate[]): Set<string> {
  return new Set(updates.map((update) => update.id));
}

test("tools turn streams text and one line per tool", async () => {
  const events = recordedEvents("tools");
  const [sink, renderer] = await render(events);
  assert.ok(sink.texts.join("").trim());
  const tools = topLevelToolIds(events);
  assert.ok(tools.length > 0);
  assert.deepEqual(ids(sink.tasks), new Set(tools));
  const last = finals(sink.tasks);
  assert.ok(tools.every((id) => last.get(id)?.status === "complete"));
  assert.deepEqual(sink.finished, []);
  assert.equal(sink.closedOut, "footer");
  assert.ok(renderer.result !== null);
});

test("a running command is titled by its description, any other call by its first argument", async () => {
  // The terminal's live line for a command reads its description (captured on Claude Code
  // 2.1.296: `Sleeping 20 seconds then printing marker`), with the command under it.
  const events = recordedEvents("tools");
  const calls = eventsOf(events, "call_started");
  const command = calls.find(
    (event) => event.toolName === "Bash" && typeof event.input.description === "string",
  );
  assert.ok(command !== undefined);
  const [sink] = await render(events);
  assert.equal(sink.tasks.find((t) => t.id === command.callId)?.title, command.input.description);
  // A command with no description, and a call of another tool, keep the generic title.
  const bare: SessionEvent = { ...command, callId: "toolu_bare", input: { command: "ls -la" } };
  const other: SessionEvent = { ...command, callId: "toolu_other", toolName: "WebFetch" };
  const [plain] = await render([bare, other]);
  assert.deepEqual(
    plain.tasks.map((t) => t.title),
    ["Bash: ls -la", taskTitle("WebFetch", command.input)],
  );
});

test("a failed tool is an error line", async () => {
  const [sink] = await render(recordedEvents("tool-error"));
  assert.ok(sink.tasks.some((t) => t.status === "error"));
});

test("a long command in the foreground stays a call line", async () => {
  // foreground.jsonl (CLI 2.1.286): task_started with is_backgrounded false, then the task's
  // end, then the call's result.
  const [sink, renderer] = await render(recordedEvents("foreground"));
  assert.ok(!sink.tasks.some((t) => t.task || t.details === BACKGROUND));
  assert.equal(sink.tasks.at(-1)?.status, "complete");
  assert.deepEqual(renderer.runningTasks, []);
});

test("a call whose task outlives its result becomes a task line", async () => {
  // background.jsonl: the call's result arrives while its command still runs.
  const events = recordedEvents("background");
  const [sink] = await render(events);
  const tools = topLevelToolIds(events);
  assert.equal(tools.length, 1);
  const history = sink.tasks.filter((t) => t.id === tools[0]);
  assert.equal(history[0]?.task, false); // a call's line until its result
  assert.ok(history.some((t) => t.task && t.details === BACKGROUND));
  assert.equal(history.at(-1)?.task, true); // a task's line stays one after the task ends
});

test("the calls of a subagent the turn waits for nest in the parent line", async () => {
  // subagent-foreground.jsonl: `is_backgrounded` false, the call's result is the agent's report.
  const events = recordedEvents("subagent-foreground");
  const [sink] = await render(events);
  assert.deepEqual(ids(sink.tasks), new Set(topLevelToolIds(events)));
  assert.ok(sink.tasks.some((t) => t.details));
  assert.ok(!sink.texts.join("").includes("Backgrounded agent"));
});

// A subagent in the background (issue #299): the terminal writes `type(description)` and
// `Backgrounded agent` under it, and nothing of what the agent does (captured on Claude Code
// 2.1.296, 2026-10-13). The reply writes that line as text and no card.

test("a subagent in the background is the terminal's line, with no card", async () => {
  const [first = [], ...later] = splitTurns(recordedEvents("subagent"));
  const [call] = topLevelToolIds(first);
  assert.ok(call !== undefined);
  const [sink, renderer] = await render(first);
  assert.deepEqual(sink.notices, [
    "**Agent**(Run ls and report contents)\n⎿ Backgrounded agent\n\n",
  ]);
  assert.deepEqual(sink.tasks, []);
  // Still this reply's task, which the list of what still runs reads, and still its call.
  assert.equal(renderer.runningTasks.length, 1);
  assert.ok(renderer.owns(call) && renderer.shows(renderer.runningTasks[0] ?? ""));
  // What the agent does and its end write nothing either: the end line is the session's.
  for (const event of later.flat()) await renderer.feed(event);
  assert.deepEqual(sink.tasks, []);
  assert.equal(sink.notices.length, 1);
  assert.deepEqual(renderer.runningTasks, []);
});

test("the launch line names the agent's type, and none for the plain one", async () => {
  // The type is the event's, altered: no recording holds a type other than `general-purpose`,
  // which the terminal writes as `Agent(...)` (measured 2026-10-13: `mechanical(...)`).
  const events = recordedEvents("subagent").map((event) =>
    event.type === "task_started" ? { ...event, agentType: "mechanical" } : event,
  );
  const [sink] = await render(events);
  assert.deepEqual(sink.notices, [
    "**mechanical**(Run ls and report contents)\n⎿ Backgrounded agent\n\n",
  ]);
  const unnamed = recordedEvents("subagent").map((event) =>
    event.type === "task_started" ? { ...event, agentType: null } : event,
  );
  const [plain] = await render(unnamed);
  assert.ok(plain.notices[0]?.startsWith("**Agent**("));
});

test("the launch line follows the text before it after a blank line", async () => {
  const events = recordedEvents("subagent");
  const started = events.findIndex((event) => event.type === "task_started");
  const [sink] = await render([
    ...translated([
      { type: "stream_event", event: { type: "message_start", message: { id: "m0" } } },
    ]),
    { type: "text", text: "Starting it." },
    ...events.slice(0, started + 1),
  ]);
  assert.ok(sink.texts.join("").includes("Starting it.\n\n**Agent**("));
});

test("a turn that only starts an agent still gets its last text from its end", async () => {
  // The launch line is the daemon's, not the turn's text: the recorded turn with its text
  // events taken out, as for a text that came with the turn's end alone.
  const [first = []] = splitTurns(recordedEvents("subagent"));
  const silent = first.filter((event) => !event.type.startsWith("text"));
  const [sink, renderer] = await render(silent);
  assert.ok(renderer.result?.finalText);
  assert.ok(sink.texts.join("").endsWith(`Backgrounded agent\n\n${renderer.result.finalText}`));
});

test("a call under an agent's call that comes before its task writes no card", async () => {
  // Hand-built order, no recording behind it: the agent's first call ahead of `task_started`.
  const events = recordedEvents("subagent");
  const inner = events.find(
    (event) => event.type === "call_started" && event.parentCallId !== null,
  );
  assert.ok(inner !== undefined);
  const started = events.findIndex((event) => event.type === "task_started");
  const moved = events.filter((event) => event !== inner);
  moved.splice(started, 0, inner);
  const [sink] = await render(moved);
  assert.deepEqual(sink.tasks, []);
  assert.equal(sink.notices.length, 1);
});

test("a background agent of a call the reply never saw has no card and no launch line", async () => {
  // subagent-nested-background-mid-turn.jsonl: the agent starts again after the reply of its
  // call has ended, so the frame reaches a reply that holds no call for it.
  const [started] = eventsOf(recordedEvents("subagent"), "task_started");
  assert.ok(started !== undefined && started.kind === "subagent" && started.background === true);
  const [sink, renderer] = await render([started]);
  assert.deepEqual([sink.tasks, sink.notices], [[], []]);
  assert.deepEqual(renderer.runningTasks, [started.taskId]);
  assert.ok(renderer.lineless(started.taskId) && renderer.shows(started.taskId));
});

test("agents started one after the other have no empty line between their launch lines", async () => {
  // The recorded call and task start, then the same two under other ids: no recording holds
  // two agents started in one message (seen in a real session, 2026-10-13).
  const events = recordedEvents("subagent");
  const started = events.findIndex((event) => event.type === "task_started");
  const call = events.findLast((event, index) => index < started && event.type === "call_started");
  const task = events[started];
  assert.ok(call?.type === "call_started" && task?.type === "task_started");
  const [sink] = await render([
    ...events.slice(0, started + 1),
    { ...call, callId: "toolu_second" },
    { ...task, callId: "toolu_second", taskId: "second", description: "Second one" },
  ]);
  assert.equal(
    sink.notices.join(""),
    "**Agent**(Run ls and report contents)\n⎿ Backgrounded agent\n\n" +
      "**Agent**(Second one)\n⎿ Backgrounded agent\n\n",
  );
  assert.deepEqual(sink.tasks, []);
});

test("a call that starts no agent shows as any other call", async () => {
  // The recorded stream with the task's frames taken out, as for a call the agent refuses (a
  // type it does not know): held until its result, then the card every call gets.
  const events = recordedEvents("subagent").filter((event) => !event.type.startsWith("task_"));
  const [call] = topLevelToolIds(events);
  const [sink] = await render(events);
  const card = sink.tasks.filter((t) => t.id === call);
  assert.ok(card.length > 0 && card.every((t) => t.status === "complete"));
  assert.deepEqual(sink.notices, []);
});

test("an agent that is continued gets no second launch line", async () => {
  // report-turn-agent-resume.jsonl: the agent's task starts again under the call that
  // continues it, which is no call that starts an agent and keeps its card. The terminal writes
  // no second launch line either (captured 2026-10-13, Claude Code 2.1.296).
  const events = recordedEvents("report-turn-agent-resume");
  const agents = eventsOf(events, "task_started").filter((event) => event.kind === "subagent");
  assert.equal(agents.length, 2);
  assert.equal(agents[0]?.taskId, agents[1]?.taskId);
  assert.notEqual(agents[0]?.callId, agents[1]?.callId);
  const [sink, renderer] = await render(events);
  assert.equal(sink.notices.filter((text) => text.includes("Backgrounded agent")).length, 1);
  assert.ok(!sink.tasks.some((t) => t.id === agents[0]?.callId));
  assert.ok(sink.tasks.some((t) => t.id === agents[1]?.callId));
  assert.deepEqual(renderer.runningTasks, []);
});

test("a local command shows its result text", async () => {
  const [sink, renderer] = await render(recordedEvents("usage"));
  assert.ok(renderer.result?.finalText);
  assert.equal(sink.texts.join(""), renderer.result.finalText);
});

test("logged out cli gets the login instructions", async () => {
  const [sink, renderer] = await render(recordedEvents("auth-failed"));
  assert.ok(renderer.authFailed);
  assert.ok(sink.texts.join("").includes(texts.named(texts.AUTH_FAILED, NAMES)));
});

/** The reply Claude Code wrote itself after the API refused the turn. */
function errorReply(events: readonly SessionEvent[]): EventOf<"agent_error"> {
  const replies = eventsOf(events, "agent_error");
  assert.equal(replies.length, 1);
  return replies[0] as EventOf<"agent_error">;
}

test("an api error shows the text claude code wrote", async () => {
  // Recorded on SDK 0.2.163 (CLI 2.1.286) against a local endpoint answering 529 (issue #157).
  const events = recordedEvents("server-error");
  const reply = errorReply(events);
  assert.equal(reply.category, "server_error");
  assert.ok(reply.text.startsWith("API Error: 529"));
  const [sink, renderer] = await render(events);
  // Once: the result repeats the same sentence, and the category is not shown beside it.
  assert.equal(sink.texts.join(""), reply.text);
  assert.deepEqual(sink.notices, sink.texts);
  assert.ok(renderer.error === "server_error" && !renderer.authFailed);
});

// One recording for each status a local endpoint answered with, and the error type the API
// reference gives it (issue #162, SDK 0.2.163, CLI 2.1.286). 401, 402 and 403 were recorded with
// a made-up API key, so their sentence is the one of API-key auth.
const RECORDED_API_ERRORS: Readonly<Record<number, string>> = {
  400: "unknown",
  402: "unknown",
  404: "model_not_found",
  413: "invalid_request",
  429: "rate_limit",
  500: "server_error",
  504: "server_error",
};

/** The status of the API's answer, which the result record of a recording carries. */
function apiErrorStatus(name: string): unknown {
  return sdkRecords(name).find((record) => record.type === "result")?.api_error_status;
}

for (const [status, category] of Object.entries(RECORDED_API_ERRORS)) {
  test(`every recorded api error shows claude code s sentence once [${status}]`, async () => {
    const events = recordedEvents(`api-error-${status}`);
    const reply = errorReply(events);
    // The category is read from the recording, whatever the SDK's `AssistantMessageError` lists:
    // `model_not_found` is not in it, and the text is shown the same way.
    assert.equal(reply.category, category);
    assert.ok(reply.text);
    const [sink, renderer] = await render(events);
    assert.equal(sink.texts.join(""), reply.text); // once, and never read: the words are Claude Code's
    assert.deepEqual(sink.notices, sink.texts);
    assert.ok(renderer.error === reply.category && !renderer.authFailed);
    // The status is a field of the wire's result that no event carries: nothing reads it.
    assert.ok(renderer.result !== null);
    assert.equal(apiErrorStatus(`api-error-${status}`), Number(status));
  });
}

for (const status of [401, 403]) {
  test(`a 401 and a 403 both arrive as a failed login [${status}]`, async () => {
    // A 403 is a missing permission in the API reference, and Claude Code still sends it as
    // `authentication_failed` with `Failed to authenticate.`: the category is the documented
    // field, so it gets the note a 401 gets. The status is on the result, which comes after.
    const events = recordedEvents(`api-error-${status}`);
    assert.equal(errorReply(events).category, "authentication_failed");
    const [sink, renderer] = await render(events);
    assert.ok(renderer.authFailed && sink.texts.join("") === texts.named(texts.AUTH_FAILED, NAMES));
    assert.ok(renderer.result !== null);
    assert.equal(apiErrorStatus(`api-error-${status}`), status);
  });
}

test("a subagent s api error is left out of the reply s text", async () => {
  // subagent-api-error.jsonl (issue #161, CLI 2.1.286): the subagent's requests all got a 529
  // while the main conversation's succeeded. Claude Code forwards the subagent's own error
  // message, with `error` and `parent_tool_use_id` both set, after the main turn's result.
  const events = recordedEvents("subagent-api-error");
  const reply = errorReply(events);
  assert.ok(reply.category === "server_error" && reply.parentCallId !== null);
  assert.ok(reply.text.startsWith("API Error: 529"));
  const [sink, renderer] = await render(events);
  // Like every other text of a subagent: the failure belongs to its own card, not to the reply.
  assert.ok(!sink.texts.join("").includes(reply.text));
  assert.ok(renderer.error === null && !renderer.authFailed);
});

test("a subagent s api error shows under its card when no task frame says so", async () => {
  // The recorded stream with the task's own end taken out, as for a subagent whose task frames
  // never reach this reply (one started by another subagent), and its start altered to one the
  // call waits for, which has a card: the words are still on the card. The recording of a
  // subagent in the foreground holds no such message (its error is the call's result).
  const events = recordedEvents("subagent-api-error")
    .filter((event) => event.type !== "task_ended" && event.type !== "task_updated")
    .map((event) => (event.type === "task_started" ? { ...event, background: false } : event));
  const reply = errorReply(events);
  const [sink] = await render(events);
  const card = sink.tasks.filter((u) => u.id === reply.parentCallId).at(-1);
  assert.ok(card?.details?.split("\n").at(-1)?.startsWith("API Error: 529"));
  assert.equal(card?.calls, 0); // a note under the card, not one more call of the subagent
  assert.ok(!sink.texts.join("").includes("API Error"));
});

test("a background subagent s api error writes nothing in the reply", async () => {
  // subagent-api-error.jsonl: no card to carry it. The terminal says it in the task's end line
  // (`Agent "..." failed: ...`), which the session writes.
  const events = recordedEvents("subagent-api-error");
  const [sink] = await render(events);
  assert.deepEqual(sink.tasks, []);
  assert.ok(!sink.texts.join("").includes("API Error"));
});

/** A recording's records, the message about a failed request without its blocks. */
function withBareError(name: string, alter: (result: JsonObject) => JsonObject): JsonObject[] {
  return sdkRecords(name).map((record) => {
    if (record.type === "assistant" && record.error != null) {
      return { ...record, message: { ...(record.message as JsonObject), content: [] } };
    }
    return record.type === "result" ? alter(record) : record;
  });
}

test("an api error with no words of its own lets the result speak", async () => {
  // No such message was recorded: the recorded one, with its blocks taken out. The result is
  // the recorded one, and carries the sentence.
  const bare = translated(withBareError("server-error", (result) => result));
  assert.equal(errorReply(bare).text, "");
  const [sink, renderer] = await render(bare);
  assert.ok(renderer.result?.finalText);
  assert.equal(sink.texts.join(""), renderer.result.finalText);
});

test("an api error with no words anywhere shows its category", async () => {
  const silent = translated(
    withBareError("server-error", (result) => ({ ...result, result: null })),
  );
  const [sink] = await render(silent);
  assert.equal(
    sink.texts.join(""),
    texts.fill(texts.named(texts.ERROR_REPLY, NAMES), { error: "server_error" }),
  );
});

test("an interrupted turn closes every open line without error", async () => {
  const [sink] = await render(recordedEvents("interrupt"));
  assert.ok(sink.finished !== null);
  assert.ok(sink.finished.every((t) => t.status === "complete"));
});

test("background notification in a later turn gets a line", async () => {
  const turns = splitTurns(recordedEvents("background"));
  assert.ok(turns.length >= 2, "the recording holds the injected notification turn");
  const [sink] = await render(turns[1] ?? []);
  const last = sink.tasks.at(-1);
  assert.ok(last !== undefined && ["complete", "error"].includes(last.status));
});

test("a task still running when its turn ends stays open until it ends", async () => {
  const [first = [], later = []] = splitTurns(recordedEvents("background"));
  const [sink, renderer] = await render(first);
  assert.ok(sink.finished !== null);
  const open = sink.finished.filter((t) => t.status === "in_progress");
  assert.equal(open.length, 1);
  const [running] = open;
  assert.equal(running?.details, BACKGROUND);
  assert.ok(renderer.runningTasks.length > 0);
  for (const event of later) {
    if (event.type === "task_ended" || event.type === "task_updated") await renderer.feed(event);
  }
  assert.equal(renderer.runningTasks.length, 0);
  assert.equal(sink.tasks.at(-1)?.id, running?.id);
  assert.equal(sink.tasks.at(-1)?.status, "complete");
});

test("stopping the running tasks closes their lines", async () => {
  const [first = []] = splitTurns(recordedEvents("background"));
  const [sink, renderer] = await render(first);
  await renderer.stopRunning();
  assert.equal(renderer.runningTasks.length, 0);
  assert.ok(sink.tasks.at(-1)?.status === "complete" && sink.tasks.at(-1)?.output === STOPPED);
});

for (const name of ["TodoWrite", "mcp__srv__do_thing"]) {
  test(`any tool name renders the same way [${name}]`, async () => {
    const renamed = recordedEvents("tools").map((event) =>
      event.type === "call_started" ? { ...event, toolName: name } : event,
    );
    const [sink] = await render(renamed);
    assert.ok(sink.tasks.length > 0 && sink.tasks.every((t) => t.title.startsWith(name)));
  });
}

// One recording is the runtime check: `TaskStatus` is a closed union, which `tsc` holds for the rest.
test("statuses are only the ones slack accepts", async () => {
  const [sink] = await render(recordedEvents("background"));
  const closing = sink.finished ?? [];
  for (const update of [...sink.tasks, ...closing]) assert.ok(ALLOWED.has(update.status));
});

test("the renderer never branches on a tool name", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "src", "core", "reply", "renderer.ts"),
    "utf8",
  );
  assert.ok(
    !/["'`](Bash|Read|Write|Edit|Agent|Task|TodoWrite|AskUserQuestion|WebSearch)["'`]/.test(source),
  );
});

test("task title uses the first string argument", () => {
  assert.equal(taskTitle("Bash", { timeout: 5, command: "ls   -la\n/x" }), "Bash: ls -la /x");
  assert.equal(taskTitle("Thing", { n: 1 }), "Thing");
  assert.equal(Array.from(taskTitle("Read", { file_path: "x".repeat(500) })).length, 80);
});

test("feed error appends to the reply", async () => {
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  await renderer.feedError("Claude Code reported an error: `ProcessError`");
  assert.deepEqual(sink.texts, ["\n\nClaude Code reported an error: `ProcessError`"]);
  assert.deepEqual(sink.notices, sink.texts);
  assert.deepEqual(sink.endings, []); // a note, not how the reply ended
});

test("feed ending marks the line on how the reply ended", async () => {
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  await renderer.feedEnding("Claude Code reported an error: `ProcessError`");
  assert.deepEqual(sink.endings, ["\n\nClaude Code reported an error: `ProcessError`"]);
  assert.deepEqual(sink.notices, sink.endings);
});

test("feed notice opens the reply", async () => {
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  await renderer.feedNotice("The previous session could not be resumed.");
  assert.deepEqual(sink.texts, ["The previous session could not be resumed.\n\n"]);
});

// The compact_boundary payload of a /compact turn, as the bundled CLI 2.1.280 sent it
// (recorded 2026-09-24; ids synthetic).
const COMPACT_BOUNDARY = {
  type: "system",
  subtype: "compact_boundary",
  session_id: "00000000-0000-0000-0000-000000000001",
  uuid: "00000000-0000-0000-0000-000000000002",
  compact_metadata: {
    trigger: "manual",
    pre_tokens: 15022,
    post_tokens: 2035,
    cumulative_dropped_tokens: 12987,
    duration_ms: 15136,
  },
  logical_parent_uuid: "00000000-0000-0000-0000-000000000003",
};

/** A recorded result with no text, as /compact ends (`result` was ''). */
function silentResult(): JsonObject {
  const result = sdkRecords("tools").find((record) => record.type === "result");
  assert.ok(result !== undefined);
  return { ...result, result: "" };
}

test("a compaction says how many tokens it saved", async () => {
  const [sink] = await render(translated([COMPACT_BOUNDARY, silentResult()]));
  assert.equal(
    sink.texts.join("").trim(),
    texts.fill(texts.COMPACTED, { before: "15.0k", after: "2.0k" }),
  );
});

test("a turn with no text and no tool says it is done", async () => {
  const [sink] = await render(translated([silentResult()]));
  assert.equal(sink.texts.join(""), texts.named(texts.NO_OUTPUT, NAMES));
});

test("a turn with only tool lines gets no filler", async () => {
  const [sink] = await render(
    recordedEvents("tools").filter((event) => event.type !== "turn_ended"),
  );
  assert.ok(!sink.texts.join("").includes(texts.named(texts.NO_OUTPUT, NAMES)));
});

test("a silent turn that was stopped says so", async () => {
  const stopped = { ...silentResult(), terminal_reason: "aborted_streaming" };
  const [sink] = await render(translated([stopped]));
  assert.equal(sink.texts.join(""), texts.STOPPED);
});

test("a notice does not hide a local command s result", async () => {
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  await renderer.feedNotice("The previous session could not be resumed.");
  for (const event of recordedEvents("usage")) await renderer.feed(event);
  assert.ok(renderer.result?.finalText);
  assert.ok(sink.texts.join("").includes(renderer.result.finalText));
});

const ENDED_LINES: readonly (readonly [string, string, number | null, string])[] = [
  ['Agent "Scan" finished', "completed", 10_400, '✓ Agent "Scan" finished · 10s'],
  ['Agent "Scan" finished', "completed", 239_000, '✓ Agent "Scan" finished · 3m 59s'],
  [
    'Background command "Wait" completed (exit code 0)',
    "completed",
    null,
    '✓ Background command "Wait" completed (exit code 0)',
  ],
  ['Background command "Wait" failed', "failed", null, '✗ Background command "Wait" failed'],
];

for (const [summary, status, durationMs, expected] of ENDED_LINES) {
  test(`ended line is claude code s own summary [${expected}]`, () => {
    assert.equal(endedLine(summary, status, durationMs), expected);
  });
}

test("tool and task lines carry their name and kind", async () => {
  const [first = []] = splitTurns(recordedEvents("background"));
  const [sink] = await render(first);
  const last = finals([...sink.tasks, ...(sink.finished ?? [])]);
  assert.ok([...last.values()].every((t) => t.name));
  assert.ok([...last.values()].some((t) => t.task));
});

test("the daemon s own lines are notices and claude s words are not", async () => {
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  await renderer.feedNotice("The previous session could not be resumed.");
  await renderer.feedError("The process exited.");
  for (const event of recordedEvents("tools")) await renderer.feed(event);
  assert.deepEqual(sink.notices, [
    "The previous session could not be resumed.\n\n",
    "\n\nThe process exited.",
  ]);
  assert.ok(sink.texts.length > sink.notices.length); // Claude's own text followed, unmarked
});

test("a turn that says nothing gets a notice not words", async () => {
  const [sink] = await render(translated([silentResult()]));
  assert.deepEqual(sink.notices, [texts.named(texts.NO_OUTPUT, NAMES)]);
});

function streamEvents(wire: readonly JsonObject[], parent: string | null = null): JsonObject[] {
  return wire.map((event) => ({
    type: "stream_event",
    event,
    session_id: "00000000-0000-0000-0000-000000000001",
    parent_tool_use_id: parent,
    uuid: "00000000-0000-0000-0000-000000000002",
  }));
}

/**
 * The stream events of one content block, in the shape the recorded streams have (see
 * `test/fixtures/sdk/goal.jsonl`): a start, one delta per piece, a stop.
 */
function blockEvents(
  pieces: readonly string[],
  options: { parent?: string | null; thinking?: boolean } = {},
): JsonObject[] {
  const [kind, delta] = options.thinking ? ["thinking", "thinking_delta"] : ["text", "text_delta"];
  const wire: JsonObject[] = [
    { type: "content_block_start", index: 1, content_block: { type: kind, [kind]: "" } },
    ...pieces.map((piece) => ({
      type: "content_block_delta",
      index: 1,
      delta: { type: delta, [kind]: piece },
    })),
    { type: "content_block_stop", index: 1 },
  ];
  return streamEvents(wire, options.parent ?? null);
}

/**
 * The event that opens a streamed message, with the keys the renderer reads of the recorded
 * one (`goal.jsonl`); `null` leaves the id out, which no recording shows.
 */
function messageStart(messageId: string | null): JsonObject[] {
  const message: JsonObject = { type: "message", role: "assistant", content: [] };
  if (messageId !== null) message.id = messageId;
  return streamEvents([{ type: "message_start", message }]);
}

function messageStop(): JsonObject[] {
  return streamEvents([{ type: "message_stop" }]);
}

/**
 * A command's own output, in the shape of the `Goal set:` message of `goal.jsonl`: a whole
 * assistant message with a synthetic model and no stream event before it.
 */
function unannounced(
  text: string,
  options: { messageId?: string | null; parent?: string | null } = {},
): JsonObject[] {
  const { messageId = "00000000-0000-0000-0000-00000000000a", parent = null } = options;
  const message: JsonObject = {
    model: "<synthetic>",
    role: "assistant",
    type: "message",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  };
  if (messageId !== null) message.id = messageId;
  return [
    {
      type: "assistant",
      message,
      parent_tool_use_id: parent,
      session_id: "00000000-0000-0000-0000-000000000001",
      uuid: "00000000-0000-0000-0000-000000000003",
    },
  ];
}

test("the inner turns of a goal do not run together", async () => {
  const [sink] = await render(recordedEvents("goal"));
  const written = sink.texts.join("");
  assert.ok(written.endsWith("tick\n\ntick\n\ntick"));
  assert.ok(!written.includes("ticktick"));
});

test("a goal s reply opens with the command s own line", async () => {
  // `Goal set: …` is `/goal`'s own output: an assistant message no stream event announced
  // (recorded: `goal.jsonl`), followed by the first inner turn's text.
  const [sink] = await render(recordedEvents("goal"));
  const written = sink.texts.join("");
  assert.ok(written.startsWith("Goal set: Reply with the single word tick"));
  assert.ok(written.includes("Never use a tool.\n\nAcknowledged."));
  assert.equal(written.split("Goal set:").length - 1, 1);
});

test("text the stream already wrote is not written again", async () => {
  // Every streamed message also arrives whole: only its deltas are written.
  const [sink] = await render(recordedEvents("goal"));
  assert.equal(sink.texts.join("").split("Acknowledged.").length - 1, 1);
});

test("unannounced text after streamed text is a paragraph apart", async () => {
  const streamed = [...messageStart("msg_1"), ...blockEvents(["one"]), ...messageStop()];
  const [sink] = await render(translated([...streamed, ...unannounced("Goal cleared: x")]));
  assert.deepEqual(sink.texts, ["one", "\n\nGoal cleared: x"]);
});

test("a subagent s unannounced text stays out of the reply", async () => {
  const [sink] = await render(translated(unannounced("inner words", { parent: "toolu_1" })));
  assert.ok(!sink.texts.join("").includes("inner words"));
});

test("a message with no id is not taken for unannounced", async () => {
  const [sink] = await render(translated(unannounced("words", { messageId: null })));
  assert.ok(!sink.texts.join("").includes("words"));
});

test("nothing unannounced is written while a streamed message is unfinished", async () => {
  // A stream that stops halfway may be followed by the same text sent whole under another
  // id: writing it would repeat what the deltas already wrote.
  const halfway = [...messageStart("msg_1"), ...blockEvents(["Here is the pla"])];
  const [sink] = await render(translated([...halfway, ...unannounced("Here is the plan.")]));
  assert.deepEqual(sink.texts, ["Here is the pla"]);
});

test("a stream that names no message turns the rule off", async () => {
  // Without ids every streamed message would look unannounced and be written twice.
  const streamed = [...messageStart(null), ...blockEvents(["one"]), ...messageStop()];
  const [sink] = await render(
    translated([...streamed, ...unannounced("one", { messageId: "msg_1" })]),
  );
  assert.deepEqual(sink.texts, ["one"]);
});

test("two text blocks with nothing between are a paragraph apart", async () => {
  const [sink] = await render(translated([...blockEvents(["one"]), ...blockEvents(["two"])]));
  assert.deepEqual(sink.texts, ["one", "\n\ntwo"]);
});

test("deltas of one block stay joined", async () => {
  const [sink] = await render(translated(blockEvents(["on", "e ", "two"])));
  assert.deepEqual(sink.texts, ["on", "e ", "two"]);
});

test("a reply s first text has no leading break", async () => {
  const [sink] = await render(translated(blockEvents(["one"])));
  assert.deepEqual(sink.texts, ["one"]);
});

test("a tool card between two texts adds no break", async () => {
  const recorded = sdkRecords("foreground");
  const [plain] = await render(translated(recorded));
  const [sink] = await render(translated([...blockEvents(["before"]), ...recorded]));
  assert.deepEqual(sink.texts, ["before", ...plain.texts]);
});

test("an empty block adds no break", async () => {
  const [sink] = await render(
    translated([...blockEvents(["one"]), ...blockEvents([]), ...blockEvents(["two"])]),
  );
  assert.deepEqual(sink.texts, ["one", "\n\ntwo"]);
  const [short] = await render(translated([...blockEvents(["one"]), ...blockEvents([])]));
  assert.deepEqual(short.texts, ["one"]);
});

test("a subagent s text neither adds nor takes a break", async () => {
  const nested = blockEvents(["inner"], { parent: "toolu_000" });
  const [sink] = await render(
    translated([...blockEvents(["one"]), ...nested, ...blockEvents(["two"])]),
  );
  assert.deepEqual(sink.texts, ["one", "\n\ntwo"]);
  const [short] = await render(translated([...blockEvents(["one"]), ...nested]));
  assert.deepEqual(short.texts, ["one"]);
});

test("a thinking block between two texts adds one break", async () => {
  const [sink] = await render(
    translated([
      ...blockEvents(["one"]),
      ...blockEvents(["hmm"], { thinking: true }),
      ...blockEvents(["two"]),
    ]),
  );
  assert.deepEqual(sink.texts, ["one", "\n\ntwo"]);
});

test("a card updated where it sits between two texts keeps the break", async () => {
  // Recorded: a background command ends after the turn's text, so its card changes in place,
  // above that text, and the report turn's text follows it directly.
  const recorded = recordedEvents("background");
  const ended = recorded.findIndex((event) => event.type === "task_ended");
  const [before] = await render(recorded.slice(0, ended));
  const [sink] = await render(recorded);
  const known = ids(before.tasks);
  assert.ok(!sink.tasks.some((t) => !known.has(t.id))); // no new card
  const report = sink.texts[before.texts.length];
  assert.ok(before.texts.at(-1)?.trim() && report?.startsWith("\n\n"));
});

/**
 * subagent-nested-command.jsonl: the owner's turn, and what the main stream carries after it
 * (two commands the background subagent runs, each with a task of its own, then the agent's
 * own end and the report turn).
 */
function nestedCommandTurns(): [SessionEvent[], SessionEvent[], string] {
  const [first = [], later = []] = splitTurns(recordedEvents("subagent-nested-command"));
  const calls = topLevelToolIds(first);
  assert.equal(calls.length, 1);
  return [first, later, calls[0] as string];
}

function firstOf<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): EventOf<T> {
  const [found] = eventsOf(events, type);
  assert.ok(found !== undefined, type);
  return found;
}

test("the commands a subagent runs get no line of their own", async () => {
  const [first, later, agentCall] = nestedCommandTurns();
  const [sink, renderer] = await render(first);
  for (const event of later) await renderer.feed(event);
  // the agent runs in the background: what it does writes nothing, its commands included
  assert.ok(renderer.owns(agentCall));
  assert.deepEqual(sink.tasks, []);
  assert.deepEqual(renderer.runningTasks, []);
});

test("a dropped task id that starts again ends its line", async () => {
  // Hand-built order, no recording behind it: the recorded frames of the first command, sent a
  // second time after its call's result. Only an agent's task was recorded starting again
  // under its id (`subagent-nested-background.jsonl`).
  const [first, later] = nestedCommandTurns();
  const [, renderer] = await render(first);
  const started = firstOf(later, "task_started");
  const ended = eventsOf(later, "task_ended").find((event) => event.taskId === started.taskId);
  assert.ok(ended !== undefined);
  const result = later.findIndex(
    (event, index) => index > later.indexOf(ended) && event.type === "call_ended",
  );
  for (const event of later.slice(0, result + 1)) await renderer.feed(event);
  assert.ok(!renderer.runningTasks.includes(started.taskId)); // dropped: it ended before the result
  await renderer.feed(started); // its call is closed now: an ordinary task
  assert.ok(renderer.runningTasks.includes(started.taskId));
  await renderer.feed(ended);
  assert.ok(!renderer.runningTasks.includes(started.taskId));
});

test("a subagent s command is not a task that outlives the turn", async () => {
  const [first, later] = nestedCommandTurns();
  const [, renderer] = await render(first);
  assert.equal(renderer.runningTasks.length, 1);
  const [agentTask] = renderer.runningTasks;
  const started = firstOf(later, "task_started");
  for (const event of later.slice(0, later.indexOf(started) + 1)) await renderer.feed(event);
  assert.deepEqual(renderer.runningTasks, [agentTask]);
  assert.equal(renderer.taskTitle(started.taskId), null);
});

test("every frame of a nested task stays off the card list", async () => {
  const [first, later, agentCall] = nestedCommandTurns();
  const [sink, renderer] = await render(first);
  const started = firstOf(later, "task_started");
  for (const event of later) {
    await renderer.feed(event);
    if (event === started) break;
  }
  // frames of a kind the recording does not hold for a nested task, built from one it does
  const updated = firstOf(later, "task_updated");
  for (const status of ["completed", "killed"]) {
    await renderer.feed({ ...updated, taskId: started.taskId, status, terminal: true });
  }
  assert.ok(renderer.owns(agentCall));
  assert.deepEqual(sink.tasks, []);
});

test("a task of a call the reply never saw keeps its own line", async () => {
  // The reply cannot tell the call is nested (a restart dropped what held its root): the task
  // is shown as any task of an unknown call.
  const [, later] = nestedCommandTurns();
  const started = firstOf(later, "task_started");
  const [sink] = await render([started]);
  assert.deepEqual(
    sink.tasks.map((t) => t.id),
    [`task-${started.taskId}`],
  );
});

/**
 * subagent-nested-background.jsonl: a background subagent starts `sleep 20` in the background
 * (the nested call's result comes while the command runs), reports and ends; the command's end
 * arrives after the report turn, and the agent starts again and ends once more.
 */
function nestedBackgroundTurns(): [SessionEvent[], SessionEvent[], string] {
  const [first = [], ...later] = splitTurns(recordedEvents("subagent-nested-background"));
  const calls = topLevelToolIds(first);
  assert.equal(calls.length, 1);
  return [first, later.flat(), calls[0] as string];
}

test("a subagent s command that outlives its call becomes a task line", async () => {
  const [first, later, agentCall] = nestedBackgroundTurns();
  const [sink, renderer] = await render(first);
  assert.equal(renderer.runningTasks.length, 1);
  const [agentTask] = renderer.runningTasks;
  const started = firstOf(later, "task_started");
  assert.notEqual(started.callId, agentCall);
  for (const event of later) {
    await renderer.feed(event);
    if (event === started) {
      // held aside while its call is open: no line, not running
      assert.deepEqual(renderer.runningTasks, [agentTask]);
      assert.equal(renderer.taskTitle(started.taskId), null);
    }
    if (event.type === "call_ended" && renderer.runningTasks.join() !== agentTask) {
      break; // the nested call's result: the task outlives it
    }
  }
  assert.deepEqual(renderer.runningTasks, [agentTask, started.taskId]);
  const line = sink.tasks.at(-1);
  assert.deepEqual(
    [line?.id, line?.title, line?.status, line?.task],
    [`task-${started.taskId}`, started.description, "in_progress", true],
  );
  assert.deepEqual(
    renderer.takePromoted().map((event) => event.taskId),
    [started.taskId],
  );
  assert.deepEqual(renderer.takePromoted(), []);
  assert.ok(!renderer.nests(started));
});

test("an ended command of a subagent ends its line as a background task", async () => {
  const [first, later, agentCall] = nestedBackgroundTurns();
  const [sink, renderer] = await render(first);
  for (const event of later) await renderer.feed(event);
  const last = finals(sink.tasks);
  const started = firstOf(later, "task_started");
  // The command the agent left running has its line; the agent, in the background, has none,
  // nor when that command's end starts it again under its call.
  assert.equal(sink.notices.filter((text) => text.includes("Backgrounded agent")).length, 1);
  assert.ok(renderer.owns(agentCall));
  assert.deepEqual(new Set(last.keys()), new Set([`task-${started.taskId}`]));
  assert.equal(last.get(`task-${started.taskId}`)?.status, "complete");
  assert.deepEqual(renderer.runningTasks, []);
});

// An Edit or a Write is shown once it has ended (issue #136): a stream cannot take back the card
// a running call would get, and one that ended well is its preview alone.

test("an edit or a write reaches the sink only once it has ended", async () => {
  // edit-write.jsonl (CLI 2.1.286): three calls that ended well and an Edit that failed.
  const [sink] = await render(recordedEvents("edit-write"));
  const held = sink.tasks.filter((t) => t.name === "Edit" || t.name === "Write");
  assert.deepEqual(
    held.map((t) => [t.name, t.status, t.preview !== null]),
    [
      ["Write", "complete", true],
      ["Edit", "error", false],
      ["Edit", "complete", true],
      ["Write", "complete", true],
    ],
  );
  assert.equal(ids(held).size, 4); // one state each: none was sent while it ran
});

test("a write cut short by a stop shows as stopped", async () => {
  const events = recordedEvents("edit-write");
  const call = events.findIndex((event) => event.type === "call_started");
  const stopped = translated([{ ...silentResult(), terminal_reason: "aborted_tools" }]);
  const [sink] = await render([...events.slice(0, call + 1), ...stopped]);
  assert.deepEqual(sink.tasks, []); // nothing while it ran
  assert.ok(sink.finished !== null);
  assert.equal(sink.finished.length, 1);
  const [closing] = sink.finished;
  assert.deepEqual(
    [closing?.name, closing?.status, closing?.output],
    ["Write", "complete", STOPPED],
  );
});

// The renderer's helpers on their own, and what the session relies on around a reply's end.

test("a result s summary is its first line that says something, on one line", () => {
  assert.equal(resultSummary("\n  \nfirst  line\nsecond"), "first line");
  assert.equal(resultSummary("x".repeat(500))?.length, 200);
  for (const output of ["", " \n ", null]) assert.equal(resultSummary(output), null);
});

test("a duration reads in the largest two units it fills", () => {
  assert.deepEqual([59.9, 60, 3599, 3600, 7325.5, 0.4].map(formatDuration), [
    "59s",
    "1m 0s",
    "59m 59s",
    "1h 0m",
    "2h 2m",
    "0s",
  ]);
});

test("a task s end is an error only when it failed, and stopped when it was stopped or killed", () => {
  assert.deepEqual(terminalStatus("failed"), ["error", null]);
  assert.deepEqual(terminalStatus("stopped"), ["complete", STOPPED]);
  assert.deepEqual(terminalStatus("killed"), ["complete", STOPPED]);
  assert.deepEqual(terminalStatus("completed"), ["complete", null]);
  assert.deepEqual(terminalStatus("timed_out"), ["complete", null]);
});

test("a task title skips an argument that is blank or no string", () => {
  assert.equal(taskTitle("Bash", { a: "  ", b: 3, c: "x" }), "Bash: x");
  assert.equal(taskTitle("Bash", {}), "Bash");
});

test("a note fed into a written reply is a paragraph of its own, and text follows it directly", async () => {
  // A report turn's opening line, fed into the reply that started the task: the note ends with
  // its own break, so the words after it add none.
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  for (const event of translated(blockEvents(["one"]))) await renderer.feed(event);
  await renderer.feedNotice('✓ Agent "Scan" finished');
  for (const event of translated(blockEvents(["two"]))) await renderer.feed(event);
  await renderer.feedNotice("again");
  for (const event of translated(unannounced("three"))) await renderer.feed(event);
  assert.deepEqual(sink.texts, [
    "one",
    '\n\n✓ Agent "Scan" finished\n\n',
    "two",
    "\n\nagain\n\n",
    "three",
  ]);
  assert.deepEqual(sink.notices, ['\n\n✓ Agent "Scan" finished\n\n', "\n\nagain\n\n"]);
});

test("a card keeps the last ten lines of what runs under it and counts them all", async () => {
  const agent: SessionEvent = {
    type: "call_started",
    callId: "toolu_agent",
    // A call that runs calls of its own and is no agent's start, as a skill in a fork: an
    // `Agent` call is held until its task starts.
    toolName: "Skill",
    input: { skill: "Scan" },
    parentCallId: null,
  };
  const inner = Array.from(
    { length: 12 },
    (_, i): SessionEvent => ({
      type: "call_started",
      callId: `toolu_${i + 1}`,
      toolName: "Read",
      input: { file_path: `f${i + 1}` },
      parentCallId: i < 6 ? "toolu_agent" : `toolu_${i}`, // the later ones nest a level deeper
    }),
  );
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  for (const event of [agent, ...inner]) await renderer.feed(event);
  const card = sink.tasks.at(-1);
  assert.deepEqual(ids(sink.tasks), new Set(["toolu_agent"]));
  assert.equal(card?.calls, 12);
  assert.deepEqual(
    card?.details?.split("\n"),
    Array.from({ length: 10 }, (_, i) => `Read: f${i + 3}`),
  );
  assert.equal(card?.task, true);
});

test("a reply closed again with no footer ends with the footer it had", async () => {
  // A report turn closes the reply of the turn that started the task, and passes no footer.
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  await renderer.close("footer");
  assert.equal(renderer.closedOut, false);
  await renderer.close(null);
  assert.equal(await renderer.closeOut(), true);
  assert.equal(sink.closedOut, "footer");
  assert.equal(renderer.closedOut, true);
});

test("a reply keeps the answers of a question it holds the line of, and shows them at its end", async () => {
  const events = recordedEvents("ask-answered");
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  const questions = [{ text: "Which color do you prefer?" }];
  const answers = { "Which color do you prefer?": "Blue" };
  assert.equal(renderer.answered("toolu_unseen", questions, answers), false);
  for (const event of events) {
    if (event.type === "call_ended") {
      assert.equal(renderer.answered(event.callId, questions, {}), false); // no answer to show
      assert.equal(renderer.answered(event.callId, questions, answers), true);
    }
    await renderer.feed(event);
  }
  const shown = sink.tasks.filter((t) => t.preview !== null);
  assert.deepEqual(
    shown.map((t) => [t.status, t.preview?.body, t.preview?.plain]),
    [["complete", "· Which color do you prefer? → Blue", true]],
  );
});

/** What a sink was handed, in order: a text with its options, or a task line by its id. */
class OrderedSink extends RecordingSink {
  log: Array<readonly ["text", string] | readonly ["task", string]> = [];

  override async text(
    markdown: string,
    options: { readonly notice?: boolean; readonly ending?: boolean } = {},
  ): Promise<void> {
    this.log.push(["text", `${options.notice ? "notice:" : ""}${markdown}`]);
    await super.text(markdown, options);
  }

  override async task(update: TaskUpdate): Promise<void> {
    this.log.push(["task", `${update.id}:${update.status}`]);
    await super.task(update);
  }

  /** The log with the texts between two task lines put together as one. */
  get whole(): Array<readonly [string, string]> {
    const merged: Array<readonly [string, string]> = [];
    for (const entry of this.log) {
      const last = merged.at(-1);
      if (entry[0] === "text" && last?.[0] === "text" && !entry[1].startsWith("notice:")) {
        merged[merged.length - 1] = ["text", last[1] + entry[1]];
      } else {
        merged.push(entry);
      }
    }
    return merged;
  }
}

async function renderOrdered(
  events: readonly SessionEvent[],
  streaming: boolean,
): Promise<OrderedSink> {
  const sink = new OrderedSink();
  const renderer = new TurnRenderer<string>(sink, NAMES, null, streaming);
  for (const event of events) await renderer.feed(event);
  await renderer.close("footer");
  await renderer.closeOut();
  return sink;
}

for (const name of ["tools", "foreground", "tool-error", "subagent", "ask"]) {
  test(`without native streaming each text reaches the sink whole, in place [${name}]`, async () => {
    const events = recordedEvents(name);
    const streamed = await renderOrdered(events, true);
    const whole = await renderOrdered(events, false);
    // The same texts and lines in the same order; only the pieces of a text are put together.
    // Both are read with their texts joined: a note of the daemon's (an agent's launch line)
    // and the text after it are two writes either way.
    assert.deepEqual(whole.whole, streamed.whole);
    assert.ok(whole.texts.length <= streamed.texts.length);
    assert.deepEqual(whole.finished, streamed.finished);
    assert.equal(whole.closedOut, streamed.closedOut);
  });
}

test("without native streaming a text of several pieces is one write", async () => {
  const events = recordedEvents("tools");
  const streamed = await renderOrdered(events, true);
  const whole = await renderOrdered(events, false);
  const pieces = streamed.log.filter(([kind]) => kind === "text").length;
  const texts = whole.log.filter(([kind]) => kind === "text").length;
  assert.ok(pieces > texts, `${pieces} pieces became ${texts} texts`);
  // Each text of the message once: none is cut in two, none repeated.
  assert.equal(new Set(whole.texts).size, whole.texts.length);
});

test("without native streaming a text waits for its end, and a notice does not reorder it", async () => {
  const sink = new OrderedSink();
  const renderer = new TurnRenderer<string>(sink, NAMES, null, false);
  await renderer.feed({ type: "text_started" });
  await renderer.feed({ type: "text_delta", text: "Hello " });
  await renderer.feed({ type: "text_delta", text: "there" });
  assert.deepEqual(sink.log, [], "nothing is handed over while the text is being written");
  await renderer.feedError("what a restart dropped");
  assert.deepEqual(sink.log, [
    ["text", "Hello there"],
    ["text", "notice:\n\nwhat a restart dropped"],
  ]);
});

test("without native streaming the last text is handed over when the reply closes", async () => {
  const sink = new OrderedSink();
  const renderer = new TurnRenderer<string>(sink, NAMES, null, false);
  await renderer.feed({ type: "text_started" });
  await renderer.feed({ type: "text_delta", text: "done" });
  await renderer.close(null);
  assert.deepEqual(sink.log, [["text", "done"]]);
  assert.notEqual(sink.finished, null);
});
