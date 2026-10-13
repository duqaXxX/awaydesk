/**
 * The reply sink, `ReplySink`: how a reply is written to a Slack thread. Every pause of the sink
 * is on a `FakeClock` and a test moves that clock: `settled()` lets a debounce of zero seconds
 * fire and the loop run dry, `passed(seconds)` crosses a pause. A caller that is cancelled is a
 * caller whose `AbortSignal` aborts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { WebAPICallResult } from "@slack/web-api";
import type { Preview, TaskStatus, TaskUpdate } from "../../../../src/chat/seam.ts";
import { formatFooter } from "../../../../src/chat/slack/footer.ts";
import {
  BANNER_LIMIT,
  BLOCKS_LIMIT,
  type Block,
  blocksCount,
  blockText,
  CARD_TEXT_LIMIT,
  CONTEXT_LIMIT,
  type ContextBlock,
  cardBlock,
  contextBlock,
  lacking,
  MESSAGE_LIMIT,
  noticeText,
  PREVIEW_CUT,
  previewBlocks,
  previewContainers,
  ZERO_WIDTH_SPACE,
} from "../../../../src/chat/slack/reply/blocks.ts";
import { len } from "../../../../src/chat/slack/reply/chars.ts";
import { deleteRequest, type Logger } from "../../../../src/chat/slack/reply/errors.ts";
import { type Limiter, UpdateLimiter } from "../../../../src/chat/slack/reply/limiter.ts";
import {
  bannerText,
  markdownBlocks,
  markdownCut,
  stripMarkdown,
} from "../../../../src/chat/slack/reply/markdown.ts";
import { ThreadPlaces } from "../../../../src/chat/slack/reply/places.ts";
import {
  ADOPT_SKEW_SECONDS,
  DEBOUNCE_SECONDS,
  ReplySink,
  STREAM_LIFE,
  STREAM_SECONDS,
  type Tool,
} from "../../../../src/chat/slack/reply/sinks.ts";
import type { Task } from "../../../../src/chat/slack/reply/tasks.ts";
import type { Clock } from "../../../../src/clock.ts";
import { Cancelled } from "../../../../src/core/port.ts";
import { TurnRenderer } from "../../../../src/core/reply/renderer.ts";
import { STOPPED } from "../../../../src/core/reply/words.ts";
import { StateStore } from "../../../../src/core/state.ts";
import * as texts from "../../../../src/core/texts.ts";
import { blank } from "../../../../src/text.ts";
import {
  AsyncEvent,
  BOT,
  CHANNEL,
  FakeClock,
  type FakeMessage,
  FakeSlack,
  networkDown,
  OWNER,
  ResetAfterApply,
  rejected,
  TEAM,
  THREAD,
  timedOut,
} from "../../../support/fake-slack.ts";
import { golden, type Json, type JsonObject, sdkRecords } from "../../../support/fixtures.ts";
import { NAMES } from "../../../support/names.ts";
import { recordedEvents } from "../../../support/replay.ts";

const WRITE_METHODS = [
  "chat.postMessage",
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
  "chat.update",
];

// Every clock a reply of the running test sleeps on: `settled` and `passed` move them all.
let clocks: FakeClock[] = [];

beforeEach(() => {
  clocks = [];
});

/** A clock whose sleep is over at once and moves its own time: a limiter on it never holds a test. */
class SelfPacedClock implements Clock {
  now = 0;

  async sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    // Time always moves, as a real clock's does: a pause too short to change a float would
    // otherwise be asked for again without end.
    const least = this.now + Number.EPSILON * Math.max(1, Math.abs(this.now));
    this.now = Math.max(this.now + seconds, seconds > 0 ? least : this.now);
  }

  time(): number {
    return this.now;
  }
}

/** The lines a sink logged, in order. */
class Recorded implements Logger {
  lines: { level: string; message: string }[] = [];

  debug(message: string): void {
    this.lines.push({ level: "DEBUG", message });
  }

  info(message: string): void {
    this.lines.push({ level: "INFO", message });
  }

  warning(message: string): void {
    this.lines.push({ level: "WARNING", message });
  }

  error(message: string): void {
    this.lines.push({ level: "ERROR", message });
  }

  get text(): string {
    return this.lines.map((line) => `${line.level} ${line.message}`).join("\n");
  }

  messages(): string[] {
    return this.lines.map((line) => line.message);
  }
}

interface ReplyOptions {
  limiter?: Limiter;
  clock?: FakeClock;
  onOpenReply?: (old: string | null, fresh: string | null) => void;
  onWrite?: () => void;
  logger?: Logger;
  /** Zero unless a test is about the debounce itself. */
  debounceSeconds?: number;
  /** The wait before the final write is sent once more (`FINAL_RETRY_SECONDS` unless given). */
  finalRetrySeconds?: number;
  /** Where the thread's messages sit, shared by the replies of a test that has several. */
  places?: ThreadPlaces;
}

function reply(slack: FakeSlack, options: ReplyOptions = {}): ReplySink {
  const clock = options.clock ?? new FakeClock();
  if (!clocks.includes(clock)) clocks.push(clock);
  return new ReplySink(slack, {
    channel: CHANNEL,
    threadTs: THREAD,
    teamId: TEAM,
    userId: OWNER,
    botUserId: BOT,
    // The default limiter paces on the wall clock; this one never makes a test wait.
    limiter: options.limiter ?? new UpdateLimiter({ clock: new SelfPacedClock() }),
    clock,
    onOpenReply: options.onOpenReply,
    onWrite: options.onWrite,
    logger: options.logger ?? new Recorded(),
    debounceSeconds: options.debounceSeconds ?? 0,
    finalRetrySeconds: options.finalRetrySeconds,
    ...(options.places !== undefined && { places: options.places }),
  });
}

/** What a test reaches into: the sink's `ending` task and its `flush`. */
function inner(sink: ReplySink): { ending: Task<boolean> | null; flush: () => Promise<boolean> } {
  return sink as unknown as { ending: Task<boolean> | null; flush: () => Promise<boolean> };
}

/** The Slack writes a reply made, in order. */
function methods(slack: FakeSlack): string[] {
  return slack.apiCalls.map((call) => call.method).filter((m) => WRITE_METHODS.includes(m));
}

const LIST_ID = "running-list";

/** The list of what still runs, as a test says it. */
const SHELL = { title: "1 shell still running", lines: ["Sleep for 5 seconds"] };
const AGENT = { title: "1 agent still running", lines: ["Agent: Test background agent"] };

/** The card the list draws: one `task_card` with a fixed id, in progress, a line per task. */
function listCard(running: { title: string; lines: readonly string[] }): JsonObject {
  return {
    type: "task_card",
    block_id: LIST_ID,
    task_id: LIST_ID,
    title: running.title,
    status: "in_progress",
    details: {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: running.lines.join("\n") }],
        },
      ],
    },
  };
}

const isCard = (block: JsonObject): boolean => block.block_id === LIST_ID;
const isDivider = (block: JsonObject): boolean => block.type === "divider";

/** One turn of the event loop, which drains every microtask. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Long enough for a debounced write: the debounce (zero seconds) fires and what it woke runs to
 * its next wait. Five rounds: a pass that finds the reply changed under it debounces again.
 */
async function settled(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    for (const clock of clocks) await clock.advance(0);
    await tick();
  }
}

/** `seconds` pass on every clock of the test, and what that woke runs to its next wait. */
async function passed(seconds: number): Promise<void> {
  for (const clock of clocks) await clock.advance(seconds);
}

/**
 * The promise must settle without anything else happening. Nothing in these tests waits on a
 * real timer, so one still pending once the loop has turned over would never settle.
 */
async function soon<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const guarded = promise.finally(() => {
    done = true;
  });
  guarded.catch(() => {});
  for (let round = 0; round < 50 && !done; round += 1) await tick();
  if (!done) throw new Error("still pending: it waits on something that never comes");
  return guarded;
}

function tool(
  id: string,
  name: string,
  status: TaskStatus = "complete",
  fields: Partial<TaskUpdate> = {},
): TaskUpdate {
  return {
    id,
    title: `${name}: ${id}`,
    status,
    details: null,
    output: null,
    name,
    task: false,
    calls: 0,
    preview: null,
    folded: null,
    ...fields,
  };
}

function preview(
  title: string,
  summary: string,
  body: string,
  language: "" | "diff" = "",
  plain = false,
): Preview {
  return { title, summary, body, language, plain };
}

type Maybe = Json | undefined;

/** `value[a][b]...`, a negative number counting from a list's end. */
function get(value: Maybe, ...path: (string | number)[]): Maybe {
  let here = value;
  for (const key of path) {
    if (Array.isArray(here) && typeof key === "number") here = here.at(key);
    else if (typeof here === "object" && here !== null && !Array.isArray(here)) {
      here = here[String(key)];
    } else return undefined;
  }
  return here;
}

function list(value: Maybe): JsonObject[] {
  assert.ok(Array.isArray(value), "not a list");
  return value.map((item) => {
    assert.ok(typeof item === "object" && item !== null && !Array.isArray(item), "not an object");
    return item;
  });
}

function str(value: Maybe): string {
  assert.equal(typeof value, "string");
  return value as string;
}

/** The only element of a list of one. */
function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  return items[0] as T;
}

/** The last element. */
function last<T>(items: readonly T[]): T {
  assert.ok(items.length > 0, "an empty list has no last element");
  return items.at(-1) as T;
}

/** Every chunk of every stream call, in order. */
function allChunks(slack: FakeSlack): JsonObject[] {
  return slack.apiCalls.flatMap((call) => ("chunks" in call.args ? list(call.args.chunks) : []));
}

const scratch: string[] = [];

function tmpPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "awd-sinks-"));
  scratch.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

// The stream: what starts it, what grows it, what ends it.

test("the first content starts the stream and nothing comes before it", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  assert.deepEqual(slack.apiCalls, []); // no placeholder: a reply that says nothing writes nothing
  await sink.text("Looking at the files.");
  await settled();
  const start = only(slack.callsTo("chat.startStream"));
  assert.deepEqual(methods(slack), ["chat.startStream"]);
  assert.ok(start.channel === CHANNEL && start.thread_ts === THREAD);
  assert.deepEqual([start.recipient_team_id, start.recipient_user_id], [TEAM, OWNER]);
  assert.equal(start.task_display_mode, "timeline");
  assert.deepEqual(start.chunks, [{ type: "markdown_text", text: "Looking at the files." }]);
});

test("a turn that opens with a tool starts with its card", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("t1", "Bash", "in_progress"));
  await settled();
  const start = only(slack.callsTo("chat.startStream"));
  assert.deepEqual(start.chunks, [
    { type: "task_update", id: "fold:t1", title: "Bash: t1", status: "in_progress" },
  ]);
});

test("text grows the stream and a card updates in place", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Let me look.\n\n");
  await settled();
  await sink.task(tool("t1", "Bash", "in_progress"));
  await settled();
  await sink.task(tool("t1", "Bash", "complete"));
  await sink.text("The tree is clean.");
  await settled();
  assert.deepEqual(methods(slack), ["chat.startStream", "chat.appendStream", "chat.appendStream"]);
  assert.deepEqual(slack.messageTexts(), ["Let me look.\n\nThe tree is clean."]);
  // one card, which the stream keeps updating where it first appeared
  assert.deepEqual(slack.messageCards(), [
    [{ id: "fold:t1", title: "Bash: t1", status: "complete" }],
  ]);
  const chunks = slack.callsTo("chat.appendStream").flatMap((a) => list(a.chunks));
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["task_update", "task_update", "markdown_text"],
  );
  assert.ok(slack.callsTo("chat.appendStream").every((a) => a.ts === slack.streamTs[0]));
});

test("changes inside one debounce go in one append", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("A");
  await settled();
  for (const piece of ["B", "C", "D"]) await sink.text(piece);
  await sink.task(tool("t1", "Bash", "in_progress"));
  await sink.task(tool("t1", "Bash", "complete"));
  await settled();
  const append = only(slack.callsTo("chat.appendStream"));
  assert.deepEqual(append.chunks, [
    { type: "markdown_text", text: "BCD" },
    { type: "task_update", id: "fold:t1", title: "Bash: t1", status: "complete" },
  ]);
});

test("the end stops the stream with the footer in one push", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Done.");
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  const stop = only(slack.callsTo("chat.stopStream"));
  assert.equal(stop.ts, slack.streamTs[0]);
  assert.deepEqual(stop.blocks, [
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: "main · ctx 6%" }] },
  ]);
  assert.deepEqual(methods(slack), ["chat.startStream", "chat.stopStream"]); // no post, no update
  assert.equal(slack.pushes(), 1);
});

test("a reply that ends before its first write starts and stops its stream", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Done.");
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  assert.deepEqual(methods(slack), ["chat.startStream", "chat.stopStream"]);
  assert.ok(!("blocks" in only(slack.callsTo("chat.stopStream")))); // no footer, nothing to add
  assert.deepEqual(slack.messageTexts(), ["Done."]);
  assert.equal(slack.pushes(), 1);
});

test("a reply with no content writes nothing", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.deepEqual(slack.apiCalls, []);
});

test("updates are debounced", async () => {
  // A debounce of 0.1 s on the fake clock, a change every 10 ms for 0.3 s.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, debounceSeconds: 0.1 });
  await sink.text("x");
  await clock.advance(0.15);
  for (let i = 0; i < 30; i += 1) {
    await sink.text(String(i));
    await clock.advance(0.01);
  }
  await clock.advance(0.3);
  const stamps = slack.callsTo("chat.appendStream").length;
  assert.ok(1 <= stamps && stamps <= 6, `${stamps} appends`); // 0.3 s of writing, at most one append per 0.1 s
});

// The 280 seconds: a stream cannot outlive 5 minutes, and a stopped message takes updates.

test("the stream stops at 280 seconds and the message grows by update", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("First words.\n\n");
  await sink.task(tool("t1", "Bash", "complete"));
  await settled();
  await clock.advance(STREAM_SECONDS - 1);
  assert.deepEqual(slack.callsTo("chat.stopStream"), []);
  await clock.advance(2);
  const stop = only(slack.callsTo("chat.stopStream"));
  assert.ok(!("blocks" in stop) && slack.pushes() === 1); // accepted: the stop pushes
  await sink.text("Later words.");
  await settled();
  assert.ok(last(methods(slack)) === "chat.update" && slack.streamTs.length === 1);
  const update = last(slack.callsTo("chat.update"));
  assert.equal(update.ts, slack.streamTs[0]);
  assert.deepEqual(get(update, "blocks", 0), { type: "markdown", text: "First words." });
  assert.ok(
    get(update, "blocks", 1, "type") === "task_card" &&
      get(update, "blocks", 1, "task_id") === "fold:t1",
  );
  assert.deepEqual(get(update, "blocks", 2), { type: "markdown", text: "Later words." });
  assert.equal(update.text, "First words."); // short, the banner of the message
  assert.equal(slack.pushes(), 1); // an update never pushes
});

test("a stream stopped early with nothing changed needs no update", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("All of it.");
  await sink.task(tool("t1", "Bash", "complete"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await settled();
  assert.deepEqual(methods(slack), ["chat.startStream", "chat.stopStream"]); // the stream shows it all
});

test("a card running at the switch is updated not left as an error", async () => {
  // A card left in progress in a stopped stream is stored as an error until updated (M33).
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("Started a server.");
  await sink.task(
    tool("t1", "Bash", "in_progress", { task: true, details: "Running in background" }),
  );
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await settled();
  const update = last(slack.callsTo("chat.update"));
  const card = only(list(update.blocks).filter((b) => b.type === "task_card"));
  assert.equal(card.status, "in_progress");
});

test("an answer that is text alone ends on a footer only message", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("**Bold** answer, with a [link](https://example.com).\n\nSecond paragraph.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(" More.");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.ok(closing.thread_ts === THREAD && closing.unfurl_links === false);
  assert.deepEqual(closing.blocks, [
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: "main · ctx 6%" }] },
  ]);
  // Claude's own words, plain: never a line of the daemon's
  assert.equal(closing.text, "Bold answer, with a link.");
  assert.equal(slack.pushes(), 2); // the stop at 280 s, and this one
  // nothing is moved (the first message would keep nothing): the footer lives in the closing
  // message, and the body message carries none
  assert.ok(list(last(slack.callsTo("chat.update")).blocks).every((b) => b.type !== "divider"));
});

/** A reply past the stream's 280 seconds: words, a call, then the answer Claude ends on. */
async function longReply(slack: FakeSlack, options: ReplyOptions = {}): Promise<ReplySink> {
  const clock = new FakeClock();
  const sink = reply(slack, { ...options, clock });
  await sink.text("Let me check the build.");
  await sink.task(tool("t1", "Edit"));
  await sink.text("The build passed.\n\n- 214 tests\n- no failures");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  return sink;
}

const ENDING = { type: "markdown", text: "The build passed.\n\n- 214 tests\n- no failures" };

/** The kinds of block the reply's first message shows last. */
function kept(slack: FakeSlack): Json[] {
  const first = slack.messages.get(slack.streamTs[0] ?? "");
  assert.ok(first !== undefined);
  return first.blocks.map((b) => b.type ?? null);
}

test("the end after the switch posts the ending with the footer", async () => {
  const slack = new FakeSlack();
  const sink = await longReply(slack);
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  // The text Claude wrote after its last call, whole, and the footer, as the message that
  // notifies: its text says how the work ended (the stream's own stop said how it began).
  const ending = only(slack.callsTo("chat.postMessage"));
  assert.ok(ending.thread_ts === THREAD && ending.unfurl_links === false);
  assert.deepEqual(ending.blocks, [ENDING, { type: "divider" }, contextBlock("main · ctx 6%")]);
  assert.equal(ending.text, "The build passed.");
  assert.equal(slack.pushes(), 2); // the stop at 280 s, and this one
  // The message it grew in keeps the rest, silently: nothing shows twice, and no footer there.
  assert.deepEqual(slack.messageTexts(), ["Let me check the build.", ENDING.text]);
  assert.deepEqual(kept(slack), ["markdown", "context"]); // its words, and the call as a line of counts
});

test("an ending takes what follows it", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Edit"));
  await sink.text("The edit is done.");
  await sink.text("_2 messages were not sent._", { notice: true });
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  const ending = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(
    list(ending.blocks).map((b) => b.type),
    ["markdown", "markdown", "divider", "context"],
  );
  assert.equal(get(ending, "blocks", 0, "text"), "The edit is done.");
  assert.equal(ending.text, "The edit is done."); // never a line of the daemon's
  assert.ok(!kept(slack).includes("markdown")); // the call stays, the words moved
});

test("an ending that slack did not take is posted once by the retry", async () => {
  const slack = new FakeSlack();
  const sink = await longReply(slack, { finalRetrySeconds: 0.02 });
  const answer = slack.responses["chat.postMessage"] as JsonObject;
  slack.responses["chat.postMessage"] = [rejected("ratelimited"), answer];
  assert.equal(await sink.closeOutFormatted("footer"), false);
  // Not posted: the answer stays where it was, never nowhere.
  assert.deepEqual(slack.messageTexts(), [`Let me check the build.\n\n${ENDING.text}`]);
  await passed(0.02);
  assert.equal(await soon(sink.waitLanded()), true);
  assert.deepEqual(slack.messageTexts(), ["Let me check the build.", ENDING.text]);
  assert.ok(slack.postedTs.length === 1 && slack.pushes() === 2);
});

test("an ending left twice by a failed edit has not landed until the retry", async () => {
  const slack = new FakeSlack();
  const sink = await longReply(slack, { finalRetrySeconds: 0.02 });
  slack.responses["chat.update"] = [rejected("ratelimited"), { ok: true }];
  assert.equal(await sink.closeOutFormatted("footer"), false); // posted, still shown in the first message
  assert.ok(slack.messageTexts()[1] === ENDING.text && kept(slack).slice(2).includes("markdown"));
  await passed(0.02);
  assert.equal(await soon(sink.waitLanded()), true);
  assert.deepEqual(slack.messageTexts(), ["Let me check the build.", ENDING.text]);
  assert.equal(slack.postedTs.length, 1);
});

/**
 * A reply whose `closeOut` caller is cancelled while Slack holds the end's write open (released
 * by setting the returned event).
 */
async function cancelledInsideTheEnd(
  slack: FakeSlack,
  options: ReplyOptions = {},
): Promise<[ReplySink, AsyncEvent]> {
  const sink = reply(slack, options);
  await sink.text("Hello.");
  await settled();
  await sink.finish([], null);
  const gate = new AsyncEvent();
  slack.gate = gate;
  slack.gated.clear();
  const caller = new AbortController();
  const closing = sink.closeOutFormatted("footer", caller.signal);
  await slack.gated.wait();
  caller.abort(new Cancelled());
  await assert.rejects(closing, Cancelled);
  return [sink, gate];
}

test("a close out whose caller is cancelled still lands and resolves", async () => {
  const slack = new FakeSlack();
  const [sink, gate] = await cancelledInsideTheEnd(slack);
  slack.gate = null;
  gate.set();
  assert.equal(await soon(sink.waitLanded()), true);
  assert.equal(await sink.closeOutFormatted("footer"), true);
});

test("a close out cancelled over a write slack refused still gets its retry", async () => {
  const slack = new FakeSlack();
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), { ok: true }];
  const [sink, gate] = await cancelledInsideTheEnd(slack, { finalRetrySeconds: 0.02 });
  slack.gate = null;
  gate.set();
  // The refused end schedules its retry; the pause before it passes.
  await inner(sink).ending?.settled();
  await passed(0.02);
  assert.equal(await soon(sink.waitLanded()), true);
  assert.equal(slack.callsTo("chat.stopStream").length, 2); // the refused write, then the retry
});

test("a settle behind a refused end leaves no retry alive", async () => {
  const slack = new FakeSlack();
  // Slack refuses the end and then the shutdown's own write: that shutdown has lost the reply
  // and nothing may write it afterwards.
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), rejected("ratelimited")];
  const [sink, gate] = await cancelledInsideTheEnd(slack, { finalRetrySeconds: 0.02 });
  const settling = sink.settle(); // queues behind the end's write
  await tick();
  slack.gate = null;
  gate.set();
  assert.equal(await soon(settling), false);
  const writes = slack.apiCalls.length;
  await passed(0.1); // well past FINAL_RETRY_SECONDS
  assert.equal(slack.apiCalls.length, writes); // nothing goes out after `settle` returned
});

test("an end that raises still resolves landed", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Hello.");
  await settled();
  await sink.finish([], null);
  inner(sink).flush = async () => {
    throw new RangeError("boom");
  };
  await assert.rejects(sink.closeOutFormatted("footer"), RangeError);
  assert.equal(await soon(sink.waitLanded()), false);
  assert.equal(await sink.closeOutFormatted("footer"), false);
});

test("an ending cut off while it is posted is posted before anything is shortened", async () => {
  const slack = new FakeSlack();
  const sink = await longReply(slack);
  // Slack holds the ending's post open.
  const gate = new AsyncEvent();
  slack.gate = gate;
  slack.gateMethod = "chat.postMessage";
  slack.gated.clear();
  const caller = new AbortController();
  const closing = sink.closeOutFormatted("footer", caller.signal);
  await slack.gated.wait(); // the ending's post is out
  caller.abort(new Cancelled());
  await closing.catch(() => {});
  assert.deepEqual(slack.postedTs, []); // cut off before Slack took it
  const writes = slack.apiCalls.length;
  const settling = sink.settle(); // a shutdown's last pass
  slack.gate = null;
  gate.set();
  assert.equal(await soon(settling), true);
  const order = slack.apiCalls
    .slice(writes)
    .map((call) => call.method)
    .filter((m) => m === "chat.postMessage" || m === "chat.update");
  assert.equal(order[0], "chat.postMessage"); // posted first: never nowhere
  assert.deepEqual(slack.messageTexts(), ["Let me check the build.", ENDING.text]);
  assert.equal(slack.postedTs.length, 1);
});

test("the ending follows the running list by edits", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = await longReply(slack, { places });
  await sink.closeOutFormatted("footer");
  const ts = slack.postedTs[0];
  places.showRunning(SHELL);
  await settled();
  const edit = last(slack.callsTo("chat.update"));
  assert.equal(edit.ts, ts);
  assert.deepEqual(list(edit.blocks).slice(-3), [
    listCard(SHELL),
    { type: "divider" },
    contextBlock("footer"),
  ]);
  places.showRunning(null);
  await settled();
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-2), [
    { type: "divider" },
    contextBlock("footer"),
  ]);
  assert.ok(slack.postedTs.length === 1 && slack.pushes() === 2); // an edit never pushes
});

test("a reply whose end was refused lands it on the retry", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack, { finalRetrySeconds: 0.02 });
  await sink.text("Done.");
  await sink.finish([], null);
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), { ok: true }];
  assert.equal(await sink.closeOutFormatted("footer"), false);
  assert.equal(slack.streamEnds, 0, "Slack holds no ending before the retry");
  await passed(0.02);
  assert.equal(await soon(sink.waitLanded()), true);
  const stops = slack.callsTo("chat.stopStream");
  assert.equal(stops.length, 2, "the refused stop and the retry");
  assert.deepEqual(list(last(stops).blocks).slice(-2), [
    { type: "divider" },
    contextBlock("footer"),
  ]);
  assert.equal(slack.streamEnds, 1, "and Slack holds the ending after it");
});

test("the closing message text skips the daemon s own lines", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("_Compacted the conversation._\n\n", { notice: true });
  await sink.text("The real answer & more.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.equal(closing.text, "The real answer &amp; more.");
  assert.deepEqual(closing.blocks, [contextBlock(ZERO_WIDTH_SPACE)]); // no footer to show
});

const ERROR_LINE = "Claude Code reported an error: `the Claude Code process exited`";

test("a reply cut short after its stream stopped ends with the daemon s line", async () => {
  // Issue #165, seen live on 2026-10-08: the reply's last part was a tool call, the turn had no
  // footer, and the message that notified showed empty while the error sat in an edit.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [{ type: "markdown", text: ERROR_LINE }]);
  assert.equal(closing.text, bannerText(ERROR_LINE, { limit: BANNER_LIMIT }));
  const stayed = list(last(slack.callsTo("chat.update")).blocks);
  // moved, not shown twice
  assert.ok(stayed.every((block) => !JSON.stringify(block).includes(ERROR_LINE)));
});

test("an answer of text alone cut short ends with the daemon s line", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("Half an answer");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [{ type: "markdown", text: ERROR_LINE }]);
  assert.deepEqual(last(slack.callsTo("chat.update")).blocks, [
    { type: "markdown", text: "Half an answer" },
  ]);
});

test("a reply cut short while a task still counts ends with the daemon s line", async () => {
  // The session shows the running list before it closes a reply and empties it once the lost
  // process's tasks are stopped: the list is no footer, and the closing message it made
  // ended up empty when the list did.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const places = new ThreadPlaces();
  const sink = reply(slack, { clock, places });
  await sink.task(tool("t1", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  places.showRunning(AGENT);
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  // The post that rings carries the line alone; the edit once its end landed adds the list.
  assert.deepEqual(closing.blocks, [{ type: "markdown", text: ERROR_LINE }]);
  assert.equal(closing.text, bannerText(ERROR_LINE, { limit: BANNER_LIMIT }));
  await settled();
  assert.deepEqual(last(slack.messageBlocks()), [
    { type: "markdown", text: ERROR_LINE },
    listCard(AGENT),
  ]);
  places.showRunning(null);
  await settled();
  assert.deepEqual(last(slack.messageBlocks()), [{ type: "markdown", text: ERROR_LINE }]);
});

test("an answer of text alone under a daemon line cut short ends with the error", async () => {
  // A compaction at the turn's start writes its line before the answer: the text is then no
  // ending (only a line of the daemon's would stay above it), and the error still is one.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text(`${texts.COMPACTED_PLAIN}\n\n`, { notice: true });
  await sink.text("Half an answer");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [{ type: "markdown", text: ERROR_LINE }]);
  assert.deepEqual(last(slack.callsTo("chat.update")).blocks, [
    { type: "markdown", text: texts.COMPACTED_PLAIN },
    { type: "markdown", text: "Half an answer" },
  ]);
});

test("only the line on how the reply ended moves not a notice written before it", async () => {
  // Two notices in a row were one part: the compaction line moved with the error and was the
  // notification's text.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${texts.COMPACTED_PLAIN}\n\n`, { notice: true });
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [{ type: "markdown", text: ERROR_LINE }]);
  assert.equal(closing.text, bannerText(ERROR_LINE, { limit: BANNER_LIMIT }));
  assert.ok(
    JSON.stringify(last(slack.callsTo("chat.update")).blocks).includes(texts.COMPACTED_PLAIN),
  );
});

test("a card that closes after the line on how the reply ended moves under it", async () => {
  // Two calls open when the turn is cut: closing them draws a card after the error line, which
  // was then no longer the reply's last part, and the closing message showed empty.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.task(tool("t2", "Read"));
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(get(closing, "blocks", 0), { type: "markdown", text: ERROR_LINE });
  // folded, as a run that ended
  assert.ok(JSON.stringify(list(closing.blocks).slice(1)).includes("Read 1 file"));
  // the error, not the card's title, is what the notification says
  assert.equal(closing.text, bannerText(ERROR_LINE, { limit: BANNER_LIMIT }));
});

test("a daemon line that does not say how the reply ended never moves", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${texts.COMPACTED_PLAIN}`, { notice: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [contextBlock(ZERO_WIDTH_SPACE)]);
  assert.ok(
    JSON.stringify(last(slack.callsTo("chat.update")).blocks).includes(texts.COMPACTED_PLAIN),
  );
});

test("the line on how the reply ended moves from under a notice alone", async () => {
  // Nothing of the answer above it, only a line of the daemon's: that line stays, and the
  // message that notifies holds the error where it showed empty.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text(`${texts.COMPACTED_PLAIN}\n\n`, { notice: true });
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [{ type: "markdown", text: ERROR_LINE }]);
  assert.deepEqual(last(slack.callsTo("chat.update")).blocks, [
    { type: "markdown", text: texts.COMPACTED_PLAIN },
  ]);
});

test("the line on how the reply ended moves with a footer an earlier turn left", async () => {
  // A report turn cut short renders into a reply that already has its first turn's footer:
  // the footer alone was the ending, and the error stayed in a silent edit.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [
    { type: "markdown", text: ERROR_LINE },
    { type: "divider" },
    contextBlock("footer"),
  ]);
  assert.equal(closing.text, bannerText(ERROR_LINE, { limit: BANNER_LIMIT }));
});

test("a last message that opens with the line on how the reply ended is the ending", async () => {
  // The first message is full to the character, so the whole error line goes on in a
  // continuation, which rings with it: a closing message after it showed empty and rang a
  // third time. With any room left the line is cut where the room ends, as any text is.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("w".repeat(MESSAGE_LIMIT));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  // The first message holds it all, in one stream, and no more.
  assert.ok(slack.streamTs.length === 1 && slack.postedTs.length === 0);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  await settled();
  const continuation = only(slack.callsTo("chat.postMessage")); // and no closing message after it
  assert.deepEqual(continuation.blocks, [{ type: "markdown", text: ERROR_LINE }]);
  assert.equal(continuation.text, bannerText(ERROR_LINE, { limit: BANNER_LIMIT }));
  assert.deepEqual(last(slack.messageBlocks()), continuation.blocks);
});

test("a last message that opens after the line on how the reply ended is the ending", async () => {
  // The line fits the first message and the note under it does not: the continuation starts
  // in the note, past the line, and a closing message after it showed empty all the same.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("w".repeat(MESSAGE_LIMIT - `\n\n${ERROR_LINE}`.length));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(`\n\n${ERROR_LINE}`, { ending: true });
  await sink.text("\n\n_3 messages were not sent: Claude Code stopped._", { notice: true });
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  await settled();
  const continuation = only(slack.callsTo("chat.postMessage")); // and no closing message after it
  assert.ok(JSON.stringify(continuation.blocks).includes("were not sent"));
  assert.ok(!JSON.stringify(slack.messageBlocks()).includes(ZERO_WIDTH_SPACE));
});

test("a daemon line stays in the reply when the footer is the ending", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text("\n\n_Stopped._", { notice: true });
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(closing.blocks, [{ type: "divider" }, contextBlock("footer")]);
});

test("a stream slack closed first falls back to updates", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("one");
  await settled();
  slack.expire(slack.streamTs[0] ?? ""); // Slack ended it, at 5 minutes, before the daemon's timer
  await sink.text(" two");
  await settled();
  assert.equal(get(last(slack.callsTo("chat.appendStream")), "chunks", 0, "text"), " two"); // refused
  const update = last(slack.callsTo("chat.update"));
  assert.deepEqual(update.blocks, [{ type: "markdown", text: "one two" }]);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  assert.equal(slack.callsTo("chat.postMessage").length, 1); // the closing message, as after 280 s
});

test("a stop refused because the stream expired still ends the reply", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("one");
  await settled();
  slack.expire(slack.streamTs[0] ?? "");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.equal(slack.callsTo("chat.postMessage").length, 1);
  assert.equal(slack.pushes(), 2); // Slack's own stop, then the closing message
});

// Limits: a message holds so much, and the reply goes on in the next.

test("text past the limit continues in a new stream", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  const body = "a line of text\n".repeat(1_000); // 15,000 characters
  await sink.text(body);
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  assert.ok(slack.streamTs.length === 2 && slack.postedTs.length === 0);
  const [first, second] = slack.messageTexts();
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(first.length <= MESSAGE_LIMIT && second.length <= MESSAGE_LIMIT);
  assert.equal(`${first}\n${second}`, body.replace(/^\n+|\n+$/g, "")); // nothing lost at the cut
  const stops = slack.callsTo("chat.stopStream");
  assert.deepEqual(
    stops.map((s) => "blocks" in s),
    [false, true],
  ); // the footer only ends the reply
  assert.equal(slack.pushes(), 2); // each extra message pushes (accepted)
});

test("cards past the limit continue in a new stream", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  for (let i = 0; i < 60; i += 1) {
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true })); // each has a card of its own
  }
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  assert.deepEqual(
    slack.messageCards().map((cards) => cards.length),
    [BLOCKS_LIMIT, 15],
  );
});

test("a reply past the limit after the window continues in a post", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text("a line of text\n".repeat(1_000));
  await settled();
  assert.ok(slack.streamTs.length === 1 && slack.postedTs.length === 1);
  const [first, second] = slack.messageTexts();
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(first.length <= MESSAGE_LIMIT && second.length <= MESSAGE_LIMIT);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  assert.equal(slack.postedTs.length, 2); // the closing message follows the continuation
});

test("a message never holds more blocks than slack allows", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("go\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  for (let i = 0; i < 80; i += 1) {
    // text and cards alternating: every one is a block of its own
    await sink.text(`step ${i}`);
    await sink.task(tool(`t${i}`, "Read"));
  }
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  await settled();
  for (const message of slack.messageBlocks()) assert.ok(message.length <= 50);
  for (const call of slack.apiCalls) {
    if (call.method === "chat.update" || call.method === "chat.postMessage") {
      assert.ok(list(call.args.blocks).length <= 50);
    }
  }
});

test("a long reply keeps the text of an update short", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text(`${"word ".repeat(60)}\n`);
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text("tail ".repeat(2_000));
  await settled();
  for (const call of slack.apiCalls) {
    if (call.method === "chat.update" || call.method === "chat.postMessage") {
      assert.ok(str(call.args.text).length <= BANNER_LIMIT);
    }
  }
});

// What follows the end: a late change edits the stopped message, silently.

test("a task that ends after the reply edits the stopped message", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Started it.");
  await sink.task(
    tool("t1", "Bash", "in_progress", { task: true, details: "Running in background" }),
  );
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  assert.equal(slack.pushes(), 1);
  await sink.task(tool("t1", "Bash", "complete", { task: true }));
  await settled();
  const update = last(slack.callsTo("chat.update"));
  assert.equal(update.ts, slack.streamTs[0]);
  const card = only(list(update.blocks).filter((b) => b.type === "task_card"));
  assert.equal(card.status, "complete");
  assert.equal(get(update, "blocks", -1, "elements", 0, "text"), "footer"); // the footer stays
  assert.equal(slack.pushes(), 1);
});

test("an unchanged running list writes nothing", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Done.");
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  places.showRunning(null);
  await settled();
  places.showRunning(SHELL);
  await settled();
  const before = slack.apiCalls.length;
  places.showRunning({ ...SHELL, lines: [...SHELL.lines] }); // the same list, another object
  places.showRunning(SHELL);
  await settled();
  assert.equal(slack.apiCalls.length, before);
});

test("a reply that stops holding the list drops it at once, a rested one too", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Done.");
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-3), [
    listCard(SHELL),
    { type: "divider" },
    contextBlock("footer"),
  ]);
  // A reply written below that rests takes the list; this one is left with no card.
  const below = reply(slack, { places });
  await below.text("More.");
  await below.finish([], null);
  await below.closeOutFormatted(null);
  await settled();
  const [above, lower] = slack.messageBlocks();
  assert.ok(!(above ?? []).some(isCard), "the reply above lost the list");
  assert.deepEqual((lower ?? []).filter(isCard), [listCard(SHELL)]);
  assert.equal(slack.callsTo("chat.delete").length, 0);
});

test("the list is written whenever it changes, on a reply that rests before its end", async () => {
  // The defect this replaces: the count was written only once the reply was closed out, so one
  // that rested kept a stale count, and one that stopped being the latest kept it for good.
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Started a command.");
  await sink.finishFormatted([], "footer");
  sink.rest();
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 1);
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-3), [
    listCard(SHELL),
    { type: "divider" },
    contextBlock("footer"),
  ]);
  places.showRunning({ title: "2 shells still running", lines: ["a", "b"] });
  await settled();
  const second = listCard({ title: "2 shells still running", lines: ["a", "b"] });
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).filter(isCard), [second]);
  places.showRunning(null);
  await settled();
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).filter(isCard), []);
  assert.equal(slack.pushes(), 1, "no push ever comes from the list");
});

test("the closing message follows the running list", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const places = new ThreadPlaces();
  const sink = reply(slack, { clock, places });
  await sink.text("Done.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const ts = slack.postedTs[0];
  places.showRunning(SHELL);
  await settled();
  const edit = last(slack.callsTo("chat.update"));
  assert.equal(edit.ts, ts);
  assert.deepEqual(edit.blocks, [listCard(SHELL), { type: "divider" }, contextBlock("footer")]);
  assert.equal(edit.text, "Done."); // an edit never pushes: the text stays Claude's words
  places.showRunning(null);
  await settled();
  // no list: the footer stays
  assert.deepEqual(last(slack.callsTo("chat.update")).blocks, [
    { type: "divider" },
    contextBlock("footer"),
  ]);
  assert.ok(slack.postedTs.length === 1 && slack.callsTo("chat.delete").length === 0);
});

test("a second close out call is a no op", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Done.");
  await sink.finish([], null);
  await sink.closeOutFormatted("one");
  const before = slack.apiCalls.length;
  await sink.closeOutFormatted("two");
  assert.equal(slack.apiCalls.length, before);
});

// Failures never raise, and the end is tried once more.

test("a slack failure never raises", async () => {
  const slack = new FakeSlack();
  slack.responses["chat.startStream"] = networkDown();
  const sink = reply(slack);
  await sink.text("hello");
  await sink.task(tool("t1", "Bash"));
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  await sink.settle();
});

test("a failed append is sent with the next flush", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("A");
  await settled();
  slack.responses["chat.appendStream"] = [networkDown(), { ok: true }];
  await sink.text("B");
  await settled();
  await sink.text("C");
  await settled();
  assert.deepEqual(slack.messageTexts(), ["ABC"]); // B was not lost, nor sent twice
});

test("a failed start is tried again with everything since", async () => {
  const slack = new FakeSlack();
  slack.responses["chat.startStream"] = [
    networkDown(),
    slack.responses["chat.startStream"] as JsonObject,
  ];
  const sink = reply(slack);
  await sink.text("one");
  await settled();
  assert.deepEqual(slack.streamTs, []);
  await sink.text(" two");
  await settled();
  assert.deepEqual(slack.messageTexts(), ["one two"]);
});

test("a final write lost to the network is tried again once", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack, { finalRetrySeconds: 0.01 });
  await sink.text("Done.");
  await settled();
  slack.responses["chat.stopStream"] = [networkDown(), { ok: true }];
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  await passed(0.01);
  assert.equal(await soon(sink.waitLanded()), true);
  assert.equal(slack.callsTo("chat.stopStream").length, 2);
});

test("a final write that fails twice is reported lost", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack, { finalRetrySeconds: 0.01 });
  await sink.text("Done.");
  await settled();
  slack.responses["chat.stopStream"] = networkDown();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  await passed(0.01);
  assert.equal(await soon(sink.waitLanded()), false);
});

test("settle writes what is still debounced and retries the end", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("one");
  assert.equal(await sink.settle(), true); // nothing waits a debounce at a shutdown
  assert.deepEqual(slack.messageTexts(), ["one"]);
  slack.responses["chat.stopStream"] = [networkDown(), { ok: true }];
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted(null), false);
  assert.equal(await sink.settle(), true); // the retry still waiting is tried now
  assert.equal(await soon(sink.waitLanded()), true);
});

test("an error is logged without message content", async () => {
  const slack = new FakeSlack();
  const log = new Recorded();
  const sink = reply(slack, { logger: log });
  await sink.text("first");
  await settled();
  slack.responses["chat.appendStream"] = rejected("ratelimited");
  await sink.text(" the owner's secret content");
  await settled();
  assert.ok(log.text.includes("ratelimited"));
  assert.ok(!log.text.includes("secret content"));
});

test("a refused rewrite never replaces a message that shows its body", async () => {
  // A reply that ended inline already shows its whole body. Slack refusing a later rewrite of
  // it (the list joining its footer, say) must leave that body as it is: no plain-text
  // fallback.
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("line of text\n".repeat(400));
  await sink.task(tool("t1", "Bash"));
  await sink.finish([], null);
  assert.ok(await sink.closeOutFormatted("footer"));
  slack.responses["chat.update"] = rejected("invalid_blocks");
  places.showRunning(SHELL);
  await settled();
  const updates = slack.callsTo("chat.update");
  assert.ok(updates.length > 0 && updates.every((u) => list(u.blocks).length > 0));
  const tried = updates.length;
  await settled();
  assert.equal(slack.callsTo("chat.update").length, tried); // the change is dropped, not retried
  slack.responses["chat.update"] = { ok: true };
  places.showRunning({ title: "2 shells still running", lines: ["a", "b"] }); // a later change is tried again
  await settled();
  assert.equal(slack.callsTo("chat.update").length, tried + 1);
});

test("a refused continuation post is posted as plain text", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.postMessage"] = [
    rejected("invalid_blocks"),
    rejected("invalid_blocks"),
    { ok: true, ts: "9.9" },
  ];
  await sink.text("a line of text\n".repeat(1_000));
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const plain = slack.callsTo("chat.postMessage").filter((p) => !("blocks" in p));
  assert.ok(plain.length > 0 && str(plain[0]?.text).startsWith("a line of text"));
});

test("a refused draft update is not retried as plain text", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("partial");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.update"] = rejected("invalid_blocks");
  await sink.text(" more");
  await settled();
  assert.ok(
    slack.callsTo("chat.update").every((a) => !Array.isArray(a.blocks) || a.blocks.length > 0),
  );
});

test("a rate limited update is never turned into plain text", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("one");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text(" two");
  slack.responses["chat.update"] = rejected("ratelimited");
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  assert.ok(
    slack.callsTo("chat.update").every((a) => !Array.isArray(a.blocks) || a.blocks.length > 0),
  );
});

// Crash repair's bookkeeping: the message that a crash would leave unfinished.

test("the open reply is the stream until the end lands", async () => {
  const slack = new FakeSlack();
  const seen: [string | null, string | null][] = [];
  const sink = reply(slack, { onOpenReply: (old, fresh) => seen.push([old, fresh]) });
  await sink.text("x".repeat(MESSAGE_LIMIT + 10)); // two streams
  await settled();
  const [first, second] = slack.streamTs;
  assert.ok(first !== undefined && second !== undefined && slack.streamTs.length === 2);
  // the first is whole once the second starts (its cards are final): only the last stays open
  assert.deepEqual(seen, [
    [null, first],
    [null, second],
    [first, null],
  ]);
  await sink.finish([], null);
  assert.deepEqual(last(seen), [first, null]); // still open: the reply has not ended
  await sink.closeOutFormatted("footer");
  assert.deepEqual(last(seen), [second, null]);
});

test("two sinks never step on each other s entry", async () => {
  const slack = new FakeSlack();
  const directory = tmpPath();
  const store = new StateStore(join(directory, "state.json"));
  store.bind(CHANNEL, directory);
  store.openThread(CHANNEL, THREAD);
  const track = (old: string | null, fresh: string | null): void => {
    store.replaceOpenReply(CHANNEL, THREAD, old, fresh);
  };
  const limiter = new UpdateLimiter({ clock: new SelfPacedClock() });
  const a = reply(slack, { limiter, onOpenReply: track });
  const b = reply(slack, { limiter, onOpenReply: track });
  await a.text("A");
  await a.settle();
  await b.text("B");
  await b.settle();
  assert.deepEqual(store.thread(CHANNEL, THREAD)?.openReplies, slack.streamTs);
  await a.finish([], null);
  await a.closeOutFormatted(null);
  assert.deepEqual(store.thread(CHANNEL, THREAD)?.openReplies, [slack.streamTs[1]]);
});

test("a failed end keeps the reply tracked until the retry lands", async () => {
  const slack = new FakeSlack();
  const seen: [string | null, string | null][] = [];
  const sink = reply(slack, {
    finalRetrySeconds: 0.01,
    onOpenReply: (old, fresh) => seen.push([old, fresh]),
  });
  await sink.text("Done.");
  await settled();
  const ts = slack.streamTs[0];
  assert.ok(ts !== undefined);
  slack.responses["chat.stopStream"] = [networkDown(), { ok: true }];
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  assert.deepEqual(seen, [[null, ts]]); // the stream is still open: repair must still find it
  await passed(0.01);
  await soon(sink.waitLanded());
  assert.deepEqual(last(seen), [ts, null]);
});

test("a failed tracking write never orphans the stored ts", async () => {
  const slack = new FakeSlack();
  const directory = tmpPath();
  const store = new StateStore(join(directory, "state.json"));
  store.bind(CHANNEL, directory);
  store.openThread(CHANNEL, THREAD);
  let failing = false;
  const track = (old: string | null, fresh: string | null): void => {
    if (failing) throw new Error("disk full");
    store.replaceOpenReply(CHANNEL, THREAD, old, fresh);
  };
  const sink = reply(slack, { onOpenReply: track });
  await sink.text("x");
  await settled();
  const first = slack.streamTs[0];
  failing = true;
  await sink.text("y".repeat(MESSAGE_LIMIT + 10));
  await settled();
  assert.deepEqual(store.thread(CHANNEL, THREAD)?.openReplies, [first]);
  failing = false;
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  assert.deepEqual(store.thread(CHANNEL, THREAD)?.openReplies, []);
});

// Cards and previews.

test("a card says what the tool line said", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(
    tool("a", "Agent", "in_progress", { details: "Read: x\nBash: ls", calls: 3, task: true }),
  );
  await sink.task(tool("b", "Bash", "error", { output: "exit 1" }));
  await sink.task(tool("c", "Bash", "complete", { output: STOPPED }));
  await sink.task(tool("d", "Bash", "complete", { output: "fine" })); // a success shows no output
  await settled();
  assert.deepEqual(slack.messageCards()[0], [
    {
      id: "a",
      title: "Agent: a · 3 calls",
      status: "in_progress",
      details: "Read: x\nBash: ls",
    },
    // a call of a run of calls says why it failed in its title: its card is reused, and
    // Slack appends `output` to what a card already holds
    { id: "fold:b", title: "Bash: b · exit 1", status: "error" },
    { id: "c", title: "Bash: c", status: "complete", output: STOPPED },
    { id: "fold:d", title: "Bash: d", status: "complete" },
  ]);
});

test("an edit that ended well is one container with no card", async () => {
  // Issue #136: the call's line is the container's title, its sentence the subtitle.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const view = preview("Update(a.txt)", "Added 1 line", "+🟩 1 x", "diff");
  await sink.task(tool("e", "Edit", "complete", { preview: view }));
  await settled();
  const start = only(slack.callsTo("chat.startStream"));
  const blocks = only(list(start.chunks));
  assert.equal(blocks.type, "blocks");
  const container = only(list(blocks.blocks));
  assert.ok(container.type === "container" && container.is_collapsible === true);
  assert.deepEqual(container.title, { type: "plain_text", text: "Update(a.txt)" });
  assert.deepEqual(container.subtitle, { type: "plain_text", text: "Added 1 line" });
  // The call's line in code style, as a tool line shows it; the plain title is the fallback.
  const section = only(list(get(container, "rich_text_title", "elements")));
  assert.deepEqual(section.elements, [
    { type: "text", text: "Update(a.txt)", style: { code: true } },
  ]);
});

test("a new file that was written is one container with no card", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  const view = preview("Write(new.txt)", "Wrote 2 lines to new.txt", "1 alpha\n2 beta");
  await sink.task(tool("w", "Write", "complete", { preview: view }));
  await settled();
  const start = only(slack.callsTo("chat.startStream"));
  const blocks = only(list(start.chunks));
  const container = only(list(blocks.blocks));
  assert.equal(get(container, "title", "text"), "Write(new.txt)");
  assert.equal(get(container, "subtitle", "text"), "Wrote 2 lines to new.txt");
  assert.equal(container.default_collapsed, true);
  const pre = only(list(get(container, "child_blocks", 0, "elements")));
  assert.ok(!("language" in pre)); // no highlighting asked for lines that are no diff
  assert.equal(blockText(container as unknown as Block), "1 alpha\n2 beta");
});

test("a diff under a card that already showed keeps the sentence as title", async () => {
  // A stream cannot take a card back: a call that showed one keeps it, and its container
  // does not repeat the call's line (issue #110).
  const slack = new FakeSlack();
  const sink = reply(slack);
  const view = preview("Update(a.txt)", "Added 1 line", "+x", "diff");
  await sink.task(tool("e", "Edit", "in_progress"));
  await settled();
  await sink.task(tool("e", "Edit", "complete", { preview: view }));
  await settled();
  const append = only(slack.callsTo("chat.appendStream"));
  const [card, blocks] = list(append.chunks);
  assert.ok(card?.type === "task_update" && card.title === "Update(a.txt)");
  const container = only(list(blocks?.blocks));
  assert.ok(get(container, "title", "text") === "Added 1 line" && !("subtitle" in container));
  assert.ok(!("rich_text_title" in container));
});

test("a preview with no lines keeps its card", async () => {
  // An empty new file has nothing to put in a container: the card says the sentence.
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(
    tool("w", "Write", "complete", {
      preview: preview("Write(e.txt)", "Wrote 0 lines to e.txt", ""),
    }),
  );
  await settled();
  const start = only(slack.callsTo("chat.startStream"));
  const card = only(list(start.chunks));
  assert.ok(card.type === "task_update" && card.output === "Wrote 0 lines to e.txt");
});

test("a new file preview follows its card as a code block", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  const view = preview("Write(new.txt)", "Wrote 2 lines to new.txt", "1 alpha\n2 beta");
  await sink.task(tool("w", "Write", "in_progress"));
  await settled();
  await sink.task(tool("w", "Write", "complete", { preview: view }));
  await settled();
  const append = only(slack.callsTo("chat.appendStream"));
  assert.deepEqual(
    list(append.chunks).map((c) => c.type),
    ["task_update", "blocks"],
  );
  // a blocks chunk holding a markdown block: measured accepted 2026-09-29
  assert.deepEqual(get(append, "chunks", 1), {
    type: "blocks",
    blocks: [{ type: "markdown", text: "```\n1 alpha\n2 beta\n```" }],
  });
});

test("a preview is sent once however often the card changes", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  const view = preview("Update(a.txt)", "Added 1 line", "+x", "diff");
  await sink.task(tool("e", "Edit", "complete", { preview: view }));
  await settled();
  await sink.task(tool("e", "Edit", "complete", { preview: view, output: "again" }));
  await sink.text("after");
  await settled();
  assert.equal(allChunks(slack).filter((c) => c.type === "blocks").length, 1);
});

test("a failed call shows its error even if it carries a preview", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  const view = preview("Update(a.txt)", "Added 1 line", "+x", "diff");
  await sink.task(tool("e", "Edit", "error", { output: "File not found", preview: view }));
  await settled();
  const start = only(slack.callsTo("chat.startStream"));
  assert.deepEqual(start.chunks, [
    {
      type: "task_update",
      id: "fold:e",
      title: "Edit: e · File not found",
      status: "error",
    },
  ]);
});

test("an edit and a write show as the terminal shows them", async () => {
  // edit-write.jsonl (CLI 2.1.286): Write a new file, Read, a failed Edit, an Edit, a Write over
  // the file. The terminal showed each Edit and Write whole, with its sentence and its lines.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const renderer = new TurnRenderer(sink, NAMES, "/home/dev/project");
  for (const event of recordedEvents("edit-write")) await renderer.feed(event);
  await renderer.close(null);
  const chunks = allChunks(slack);
  // Each one that ended well is a container alone; no card ever named it (issue #136).
  const cards = chunks.filter((c) => c.type === "task_update");
  assert.deepEqual(
    cards.map((c) => str(c.title)).filter((t) => t.startsWith("Write") || t.startsWith("Update(")),
    [],
  );
  assert.deepEqual(
    cards.filter((c) => str(c.title).startsWith("Edit")).map((c) => [c.title, c.status]),
    [
      [
        "Edit: /home/dev/project/notes.txt · " +
          "<tool_use_error>String to replace not found in file.",
        "error",
      ],
    ],
  );
  const shown = chunks.filter((c) => c.type === "blocks").flatMap((c) => list(c.blocks));
  assert.deepEqual(
    shown.map((b) => b.type),
    ["container", "container", "container"],
  );
  assert.deepEqual(
    shown.map((b) => [get(b, "title", "text"), get(b, "subtitle", "text")]),
    [
      ["Write(new.txt)", "Wrote 15 lines to new.txt"],
      ["Update(notes.txt)", "Added 1 line, removed 1 line"],
      ["Write(notes.txt)", "Added 2 lines, removed 3 lines"],
    ],
  );
  const [newFile, ...diffs] = shown;
  assert.deepEqual(
    diffs.map((d) => blockText(d as unknown as Block)),
    [
      "    1 alpha\n-\u{1f7e5} 2 beta\n+\u{1f7e9} 2 gamma\n    3 delta",
      "-\u{1f7e5} 1 alpha\n-\u{1f7e5} 2 gamma\n-\u{1f7e5} 3 delta\n" +
        "+\u{1f7e9} 1 one\n+\u{1f7e9} 2 two",
    ],
  );
  const lines = blockText(newFile as unknown as Block).split("\n");
  assert.deepEqual(lines.slice(0, 2), [" 1 1", " 2 2"]);
  assert.equal(lines.at(-1), "… +5 lines");
});

test("a stopped message shows its previews as blocks", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  const diff = preview("Update(a.txt)", "Added 1 line", "+x", "diff");
  const fresh = preview("Write(b.txt)", "Wrote 1 line to b.txt", "1 hi");
  await sink.task(tool("e", "Edit", "complete", { preview: diff }));
  await sink.task(tool("w", "Write", "complete", { preview: fresh }));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text("more");
  await settled();
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["container", "container", "markdown"],
  );
  assert.deepEqual(
    blocks.slice(0, 2).map((b) => get(b, "title", "text")),
    ["Update(a.txt)", "Write(b.txt)"],
  );
  assert.equal(blockText(blocks[1] as unknown as Block), "1 hi");
});

test("an answered question shows in the reply where it was answered", async () => {
  // ask-answered.jsonl (CLI 2.1.286). The terminal keeps `User answered Claude's questions:`
  // and a line per answer where the question was asked, before what Claude says next.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const renderer = new TurnRenderer(sink, NAMES, "/home/dev/project");
  // The answers the owner gave, as Claude Code echoed them in the result of the call: the
  // session holds them itself, and no event carries them.
  const echoed = sdkRecords("ask-answered").find(
    (record) => record.type === "user" && record.tool_use_result !== undefined,
  )?.tool_use_result;
  let call: { callId: string; questions: { text: string }[] } | null = null;
  for (const event of recordedEvents("ask-answered")) {
    if (event.type === "call_started") {
      const questions = list(event.input.questions as Json).map((q) => ({ text: str(q.question) }));
      call = { callId: event.callId, questions };
    }
    if (event.type === "call_ended" && call !== null) {
      // The session hands the answers over once the owner gave them, before the result.
      const answers = get(echoed, "answers");
      assert.ok(typeof answers === "object" && answers !== null && !Array.isArray(answers));
      assert.ok(
        renderer.answered(
          call.callId,
          call.questions,
          answers as Record<string, string | string[]>,
        ),
      );
    }
    await renderer.feed(event);
  }
  await renderer.close(null);
  const card = only(slack.messageCards()[0] ?? []);
  assert.deepEqual([card.title, card.status], ["User answered Claude's questions:", "complete"]);
  assert.ok(!("output" in card) && !("details" in card));
  const chunks = allChunks(slack);
  const kinds = chunks.map((c) => c.type);
  const answers = only(chunks.filter((c) => c.type === "blocks"));
  assert.deepEqual(answers.blocks, [
    contextBlock(
      `${texts.NESTED}· Which color do you prefer? → Blue\n` +
        `${texts.NESTED}· Do you also like green? → Yes, Only in spring`,
    ),
  ]);
  // Claude's next words come after the answers, in the same message.
  assert.ok(kinds.slice(kinds.indexOf("blocks") + 1).includes("markdown_text"));
});

test("answers to a call the reply has no line for are not kept", () => {
  const renderer = new TurnRenderer(reply(new FakeSlack()), NAMES);
  assert.ok(!renderer.answered("toolu_unseen", [{ text: "Colour?" }], { "Colour?": "blue" }));
});

test("a stopped message shows the answers under their card", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  const answered = preview(
    "User answered Claude's questions:",
    "",
    "· Colour? → <b> `x`",
    "",
    true,
  );
  await sink.task(tool("q", "AskUserQuestion", "complete", { preview: answered }));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text("more");
  await settled();
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["task_card", "context", "markdown"],
  );
  assert.ok(blocks[0] !== undefined && !("output" in blocks[0]));
  // Shown as written: no markup of the question's or the answer's is read as Slack's.
  const zero = ZERO_WIDTH_SPACE;
  assert.equal(
    get(blocks[1], "elements", 0, "text"),
    `${texts.NESTED}· Colour? → &lt;b&gt; \`${zero}x\`${zero}`,
  );
});

test("answers longer than a context block are cut", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  const body = Array.from({ length: 4 }, () => `· ${"q".repeat(900)} → ${"a".repeat(300)}`).join(
    "\n",
  );
  await sink.task(
    tool("q", "AskUserQuestion", "complete", {
      preview: preview("User answered", "", body, "", true),
    }),
  );
  await settled();
  const answers = only(allChunks(slack).filter((c) => c.type === "blocks"));
  const block = only(list(answers.blocks));
  const text = str(get(block, "elements", 0, "text"));
  assert.ok(len(text) === CONTEXT_LIMIT && text.endsWith("…"));
});

test("answers longer than a message still show and the reply goes on", async () => {
  // Counted for the 3,000 characters it shows, never for its whole body: a body past
  // MESSAGE_LIMIT would fit no message, and the reply would stop there.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const body = `· ${"q".repeat(MESSAGE_LIMIT + 4_000)} → yes`;
  await sink.task(
    tool("q", "AskUserQuestion", "complete", {
      preview: preview("User answered", "", body, "", true),
    }),
  );
  await sink.text("And then.");
  await settled();
  assert.deepEqual(
    allChunks(slack).map((c) => c.type),
    ["task_update", "blocks", "markdown_text"],
  );
  assert.equal(slack.createdTs.length, 1);
});

test("a subagent card counts its calls from a recorded turn", async () => {
  // subagent-foreground.jsonl (CLI 2.1.286): the agent's task ends before the Agent call's
  // result. The sink is given the calls the renderer makes for the recording (the reply golden),
  // up to the turn's end.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const whole = get(golden("reply", "subagent-foreground"), "whole", "calls");
  for (const call of list(whole)) {
    if (call.call === "text") {
      await sink.text(str(call.markdown), {
        notice: call.notice === true,
        ending: call.ending === true,
      });
    } else if (call.call === "task") {
      await sink.task(call.update as unknown as TaskUpdate);
    } else if (call.call === "finish") {
      await sink.finish(list(call.closing) as unknown as TaskUpdate[], null);
      break;
    }
  }
  const cards = slack.messageCards()[0] ?? [];
  const card = only(cards.filter((c) => str(c.title).startsWith("Agent: ")));
  assert.ok(str(card.title).endsWith(" · 1 call") && card.status === "complete");
});

// The limiter: appends and updates spend its budget, a start, a stop and a post do not.

class CountingLimiter implements Limiter {
  acquired = 0;
  refunded = 0;

  async acquire(): Promise<void> {
    this.acquired += 1;
  }

  async refund(): Promise<void> {
    this.refunded += 1;
  }
}

test("appends and updates spend the budget and starts stops and posts do not", async () => {
  const slack = new FakeSlack();
  const limiter = new CountingLimiter();
  const clock = new FakeClock();
  const sink = reply(slack, { limiter, clock });
  await sink.text("one");
  await settled(); // a start
  await sink.text(" two");
  await settled(); // an append
  assert.equal(limiter.acquired, 1);
  await clock.advance(STREAM_SECONDS + 1); // a stop, then an update
  await sink.text(" three");
  await settled();
  assert.equal(limiter.acquired, 2);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer"); // a post
  assert.ok(limiter.acquired === 2 && limiter.refunded === 0);
});

/**
 * `acquire` blocks until `release`, as a busy shared limiter does while another reply spends its
 * only token.
 */
class StuckLimiter implements Limiter {
  acquired = 0;
  refunded = 0;
  private readonly gate = new AsyncEvent();

  async acquire(): Promise<void> {
    this.acquired += 1;
    await this.gate.wait();
  }

  async refund(): Promise<void> {
    this.refunded += 1;
  }

  release(): void {
    this.gate.set();
  }
}

test("a task update never blocks the caller", async () => {
  // `task` runs in the SDK reader loop: a limiter that makes a write wait must not hold it.
  const slack = new FakeSlack();
  const limiter = new StuckLimiter();
  const sink = reply(slack, { limiter });
  await sink.text("one");
  await settled();
  await soon(sink.text(" two"));
  await soon(sink.task(tool("t1", "Bash", "in_progress")));
  await settled();
  assert.equal(limiter.acquired, 1); // the append is waiting its turn, and the caller is not
  limiter.release();
  await settled();
});

test("a change during a limiter wait is not dropped", async () => {
  // The limiter refills on the reply's own clock: its wait is crossed, not slept through.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const limiter = new UpdateLimiter({ limit: 1, window: 0.5, burst: 1, clock });
  const sink = reply(slack, { limiter, clock });
  await sink.text("one");
  await settled();
  await sink.text(" two"); // spends the only token; the next append waits for a refill
  await settled();
  await sink.text(" three");
  await sink.text(" four");
  await settled(); // the debounce is over: the append waits its turn
  assert.deepEqual(slack.messageTexts(), ["one two"]);
  await clock.advance(1.3);
  await settled();
  assert.deepEqual(slack.messageTexts(), ["one two three four"]);
});

/** A fake Slack that notes when each append arrives, on a clock, and may answer late on it. */
class TimedSlack extends FakeSlack {
  stamps: number[] = [];
  private readonly clock: FakeClock;
  private readonly roundTrip: number;

  constructor(clock: FakeClock, roundTrip = 0) {
    super();
    this.clock = clock;
    this.roundTrip = roundTrip;
  }

  override async apiCall(
    method: string,
    options: Record<string, unknown> = {},
  ): ReturnType<FakeSlack["apiCall"]> {
    if (method === "chat.appendStream") this.stamps.push(this.clock.time());
    if (this.roundTrip > 0) await this.clock.sleep(this.roundTrip);
    return super.apiCall(method, options);
  }
}

/** `seconds` pass one at a time, so that what a second wakes can wait and be woken in turn. */
async function elapse(clock: FakeClock, seconds: number): Promise<void> {
  for (let second = 0; second < seconds; second += 1) await clock.advance(1);
}

/** The clock moves, a second at a time, for as long as `promise` is pending. */
async function during<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let done = false;
  const guarded = promise.finally(() => {
    done = true;
  });
  guarded.catch(() => {});
  for (let second = 0; second < 10_000 && !done; second += 1) await clock.advance(1);
  if (!done) throw new Error("still pending after 10,000 seconds of the fake clock");
  return guarded;
}

function pairwise(values: readonly number[]): [number, number][] {
  return values.slice(1).map((value, i) => [values[i] as number, value]);
}

test("the debounce holds while streaming through a slow round trip", async () => {
  // On the fake clock: the debounce is DEBOUNCE_SECONDS itself, a round trip takes 5 seconds, a
  // change comes every 2.
  const clock = new FakeClock();
  const slack = new TimedSlack(clock, 5);
  const sink = reply(slack, { clock, debounceSeconds: DEBOUNCE_SECONDS });
  await sink.text("go");
  await elapse(clock, 20);
  for (let i = 0; i < 20; i += 1) {
    await sink.text(` ${i}`);
    await elapse(clock, 2);
  }
  await elapse(clock, 40);
  assert.ok(slack.stamps.length >= 2);
  const gaps = pairwise(slack.stamps).map(([a, b]) => b - a);
  assert.ok(Math.min(...gaps) >= DEBOUNCE_SECONDS);
});

test("two busy sinks share one limiter and each reaches its end", async () => {
  // A window of 60 s and steps of 3 s, on the fake clock.
  const [limit, window, burst] = [9, 60, 1];
  const clock = new FakeClock();
  const slack = new TimedSlack(clock);
  const limiter = new UpdateLimiter({ limit, window, burst, clock });
  const options = { limiter, clock, debounceSeconds: DEBOUNCE_SECONDS };
  const a = reply(slack, options);
  const b = reply(slack, options);
  for (let i = 0; i < 6; i += 1) {
    await a.text(`a${i} `);
    await b.text(`b${i} `);
    await elapse(clock, 3);
  }
  await during(clock, a.finish([], null));
  await during(clock, a.closeOutFormatted("footer-a"));
  await during(clock, b.finish([], null));
  await during(clock, b.closeOutFormatted("footer-b"));
  await elapse(clock, 150);
  for (const [i, start] of slack.stamps.entries()) {
    const inWindow = slack.stamps.slice(i).filter((t) => t < start + window).length;
    assert.ok(inWindow <= limit + burst);
  }
  assert.deepEqual(slack.messageTexts(), ["a0 a1 a2 a3 a4 a5", "b0 b1 b2 b3 b4 b5"]);
  assert.equal(slack.pushes(), 2);
});

// Helpers that build the blocks.

test("a notice fits one context element", () => {
  assert.equal(noticeText("short"), "short");
  const cut = noticeText("x".repeat(CONTEXT_LIMIT + 10));
  assert.ok(cut.length === CONTEXT_LIMIT && cut.endsWith("…"));
});

test("a banner is plain and escaped", () => {
  const text = "## Title\n\n- **bold** and `code` with [a link](https://x.example) & <tags>";
  assert.equal(bannerText(text), "Title\nbold and code with a link &amp; &lt;tags&gt;");
});

for (const [text, plain] of [
  ["see [1] and [a [b](u) then [c](v", "see [1] and a [b then [c](v"],
  ["intro\n \n\t\n- item\n  \nnot a marker", "intro\nitem\n  \nnot a marker"],
  ["snake_case a_`_`_b _lead_ trail_ *x* 2*3", "snake_case a___b lead trail x 2*3"],
] as const) {
  test(`stripping markdown keeps what only looks like a marker [${JSON.stringify(text)}]`, () => {
    // The texts a pattern reads and puts back. Each result is the one the patterns gave before
    // they were made linear (taken from them, 2026-10-04).
    assert.equal(stripMarkdown(text), plain);
  });
}

for (const [id, paragraph, banner] of [
  ["brackets", "[".repeat(100_000), "[".repeat(BANNER_LIMIT)],
  ["blank lines", `x${"\n ".repeat(50_000)}y`, `x${"\n ".repeat(150)}`.slice(0, BANNER_LIMIT)],
  ["underscores", `a${"_`".repeat(50_000)}b`, `a${"_".repeat(BANNER_LIMIT - 1)}`],
] as const) {
  test(`a banner takes a time linear in its paragraph [${id}]`, () => {
    // A few milliseconds of CPU each. Patterns that start again from every `[`, blank line or
    // `_` took 15, 49 and 11 seconds on these in Python (measured 2026-10-04, Python 3.12).
    const started = process.cpuUsage();
    assert.equal(bannerText(paragraph, { limit: BANNER_LIMIT }), banner);
    const spent = process.cpuUsage(started);
    assert.ok((spent.user + spent.system) / 1e6 < 1);
  });
}

test("a task card block reads back as the card it was", () => {
  const update = tool("t1", "Bash", "error", {
    output: "exit 1",
    details: "ignored while it ended",
  });
  const block = cardBlock(update);
  assert.ok(block.type === "task_card" && block.task_id === "t1");
  assert.ok(block.status === "error" && block.title === "Bash: t1");
  assert.ok(block.output?.type === "rich_text" && !("details" in block));
});

test("a diff shows collapsed and full width", () => {
  const block = only(previewContainers("Added 1 line", "+🟩 1 x"));
  assert.ok(block.is_collapsible === true && block.default_collapsed === true);
  assert.equal(block.width, "full");
  const child = only(block.child_blocks);
  const pre = only(child.elements);
  assert.ok(pre.type === "rich_text_preformatted" && pre.language === "diff");
});

test("a diff is titled with its sentence alone", () => {
  // The call's line is the card above it (issue #110): the container must not say it again.
  const block = only(previewContainers("Added 1 line", "+x"));
  assert.deepEqual(block.title, { type: "plain_text", text: "Added 1 line" });
  assert.ok(!("rich_text_title" in block) && !("subtitle" in block));
});

test("a container with no card says the sentence under the calls line", () => {
  const block = only(previewContainers("Update(a.txt)", "+x", { subtitle: "s".repeat(200) }));
  assert.equal(block.title.text, "Update(a.txt)");
  assert.deepEqual(block.subtitle, { type: "plain_text", text: "s".repeat(150) });
});

test("a diff past a message continues in the next", () => {
  const body = Array.from({ length: 399 }, (_, i) => `+🟩 ${i + 1} ${"x".repeat(90)}`).join("\n");
  const blocks = previewContainers("Added 399 lines", body);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every((b) => len(blockText(b)) <= MESSAGE_LIMIT));
  assert.equal(blocks.map((b) => blockText(b)).join("\n"), body); // nothing lost at the cuts
});

test("a long title is cut to slacks limit", () => {
  const block = only(previewContainers("x".repeat(200), "+x", { asCode: true }));
  assert.equal(block.title.text.length, 150);
  const section = only(block.rich_text_title?.elements ?? []);
  assert.equal(section.elements[0]?.text.length, 150);
});

for (const fence of ["```", "````", "``````", "```x```"]) {
  test(`a fence inside a preview does not close its block [${fence}]`, () => {
    // Any run of three or more backticks would close the block (a Markdown file's ```` fence).
    const block = only(previewBlocks(`a\n${fence}\nb`));
    assert.equal(block.text.split("```").length - 1, 2);
  });
}

test("update limiter never exceeds the budget in any window", async () => {
  // On a clock that moves by what the limiter sleeps: the times are exact.
  const [limit, window, burst] = [4, 0.2, 1];
  const clock = new SelfPacedClock();
  const limiter = new UpdateLimiter({ limit, window, burst, clock });
  const times: number[] = [];
  for (let i = 0; i < limit * 3; i += 1) {
    await limiter.acquire();
    times.push(clock.time());
  }
  // a token bucket may spend its whole burst at once; past that, the standard bound holds:
  // tokens spent in any span <= burst + rate * span, i.e. at most limit+burst per window.
  for (let i = 0; i < times.length - (limit + burst); i += 1) {
    assert.ok((times[i + limit + burst] as number) - (times[i] as number) >= window - 0.03);
  }
});

test("update limiter paces evenly after its burst", async () => {
  // Even pacing, not a sliding window: past the burst, one token every window/limit seconds,
  // never every reply racing through the whole budget and then freezing together. An injected
  // clock, advanced by exactly what the limiter itself sleeps for, so the gaps are exact and
  // this cannot flake on a loaded runner.
  const [limit, window, burst] = [6, 0.6, 2];
  const clock = new SelfPacedClock();
  const limiter = new UpdateLimiter({ limit, window, burst, clock });
  const gaps: number[] = [];
  let previous: number | null = null;
  for (let i = 0; i < limit; i += 1) {
    await limiter.acquire();
    if (previous !== null) gaps.push(clock.time() - previous);
    previous = clock.time();
  }
  const steady = gaps.slice(burst - 1); // the gaps once the burst is spent
  const interval = window / limit;
  assert.ok(steady.length > 0);
  assert.ok(steady.every((gap) => Math.abs(gap - interval) <= interval * 1e-6));
});

test("update limiter serves waiters in arrival order", async () => {
  const limiter = new UpdateLimiter({
    limit: 1,
    window: 0.1,
    burst: 1,
    clock: new SelfPacedClock(),
  });
  const order: number[] = [];
  const take = async (n: number): Promise<void> => {
    await limiter.acquire();
    order.push(n);
  };
  await Promise.all([take(1), take(2), take(3)]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("update limiter releases its place when a waiter is cancelled", async () => {
  const clock = new FakeClock();
  const limiter = new UpdateLimiter({ limit: 1, window: 0.2, burst: 1, clock });
  await limiter.acquire(); // spends the only token
  const caller = new AbortController();
  const waiter = limiter.acquire(caller.signal);
  await tick(); // the waiter is now sleeping, holding the limiter's own lock
  caller.abort(new Cancelled());
  await assert.rejects(waiter, Cancelled);
  // a cancelled waiter must not keep the lock: the next acquire is served once a token is back.
  const next = limiter.acquire();
  await clock.advance(0.2);
  await soon(next);
});

test("update limiter refund makes a token available at once", async () => {
  // too slow to refill on its own, on a clock that never moves
  const limiter = new UpdateLimiter({ limit: 1, window: 10.0, burst: 1, clock: new FakeClock() });
  await limiter.acquire(); // spends the only token
  await limiter.refund();
  await soon(limiter.acquire()); // available again, not after `window`
});

test("update limiter refund never exceeds burst", async () => {
  const limiter = new UpdateLimiter({ limit: 1, window: 10.0, burst: 2, clock: new FakeClock() });
  await limiter.refund();
  await limiter.refund();
  await limiter.refund(); // never more than a full burst, whatever was actually spent
  assert.equal((limiter as unknown as { tokens: number }).tokens, 2);
});

// The helpers of the tests that follow.

// A run of calls: two cards while the reply is written, a line of counts once its body ended.

export function context(text: string): ContextBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** Text, then three calls one after the other (the last fails), then text. */
export async function runOfCalls(sink: ReplySink): Promise<void> {
  await sink.text("Let me look.\n\n");
  for (const [id, name, status, fields] of [
    ["a", "Bash", "complete", {}],
    ["b", "Read", "complete", {}],
    ["c", "Bash", "error", { output: "Exit code 1" }],
  ] as const) {
    await sink.task(tool(id, name, "in_progress"));
    await settled();
    await sink.task(tool(id, name, status, fields));
    await settled();
  }
  await sink.text("One test fails.");
  await settled();
}

// A reply that has ended never opens a message below its footer or its closing message.

/** The text of one line of `previewOf`: what tells that a preview is on the page. */
export function marker(line: number): string {
  return `${String(line).padStart(4)} ${"x".repeat(90)}`;
}

export function latePreview(lines = 40): Preview {
  const body = Array.from({ length: lines }, (_, i) => marker(i)).join("\n");
  return preview("Write(big.txt)", `Wrote ${lines} lines to big.txt`, body);
}

export function previewOf(lines: number): Preview {
  return latePreview(lines);
}

export function shows(blocks: readonly JsonObject[], needle: string): boolean {
  return blocks.some((b) => blockText(b as unknown as Block).includes(needle));
}

export function cardsOf(blocks: readonly JsonObject[]): Record<string, Json> {
  return Object.fromEntries(
    blocks.filter((b) => b.type === "task_card").map((b) => [str(b.task_id), b.status ?? null]),
  );
}

export const CUT_NOTE = contextBlock(PREVIEW_CUT);

// What a message written by `chat.update` holds: a collapsed container's text does not count
// toward MESSAGE_LIMIT there (measured 2026-10-06, slack-sdk 3.44.1: `chat.update` took 50
// containers of 10,000 characters and refused nothing; a stream and a post count the text).

/**
 * A diff of about `chars` characters: the size of the largest Edit previews, which a message of
 * MESSAGE_LIMIT cannot hold two of.
 */
export function largeDiff(i: number, chars = 9_000): Preview {
  const body = Array.from(
    { length: Math.floor(chars / 96) },
    (_, n) => `+${String(n).padStart(4)} ${"x".repeat(90)}`,
  ).join("\n");
  return preview(`Update(f${i}.txt)`, "Added lines", body, "diff");
}

export function containersOf(blocks: readonly JsonObject[]): JsonObject[] {
  return blocks.filter((b) => b.type === "container");
}

/** A stopped first message of 45 blocks, and a continuation that gets three large diffs. */
export async function continuationWithDiffs(
  slack: FakeSlack,
  clock: FakeClock,
): Promise<ReplySink> {
  const sink = reply(slack, { clock });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  for (let i = 0; i < 50; i += 1) {
    await sink.task(tool(`c${i}`, "Agent", "complete", { task: true }));
  }
  for (let i = 0; i < 3; i += 1) {
    await sink.task(tool(`e${i}`, "Edit", "complete", { preview: largeDiff(i) }));
  }
  return sink;
}

/**
 * Slack refuses every `chat.update` that carries more than one container; the refused updates
 * are listed.
 */
export function refusingContainers(slack: FakeSlack, code = "msg_too_long"): JsonObject[] {
  const refused: JsonObject[] = [];
  slack.responses["chat.update"] = (args) => {
    if (containersOf(list(args.blocks)).length > 1) {
      refused.push(args);
      return rejected(code);
    }
    return { ok: true };
  };
  return refused;
}

// A stream's card: Slack adds the details and the output of every chunk to what the card holds
// (measured 2026-10-01 and 2026-10-08), so a stream is sent only what the card lacks.

/** Every chunk a reply's streams were sent for one card, in order. */
export function cardChunks(slack: FakeSlack, cardId: string): JsonObject[] {
  return ["chat.startStream", "chat.appendStream"].flatMap((method) =>
    slack.callsTo(method).flatMap((call) => list(call.chunks).filter((c) => c.id === cardId)),
  );
}

// The blocks Slack makes of markdown: a header per heading, a table per table, a divider per
// rule, rich text for each run between them. A post or an update whose message passes 50 of them
// is refused; a stream is not, and the update after its stop is (measured 2026-10-08).

/** `count` headings with a paragraph each: two blocks a section, as Slack stored them. */
export function sections(count: number, start = 1): string {
  return Array.from(
    { length: count },
    (_, i) => `## Heading ${start + i}\n\nparagraph ${start + i}`,
  ).join("\n\n");
}

/** The lines with words of some texts, in order: what a reply says, however it was cut. */
export function linesOf(...written: string[]): string[] {
  return written.flatMap((text) => text.split("\n").filter((line) => !blank(line)));
}

/** Slack's refusal of a message with more than 50 blocks, as recorded on 2026-10-08. */
export function tooMany(error = "invalid_blocks"): ReturnType<typeof rejected> {
  const notes = ["[ERROR] no more than 50 items allowed [json-pointer:/blocks]"];
  return rejected(error, { response_metadata: { messages: notes } });
}

// An append Slack refuses for its content (`msg_too_long` on `chat.appendStream`, measured
// 2026-10-01, slack-sdk 3.44.1): the same append would be refused again.

/** The reply's first stream, as Slack holds it. */
function firstStream(slack: FakeSlack): FakeMessage {
  const message = slack.messages.get(slack.streamTs[0] ?? "");
  assert.ok(message !== undefined, "the reply started no stream");
  return message;
}

/** The text of the last block of a message, a context block's. */
function footerOf(blocks: JsonObject[]): Maybe {
  return get(blocks, -1, "elements", 0, "text");
}

test("an append refused for its content stops the stream and goes on by update", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Hello. ");
  await settled();
  slack.responses["chat.appendStream"] = rejected("msg_too_long");
  await sink.text("World.");
  await settled();
  // stopped at once, and written from the model: nothing waits for the next change
  assert.equal(firstStream(slack).streaming, false);
  assert.deepEqual(slack.streamTexts(), ["Hello. World."]);
  await sink.text(" Again.");
  await settled();
  assert.equal(slack.callsTo("chat.appendStream").length, 1); // the refused append is never repeated
  assert.deepEqual(slack.streamTexts(), ["Hello. World. Again."]);
  assert.deepEqual(slack.postedTs, []);
});

test("a final append refused for its content still ends the reply", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Hello. ");
  await settled();
  slack.responses["chat.appendStream"] = rejected("msg_too_long");
  await sink.text("Done.");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true); // landed in this pass: no retry is owed
  assert.deepEqual(slack.streamTexts(), ["Hello. Done."]);
  // as a reply past STREAM_SECONDS ends: the bare stop, then the closing message
  assert.equal(slack.callsTo("chat.stopStream")[0]?.blocks, undefined);
  const closing = only(slack.postedTs);
  assert.equal(footerOf(slack.messages.get(closing)?.blocks ?? []), "footer");
  assert.equal(slack.pushes(), 2);
});

test("an update refused after a refused append is an end that did not land", async () => {
  // The message shows less than the model and no later write can fix it: never a checkmark.
  const slack = new FakeSlack();
  const sink = reply(slack, { finalRetrySeconds: 0.01 });
  await sink.text("Hello. ");
  await settled();
  slack.responses["chat.appendStream"] = rejected("msg_too_long");
  slack.responses["chat.update"] = rejected("msg_too_long");
  await sink.text("Done.");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  await passed(0.01);
  assert.equal(await soon(sink.waitLanded()), false);
  assert.deepEqual(slack.streamTexts(), ["Hello."]); // what the stream held when it was stopped
  assert.equal(slack.postedTs.length, 1); // the closing message, posted once: the retry adds none
});

test("a later update that passes lands the reply after a refused one", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Hello. ");
  await settled();
  slack.responses["chat.appendStream"] = rejected("msg_too_long");
  slack.responses["chat.update"] = [rejected("msg_too_long"), { ok: true }];
  await sink.text("World.");
  await settled();
  assert.deepEqual(slack.streamTexts(), ["Hello."]); // the update was refused too: the change is dropped
  await sink.text(" Done.");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.deepEqual(slack.streamTexts(), ["Hello. World. Done."]);
});

test("an append refused for another reason stays a failed write", async () => {
  // Not measured on `chat.appendStream`, and an update of the same content may be refused
  // too, which would drop it: the end is reported lost, so the session shows the cross.
  const slack = new FakeSlack();
  const sink = reply(slack, { finalRetrySeconds: 0.01 });
  await sink.text("Hello. ");
  await settled();
  slack.responses["chat.appendStream"] = rejected("invalid_blocks");
  await sink.text("Done.");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  await passed(0.01);
  assert.equal(await soon(sink.waitLanded()), false);
  assert.equal(firstStream(slack).streaming, true);
  assert.deepEqual(slack.callsTo("chat.stopStream"), []);
  assert.deepEqual(slack.callsTo("chat.update"), []);
});

test("a refused append logs the method and the sizes without content", async () => {
  const slack = new FakeSlack();
  const log = new Recorded();
  const sink = reply(slack, { logger: log });
  await sink.text("Hello. ");
  await sink.task(tool("t1", "Bash", "in_progress"));
  await settled();
  slack.responses["chat.appendStream"] = rejected("msg_too_long");
  await sink.text("World.");
  await settled();
  const line = only(
    log.messages().filter((message) => message.includes("chat.appendStream refused")),
  );
  assert.ok(line.includes("msg_too_long"));
  // what the message would hold: both texts, three elements (text, card, text), one card,
  // whose title was sent before and is not in the refused append
  assert.ok(line.includes("text 13, elements 3, cards 1"));
  assert.ok(line.includes(`card text sent ${len("Bash: t1")} and 0 more`));
  assert.ok(!log.text.includes("Bash") && !log.text.includes("Hello"));
});

// A call whose outcome is unknown: Slack may have applied it. Stream calls are not idempotent.

test("an append of unknown outcome is never sent again", async () => {
  const slack = new ResetAfterApply();
  const sink = reply(slack);
  await sink.text("Hello. ");
  await settled();
  slack.resetNext = "chat.appendStream";
  await sink.text("World. ");
  await settled();
  await sink.text("Again.");
  await settled();
  // the message went on by update, from the model: each word once
  assert.equal(slack.callsTo("chat.appendStream").length, 1);
  assert.equal(slack.streamTexts()[0]?.split("World.").length, 2);
  assert.equal(slack.streamTexts()[0], "Hello. World. Again.");
  assert.equal(firstStream(slack).streaming, false);
});

test("a stop of unknown outcome that carried the footer ends once", async () => {
  const slack = new ResetAfterApply();
  const sink = reply(slack, { finalRetrySeconds: 0.05 });
  await sink.text("Answer.");
  await settled();
  slack.resetNext = "chat.stopStream";
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  await passed(0.05);
  assert.equal(await soon(sink.waitLanded()), true);
  await passed(0.1);
  assert.equal(slack.pushes(), 1); // no closing message, footer once
  assert.deepEqual(slack.postedTs, []);
  assert.equal(footerOf(firstStream(slack).blocks), "footer");
});

test("a start of unknown outcome says so in the log", async () => {
  const slack = new ResetAfterApply();
  slack.resetNext = "chat.startStream";
  const log = new Recorded();
  const sink = reply(slack, { logger: log });
  await sink.text("one");
  await settled();
  assert.ok(log.text.includes("outcome unknown"));
});

// `the connection retry skips the calls that create a message` is in `clients.test.ts`: the policy
// is the client's, and is tested there on the real `WebClient`.

/**
 * Slack applies the call, and its answer is held until `release` is set.
 */
class HeldAfterApply extends FakeSlack {
  holdMethod: string | null = null;
  readonly applied = new AsyncEvent();
  readonly release = new AsyncEvent();

  override async apiCall(
    method: string,
    options: Record<string, unknown> = {},
  ): Promise<WebAPICallResult> {
    const answer = await super.apiCall(method, options);
    if (method === this.holdMethod) {
      this.applied.set();
      await this.release.wait();
    }
    return answer;
  }
}

test("settle during the retry does not lose the stop", async () => {
  const slack = new HeldAfterApply();
  const sink = reply(slack, { finalRetrySeconds: 0.01 });
  await sink.text("Answer.");
  await settled();
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), { ok: true }];
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  // the retry's stop is applied and its answer still on the way when the shutdown settles
  slack.holdMethod = "chat.stopStream";
  await passed(0.01);
  await slack.applied.wait();
  const settling = sink.settle();
  await tick();
  slack.release.set();
  assert.equal(await soon(settling), true);
  assert.equal(slack.pushes(), 1);
  assert.deepEqual(slack.postedTs, []);
});

/** The (old, new) transitions a sink reported to its open-replies list. */
function tracking(): [
  Array<[string | null, string | null]>,
  (a: string | null, b: string | null) => void,
] {
  const seen: Array<[string | null, string | null]> = [];
  return [seen, (old, fresh) => void seen.push([old, fresh])];
}

function sawTransition(
  seen: ReadonlyArray<readonly [string | null, string | null]>,
  old: string | null,
  fresh: string | null,
): boolean {
  return seen.some(([a, b]) => a === old && b === fresh);
}

test("a message stays tracked while its cards run after a roll over", async () => {
  const slack = new FakeSlack();
  const [seen, onOpenReply] = tracking();
  const sink = reply(slack, { onOpenReply });
  await sink.task(
    tool("t0", "Bash", "in_progress", { task: true, details: "Running in background" }),
  );
  for (let i = 1; i < 60; i += 1)
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true }));
  await settled();
  const [first, second] = slack.streamTs;
  assert.ok(first !== undefined && second !== undefined);
  // a card still runs in the first
  assert.ok(sawTransition(seen, null, second) && !sawTransition(seen, first, null));
  await sink.task(tool("t0", "Bash", "complete", { task: true }));
  await settled();
  assert.ok(sawTransition(seen, first, null)); // final now: nothing left for a repair to close
});

test("a reply whose body landed is not tracked when only the closing post fails", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const [seen, onOpenReply] = tracking();
  const sink = reply(slack, { clock, onOpenReply, finalRetrySeconds: 60.0 });
  await sink.text("A complete answer.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.postMessage"] = networkDown();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  // the answer is whole: a repair must not say it stopped before it
  assert.deepEqual(seen.at(-1), [slack.streamTs[0], null]);
  await sink.settle();
});

test("a footerless stop of unknown outcome does not stand for the footer", async () => {
  // The 280 s stop lands and its answer is lost. The stream is over, without the footer: the
  // end must post the closing message, not count the earlier stop as its own.
  const slack = new ResetAfterApply();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, finalRetrySeconds: 0.05 });
  await sink.text("Answer.");
  await settled();
  slack.resetNext = "chat.stopStream";
  await clock.advance(STREAM_SECONDS + 1);
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  const closing = only(slack.callsTo("chat.postMessage"));
  assert.equal(footerOf(list(closing.blocks)), "footer");
  assert.equal(slack.pushes(), 2); // the 280 s stop, and the end
});

// Adopting what a create of unknown outcome made, before writing again.

test("a start of unknown outcome is adopted not started again", async () => {
  const slack = new ResetAfterApply();
  const [seen, onOpenReply] = tracking();
  slack.resetNext = "chat.startStream";
  const sink = reply(slack, { onOpenReply });
  await sink.text("one");
  await settled();
  await sink.text(" two");
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 1); // never started again
  assert.deepEqual(slack.streamTexts(), ["one two"]); // the adopted stream took the rest
  assert.deepEqual(seen, [[null, slack.streamTs[0]]]); // and a repair can find it
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  assert.equal(slack.pushes(), 1);
});

test("a start that never landed is started again", async () => {
  const slack = new FakeSlack();
  slack.responses["chat.startStream"] = [
    networkDown(),
    slack.responses["chat.startStream"] as JsonObject,
  ];
  const sink = reply(slack);
  await sink.text("one");
  await settled();
  await sink.text(" two");
  await settled();
  assert.deepEqual(slack.streamTexts(), ["one two"]);
  assert.equal(slack.callsTo("chat.startStream").length, 2);
});

test("a continuation post of unknown outcome is adopted", async () => {
  const slack = new ResetAfterApply();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.resetNext = "chat.postMessage";
  await sink.text("a line of text\n".repeat(1_000));
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const posts = slack.callsTo("chat.postMessage");
  assert.equal(posts.length, 2); // the continuation once, then the closing message
  assert.equal(slack.postedTs.length, 2);
});

test("a closing post of unknown outcome is adopted", async () => {
  const slack = new ResetAfterApply();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, finalRetrySeconds: 0.02 });
  await sink.text("A complete answer.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.resetNext = "chat.postMessage";
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true); // read back, found: nothing to retry
  assert.equal(slack.postedTs.length, 1); // one closing message, not two
  assert.equal(slack.pushes(), 2);
});

// A stop that failed on the connection: landed, or expired at Slack's 5 minutes?

test("a stop of unknown outcome past the streams life is taken as expired", async () => {
  const slack = new ResetAfterApply();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, finalRetrySeconds: 60.0 });
  await sink.text("Answer.");
  await settled();
  slack.resetNext = "chat.stopStream";
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false); // the stop landed, its answer was lost
  clock.now += STREAM_LIFE + 10; // what the retry finds is Slack's own end, or ours
  assert.equal(await sink.settle(), true);
  // past the stream's life it cannot be told from an expiry: the footer gets its own message
  assert.equal(slack.postedTs.length, 1);
});

// What a message holds: a preview that arrives late never passes the limit.

test("a late preview that does not fit its message is cut with a pointer", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("t0", "Write", "in_progress"));
  for (let i = 1; i < 60; i += 1)
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true }));
  await settled();
  const first = slack.streamTs[0];
  const body = Array.from({ length: 100 }, (_, i) => marker(i)).join("\n"); // about 9,000 characters
  const view = preview("Write(big.txt)", "Wrote 100 lines to big.txt", body);
  await sink.task(tool("t0", "Write", "complete", { preview: view }));
  await settled();
  const updates = slack.callsTo("chat.update").filter((u) => u.ts === first);
  assert.ok(updates.length > 0);
  for (const update of slack.callsTo("chat.update")) {
    const blocks = list(update.blocks);
    assert.ok(blocks.length <= 50);
    const size = blocks.reduce((sum, b) => sum + len(blockText(b as unknown as Block)), 0);
    assert.ok(size <= 12_000);
  }
  const blocks = list(last(updates).blocks);
  assert.equal(blocks.find((b) => b.type === "task_card")?.status, "complete");
  assert.ok(blocks.some((b) => isDeepStrictEqual(b, contextBlock(PREVIEW_CUT))));
});

// The sink's own cost: a message whose span did not change is not rendered again.

test("a message whose span did not change is not rendered again", async () => {
  // An ES export cannot be patched, and `pieceBlocks` reads the text of a piece through
  // `Tool.piece` alone: the test counts the calls of that method on the one tool that holds a
  // preview.
  // Task cards fill the message, not `Read` calls: the fold keeps 60 `Read` calls to two cards, so
  // the reply never rolls over, no message freezes, and an empty `calls` would hold whether or not
  // the skip existed (checked by running it, 2026-10-10). The fold leaves task cards alone, so the
  // first message does freeze with its preview.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const view = preview("Write(a.txt)", "Wrote 1 line to a.txt", "1 hi");
  await sink.task(tool("w", "Write", "complete", { preview: view }));
  for (let i = 0; i < 60; i += 1) {
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true }));
  }
  await settled();
  await sink.text("warm"); // the first pass over a message that just froze
  await settled();
  const reach = sink as unknown as { tools: Map<string, Tool>; messages: unknown[] };
  assert.ok(reach.messages.length > 1, "the first message did not freeze");
  const written = reach.tools.get("w");
  assert.ok(written !== undefined);
  const calls: number[] = [];
  const real = written.piece.bind(written);
  written.piece = (index: number) => {
    calls.push(index);
    return real(index);
  };
  for (let i = 0; i < 5; i += 1) {
    await sink.text(`more ${i}`);
    await settled();
  }
  assert.deepEqual(calls, []); // the first message, frozen with its preview, was left alone
});

test("a banner is cut before it is escaped", () => {
  const text = "&".repeat(400);
  assert.ok(len(bannerText(text, { limit: BANNER_LIMIT })) <= BANNER_LIMIT);
  assert.equal(bannerText(text, { limit: 10 }), "&amp;".repeat(2)); // never half an entity
});

test("many late previews in a full message get one note and stay in the limit", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  for (let w = 0; w < 10; w += 1) await sink.task(tool(`w${w}`, "Write", "in_progress"));
  for (let i = 0; i < 60; i += 1)
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true }));
  await settled();
  const first = slack.streamTs[0];
  const body = Array.from({ length: 100 }, (_, i) => marker(i)).join("\n");
  for (let w = 0; w < 10; w += 1) {
    const view = preview("Write(big.txt)", "Wrote 100 lines to big.txt", body);
    await sink.task(tool(`w${w}`, "Write", "complete", { preview: view }));
  }
  await settled();
  const updates = slack.callsTo("chat.update").filter((u) => u.ts === first);
  assert.ok(updates.length > 0);
  for (const update of updates) assert.ok(list(update.blocks).length <= 50);
  const note = contextBlock(PREVIEW_CUT);
  const notes = list(last(updates).blocks).filter((b) => isDeepStrictEqual(b, note));
  assert.equal(notes.length, 1); // one note for the message, however many previews it left out
});

test("a stream is adopted from slack s converted read back", async () => {
  // Slack reads markdown back converted (`**b**` as `*b*`, a heading without its `## `, a link
  // as `<url|label>`, the blank lines kept): the words are compared, not the markup.
  const slack = new ResetAfterApply();
  slack.resetNext = "chat.startStream";
  const sink = reply(slack);
  await sink.text("## Title\n\n**bold** and [a link](https://example.com) follow.");
  await settled();
  await sink.text(" More.");
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 1);
});

test("a start that holds only a container is adopted by its title", async () => {
  // A reply that opens on an Edit that ended well starts its stream with a `blocks` chunk
  // alone (issue #136): the container's title is what the read-back is compared with.
  const slack = new ResetAfterApply();
  slack.resetNext = "chat.startStream";
  const sink = reply(slack);
  const view = preview("Update(a.txt)", "Added 1 line", "+x", "diff");
  await sink.task(tool("e", "Edit", "complete", { preview: view }));
  await settled();
  await sink.text("Done.");
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 1); // never started again
  assert.deepEqual(slack.streamTexts(), ["Done."]); // the adopted stream took the rest
});

test("a start with nothing to compare is not adopted", async () => {
  const slack = new ResetAfterApply();
  slack.resetNext = "chat.startStream";
  const sink = reply(slack);
  await sink.text("…");
  await settled();
  await sink.text(" and then more words");
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 2); // tried again, not guessed at
});

// A run of calls: two cards while the reply is written, a line of counts once its body ended.

/** Whether `blocks` holds `block`, by value. */
function includesBlock(blocks: readonly JsonObject[], block: object): boolean {
  return blocks.some((b) => isDeepStrictEqual(b, block));
}

test("a run of calls streams as the counts and the call shown", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await runOfCalls(sink);
  assert.deepEqual(slack.messageCards(), [
    [
      { id: "fold:a", title: "Ran 1 shell command · Read 1 file", status: "complete" },
      { id: "now:b", title: "Bash: c · Exit code 1", status: "error" },
    ],
  ]);
  // No chunk carries text Slack would append to what a reused card holds.
  assert.ok(!allChunks(slack).some((c) => "details" in c || "output" in c));
  assert.deepEqual(slack.callsTo("chat.update"), []);
});

test("the end folds the run into a line with a silent update", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await runOfCalls(sink);
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  assert.deepEqual(methods(slack).slice(-2), ["chat.stopStream", "chat.update"]);
  const update = only(slack.callsTo("chat.update"));
  assert.equal(update.ts, slack.streamTs[0]);
  assert.deepEqual(update.blocks, [
    { type: "markdown", text: "Let me look." },
    context("✓ Ran 1 shell command · Read 1 file · ✗ Ran 1 shell command"),
    { type: "markdown", text: "One test fails." },
    { type: "divider" },
    context("main · ctx 6%"),
  ]);
  assert.equal(slack.pushes(), 1); // the stop pushed; the update that folds never does
});

test("a reply with no run of calls gets no update at its end", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Working.\n\n");
  await sink.task(tool("t", "Agent", "in_progress", { task: true }));
  await sink.task(tool("t", "Agent", "complete", { task: true, calls: 2 }));
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.deepEqual(slack.callsTo("chat.update"), []);
});

test("a fold that cannot be written does not undo the end", async () => {
  const slack = new FakeSlack();
  const [seen, onOpenReply] = tracking();
  const sink = reply(slack, { onOpenReply });
  await sink.task(tool("a", "Bash"));
  await settled();
  await sink.finish([], null);
  slack.responses["chat.update"] = [rejected("ratelimited"), { ok: true }];
  // The stop carried the footer and pushed: the reply has ended, whatever the fold does.
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.equal(await sink.waitLanded(), true);
  assert.ok(sawTransition(seen, slack.streamTs[0] ?? "", null)); // nothing is left for a crash repair to close
  await settled(); // the fold Slack refused is tried again with the next write
  const updates = slack.callsTo("chat.update");
  assert.equal(updates.length, 2);
  assert.deepEqual(get(last(updates), "blocks", 0), context("✓ Ran 1 shell command"));
  assert.equal(slack.pushes(), 1); // no second stop, no closing message
  assert.deepEqual(slack.postedTs, []);
});

test("a fold that keeps failing is given up and the cards stay", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a", "Bash"));
  await settled();
  await sink.finish([], null);
  slack.responses["chat.update"] = rejected("ratelimited");
  assert.equal(await sink.closeOutFormatted("footer"), true);
  await settled();
  await settled();
  assert.equal(slack.callsTo("chat.update").length, 2); // once at the end, once more, then no loop
  assert.equal(await sink.settle(), true);
});

test("a stream slack closed first is folded before its closing message", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a", "Bash"));
  await settled();
  await sink.finish([], null);
  slack.expire(slack.streamTs[0] ?? "");
  assert.equal(await sink.closeOutFormatted("footer"), true);
  const update = only(slack.callsTo("chat.update"));
  assert.deepEqual(update.blocks, [context("✓ Ran 1 shell command")]);
  assert.equal(slack.postedTs.length, 1); // the footer's own message, as for any stream Slack closed
});

test("past the window the run keeps its two cards until the body ends", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("a", "Bash"));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.task(tool("b", "Read", "in_progress"));
  await settled();
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  assert.deepEqual(
    blocks.map((b) => [b.type, b.title, b.status]),
    [
      ["task_card", "Ran 1 shell command", "complete"],
      ["task_card", "Read: b", "in_progress"],
    ],
  );
  await sink.finish([tool("b", "Read")], null);
  assert.deepEqual(last(slack.callsTo("chat.update")).blocks, [
    context("✓ Ran 1 shell command · Read 1 file"),
  ]);
});

test("a task that outlives the turn keeps its card beside the folded line", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a", "Read"));
  await sink.task(
    tool("t", "Bash", "in_progress", { task: true, details: "Running in background" }),
  );
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted(null), true);
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  assert.deepEqual(blocks[0], context("✓ Read 1 file"));
  assert.ok(blocks[1]?.type === "task_card" && blocks[1].status === "in_progress");
});

test("a run in a message the reply has left is folded at the end too", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a", "Bash"));
  for (let i = 0; i < BLOCKS_LIMIT + 5; i += 1) {
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true }));
  }
  await settled();
  assert.equal(slack.streamTs.length, 2);
  await sink.text("More."); // a later pass finds the first message as its stream left it
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted(null), true);
  const first = slack.messageBlocks()[0] ?? [];
  assert.deepEqual(first[0], context("✓ Ran 1 shell command"));
  assert.ok(first.every((block) => block.task_id !== "fold:a"));
});

test("every pass that wrote tells the thread status", async () => {
  const slack = new FakeSlack();
  const passes: number[] = [];
  const sink = reply(slack, { onWrite: () => void passes.push(slack.apiCalls.length) });
  await sink.text("Hello.");
  await settled();
  assert.deepEqual(passes, [1]); // after the stream's start
  assert.ok(await sink.settle()); // a pass with nothing to write: the status was not cleared
  assert.deepEqual(passes, [1]);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  assert.ok(passes.length >= 2 && passes.at(-1) === slack.apiCalls.length);
});

// A reply that has ended never opens a message below its footer or its closing message.

test("a late preview never opens a message after the footer", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await sink.task(tool("t1", "Write", "in_progress", { task: true }));
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const posted = slack.callsTo("chat.postMessage").length;
  await sink.task(tool("t1", "Write", "complete", { preview: latePreview() }));
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, posted);
  const update = last(slack.callsTo("chat.update"));
  assert.equal(update.ts, slack.streamTs[0]);
  const blocks = list(update.blocks);
  assert.deepEqual(last(blocks), contextBlock("footer")); // the footer stays last
  assert.ok(shows(blocks, "w".repeat(MESSAGE_LIMIT - 200))); // what was shown stays
  assert.deepEqual(cardsOf(blocks), { t1: "complete" }); // the card took the update in place
  assert.ok(includesBlock(blocks, CUT_NOTE) && !shows(blocks, marker(0))); // the preview did not fit
});

test("a late preview never opens a message after the closing message", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await sink.task(tool("t1", "Write", "in_progress", { task: true }));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const closing = only(slack.callsTo("chat.postMessage")); // an answer of text alone: a footer message
  await sink.task(tool("t1", "Write", "complete", { preview: latePreview() }));
  await settled();
  assert.deepEqual(slack.callsTo("chat.postMessage"), [closing]);
  const update = last(slack.callsTo("chat.update"));
  assert.equal(update.ts, slack.streamTs[0]);
  const blocks = list(update.blocks);
  assert.ok(shows(blocks, "w".repeat(MESSAGE_LIMIT - 200)));
  assert.deepEqual(cardsOf(blocks), { t1: "complete" });
  assert.ok(includesBlock(blocks, CUT_NOTE) && !shows(blocks, marker(0)));
});

test("a late preview never opens a message after the ending", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("t1", "Read"));
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const ending = only(slack.callsTo("chat.postMessage"));
  const updates = slack.callsTo("chat.update").length;
  await sink.task(tool("late", "Write", "in_progress"));
  await sink.task(tool("late", "Write", "complete", { preview: latePreview() }));
  await settled();
  assert.deepEqual(slack.callsTo("chat.postMessage"), [ending]);
  // A late card with its preview does not fit the ending: left out whole, no note, and the
  // ending message already shows what it should.
  assert.equal(slack.callsTo("chat.update").length, updates);
  assert.deepEqual(get(ending, "blocks", -1), contextBlock("footer"));
  assert.ok(shows(list(ending.blocks), "w".repeat(MESSAGE_LIMIT - 200)));
});

test("a late card never opens a message past the blocks limit", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  for (let i = 0; i < BLOCKS_LIMIT; i += 1) {
    await sink.task(tool(`t${i}`, "Agent", "in_progress", { task: true }));
  }
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const posted = slack.callsTo("chat.postMessage").length;
  await sink.task(tool("late", "Agent", "in_progress", { task: true }));
  places.showRunning(AGENT);
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, posted);
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  assert.deepEqual(
    Object.keys(cardsOf(blocks)).sort(),
    [...Array.from({ length: BLOCKS_LIMIT }, (_, i) => `t${i}`), LIST_ID].sort(),
  );
  assert.deepEqual(blocks.slice(-3), [
    listCard(AGENT),
    { type: "divider" },
    contextBlock("footer"),
  ]);
});

// What the last message showed when the end was written stays; late content takes the room left.

test("late words never remove a preview that was shown", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("w".repeat(6000));
  await sink.task(tool("t1", "Write", "complete", { preview: previewOf(42) })); // about 4,000 characters
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  await sink.text("late ".repeat(1_200)); // 6,000 characters, with room for 5,000: none shows
  await settled();
  assert.equal(slack.createdTs.length, 1);
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  assert.ok(shows(blocks, marker(0)) && shows(blocks, marker(41)));
  assert.ok(shows(blocks, "w".repeat(6000)));
  assert.ok(!includesBlock(blocks, CUT_NOTE)); // late words get no note
  assert.ok(!shows(blocks, "late"));
});

test("late cards never remove a preview that was shown", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  for (let i = 0; i < 44; i += 1) {
    // a preview each, with no card: 44 blocks
    await sink.task(tool(`w${i}`, "Write", "complete", { preview: previewOf(1) }));
  }
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  for (let i = 0; i < 3; i += 1) {
    await sink.task(tool(`late${i}`, "Agent", "in_progress", { task: true }));
  }
  await settled();
  assert.equal(slack.createdTs.length, 1);
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  assert.equal(
    blocks.filter((b) => blockText(b as unknown as Block).includes(marker(0))).length,
    44,
  );
  assert.ok(!includesBlock(blocks, CUT_NOTE));
  assert.deepEqual(cardsOf(blocks), {}); // none of the late
});

test("a late preview never removes the one a later call showed", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("w".repeat(9_000)); // b's container adds no characters to an update: the words do
  await sink.task(tool("a", "Write", "in_progress", { task: true }));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.task(tool("b", "Write", "complete", { preview: previewOf(95) })); // about 9,000 characters
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  await sink.task(tool("a", "Write", "complete", { preview: previewOf(32) })); // about 3,000: no room left
  await settled();
  assert.ok(slack.streamTs.length === 1 && slack.postedTs.length === 1); // and the closing message
  const blocks = list(
    last(slack.callsTo("chat.update").filter((u) => u.ts === slack.streamTs[0])).blocks,
  );
  assert.ok(shows(blocks, marker(94))); // b's preview, whole
  assert.deepEqual(cardsOf(blocks), { a: "complete" }); // b never had a card
  assert.ok(includesBlock(blocks, CUT_NOTE));
  const counted = blocks.filter((b) => b.type !== "container");
  const size = counted.reduce((sum, b) => sum + len(blockText(b as unknown as Block)), 0);
  assert.ok(size <= MESSAGE_LIMIT + 100);
});

test("a failed closing post is not a written end", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, finalRetrySeconds: 30 }); // the late update comes first
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await sink.task(tool("t1", "Write", "in_progress", { task: true }));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  const taken = slack.responses["chat.postMessage"];
  slack.responses["chat.postMessage"] = rejected("ratelimited");
  assert.equal(await sink.closeOutFormatted("footer"), false); // no closing message exists
  if (taken !== undefined) slack.responses["chat.postMessage"] = taken;
  await sink.task(tool("t1", "Write", "complete", { preview: latePreview() }));
  await settled();
  const posts = slack.callsTo("chat.postMessage");
  // The preview goes on in a message of its own, and the closing message comes last.
  assert.ok(shows(list(posts.at(-2)?.blocks), marker(0)));
  assert.deepEqual(get(last(posts), "blocks", -1), contextBlock("footer"));
  assert.ok(!slack.callsTo("chat.update").some((u) => includesBlock(list(u.blocks), CUT_NOTE)));
  await sink.settle();
});

test("a late card that is dropped leaves the sink caught up", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  for (let i = 0; i < BLOCKS_LIMIT; i += 1) {
    await sink.task(tool(`t${i}`, "Agent", "in_progress", { task: true }));
  }
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  await sink.task(tool("late", "Agent", "in_progress", { task: true }));
  assert.equal(await sink.settle(), true); // nothing failed: no retry, no error
  const calls = slack.apiCalls.length;
  assert.equal(await sink.settle(), true);
  await settled();
  assert.equal(slack.apiCalls.length, calls); // caught up: the same pass writes nothing more
});

test("late text past the limit is cut and never opens a message", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const posted = slack.callsTo("chat.postMessage").length;
  await sink.text(`\n\n${"late words ".repeat(100)}`);
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, posted);
  for (const update of slack.callsTo("chat.update")) {
    const size = list(update.blocks).reduce(
      (sum, b) => sum + len(blockText(b as unknown as Block)),
      0,
    );
    assert.ok(size <= 12_000); // Slack's cap
  }
});

test("the running list after the end edits the message that carries the footer", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await sink.task(tool("t1", "Write", "in_progress", { task: true }));
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  const posted = slack.callsTo("chat.postMessage").length;
  places.showRunning(AGENT);
  await settled();
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-3), [
    listCard(AGENT),
    { type: "divider" },
    contextBlock("footer"),
  ]);
  places.showRunning(null);
  await settled();
  assert.deepEqual(get(last(slack.callsTo("chat.update")), "blocks", -1), contextBlock("footer"));
  assert.equal(slack.callsTo("chat.postMessage").length, posted);
});

test("a reply still open splits into a new message as before", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await sink.task(tool("t1", "Write", "in_progress", { task: true }));
  await settled();
  await sink.task(tool("t1", "Write", "complete", { preview: latePreview() }));
  await settled();
  assert.equal(slack.createdTs.length, 2); // the preview went on in a message of its own
});

test("a close whose first write failed still opens the messages it needs", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, finalRetrySeconds: 0.02 });
  await sink.text("Start.\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1); // from here the message goes on by update
  const lines = Math.floor((MESSAGE_LIMIT * 5) / 2 / 100);
  await sink.text(`${"x".repeat(99)}\n`);
  await sink.text(`${"x".repeat(99)}\n`.repeat(lines - 1));
  slack.responses["chat.update"] = rejected("ratelimited");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  delete slack.responses["chat.update"]; // Slack takes the retry
  await passed(0.02);
  assert.equal(await soon(sink.waitLanded()), true);
  const shown = slack.messageTexts().join("");
  assert.equal(shown.split("x").length - 1, 99 * lines); // nothing cut
  assert.ok(slack.messageTexts().length >= 3);
});

test("late content that fits is shown as the open path computes it", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Start.");
  await sink.task(tool("t1", "Write", "in_progress", { task: true }));
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  await sink.task(tool("t1", "Write", "complete", { preview: previewOf(3) }));
  await sink.text("And a late word.");
  await sink.task(tool("t2", "Read", "complete", { task: true }));
  await settled();
  assert.equal(slack.createdTs.length, 1);
  const blocks = list(last(slack.callsTo("chat.update")).blocks);
  const reach = sink as unknown as {
    messages: unknown[];
    render(message: unknown, end: null, held: null): [Block[], unknown];
    closingBlocks(): Block[];
  };
  const final = reach.messages.at(-1);
  assert.deepEqual(blocks, [...reach.render(final, null, null)[0], ...reach.closingBlocks()]);
  assert.ok(shows(blocks, marker(2)) && shows(blocks, "And a late word."));
  assert.deepEqual(cardsOf(blocks), { t1: "complete", t2: "complete" });
  assert.ok(!includesBlock(blocks, CUT_NOTE));
});

test("words that reach the model while the end is written open no message", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Hello.");
  await settled();
  await sink.finish([], null);
  // The stream's stop takes a while: the gate holds it while the words arrive.
  const gate = new AsyncEvent();
  slack.gate = gate;
  slack.gated.clear();
  const closing = sink.closeOutFormatted("footer");
  await slack.gated.wait();
  await sink.text(`\n\n${"z".repeat(20_000)}`); // past one message, and held without being shown
  slack.gate = null;
  gate.set();
  await closing;
  await settled();
  assert.equal(await sink.settle(), true);
  assert.equal(slack.createdTs.length, 1);
  assert.deepEqual(slack.callsTo("chat.postMessage"), []);
  // Only what fits the message is held: a later edit stays inside the limit Slack enforces,
  // so the footer still changes.
  places.showRunning(AGENT);
  await settled();
  const edit = list(last(slack.callsTo("chat.update")).blocks);
  const words = edit
    .filter((b) => b.type === "markdown")
    .reduce((sum, b) => sum + len(str(b.text)), 0);
  assert.ok(words <= MESSAGE_LIMIT);
  assert.ok(edit.some(isCard) && shows(edit, "footer"));
});

// A refused edit or post logs its method and the sizes it sent, never its content.

test("a refused update logs the method and the sizes without content", async () => {
  const slack = new FakeSlack();
  const log = new Recorded();
  const places = new ThreadPlaces();
  const sink = reply(slack, { logger: log, places });
  await sink.text("Hello.");
  await sink.task(tool("t1", "Agent", "complete", { task: true }));
  await sink.finish([], null);
  assert.ok(await sink.closeOutFormatted("footer"));
  slack.responses["chat.update"] = rejected("msg_too_long");
  places.showRunning(AGENT);
  await settled();
  const line = only(log.messages().filter((message) => message.includes("chat.update failed")));
  assert.ok(line.includes("msg_too_long"));
  // the message sent: its words, the call's card, the list, and the footer under a divider
  assert.ok(line.includes("text 12, elements 5, cards 2"));
  assert.ok(!log.text.includes("Agent") && !log.text.includes("Hello"));
});

test("a refused post logs the method and the sizes without content", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const log = new Recorded();
  const sink = reply(slack, { clock, logger: log });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.postMessage"] = rejected("msg_too_long");
  await sink.text("secret line\n".repeat(1_500)); // past one message: the rest is posted
  await settled();
  const line = only(
    log.messages().filter((message) => message.includes("chat.postMessage failed")),
  );
  assert.ok(line.includes("msg_too_long"));
  const attempt = only(slack.callsTo("chat.postMessage"));
  const sent = list(attempt.blocks).reduce((sum, b) => sum + len(str(b.text)), 0);
  assert.ok(sent > 0 && sent < MESSAGE_LIMIT);
  assert.ok(line.includes(`text ${sent}, elements 1, cards 0`));
  assert.ok(!log.text.includes("secret") && !log.text.includes("start"));
});

test("a stopped message holds large diffs a stream would continue", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("e0", "Edit", "complete", { preview: largeDiff(0) }));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  for (let i = 1; i < 4; i += 1) {
    await sink.task(tool(`e${i}`, "Edit", "complete", { preview: largeDiff(i) }));
  }
  await settled();
  assert.ok(slack.callsTo("chat.postMessage").length === 0 && slack.streamTs.length === 1);
  const update = last(slack.callsTo("chat.update"));
  assert.equal(update.ts, slack.streamTs[0]);
  assert.deepEqual(
    containersOf(list(update.blocks)).map((b) => get(b, "title", "text")),
    Array.from({ length: 4 }, (_, i) => `Update(f${i}.txt)`),
  );
});

test("a stream still continues in a new message past the limit with diffs", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack); // no stop: the diffs go to a stream, which counts their text
  for (let i = 0; i < 4; i += 1) {
    await sink.task(tool(`e${i}`, "Edit", "complete", { preview: largeDiff(i) }));
  }
  await settled();
  assert.ok(slack.streamTs.length >= 2);
  for (const call of [
    ...slack.callsTo("chat.startStream"),
    ...slack.callsTo("chat.appendStream"),
  ]) {
    const shown = list(call.chunks ?? [])
      .filter((c) => c.type === "blocks")
      .flatMap((c) => list(c.blocks))
      .reduce((sum, b) => sum + len(blockText(b as unknown as Block)), 0);
    assert.ok(shown <= MESSAGE_LIMIT);
  }
});

test("a fixed span no longer cuts a late diff for its size", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("t0", "Edit", "in_progress"));
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await settled();
  await sink.text("v".repeat(1_000)); // does not fit: the reply goes on in a second stream
  await settled();
  assert.equal(slack.streamTs.length, 2);
  await sink.task(tool("t0", "Edit", "complete", { preview: largeDiff(0) }));
  await settled();
  const blocks = list(
    last(slack.callsTo("chat.update").filter((u) => u.ts === slack.streamTs[0])).blocks,
  );
  assert.ok(containersOf(blocks).length === 1 && !includesBlock(blocks, CUT_NOTE));
});

test("a fixed span still cuts a late diff for the blocks limit", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("t0", "Edit", "in_progress"));
  for (let i = 1; i < 60; i += 1)
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true }));
  await settled();
  const first = slack.streamTs[0];
  await sink.task(tool("t0", "Edit", "complete", { preview: largeDiff(0) }));
  await settled();
  const blocks = list(last(slack.callsTo("chat.update").filter((u) => u.ts === first)).blocks);
  assert.ok(blocks.length <= 50);
  assert.ok(includesBlock(blocks, CUT_NOTE) && containersOf(blocks).length === 0);
});

test("a preview in markdown still counts toward the limit on an update", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.task(tool("a", "Write", "in_progress"));
  await sink.text("w".repeat(6_000));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.task(tool("a", "Write", "complete", { preview: previewOf(95) })); // about 9,000 characters
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, 1); // it did not fit the first message
  for (const update of slack.callsTo("chat.update")) {
    const size = list(update.blocks).reduce(
      (sum, b) => sum + len(blockText(b as unknown as Block)),
      0,
    );
    assert.ok(size <= 12_000); // Slack's cap
  }
});

test("a continuation post grows by update to what an update holds", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  await continuationWithDiffs(slack, clock);
  await settled();
  const post = only(slack.callsTo("chat.postMessage")); // the post counts a container: one fits
  assert.equal(containersOf(list(post.blocks)).length, 1);
  const ts = slack.postedTs[0];
  const update = last(slack.callsTo("chat.update").filter((u) => u.ts === ts));
  assert.equal(containersOf(list(update.blocks)).length, 3); // the other two reached it by update
});

test("a refused growth of a continuation goes on in a new message", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const refused: string[] = [];
  slack.responses["chat.update"] = (args) => {
    if (slack.postedTs.includes(String(args.ts)) && refused.length === 0) {
      refused.push(String(args.ts));
      return rejected("invalid_blocks");
    }
    return { ok: true };
  };
  await continuationWithDiffs(slack, clock);
  await settled();
  const posts = slack.callsTo("chat.postMessage"); // what the update was refused went on
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((p) => containersOf(list(p.blocks)).length),
    [1, 1],
  );
  const update = last(slack.callsTo("chat.update").filter((u) => u.ts === slack.postedTs[1]));
  assert.equal(containersOf(list(update.blocks)).length, 2); // and it took the last by update
  // the refused update is the only one of the posted message: it is not rewritten with what
  // its post already holds
  assert.equal(slack.callsTo("chat.update").filter((u) => u.ts === slack.postedTs[0]).length, 1);
});

test("a refused update with containers counts them from then on", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const places = new ThreadPlaces();
  const sink = reply(slack, { clock, places });
  await sink.task(tool("e0", "Edit", "complete", { preview: largeDiff(0) }));
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  const refused = refusingContainers(slack);
  for (let i = 1; i < 3; i += 1) {
    await sink.task(tool(`e${i}`, "Edit", "complete", { preview: largeDiff(i) }));
  }
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true); // the reply's outcome is not an error
  // what fits by the post's counting stays, the rest went on in new messages, each shown whole
  assert.ok(refused.length > 0 && slack.postedTs.length >= 2);
  const titles = slack
    .messageBlocks()
    .flatMap((blocks) => containersOf(blocks).map((b) => get(b, "title", "text")));
  assert.deepEqual(
    titles,
    Array.from({ length: 3 }, (_, i) => `Update(f${i}.txt)`),
  );
  assert.ok(slack.messageBlocks().some((blocks) => includesBlock(blocks, contextBlock("footer"))));
  await sink.task(tool("e3", "Edit", "complete", { preview: largeDiff(3) })); // a later diff, in the last message
  await settled();
  const tried = refused.length; // that message was refused once too, and counts from then on
  places.showRunning(AGENT); // a later change to it: no refused blocks again
  await settled();
  assert.equal(refused.length, tried);
});

test("a refused update of a fixed span cuts the late diff with the note", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("t0", "Edit", "in_progress"));
  await sink.text("w".repeat(MESSAGE_LIMIT - 200));
  await settled();
  await sink.text("v".repeat(1_000));
  await settled();
  const first = slack.streamTs[0];
  slack.responses["chat.update"] = (args) =>
    containersOf(list(args.blocks)).length > 0 ? rejected("invalid_blocks") : { ok: true };
  await sink.task(tool("t0", "Edit", "complete", { preview: largeDiff(0) }));
  await settled();
  const blocks = list(last(slack.callsTo("chat.update").filter((u) => u.ts === first)).blocks);
  assert.ok(containersOf(blocks).length === 0 && includesBlock(blocks, CUT_NOTE));
  assert.deepEqual(Object.values(cardsOf(blocks)), ["complete"]); // card and words updated
  assert.ok(shows(blocks, "w".repeat(MESSAGE_LIMIT - 200)));
});

test("a refused update with no container is dropped as before", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("partial");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.update"] = rejected("invalid_blocks");
  await sink.text(" more");
  await settled();
  assert.equal(slack.callsTo("chat.update").length, 1); // no second try with other counting
  slack.responses["chat.update"] = { ok: true };
  await sink.text(" again");
  await settled();
  assert.equal(slack.callsTo("chat.update").length, 2); // the next change is tried
});

test("a request slack refuses to delete is not logged as removed", async () => {
  // Issue #71 reads the removal's timing from the log: a delete that failed must not be in it.
  const slack = new FakeSlack();
  const log = new Recorded();
  slack.responses["chat.delete"] = { ok: false, error: "cant_delete_message" };
  await deleteRequest(slack, { channel: CHANNEL, ts: "1790000000.000100" }, { logger: log });
  assert.ok(log.text.includes("could not remove a request"));
  assert.ok(!log.text.includes("removed a request"));
  slack.responses["chat.delete"] = { ok: false, error: "message_not_found" };
  await deleteRequest(slack, { channel: CHANNEL, ts: "1790000000.000100" }, { logger: log });
  assert.ok(log.text.includes("removed a request")); // already gone counts as done
});

// A stream's card: Slack adds the details and the output of every chunk to what the card holds
// (measured 2026-10-01 and 2026-10-08), so a stream is sent only what the card lacks.

for (const [held, wanted, more] of [
  ["", "a\nb", "a\nb"],
  ["a\nb", "a\nb", ""],
  ["a\nb", "a\nb\nc", "\nc"],
  ["a\nb\nc", "b\nc\nd\ne", "\nd\ne"],
  ["a\nb", "c", "\nc"],
  ["a\na", "a\na\na", "\na"],
  ["x\na", "a\na", "\na"],
] as const) {
  test(`a card is sent the lines it lacks [${JSON.stringify(held)}, ${JSON.stringify(wanted)}]`, () => {
    assert.equal(lacking(held, wanted), more);
  });
}

test("a subagent card is sent each of its lines once", async () => {
  const slack = new FakeSlack();
  // room for a write per line
  const limiter = new UpdateLimiter({ burst: 20, clock: new SelfPacedClock() });
  const sink = reply(slack, { limiter });
  const lines = Array.from({ length: 12 }, (_, i) => `Bash: step ${i + 1}`);
  for (let n = 1; n <= 12; n += 1) {
    const window = lines.slice(Math.max(0, n - 10), n).join("\n"); // the last ten, as the renderer keeps them
    await sink.task(tool("a1", "Agent", "in_progress", { details: window, task: true, calls: n }));
    await settled();
  }
  // However the writes were batched, the chunks carry each line once, in order.
  const sent = cardChunks(slack, "a1")
    .map((chunk) => chunk.details ?? "")
    .join("");
  assert.equal(sent, lines.join("\n"));
  const card = only(only(slack.messageCards()));
  assert.equal(card.details, lines.join("\n"));
  assert.ok(str(card.title).endsWith(" · 12 calls"));
});

test("a card whose title alone changes is sent no text again", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a1", "Agent", "in_progress", { details: "Read: notes.md", task: true }));
  await settled();
  await sink.task(
    tool("a1", "Agent", "in_progress", { details: "Read: notes.md", task: true, calls: 1 }),
  );
  await settled();
  await sink.task(tool("b1", "Agent", "error", { output: "exit 2", task: true }));
  await settled();
  await sink.task(
    tool("b1", "Agent", "error", { title: "Agent: again", output: "exit 2", task: true }),
  );
  await settled();
  let [first, second] = cardChunks(slack, "a1");
  assert.ok(first?.details === "Read: notes.md" && second !== undefined && !("details" in second));
  [first, second] = cardChunks(slack, "b1");
  assert.ok(first?.output === "exit 2" && second !== undefined && !("output" in second));
  assert.deepEqual(
    (slack.messageCards()[0] ?? []).map((c) => c.details ?? c.output),
    ["Read: notes.md", "exit 2"],
  );
});

test("cards whose text fills the message continue in a new stream", async () => {
  // Measured 2026-10-01: a stream took 4 error cards with 2,900 characters of output and
  // refused the fifth. Three of them are counted as a full message.
  const slack = new FakeSlack();
  const sink = reply(slack);
  for (let i = 0; i < 6; i += 1) {
    await sink.task(
      tool(`t${i}`, "Agent", "error", { output: `${i}`.repeat(CARD_TEXT_LIMIT), task: true }),
    );
    await settled();
  }
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  assert.equal(slack.streamTs.length, 2);
  assert.deepEqual(
    slack.messageCards().map((cards) => cards.length),
    [3, 3],
  );
});

test("text after cards that fill the message continues in a new stream", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  for (let i = 0; i < 3; i += 1) {
    await sink.task(
      tool(`t${i}`, "Agent", "error", { output: `${i}`.repeat(CARD_TEXT_LIMIT), task: true }),
    );
  }
  await settled();
  await sink.text("a line of text\n".repeat(200)); // 3,000 characters: the cards left room for less
  await settled();
  const [first, second] = slack.messageTexts();
  assert.ok(first && second && len(first) + len(second) >= 2_990);
  assert.ok(len(first) < 1_500);
});

test("a running card in a full message keeps its title and gains no line", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a1", "Agent", "in_progress", { details: "Read: notes.md", task: true }));
  await sink.text("a line of text\n".repeat(700)); // 10,500 characters
  await settled();
  await sink.task(
    tool("a1", "Agent", "in_progress", {
      details: `Read: notes.md\n${"x".repeat(400)}`,
      task: true,
      calls: 2,
    }),
  );
  await settled();
  const final = last(cardChunks(slack, "a1"));
  assert.ok(str(final.title).endsWith(" · 2 calls") && !("details" in final));
  assert.equal(slack.messageCards()[0]?.[0]?.details, "Read: notes.md");
  assert.equal(slack.streamTs.length, 1);
});

test("a card that ends is sent no text for the details it no longer says", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a1", "Agent", "in_progress", { details: "Read: notes.md", task: true }));
  await settled();
  await sink.task(tool("a1", "Agent", "complete", { task: true }));
  await settled();
  const [, second] = cardChunks(slack, "a1");
  assert.deepEqual(second, {
    type: "task_update",
    id: "a1",
    title: "Agent: a1",
    status: "complete",
  });
  assert.equal(slack.messageCards()[0]?.[0]?.details, "Read: notes.md"); // Slack keeps them
});

test("a card that fails in a full message still says why", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.task(tool("a1", "Agent", "in_progress", { task: true }));
  await sink.text("a line of text\n".repeat(720)); // 10,800 characters
  await settled();
  await sink.task(tool("a1", "Agent", "error", { output: "x".repeat(400), task: true }));
  await settled();
  assert.equal(last(cardChunks(slack, "a1")).output, "x".repeat(400));
  assert.equal(slack.streamTs.length, 1);
});

// The blocks Slack makes of markdown: a header per heading, a table per table, a divider per
// rule, rich text for each run between them. A post or an update whose message passes 50 of them
// is refused; a stream is not, and the update after its stop is (measured 2026-10-08).

/** `UpdateLimiter(burst=...)`, on a clock that never makes a test wait. */
function burstOf(burst: number): UpdateLimiter {
  return new UpdateLimiter({ burst, clock: new SelfPacedClock() });
}

for (const [text, stored] of [
  // each shape was posted alone on 2026-10-08 and its stored blocks counted
  ["one\n\ntwo", 1],
  ["## Title\n\ntext", 2],
  ["before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter", 3],
  ["| a | b |\n|---|---|\n| 1 | 2 |\n\nmid\n\n| c | d |\n|---|---|\n| 3 | 4 |", 3],
  ["- one\n- two\n\ntext", 1],
  ["text\n\n```\ncode\n```\n\nmore", 1],
  ["## A\n\na\n\n## B\n\nb\n\n## C\n\nc", 6],
  ["before\n\n> quoted\n\nafter", 1],
  ["before\n\n---\n\nafter", 3],
  ["before\n\n![alt](https://example.com/a.png)\n\nafter", 1],
  ["- [ ] one\n- [x] two\n\nafter", 1],
  ["```\n# not a heading\n```\n\nafter", 1],
  ["# one\n\n## two\n\n### three\n\ntext", 4],
  ["## one\n## two\n\ntext", 3],
  ["**Title**\n\ntext\n\n**Title 2**\n\ntext", 1],
  [sections(25), 50],
] as const) {
  test(`markdown counts the blocks slack stored for it [${JSON.stringify(text.slice(0, 40))}]`, () => {
    assert.equal(markdownBlocks(text), stored);
  });
}

for (const [row, table] of [
  ["|---|---|", true],
  ["---|---", true],
  ["  | :--- | ---: |  ", true],
  ["|:-:|", true],
  ["-|-", true],
  ["|---|x|", false],
  ["||---|", false],
  ["---||", false],
  ["| |", false],
  ["|--- ---|", false],
] as const) {
  test(`a table starts only above a delimiter row [${JSON.stringify(row)}]`, () => {
    // A table is a block of its own between two runs of text; with no table the text is one run.
    const text = `before\n\na | b\n${row}\n1 | 2\n\nafter`;
    assert.equal(markdownBlocks(text), table ? 3 : 1);
  });
}

test("a long line of spaces under a table row is read in linear time", () => {
  // The agent writes this text, so a page it read can shape it. Measured 2026-10-11 on Node
  // 26.5.1: one pattern for the whole row took 200 ms at 800 spaces a side and about eight times
  // that at each doubling, on the event loop every thread shares.
  const side = " ".repeat(2000);
  const began = performance.now();
  assert.equal(markdownBlocks(`a | b\n${side}-${side}|x`), 1);
  assert.ok(performance.now() - began < 500);
});

test("markdown is cut at the line that starts one block too many", () => {
  const text = sections(3);
  assert.equal(markdownCut(text, 6), null);
  const cut = markdownCut(text, 4);
  assert.ok(cut !== null && text.slice(cut) === "## Heading 3\n\nparagraph 3");
});

test("a streamed text with many headings continues in a new stream", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  const text = sections(60); // 120 blocks, 1,600 characters: far below the size limit
  for (let i = 0; i < text.length; i += 400) {
    await sink.text(text.slice(i, i + 400));
    await settled();
  }
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const shown = slack.messageTexts();
  assert.equal(slack.streamTs.length, 3);
  assert.ok(shown.every((words) => markdownBlocks(words) <= BLOCKS_LIMIT));
  assert.deepEqual(linesOf(...shown), linesOf(text)); // nothing left out
});

test("an updated message with many headings continues in a post", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, limiter: burstOf(50) });
  await sink.text("start\n\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  const text = sections(60);
  for (let i = 0; i < text.length; i += 400) {
    await sink.text(text.slice(i, i + 400));
    await settled();
  }
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const writes = [...slack.callsTo("chat.update"), ...slack.callsTo("chat.postMessage")];
  const most = Math.max(
    ...writes.filter((w) => w.blocks).map((w) => blocksCount(list(w.blocks) as unknown as Block[])),
  );
  assert.ok(most <= 50);
  assert.deepEqual(linesOf(...slack.messageTexts()), linesOf("start", text));
});

test("cards and headings share the room of a message", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  for (let i = 0; i < 30; i += 1)
    await sink.task(tool(`t${i}`, "Agent", "complete", { task: true }));
  await settled();
  await sink.text(sections(20)); // 40 blocks: 15 fit beside the 30 cards
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const [first, second] = slack.messageTexts();
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(markdownBlocks(first), 14); // the fifteenth is a heading: it goes with its text
  assert.deepEqual(linesOf(first, second), linesOf(sections(20)));
});

test("an update refused for too many blocks goes on in a new message", async () => {
  // Slack counts more than the daemon does: here every list item is a block of its own.
  const slack = new FakeSlack();
  slack.responses["chat.update"] = (args) => {
    const items = list(args.blocks)
      .filter((b) => b.type === "markdown")
      .reduce((sum, b) => sum + str(b.text).split("\n- ").length - 1, 0);
    return items > 20 ? tooMany() : { ok: true };
  };
  const clock = new FakeClock();
  const log = new Recorded();
  const sink = reply(slack, { clock, limiter: burstOf(50), logger: log });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  const items = Array.from(
    { length: 40 },
    (_, i) => `\n- item ${i + 1}\n\n## Heading ${i + 1}\n`,
  ).join("");
  await sink.text(items);
  await settled();
  await sink.finish([], null);
  assert.ok(await sink.closeOutFormatted(null));
  assert.deepEqual(linesOf(...slack.messageTexts()), linesOf("start", items)); // nothing was dropped
  assert.ok(slack.postedTs.length >= 2);
  assert.ok(
    log.text.includes(
      "chat.update failed (invalid_blocks at /blocks, over 50 blocks once translated)",
    ),
  );
  assert.ok(!log.text.includes("item"));
});

test("an update refused for another reason is not split", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.update"] = () => rejected("invalid_blocks");
  await sink.text(sections(5));
  await settled();
  assert.deepEqual(slack.postedTs, []); // the change is dropped, as before
});

test("a post refused for too many blocks is posted with less", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.postMessage"] = [
    tooMany(),
    slack.responses["chat.postMessage"] as JsonObject,
  ];
  const text = "a line of text\n".repeat(1_000); // past one message: the rest is posted
  await sink.text(text);
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, 2); // refused, then posted
  assert.deepEqual(linesOf(...slack.messageTexts()), linesOf("start", text));
});

for (const [text, blocks] of [
  // Not measured on Slack: read as CommonMark and GFM define them.
  ["Title\n=====\n\ntext", 3],
  ["````md\n```\n# inside\n```\n````\n\n## after\n\ntext", 3],
  ["```x``` then words\n\n## after\n\ntext", 3],
  ["~~~\n# inside\n~~~\n\n## after", 2],
  ["before\r\n\r\n---\r\n\r\nafter", 3],
  ["before\n\n- - -\n\nafter", 3],
  ["```\n# the fence is still open while the text streams", 1],
] as const) {
  test(`markdown shapes that were not measured are read as commonmark [${JSON.stringify(text.slice(0, 40))}]`, () => {
    assert.equal(markdownBlocks(text), blocks);
  });
}

test("a fold refused for too many blocks keeps the text the stream showed", async () => {
  // Slack counts more than the daemon does: here every list item is a block of its own.
  const slack = new FakeSlack();
  slack.responses["chat.update"] = (args) => {
    const items = list(args.blocks)
      .filter((b) => b.type === "markdown")
      .reduce((sum, b) => sum + str(b.text).split("- item").length - 1, 0);
    return items > 10 ? tooMany() : { ok: true };
  };
  const sink = reply(slack);
  await sink.task(tool("t1", "Bash"));
  const text = Array.from(
    { length: 20 },
    (_, i) => `- item ${i + 1}\n\n## Heading ${i + 1}\n\n`,
  ).join("");
  await sink.text(text);
  await settled();
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted(null), true); // nothing is missing: the reply ended well
  await settled();
  assert.deepEqual(linesOf(...slack.messageTexts()), linesOf(text)); // the fold is dropped, not the text
});

test("an update refused down to one block repeats nothing", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, limiter: burstOf(50) });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.update"] = () => tooMany();
  await sink.text(sections(5));
  await settled();
  assert.deepEqual(slack.postedTs, []); // no rest posted while the message still shows what it showed
  slack.responses["chat.update"] = { ok: true };
  await sink.text("\n\nthe end");
  await settled();
  assert.deepEqual(linesOf(...slack.messageTexts()), linesOf("start", sections(5), "the end"));
});

test("a sent line that turns into a table is not cut in two", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack, { limiter: burstOf(50) });
  await sink.text(`${sections(22)}\n\nintro\n\na | b`); // 45 blocks, the last one a run of text
  await settled();
  await sink.text("\n---|---\n1 | 2\n\n## Next\n\nlast");
  await settled();
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const [first, second] = slack.messageTexts();
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(first.endsWith("a | b\n---|---\n1 | 2") && second.startsWith("## Next"));
});

test("a heading is not left as the last block before a cut", () => {
  const text = sections(3);
  const third = text.indexOf("## Heading 3");
  assert.equal(markdownCut(text, 5), third); // the fifth block is the third heading
  assert.equal(markdownCut(text, 4), third);
  // a text that ends on the heading that fills the room: whatever follows would be cut off it
  assert.equal(markdownCut(text.slice(0, third + "## Heading 3".length), 5), third);
  assert.equal(markdownCut("## Only\n\ntext", 1), "## Only\n\n".length); // never an empty message
  // a stream cannot take back a heading it was sent
  assert.equal(markdownCut(text, 5, third + 3), text.indexOf("paragraph 3"));
});

test("a streamed heading goes to the next message with its text", async () => {
  // Seen on 2026-10-08: 40 sections, the first message ended on the heading of the 23rd.
  const slack = new FakeSlack();
  const sink = reply(slack, { limiter: burstOf(200) });
  const text = sections(40);
  for (let i = 0; i < text.length; i += 7) {
    // in small pieces, as a stream brings it
    await sink.text(text.slice(i, i + 7));
    await settled();
  }
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const [first, second] = slack.messageTexts();
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(first.endsWith("paragraph 22") && second.startsWith("## Heading 23"));
  assert.deepEqual(linesOf(first, second), linesOf(text));
});

// A dropped update leaves the message short of what Claude wrote: the reply's end does not land,
// which the session shows as a failed turn, until an update of that message passes.

test("a dropped update of a message written by edit is an end that did not land", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, finalRetrySeconds: 0.01 });
  await sink.text("partial");
  await settled();
  await clock.advance(STREAM_SECONDS + 1); // from here the message grows by update
  slack.responses["chat.update"] = rejected("invalid_blocks");
  await sink.text(" and more");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  await passed(0.01);
  assert.equal(await soon(sink.waitLanded()), false);
  assert.deepEqual(slack.streamTexts(), ["partial"]);
});

test("a dropped update followed by one that passes lands the reply", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("partial");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.update"] = [rejected("invalid_blocks"), { ok: true }];
  await sink.text(" and more");
  await settled();
  assert.deepEqual(slack.streamTexts(), ["partial"]); // the change was dropped
  await sink.text(", then the end");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.ok(slack.streamTexts()[0]?.startsWith("partial and more, then the end"));
});

test("a dropped update of a continuation is an end that did not land", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock, limiter: burstOf(50), finalRetrySeconds: 0.01 });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text("a line of text\n".repeat(1_000)); // past one message: the rest is a post
  await settled();
  const posted = slack.postedTs[0];
  slack.responses["chat.update"] = (args) =>
    args.ts === posted ? rejected("invalid_blocks") : { ok: true };
  await sink.text("the last line");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
});

// Behaviours the tests above do not reach, found by mutating the source and running them
// (2026-10-10): each test below fails when its line is taken out.

test("an ending posted from a stream that sent everything leaves the first message without it", async () => {
  // The stopped stream shows its whole span, so it needs no write: until the ending leaves the
  // span. The message must then be edited, or the ending would show twice.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("Before.\n\n");
  await sink.task(tool("t1", "Agent", "complete", { task: true }));
  await sink.text("The build passed.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), true);
  const ending = only(slack.callsTo("chat.postMessage"));
  assert.equal(get(ending, "blocks", 0, "text"), "The build passed.");
  const [first] = slack.messageBlocks();
  assert.ok(first !== undefined && !shows(first, "The build passed."));
  assert.ok(shows(first, "Before."));
});

test("a start of unknown outcome is looked for from the attempt's time less the skew", async () => {
  const slack = new ResetAfterApply();
  const clock = new FakeClock();
  clock.now = 1_790_000_000;
  slack.resetNext = "chat.startStream";
  const sink = reply(slack, { clock });
  await sink.text("one");
  await settled();
  const read = only(slack.callsTo("conversations.replies"));
  assert.equal(read.oldest, (1_790_000_000 - ADOPT_SKEW_SECONDS).toFixed(6));
  assert.equal(read.ts, THREAD);
});

test("a thread that cannot be read back is logged and the lost start is made again", async () => {
  const slack = new ResetAfterApply();
  const log = new Recorded();
  slack.resetNext = "chat.startStream";
  slack.responses["conversations.replies"] = rejected("ratelimited");
  const sink = reply(slack, { logger: log });
  await sink.text("one");
  await settled();
  assert.ok(log.text.includes("could not read the thread back for a lost write: ratelimited"));
  await sink.text(" two");
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 2); // nothing found: written again
});

test("a continuation post Slack refuses at the end is retried as text and logged when that fails too", async () => {
  // Once the reply is closed out, a continuation whose blocks Slack refuses is posted as text
  // alone: nothing else would ever show it.
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const log = new Recorded();
  const sink = reply(slack, { clock, logger: log, finalRetrySeconds: 60 });
  await sink.text("start\n");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.text("a line of text\n".repeat(1_000)); // past one message: the rest is posted
  slack.responses["chat.postMessage"] = rejected("invalid_blocks");
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("footer"), false);
  assert.ok(log.text.includes("could not write a reply to Slack as plain text: invalid_blocks"));
  assert.equal(slack.postedTs.length, 0);
  await sink.settle();
});

test("a change that arrives while a write waits its turn is sent with it", async () => {
  // The plan is worked out again after the limiter's wait, so one append carries both texts.
  const slack = new FakeSlack();
  const gate = new AsyncEvent();
  const waiting = new AsyncEvent();
  let acquired = 0;
  const limiter: Limiter = {
    async acquire() {
      acquired += 1;
      if (acquired === 1) {
        waiting.set();
        await gate.wait();
      }
    },
    async refund() {},
  };
  const sink = reply(slack, { limiter });
  await sink.text("Hello. ");
  await settled();
  await sink.text("World. ");
  await settled();
  await waiting.wait(); // the append is out of its debounce, waiting for the budget
  await sink.text("More.");
  gate.set();
  await settled();
  const appends = slack.callsTo("chat.appendStream");
  assert.equal(appends.length, 1);
  assert.deepEqual(
    list(appends[0]?.chunks).map((c) => c.text),
    ["World. More."],
  );
});

test("the footer's limit counts down from the clock's time in milliseconds", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  clock.now = 36_000; // seconds, as every clock of the daemon reads
  const sink = reply(slack, { clock });
  await sink.text("Answer.");
  await settled();
  const fields = {
    bypass: false,
    model: null,
    effort: null,
    folder: null,
    branch: null,
    changes: null,
    sessionTokens: null,
    contextPercent: null,
    sessionLimit: { percent: 3, resetsAt: 36_000_000 + 2 * 3_600_000 + 10 * 60_000 },
    weekLimit: null,
  };
  await sink.finish([], fields);
  assert.equal(await sink.closeOut(), true);
  assert.equal(footerOf(firstStream(slack).blocks), "*5h* 3% ↻ 2h");
});

test("the footer's fields are formatted into the line the end writes", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = reply(slack, { clock });
  await sink.text("Answer.");
  await settled();
  const fields = {
    bypass: true,
    model: "opus",
    effort: null,
    folder: null,
    branch: null,
    changes: null,
    sessionTokens: null,
    contextPercent: 6,
    sessionLimit: null,
    weekLimit: null,
  };
  await sink.finish([], fields);
  assert.equal(await sink.closeOut(), true);
  const line = formatFooter(fields, clock.time() * 1000);
  assert.ok(line.startsWith("⚡ bypass"));
  assert.equal(footerOf(firstStream(slack).blocks), line);
});

// ---- a reply with another reply's message below it ends where it is
// Hand-driven: no recording holds two replies in one thread ending out of turn.

/** A moment above every message a FakeSlack makes in a test. */
const OWNER_TS = "1790000000.900000";

test("a reply overtaken after its stream stopped ends by one edit, with no post", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = await longReply(slack, { places });
  const other = reply(slack, { places });
  await other.text("Another turn started.");
  await settled();
  assert.equal(sink.overtaken, true);
  assert.equal(other.overtaken, false);
  const pushes = slack.pushes();
  const posts = slack.callsTo("chat.postMessage").length;
  const updates = slack.callsTo("chat.update").length;
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  assert.equal(slack.callsTo("chat.postMessage").length, posts, "nothing is posted");
  assert.equal(slack.callsTo("chat.update").length, updates + 1, "one edit");
  assert.equal(slack.pushes(), pushes, "and no push");
  const update = last(slack.callsTo("chat.update"));
  assert.deepEqual(list(update.blocks).slice(-2), [
    { type: "divider" },
    contextBlock("main · ctx 6%"),
  ]);
});

test("a reply with only an owner message below it still posts its ending", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = await longReply(slack, { places });
  places.ownerPosted(OWNER_TS);
  assert.equal(sink.overtaken, false);
  assert.equal(sink.last, false);
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  assert.equal(only(slack.callsTo("chat.postMessage")).thread_ts, THREAD);
});

test("a reply overtaken while its stream is open ends on its stop, with no post", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Working on it.");
  await settled();
  const other = reply(slack, { places });
  await other.text("Another turn started.");
  await settled();
  assert.equal(sink.overtaken, true);
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  assert.equal(slack.callsTo("chat.postMessage").length, 0);
  const stop = only(slack.callsTo("chat.stopStream"));
  assert.deepEqual(list(stop.blocks), [{ type: "divider" }, contextBlock("main · ctx 6%")]);
});

test("an overtaken reply whose new content would overflow posts nothing", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const logger = new Recorded();
  const clock = new FakeClock();
  const sink = reply(slack, { places, logger, clock });
  await sink.text("Start.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  const other = reply(slack, { places });
  await other.text("Another turn started.");
  await settled();
  const created = slack.createdTs.length;
  await sink.text(`\n\n${"word ".repeat(MESSAGE_LIMIT)}`);
  await sink.finish([], null);
  assert.equal(await sink.closeOutFormatted("main · ctx 6%"), true);
  assert.equal(slack.callsTo("chat.postMessage").length, 0);
  assert.equal(slack.createdTs.length, created, "no message was opened");
  assert.equal(logger.lines.filter((line) => line.level === "WARNING").length, 1);
  const update = last(slack.callsTo("chat.update"));
  assert.deepEqual(list(update.blocks).slice(-2), [
    { type: "divider" },
    contextBlock("main · ctx 6%"),
  ]);
});

test("an older reply does not post its ending below a newer one that was let go of", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const older = await longReply(slack, { places });
  const newer = reply(slack, { places });
  await newer.text("The newer answer.");
  await settled();
  await newer.finish([], null);
  assert.equal(await newer.closeOutFormatted("newer"), true);
  places.ownerPosted(OWNER_TS); // the owner wrote below it: the places let it go
  assert.equal(newer.last, false);
  assert.equal(older.overtaken, true, "the newer reply still sits below it");
  const posts = slack.callsTo("chat.postMessage").length;
  assert.equal(await older.closeOutFormatted("older"), true);
  assert.equal(slack.callsTo("chat.postMessage").length, posts, "no ending is posted");
});

test("a closing message whose post failed is not posted once another reply is below", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const clock = new FakeClock();
  const sink = reply(slack, { places, clock, finalRetrySeconds: 0.02 });
  await sink.text("Only words.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finishFormatted([], "footer");
  const answer = slack.responses["chat.postMessage"] as JsonObject;
  slack.responses["chat.postMessage"] = [rejected("ratelimited"), answer];
  assert.equal(await sink.closeOut(), false);
  const posts = slack.callsTo("chat.postMessage").length;
  const other = reply(slack, { places });
  await other.text("Another turn.");
  await settled();
  await passed(0.02);
  assert.equal(await soon(sink.waitLanded()), true);
  assert.equal(slack.callsTo("chat.postMessage").length, posts, "the retry posts nothing");
  const update = last(slack.callsTo("chat.update"));
  assert.deepEqual(list(update.blocks).slice(-2), [{ type: "divider" }, contextBlock("footer")]);
});

test("a continuation not yet posted is dropped once another reply is below", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const logger = new Recorded();
  const clock = new FakeClock();
  const sink = reply(slack, { places, logger, clock });
  await sink.text("Start.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  const answer = slack.responses["chat.postMessage"] as JsonObject;
  slack.responses["chat.postMessage"] = [rejected("ratelimited"), answer];
  await sink.text(`\n\n${"word ".repeat(MESSAGE_LIMIT)}`); // overflows: the continuation's post fails
  await settled();
  const posts = slack.callsTo("chat.postMessage").length;
  const other = reply(slack, { places });
  await other.text("Another turn.");
  await settled();
  await sink.text("\n\nmore");
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, posts, "the continuation is not posted");
  assert.equal(other.overtaken, false, "so the roles did not flip");
  assert.equal(sink.overtaken, true);
  assert.equal(logger.lines.filter((line) => line.level === "WARNING").length >= 1, true);
});

test("a message is created in a thread by one reply at a time", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = await longReply(slack, { places });
  const gate = new AsyncEvent();
  slack.gate = gate;
  slack.gateMethod = "chat.postMessage";
  slack.gated.clear();
  const closing = sink.closeOutFormatted("footer"); // its ending post is held in flight
  await slack.gated.wait();
  const other = reply(slack, { places });
  await other.text("Another turn.");
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 1, "the other stream waits for the post");
  slack.gate = null;
  gate.set();
  assert.equal(await soon(closing), true);
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 2);
  const [, ending] = slack.createdTs;
  const [, , second] = slack.createdTs;
  assert.ok(ending !== undefined && second !== undefined && ending < second, "the ending is above");
  assert.equal(sink.overtaken, true);
  assert.equal(other.overtaken, false);
});

test("an edit that waits for the update budget does not hold another reply's new message back", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const budget = new AsyncEvent();
  let drained = false;
  const limiter: Limiter = {
    async acquire() {
      if (drained) await budget.wait();
    },
    async refund() {},
  };
  const sink = await longReply(slack, { places, limiter });
  drained = true;
  const closing = sink.closeOutFormatted("footer"); // the ending is posted, its edit waits
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, 1, "the ending is posted");
  const other = reply(slack, { places });
  await other.text("Another turn.");
  await settled();
  assert.equal(slack.callsTo("chat.startStream").length, 2, "the other stream does not wait");
  drained = false;
  budget.set();
  assert.equal(await soon(closing), true);
});

// ---- the footer by position: one under the last reply between two owner messages
// Hand-driven: no recording holds replies of one thread ending out of turn.

/** What each message of the thread shows as its footer, by creation; null for none or deleted. */
function footerTexts(slack: FakeSlack): Array<string | null> {
  return slack.createdTs.map((ts) => {
    const message = slack.messages.get(ts);
    const blocks = message?.blocks ?? [];
    const [divider, context] = blocks.slice(-2);
    if (message?.deleted || divider?.type !== "divider" || context?.type !== "context") return null;
    return str(get(context, "elements", 0, "text"));
  });
}

/** A reply that says one line and ends with `footer`, its write landed. */
async function ended(sink: ReplySink, line: string, footer: string | null): Promise<void> {
  if (line !== "") await sink.text(line);
  await sink.finishFormatted([], footer);
  assert.equal(await soon(sink.closeOut()), true);
  await settled();
}

/** A reply of text alone whose stream stopped at 280 s: its end is a closing message. */
async function closingReply(
  slack: FakeSlack,
  places: ThreadPlaces,
  footer: string,
  options: ReplyOptions = {},
) {
  const clock = new FakeClock();
  const sink = reply(slack, { ...options, places, clock });
  await sink.text("Only words.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finishFormatted([], footer);
  assert.equal(await soon(sink.closeOut()), true);
  await settled();
  return sink;
}

test("two replies of a stretch show one footer: the lower taking it, the upper gives it up by one edit", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = reply(slack, { places });
  await upper.text("Upper.");
  await settled();
  const lower = reply(slack, { places });
  await lower.text("Lower.");
  await settled();
  await ended(upper, "", "upper footer"); // overtaken: it ends where it is
  assert.deepEqual(footerTexts(slack), ["upper footer", null]);
  const updates = slack.callsTo("chat.update").length;
  await ended(lower, "", "lower footer");
  assert.deepEqual(footerTexts(slack), [null, "lower footer"]);
  assert.equal(slack.callsTo("chat.update").length, updates + 1, "one edit took it off");
  assert.equal(slack.pushes(), 2, "each stop notified once, the edit did not");
});

test("the upper reply that ends after the lower one shows no footer", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = reply(slack, { places });
  await upper.text("Upper.");
  await settled();
  const lower = reply(slack, { places });
  await lower.text("Lower.");
  await settled();
  await ended(lower, "", "lower footer");
  await ended(upper, "", "upper footer");
  assert.deepEqual(footerTexts(slack), [null, "lower footer"]);
  assert.equal(slack.callsTo("chat.postMessage").length, 0);
});

test("an owner message between two replies leaves both a footer", async () => {
  const slack = new FakeSlack();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const upper = reply(slack, { places });
  await upper.text("Upper.");
  await settled();
  places.ownerPosted(slack.ownerTs());
  const lower = reply(slack, { places });
  await lower.text("Lower.");
  await settled();
  await ended(upper, "", "upper footer");
  await ended(lower, "", "lower footer");
  assert.deepEqual(footerTexts(slack), ["upper footer", "lower footer"]);
});

test("a lower reply with no footer of its own shows the upper one's, and the upper none", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = reply(slack, { places });
  await upper.text("Upper.");
  await settled();
  const lower = reply(slack, { places });
  await lower.text("Lower.");
  await settled();
  await ended(upper, "", "upper footer");
  await ended(lower, "", null);
  assert.deepEqual(footerTexts(slack), [null, "upper footer"]);
});

test("a reply that ends in place between two reports leaves one footer, on the second report", async () => {
  // Ruling R6 of #295, case 2: the reply waits on a task, the first report goes below it, the
  // reply ends where it is, then a second report goes below.
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const waiting = reply(slack, { places });
  await waiting.text("Started a task.");
  await settled();
  const first = reply(slack, { places });
  await first.text("First report.");
  await settled();
  await ended(first, "", "first footer");
  await ended(waiting, "", "waiting footer");
  assert.deepEqual(footerTexts(slack), [null, "first footer"]);
  const second = reply(slack, { places });
  await second.text("Second report.");
  await settled();
  await ended(second, "", "second footer");
  assert.deepEqual(footerTexts(slack), [null, null, "second footer"]);
});

test("an owner message that lands while the lower reply still writes does not keep the upper footer", async () => {
  // The upper reply is let go of by an owner message only when no reply of its stretch is
  // still to end: the report below it (above the message) takes the footer when it does.
  const slack = new FakeSlack();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const upper = reply(slack, { places });
  await upper.text("Upper.");
  await settled();
  const report = reply(slack, { places });
  await report.text("Report.");
  await settled();
  await ended(upper, "", "upper footer");
  places.ownerPosted(slack.ownerTs()); // the report is still writing, above this message
  assert.equal(places.holds(upper), true, "its stretch is not over");
  await ended(report, "", "report footer");
  assert.deepEqual(footerTexts(slack), [null, "report footer"]);
  assert.equal(places.holds(upper), false, "now it is let go of");
});

test("a closing message that held the footer alone is deleted once the footer moves below", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = await closingReply(slack, places, "upper footer");
  assert.equal(slack.callsTo("chat.postMessage").length, 1, "the closing message");
  const [body, closing] = slack.createdTs;
  const lower = reply(slack, { places });
  await ended(lower, "Lower.", "lower footer");
  assert.equal(slack.messages.get(closing ?? "")?.deleted, true);
  assert.equal(slack.callsTo("chat.delete").length, 1);
  assert.equal(slack.callsTo("chat.postMessage").length, 1, "no second closing message");
  assert.equal(footerTexts(slack)[slack.createdTs.indexOf(body ?? "")], null);
  assert.equal(await upper.waitLanded(), true);
  // More changes to the upper reply post nothing either.
  await upper.text(" And more.");
  await settled();
  assert.equal(slack.callsTo("chat.postMessage").length, 1);
});

/** Places that hand nothing out by themselves: the test hands the tails. */
class HandPlaced extends ThreadPlaces {
  override place(): void {}
}

test("a footer assigned later to a reply whose closing message went is drawn under its body", async () => {
  const slack = new FakeSlack();
  const upper = await closingReply(slack, new HandPlaced(), "upper footer");
  upper.assign({ footer: null, list: null });
  await settled();
  assert.equal(slack.callsTo("chat.delete").length, 1);
  assert.equal(footerTexts(slack)[0], null);
  upper.assign({ footer: "back", list: null });
  await settled();
  assert.equal(footerTexts(slack)[0], "back");
  assert.equal(slack.callsTo("chat.postMessage").length, 1, "still no second closing message");
  assert.equal(slack.callsTo("chat.delete").length, 1);
});

test("a closing message whose delete fails keeps its footer and is deleted once more later", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const logger = new Recorded();
  await closingReply(slack, places, "upper footer", { logger, finalRetrySeconds: 0.02 });
  const closing = slack.createdTs[1] ?? "";
  slack.responses["chat.delete"] = [rejected("internal_error"), { ok: true }];
  await ended(reply(slack, { places }), "Lower.", "lower footer");
  assert.equal(slack.messages.get(closing)?.deleted, false, "kept");
  assert.equal(footerTexts(slack)[1], "upper footer");
  assert.equal(logger.lines.filter((line) => line.level === "WARNING").length, 1);
  await passed(0.02);
  await settled();
  assert.equal(slack.messages.get(closing)?.deleted, true);
  assert.equal(slack.callsTo("chat.delete").length, 2);
});

test("a closing message already gone counts as deleted", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const logger = new Recorded();
  await closingReply(slack, places, "upper footer", { logger });
  slack.responses["chat.delete"] = rejected("message_not_found");
  await ended(reply(slack, { places }), "Lower.", "lower footer");
  assert.equal(slack.callsTo("chat.delete").length, 1);
  assert.equal(logger.lines.filter((line) => line.level === "WARNING").length, 0);
  assert.equal(slack.callsTo("chat.postMessage").length, 1);
});

test("a footer taken off by a write of unknown outcome is taken off again by the next pass", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = await longReply(slack, { places, finalRetrySeconds: 0.02 });
  assert.equal(await soon(upper.closeOutFormatted("upper footer")), true);
  const lower = reply(slack, { places });
  await lower.text("Lower.");
  await settled();
  const ending = 1; // the upper reply's ending was posted, with its footer
  assert.equal(footerTexts(slack)[ending], "upper footer");
  slack.responses["chat.update"] = [timedOut(), { ok: true }];
  await ended(lower, "", "lower footer");
  assert.equal(footerTexts(slack)[ending], "upper footer", "the edit may or may not have landed");
  await passed(0.02);
  await settled();
  assert.equal(footerTexts(slack)[ending], null);
  assert.equal(footerTexts(slack).at(-1), "lower footer");
});

test("an ending that goes by an edit of unknown outcome is not reported landed before it is rewritten", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = await longReply(slack, { places, finalRetrySeconds: 0.02 });
  const other = reply(slack, { places });
  await other.text("Another turn.");
  await settled();
  slack.responses["chat.update"] = [timedOut(), { ok: true }];
  assert.equal(await soon(sink.closeOutFormatted("upper footer")), false, "outcome unknown");
  let landed: boolean | null = null;
  void sink.waitLanded().then((value) => {
    landed = value;
  });
  await settled();
  assert.equal(landed, null, "not landed before the rewrite");
  await passed(0.02);
  assert.equal(await soon(sink.waitLanded()), true);
  assert.equal(footerTexts(slack)[0], "upper footer");
});

test("three replies of a stretch end in every order, with an owner message at every point: one footer, on the lowest ended", async () => {
  // Generated: 6 orders of the ends x 4 patterns of which reply has no footer of its own x 5
  // arrivals of the owner's message (before the first end, after the first, the second, the
  // third, or never) = 120 cases.
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const missing = [null, 0, 1, 2];
  const arrivals = [0, 1, 2, 3, null];
  let cases = 0;
  const failures: string[] = [];
  for (const order of orders) {
    for (const lacks of missing) {
      for (const arrival of arrivals) {
        cases += 1;
        clocks = []; // `settled` moves every clock of the test: keep it to this case's
        const name = `order ${order.join("")} lacks ${lacks} mark after ${arrival} ends`;
        const slack = new FakeSlack();
        slack.tsStep = 10;
        const places = new ThreadPlaces();
        const sinks = [0, 1, 2].map(() => reply(slack, { places }));
        for (const [i, sink] of sinks.entries()) {
          await sink.text(`Reply ${i}.`);
          await settled();
        }
        const own = (i: number) => (i === lacks ? null : `footer ${i}`);
        const ownerTs = slack.ownerTs();
        const done: number[] = [];
        if (arrival === 0) places.ownerPosted(ownerTs);
        for (const i of order) {
          await ended(sinks[i] as ReplySink, "", own(i));
          done.push(i);
          if (arrival === done.length) places.ownerPosted(ownerTs);
          await settled();
          const lowest = Math.max(...done);
          const source = [...done].sort((a, b) => a - b).findLast((j) => own(j) !== null);
          const expected = [0, 1, 2].map((j) =>
            j === lowest && source !== undefined ? own(source) : null,
          );
          if (!isDeepStrictEqual(footerTexts(slack), expected)) {
            failures.push(`${name}, after end of ${i}: ${JSON.stringify(footerTexts(slack))}`);
          }
        }
      }
    }
  }
  assert.equal(cases, 120);
  assert.deepEqual(failures, []);
});

test("a footer edit in flight while the lower reply's end lands is taken off once it lands", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = await longReply(slack, { places });
  const lower = reply(slack, { places });
  await lower.text("Lower.");
  await settled();
  const gate = new AsyncEvent();
  slack.gate = gate;
  slack.gateMethod = "chat.update";
  slack.gated.clear();
  const closing = upper.closeOutFormatted("upper footer"); // overtaken: ends by an edit, held in flight
  await slack.gated.wait();
  slack.gate = null;
  await ended(lower, "", "lower footer"); // lands while the edit is still on the way
  gate.set();
  assert.equal(await soon(closing), true);
  await settled();
  await passed(30);
  assert.deepEqual(footerTexts(slack).slice(-2), [null, "lower footer"]);
});

test("a deleted closing message does not move its reply back above an owner message", async () => {
  const slack = new FakeSlack();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const a = reply(slack, { places });
  await ended(a, "A.", "a footer");
  const clock = new FakeClock();
  const b = reply(slack, { places, clock });
  await b.text("Only words.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await b.finish([], null);
  places.ownerPosted(slack.ownerTs()); // the owner writes: B's closing message lands below it
  assert.equal(await soon(b.closeOutFormatted("b footer")), true);
  await settled();
  await ended(reply(slack, { places }), "C.", "c footer");
  assert.equal(slack.callsTo("chat.delete").length, 1, "B's closing message went");
  const shown = footerTexts(slack);
  assert.equal(shown.filter((footer) => footer !== null).length, 2, shown.join(" | "));
  assert.equal(shown[0], "a footer");
  assert.equal(shown.at(-1), "c footer");
});

test("a retry of a write after the end that fails too is logged once, naming the footer", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const logger = new Recorded();
  await closingReply(slack, places, "upper footer", { logger, finalRetrySeconds: 0.02 });
  slack.responses["chat.delete"] = rejected("internal_error");
  await ended(reply(slack, { places }), "Lower.", "lower footer");
  await passed(0.02);
  await settled();
  assert.equal(slack.callsTo("chat.delete").length, 2, "tried, then once more");
  const twice = logger.lines.filter((line) => line.message.includes("tried twice"));
  assert.equal(twice.length, 1);
  assert.match(twice[0]?.message ?? "", /footer/);
  // The next change of the reply writes it.
  slack.responses["chat.delete"] = { ok: true };
  const upper = places as unknown as { replies: Set<ReplySink> };
  const [sink] = [...upper.replies];
  await sink?.text(" More.");
  await settled();
  assert.equal(slack.callsTo("chat.delete").length, 3);
});

test("a retry that a settling flush starts does not outlive the close", async () => {
  const slack = new FakeSlack();
  const sink = await closingReply(slack, new HandPlaced(), "upper footer", {
    finalRetrySeconds: 0.02,
  });
  slack.responses["chat.delete"] = rejected("internal_error");
  sink.assign({ footer: null, list: null }); // schedules the delete, which fails
  await sink.settle();
  const deletes = slack.callsTo("chat.delete").length;
  await passed(1);
  await settled();
  assert.equal(slack.callsTo("chat.delete").length, deletes, "no retry after the close");
});

// ---- a reply at rest: its turn ended with work still running
// Hand-driven: the stream test replays a recording, these cover the orderings it cannot reach.

/** A reply with text, its turn ended with `footer`, and `seconds` since its stream started. */
async function finishedReply(
  slack: FakeSlack,
  seconds = 0,
  options: ReplyOptions = {},
): Promise<[ReplySink, FakeClock]> {
  const clock = new FakeClock();
  const sink = reply(slack, { ...options, clock });
  await sink.text("Started it.");
  await settled();
  if (seconds > 0) await clock.advance(seconds);
  await sink.finishFormatted([], "footer");
  return [sink, clock];
}

test("a reply that rests stops its stream with the footer and goes on by edit", async () => {
  const slack = new FakeSlack();
  const [sink] = await finishedReply(slack);
  assert.equal(slack.callsTo("chat.stopStream").length, 0, "finishing alone stops nothing");
  sink.rest();
  await settled();
  const stop = only(slack.callsTo("chat.stopStream"));
  assert.deepEqual(stop.blocks, [{ type: "divider" }, contextBlock("footer")]);
  assert.equal(slack.pushes(), 1);
  assert.deepEqual(slack.callsTo("chat.update"), [], "the stop carried everything");
  // What arrives later changes the message by edit, the footer staying under it.
  await sink.text(" The report.");
  await settled();
  assert.equal(slack.pushes(), 1);
  assert.equal(slack.callsTo("chat.appendStream").length, 0);
  const update = last(slack.callsTo("chat.update"));
  assert.deepEqual(list(update.blocks).slice(-2), [{ type: "divider" }, contextBlock("footer")]);
  assert.equal(slack.messageTexts()[0], "Started it. The report.");
});

test("a reply rests once however many times it is told to", async () => {
  const slack = new FakeSlack();
  const [sink] = await finishedReply(slack);
  sink.rest();
  sink.rest();
  await settled();
  sink.rest();
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 1);
  assert.equal(slack.pushes(), 1);
});

test("a reply that rests after its stream stopped at 280 seconds writes the footer by edit", async () => {
  const slack = new FakeSlack();
  const [sink] = await finishedReply(slack, STREAM_SECONDS + 1);
  assert.equal(slack.callsTo("chat.stopStream").length, 1, "the deadline stopped it");
  // Finishing alone drew no footer: the reply's end may follow at once.
  assert.ok(!JSON.stringify(slack.callsTo("chat.update")).includes("footer"));
  const edits = slack.callsTo("chat.update").length;
  const pushes = slack.pushes();
  sink.rest();
  await settled();
  assert.equal(slack.callsTo("chat.update").length, edits + 1);
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-2), [
    { type: "divider" },
    contextBlock("footer"),
  ]);
  assert.equal(slack.callsTo("chat.stopStream").length, 1);
  assert.equal(slack.pushes(), pushes, "an edit never notifies");
});

test("a stop that fails leaves the stream open and the next pass tries again", async () => {
  const slack = new FakeSlack();
  const [sink] = await finishedReply(slack);
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), { ok: true }];
  sink.rest();
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 1);
  assert.equal(slack.messages.get(slack.streamTs[0] ?? "")?.streaming, true);
  assert.equal(slack.pushes(), 0);
  await sink.text(" More.");
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 2);
  assert.equal(slack.messages.get(slack.streamTs[0] ?? "")?.streaming, false);
  assert.equal(slack.pushes(), 1);
});

test("a reply that rests is still registered, and its end writes the ending with the footer", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const [sink] = await finishedReply(slack, 0, { places });
  sink.rest();
  await settled();
  places.ownerPosted("1790000000.900000"); // the owner wrote below it
  assert.ok(places.holds(sink), "resting is not ending: the places keep the reply");
  await sink.text("\n\nThe report.");
  assert.equal(await sink.closeOutFormatted("footer"), true);
  const ending = only(slack.callsTo("chat.postMessage"));
  assert.deepEqual(list(ending.blocks).slice(-2), [{ type: "divider" }, contextBlock("footer")]);
  assert.equal(slack.pushes(), 2); // the stop of the rest, and the ending
  assert.ok(!places.holds(sink), "ended, and sealed by the owner's message");
});

// ---- a reply at rest that something sits below: it ends where it is

/** A reply at rest with a message of the owner's below it. */
async function restedUnderOwner(slack: FakeSlack): Promise<[ReplySink, ThreadPlaces]> {
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const [sink] = await finishedReply(slack, 0, { places });
  sink.rest();
  await settled();
  places.ownerPosted(slack.ownerTs());
  return [sink, places];
}

test("a rested reply with an owner message below it and no words since ends by edit, with no post", async () => {
  const slack = new FakeSlack();
  const [sink] = await restedUnderOwner(slack);
  const pushes = slack.pushes();
  // The task's end line is the daemon's, not the agent's words.
  await sink.text("\n\nThe task ended.", { notice: true });
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.deepEqual(slack.callsTo("chat.postMessage"), [], "no new message");
  assert.equal(slack.pushes(), pushes, "no push");
  assert.equal(slack.messageTexts()[0], "Started it.\n\nThe task ended.");
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-2), [
    { type: "divider" },
    contextBlock("footer"),
  ]);
});

test("a rested reply that received the agent's words since posts its ending", async () => {
  const slack = new FakeSlack();
  const [sink] = await restedUnderOwner(slack);
  await sink.text(" The report.");
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.equal(slack.callsTo("chat.postMessage").length, 1);
});

test("the words of an earlier rest do not make the ending post after a later one", async () => {
  const slack = new FakeSlack();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const [sink] = await finishedReply(slack, 0, { places });
  sink.rest();
  await settled();
  await sink.text("\n\nThe first report."); // grows the message by edit
  await sink.finishFormatted([], "footer");
  sink.rest(); // it still owes a second task
  await settled();
  places.ownerPosted(slack.ownerTs());
  const pushes = slack.pushes();
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.deepEqual(slack.callsTo("chat.postMessage"), []);
  assert.equal(slack.pushes(), pushes);
});

test("a reply still writing its turn when the owner writes posts its ending", async () => {
  const slack = new FakeSlack();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const [sink] = await finishedReply(slack, STREAM_SECONDS + 1, { places });
  places.ownerPosted(slack.ownerTs()); // finished, not at rest
  assert.equal(await sink.closeOutFormatted("footer"), true);
  assert.equal(slack.callsTo("chat.postMessage").length, 1);
});

// ---- fix round 1: when a reply counts as at rest

test("a reply whose stream Slack closed shows the footer after rest, found out by the finish flush", async () => {
  const slack = new FakeSlack();
  const sink = reply(slack);
  await sink.text("Started it.");
  await settled();
  slack.expire(slack.streamTs[0] ?? ""); // Slack closes the stream; the daemon does not know
  await sink.text(" More.");
  await sink.finishFormatted([], "footer"); // its flush is what finds the stream gone
  sink.rest();
  await settled();
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-2), [
    { type: "divider" },
    contextBlock("footer"),
  ]);
  await sink.text(" Later.");
  await settled();
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-2), [
    { type: "divider" },
    contextBlock("footer"),
  ]);
});

test("a reply whose end does not land does not take the footer from the reply above", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = reply(slack, { places });
  await ended(upper, "Upper.", "a footer");
  const clock = new FakeClock();
  const lower = reply(slack, { places, clock, finalRetrySeconds: 0.02 });
  await lower.text("Lower.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  slack.responses["chat.postMessage"] = [rejected("internal_error"), rejected("internal_error")];
  await lower.finishFormatted([], "b footer");
  assert.equal(await lower.closeOut(), false);
  await passed(0.05);
  await settled();
  // Before the end lands, the footer stays where it was.
  assert.deepEqual(footerTexts(slack), ["a footer", null]);
});

test("a stop that keeps failing does not hide the text that follows", async () => {
  const slack = new FakeSlack();
  const [sink] = await finishedReply(slack);
  slack.responses["chat.stopStream"] = [
    rejected("ratelimited"),
    rejected("ratelimited"),
    { ok: true },
  ];
  sink.rest();
  await settled();
  await sink.text(" Between.");
  await settled();
  assert.ok(
    JSON.stringify(slack.callsTo("chat.appendStream")).includes("Between."),
    "the text goes on to the open stream",
  );
});

test("a refused rest stop is tried again after the retry pause, with no other change", async () => {
  const slack = new FakeSlack();
  const [sink] = await finishedReply(slack, 0, { finalRetrySeconds: 0.02 });
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), { ok: true }];
  sink.rest();
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 1);
  await passed(0.05);
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 2);
  assert.equal(slack.messages.get(slack.streamTs[0] ?? "")?.streaming, false);
});

test("a retry whose stop and whose append both fail is logged once", async () => {
  const slack = new FakeSlack();
  const logger = new Recorded();
  const [sink] = await finishedReply(slack, 0, { finalRetrySeconds: 0.05, logger });
  slack.responses["chat.stopStream"] = networkDown();
  slack.responses["chat.appendStream"] = networkDown();
  sink.rest();
  await settled();
  await sink.text(" More."); // an append waits for the retry too
  await passed(0.2);
  await settled();
  assert.equal(logger.lines.filter((line) => line.message.includes("tried twice")).length, 1);
});

test("a rest stop refused twice is logged as given up", async () => {
  const slack = new FakeSlack();
  const logger = new Recorded();
  const [sink] = await finishedReply(slack, 0, { finalRetrySeconds: 0.02, logger });
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), rejected("ratelimited")];
  sink.rest();
  await settled();
  await passed(0.05);
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 2);
  assert.equal(logger.lines.filter((line) => line.message.includes("tried twice")).length, 1);
});

test("a rest told again while the stream is still open tries the stop again", async () => {
  const slack = new FakeSlack();
  const [sink] = await finishedReply(slack);
  slack.responses["chat.stopStream"] = [rejected("ratelimited"), { ok: true }];
  sink.rest();
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 1);
  sink.rest(); // nothing else changed: only this call can start the pass
  await settled();
  assert.equal(slack.callsTo("chat.stopStream").length, 2);
  assert.equal(slack.pushes(), 1);
});

test("a rest stop that landed with its answer lost keeps the footer when text is pending", async () => {
  const slack = new ResetAfterApply();
  const sink = reply(slack);
  await sink.text("Started it.");
  await settled();
  await sink.finishFormatted([], "footer");
  await sink.text(" More.");
  slack.resetNext = "chat.stopStream"; // the stop lands with the footer, its answer is lost
  sink.rest();
  await settled();
  assert.deepEqual(footerTexts(slack), ["footer"]);
  await sink.text(" Later.");
  await settled();
  assert.deepEqual(footerTexts(slack), ["footer"]);
});

// ---- the list of what still runs (it sits above the footer of the thread's last reply at rest)

/** A reply that ended well, in a thread whose places the test holds. */
async function endedReply(
  slack: FakeSlack,
  places: ThreadPlaces,
  options: ReplyOptions = {},
): Promise<ReplySink> {
  const sink = reply(slack, { ...options, places });
  await sink.text("Done.");
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  return sink;
}

test("the list's card keeps its block id across three updates and a message never repeats a task id", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Started it.");
  await sink.task(tool("t1", "Agent", "in_progress", { task: true }));
  await sink.finishFormatted([], "footer");
  sink.rest();
  await settled();
  const lists = [
    { title: "1 agent still running", lines: ["Agent: one"] },
    { title: "2 agents still running", lines: ["Agent: one", "Agent: two"] },
    { title: "1 agent still running", lines: ["Agent: two"] },
  ];
  for (const running of lists) {
    places.showRunning(running);
    await settled();
    const blocks = list(last(slack.callsTo("chat.update")).blocks);
    assert.deepEqual(blocks.filter(isCard), [listCard(running)]);
  }
  // FakeSlack does not check it, Slack refuses it (`invalid_blocks`, measured 2026-10-12): in no
  // write is one `task_id` held by two blocks, and the tool's card is not the list's.
  for (const call of slack.apiCalls) {
    if (!Array.isArray(call.args.blocks)) continue;
    const ids = (call.args.blocks as JsonObject[])
      .filter((block) => block.type === "task_card")
      .map((block) => block.task_id);
    assert.equal(new Set(ids).size, ids.length, `${call.method} repeats a task id`);
  }
  const ids = list(last(slack.callsTo("chat.update")).blocks)
    .filter((block) => block.type === "task_card")
    .map((block) => block.task_id);
  assert.deepEqual(ids, ["t1", LIST_ID]);
});

test("the stream's stop carries the footer alone and the edit after it the list", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Started it.");
  await sink.finishFormatted([], "footer");
  places.showRunning(SHELL);
  sink.rest();
  await settled();
  const [stop] = slack.callsTo("chat.stopStream");
  assert.deepEqual(stop?.blocks, [{ type: "divider" }, contextBlock("footer")]);
  assert.deepEqual(list(last(slack.callsTo("chat.update")).blocks).slice(-3), [
    listCard(SHELL),
    { type: "divider" },
    contextBlock("footer"),
  ]);
  assert.equal(slack.pushes(), 1);
});

test("nine lines draw six and the count of the rest, and the title is cut at 150", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  await endedReply(slack, places);
  const lines = Array.from({ length: 9 }, (_, i) => `Agent: task number ${i + 1}`);
  places.showRunning({ title: `9 agents still running ${"x".repeat(200)}`, lines });
  await settled();
  const card = list(last(slack.callsTo("chat.update")).blocks).find(isCard);
  assert.equal(len(str(card?.title)), 150);
  assert.deepEqual(
    card?.details,
    listCard({
      title: "",
      lines: [...lines.slice(0, 6), "+3 more"],
    }).details,
  );
});

test("a failed write of the list is written again by the next pass", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = await endedReply(slack, places, { finalRetrySeconds: 0.02 });
  const written = slack.callsTo("chat.update").length;
  slack.responses["chat.update"] = [networkDown(), { ok: true }];
  places.showRunning(SHELL);
  await settled();
  assert.equal(slack.callsTo("chat.update").length, written + 1, "the first try failed");
  assert.deepEqual(slack.messageBlocks().at(-1)?.filter(isCard), [], "nothing was written");
  // The pass that fails leaves the message as it was; the next one, which the retry starts,
  // writes the card.
  await passed(0.02);
  await settled();
  const blocks = slack.messageBlocks().at(-1) ?? [];
  assert.deepEqual(blocks.filter(isCard), [listCard(SHELL)]);
  await sink.settle();
});

test("a message that shows the list stays among the open replies until it is taken off", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const changes: Array<[string | null, string | null]> = [];
  const sink = reply(slack, { places, onOpenReply: (old, fresh) => changes.push([old, fresh]) });
  await sink.text("Done.");
  await sink.finish([], null);
  await sink.closeOutFormatted("footer");
  await settled();
  const ts = slack.streamTs[0] ?? "";
  assert.deepEqual(changes, [
    [null, ts],
    [ts, null],
  ]);
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(changes.at(-1), [null, ts], "open again while it shows the list");
  places.showRunning(null);
  await settled();
  assert.deepEqual(changes.at(-1), [ts, null], "and closed once the list is off it");
  await sink.settle();
});

test("the closing message that shows the list is tracked, and goes with the list when it holds nothing else", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const places = new ThreadPlaces();
  const changes: Array<[string | null, string | null]> = [];
  const sink = reply(slack, {
    clock,
    places,
    onOpenReply: (old, fresh) => changes.push([old, fresh]),
  });
  await sink.text("Done.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  const closing = slack.postedTs[0] ?? "";
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(slack.messageBlocks().at(-1)?.filter(isCard), [listCard(SHELL)]);
  assert.deepEqual(changes.at(-1), [null, closing]);
  places.showRunning(null);
  await settled();
  assert.deepEqual(changes.at(-1), [closing, null]);
  const [deleted, ...more] = slack.callsTo("chat.delete");
  assert.equal(deleted?.ts, closing, "the closing message held the list alone: it is deleted");
  assert.equal(more.length, 0);
});

test("an owner message below the reply that holds the list does not let the reply go", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = await endedReply(slack, places);
  places.showRunning(SHELL);
  places.ownerPosted(OWNER_TS);
  await settled();
  assert.equal(places.holds(sink), true, "it holds the list, so it is still registered");
  assert.deepEqual(slack.messageBlocks().at(-1)?.filter(isCard), [listCard(SHELL)]);
  places.showRunning(null);
  await settled();
  assert.deepEqual(slack.messageBlocks().at(-1)?.filter(isCard), []);
  assert.equal(places.holds(sink), false, "and it is let go of once it holds nothing");
});

test("a reply that stopped holding the list is let go of when an owner message sits below it", async () => {
  const slack = new FakeSlack();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const first = await endedReply(slack, places);
  places.showRunning(SHELL);
  places.ownerPosted(slack.ownerTs());
  const second = reply(slack, { places });
  await second.text("More.");
  await second.finish([], null);
  await second.closeOutFormatted("footer");
  await settled();
  assert.equal(places.holds(first), false, "the list moved down, the first reply is let go of");
  assert.deepEqual(slack.messageBlocks().at(-1)?.filter(isCard), [listCard(SHELL)]);
  assert.deepEqual(slack.messageBlocks()[0]?.filter(isCard), []);
});

// ---- fix round 1

/** The cards of the list that all the messages of the thread show. */
function listCards(slack: FakeSlack): JsonObject[] {
  return slack.messageBlocks().flatMap((blocks) => blocks.filter(isCard));
}

test("a card write whose answer was lost is corrected when the list goes, on a resting reply", async () => {
  const slack = new ResetAfterApply();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Started it.");
  await sink.finishFormatted([], "footer");
  sink.rest();
  await settled();
  slack.resetNext = "chat.update"; // the update that adds the card lands, its answer is lost
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(listCards(slack), [listCard(SHELL)], "it landed");
  places.showRunning(null);
  await settled();
  await sink.settle();
  assert.deepEqual(listCards(slack), []);
});

test("a card write whose answer was lost on an ended holder leaves one card when the list moves", async () => {
  const slack = new ResetAfterApply();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  const first = await endedReply(slack, places, { finalRetrySeconds: 0.02 });
  // An earlier edit of the message is known to have landed, with no card in it.
  places.showRunning(AGENT);
  await settled();
  places.showRunning(null);
  await settled();
  slack.resetNext = "chat.update";
  places.showRunning(SHELL);
  await settled();
  places.ownerPosted(slack.ownerTs()); // a new stretch: the first reply keeps its own footer
  const second = reply(slack, { places });
  await second.text("More.");
  await second.finish([], null);
  await second.closeOutFormatted("footer");
  await settled();
  assert.deepEqual(slack.messageBlocks()[0]?.filter(isCard), []);
  assert.deepEqual(listCards(slack), [listCard(SHELL)]);
  await first.settle();
  assert.deepEqual(listCards(slack), [listCard(SHELL)]);
});

test("a closing message whose card write lost its answer is corrected when the list goes", async () => {
  const slack = new ResetAfterApply();
  const clock = new FakeClock();
  const places = new ThreadPlaces();
  const sink = reply(slack, { clock, places });
  await sink.text("Done.");
  await settled();
  await clock.advance(STREAM_SECONDS + 1);
  await sink.finish([], null);
  await sink.closeOutFormatted(null);
  slack.resetNext = "chat.update";
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(listCards(slack), [listCard(SHELL)], "it landed");
  places.showRunning(null);
  await settled();
  await sink.settle();
  assert.deepEqual(listCards(slack), []);
});

test("a failed card write on a resting reply is tried again after the retry pause", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places, finalRetrySeconds: 0.02 });
  await sink.text("Started it.");
  await sink.finishFormatted([], "footer");
  sink.rest();
  await settled();
  slack.responses["chat.update"] = [networkDown(), { ok: true }];
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(listCards(slack), [], "the first try failed");
  await passed(0.05);
  await settled();
  assert.deepEqual(listCards(slack), [listCard(SHELL)]);
});

test("a reply that was settled and goes on is tried again after a failed write", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places, finalRetrySeconds: 0.02 });
  await sink.text("Started it.");
  await sink.finishFormatted([], "footer");
  sink.rest();
  await settled();
  await sink.settle(); // the agent's process died, the session goes on
  slack.responses["chat.update"] = [networkDown(), { ok: true }];
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(listCards(slack), [], "the first try failed");
  await passed(0.05);
  await settled();
  assert.deepEqual(listCards(slack), [listCard(SHELL)]);
});

test("a reply whose end did not land draws no second card, and none is left when the list goes", async () => {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const upper = await endedReply(slack, places);
  places.showRunning(SHELL);
  await settled();
  assert.deepEqual(listCards(slack), [listCard(SHELL)]);
  const lower = await longReply(slack, { places, finalRetrySeconds: 60 });
  const lowerTs = slack.streamTs[1];
  // The cut of the lower reply's first message fails: its end does not land.
  slack.responses["chat.update"] = (args) =>
    args.ts === lowerTs ? rejected("ratelimited") : { ok: true };
  assert.equal(await lower.closeOutFormatted("footer"), false);
  await settled();
  assert.equal(listCards(slack).length, 1, "the list is drawn once");
  assert.equal(slack.messageBlocks()[0]?.some(isCard), true, "still on the reply that held it");
  places.showRunning(null);
  await settled();
  assert.deepEqual(listCards(slack), []);
  await upper.settle();
});

/** A resting reply that was shown (with the list or not) and whose later words overflow it. */
async function overflowingRest(withList: boolean): Promise<FakeSlack> {
  const slack = new FakeSlack();
  const places = new ThreadPlaces();
  const sink = reply(slack, { places });
  await sink.text("Started it.\n");
  await sink.finishFormatted([], "footer");
  if (withList) places.showRunning(SHELL);
  sink.rest();
  await settled();
  await sink.text("a line of the report\n".repeat(900)); // past one message
  await settled();
  return slack;
}

for (const withList of [true, false]) {
  test(`a continuation leaves the footer${withList ? " and the list" : ""} in the last message alone`, async () => {
    const slack = await overflowingRest(withList);
    const blocks = slack.messageBlocks();
    assert.ok(blocks.length >= 2, "the report went on in a continuation");
    assert.equal(blocks.flat().filter(isDivider).length, 1, "one footer");
    assert.equal(blocks.flat().filter(isCard).length, withList ? 1 : 0);
    assert.equal(blocks.at(-1)?.some(isDivider), true, "in the last message");
    assert.equal(blocks.at(-1)?.some(isCard), withList);
  });
}

// ---- fix round 2

test("replies that held the list and were let go of are not kept by the places", async () => {
  const slack = new FakeSlack();
  slack.tsStep = 10;
  const places = new ThreadPlaces();
  places.showRunning(SHELL);
  for (let turn = 0; turn < 6; turn += 1) {
    places.ownerPosted(slack.ownerTs());
    await endedReply(slack, places);
    await settled();
  }
  const listed = (places as unknown as { listed: Set<unknown> }).listed;
  assert.equal(listed.size, 1, "only the reply that holds the list");
  assert.equal(listCards(slack).length, 1);
});
