/**
 * The golden files: what the code does at two seams for every recorded SDK stream. They are
 * snapshots. `npm run golden` (`write-golden.ts`) writes them again from the code as it is, and
 * the two golden tests fail when the code no longer produces what the files hold. A change to a
 * reply therefore shows as a diff under `test/golden/`, which is to be read before it is committed.
 *
 * Seam 1 (`reply/<name>.json`): the calls `TurnRenderer` makes on its sink, in order. `whole` is
 * one renderer fed the whole recording, then closed as a finished turn is; `turns` is one fresh
 * renderer per turn. The recording goes through one `Translator`, as one session's would.
 * Seam 2 (`slack/<name>.json`): the Slack calls a real `ReplySink` makes for the `whole` calls of
 * seam 1, on the fake Slack.
 *
 * The files must be byte-for-byte reproducible: no wall clock, keys sorted.
 */
import type { SessionEvent } from "../../src/agent/seam.ts";
import type { Preview, TaskStatus, TaskUpdate } from "../../src/chat/seam.ts";
import { UpdateLimiter } from "../../src/chat/slack/reply/limiter.ts";
import { ReplySink } from "../../src/chat/slack/reply/sinks.ts";
import { type Sink, TurnRenderer } from "../../src/core/reply/renderer.ts";
import { BOT, CHANNEL, FakeClock, FakeSlack, OWNER, TEAM, THREAD } from "./fake-slack.ts";
import type { Json, JsonObject } from "./fixtures.ts";
import { NAMES } from "./names.ts";
import { recordedEvents, splitTurns } from "./replay.ts";

// The renderer never reads a footer, so any string stands for the one a session hands it.
const FOOTER = "footer";

// Nothing in the replay waits on a timer, and the Slack write budget never delays one.
const DISCIPLINE =
  "Each sink call of the seam-1 'whole' list is replayed in order on a ReplySink over FakeSlack. " +
  "After a text or task call, ReplySink.settle() flushes the reply at once, standing in for the " +
  "debounced write (one flush per sink call, so the debounce never merges two calls); finish " +
  "and close_out flush by themselves. The fake clock never advances, so the 280-second stream " +
  "deadline never fires, and the UpdateLimiter has a budget no recording can spend.";

type SinkCall =
  | { call: "text"; markdown: string; notice: boolean; ending: boolean }
  | { call: "task"; update: TaskUpdate }
  | { call: "finish"; closing: readonly TaskUpdate[]; footer: string | null }
  | { call: "close_out" }
  | { call: "wait_landed" }
  | { call: "settle" };

/** Every call the renderer makes on its sink, as the plain objects the golden files hold. */
class RecordingSink implements Sink<string> {
  calls: SinkCall[] = [];

  async text(
    markdown: string,
    options: { readonly notice?: boolean; readonly ending?: boolean } = {},
  ): Promise<void> {
    this.calls.push({
      call: "text",
      markdown,
      notice: options.notice ?? false,
      ending: options.ending ?? false,
    });
  }

  async task(update: TaskUpdate): Promise<void> {
    this.calls.push({ call: "task", update });
  }

  async finish(closing: readonly TaskUpdate[], footer: string | null): Promise<void> {
    this.calls.push({ call: "finish", closing, footer });
  }

  async closeOut(): Promise<boolean> {
    this.calls.push({ call: "close_out" });
    return true;
  }

  async waitLanded(): Promise<boolean> {
    this.calls.push({ call: "wait_landed" });
    return true;
  }

  async settle(): Promise<boolean> {
    this.calls.push({ call: "settle" });
    return true;
  }
}

/** One renderer fed `events`, then closed as a finished turn is. */
async function replayReply(events: readonly SessionEvent[]): Promise<unknown> {
  const sink = new RecordingSink();
  const renderer = new TurnRenderer<string>(sink, NAMES);
  for (const event of events) await renderer.feed(event);
  await renderer.close(FOOTER);
  await renderer.closeOut();
  return {
    calls: sink.calls,
    result_set: renderer.result !== null,
    running_tasks: renderer.runningTasks,
  };
}

/** What the reply seam does for a recording, as its golden file holds it. */
export async function replyGolden(name: string): Promise<JsonObject> {
  const events = recordedEvents(name);
  const turns: unknown[] = [];
  for (const turn of splitTurns(events)) turns.push(await replayReply(turn));
  return plain({ recording: name, whole: await replayReply(events), turns });
}

function object(value: Json | undefined, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`);
  }
  return value;
}

function list(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} is not a list`);
  return value;
}

function text(value: Json | undefined, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} is not a string`);
  return value;
}

function optional(value: Json | undefined, what: string): string | null {
  return value === null || value === undefined ? null : text(value, what);
}

/** A `TaskUpdate` as a reply golden holds it. */
function taskUpdate(value: Json | undefined): TaskUpdate {
  const fields = object(value, "update");
  let preview: Preview | null = null;
  if (fields.preview !== null && fields.preview !== undefined) {
    const view = object(fields.preview, "preview");
    preview = {
      title: text(view.title, "preview.title"),
      summary: text(view.summary, "preview.summary"),
      body: text(view.body, "preview.body"),
      language: text(view.language, "preview.language") as Preview["language"],
      plain: view.plain === true,
    };
  }
  return {
    id: text(fields.id, "id"),
    title: text(fields.title, "title"),
    status: text(fields.status, "status") as TaskStatus,
    details: optional(fields.details, "details"),
    output: optional(fields.output, "output"),
    name: text(fields.name, "name"),
    task: fields.task === true,
    calls: Number(fields.calls),
    preview,
    folded: optional(fields.folded, "folded"),
  };
}

/**
 * What the Slack seam does for the `whole` of a reply golden, as its golden file holds it. Each
 * Slack call names the index of the sink call behind it.
 */
export async function slackGolden(name: string, reply: JsonObject): Promise<JsonObject> {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = new ReplySink(slack, {
    channel: CHANNEL,
    threadTs: THREAD,
    teamId: TEAM,
    userId: OWNER,
    botUserId: BOT,
    limiter: new UpdateLimiter({ limit: 10 ** 9, burst: 10 ** 9, clock }),
    clock,
  });
  const caused: number[] = [];
  for (const [index, item] of list(object(reply.whole, "whole").calls, "calls").entries()) {
    const call = object(item, "call");
    switch (call.call) {
      case "text":
        await sink.text(text(call.markdown, "markdown"), {
          notice: call.notice === true,
          ending: call.ending === true,
        });
        await sink.settle();
        break;
      case "task":
        await sink.task(taskUpdate(call.update));
        await sink.settle();
        break;
      case "finish":
        await sink.finishFormatted(
          list(call.closing, "closing").map(taskUpdate),
          optional(call.footer, "footer"),
        );
        break;
      case "close_out":
        await sink.closeOut();
        break;
      case "wait_landed":
        await sink.waitLanded();
        break;
      case "settle":
        await sink.settle();
        break;
      default:
        throw new Error(`unknown sink call ${JSON.stringify(call.call)}`);
    }
    while (caused.length < slack.apiCalls.length) caused.push(index);
  }
  return plain({
    recording: name,
    discipline: DISCIPLINE,
    slack_calls: slack.apiCalls.map((call, at) => ({
      after_sink_call: caused[at],
      method: call.method,
      args: call.args,
    })),
    final: {
      message_blocks: slack.messageBlocks(),
      message_cards: slack.messageCards(),
      message_texts: slack.messageTexts(),
      pushes: slack.pushes(),
    },
  });
}

/** `value` as the JSON it is written as, so that a test compares what a file can hold. */
function plain(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const keys = Object.keys(value).sort();
  return Object.fromEntries(keys.map((key) => [key, sorted(value[key] as Json)]));
}

/** The bytes of a golden file: keys sorted, one space of indent, a final line end. */
export function dump(value: Json): string {
  return `${JSON.stringify(sorted(value), null, 1)}\n`;
}
