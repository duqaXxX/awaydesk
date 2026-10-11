/**
 * What `FakeSlack` answers: Slack's recorded responses, the funnel every call goes through, the
 * errors of `@slack/web-api` and the normalisation of the arguments.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FetchFunction,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
} from "@slack/web-api";
import {
  BOT,
  CHANNEL,
  connectionReset,
  FakeClock,
  FakeSlack,
  httpError,
  rateLimited,
  rejected,
  SlowAfterApply,
  THREAD,
  timedOut,
} from "./fake-slack.ts";
import { type JsonObject, slackPayload } from "./fixtures.ts";

test("fake slack returns recorded responses", async () => {
  const slack = new FakeSlack();
  const auth = await slack.auth.test();
  assert.ok(auth.team_id === "T000TEAM" && auth.user_id === "U000BOT");
  assert.ok(slack.callsTo("auth.test").length > 0);
});

test("a file upload goes through its two Slack calls and posts the bytes to the upload url", async () => {
  const slack = new FakeSlack();
  const done = await slack.files.uploadV2({
    channel_id: CHANNEL,
    thread_ts: THREAD,
    filename: "notes.txt",
    content: "hello",
    initial_comment: "here",
  });
  assert.equal(done.ok, true);
  assert.deepEqual(slack.apiCalls, [
    { method: "files.getUploadURLExternal", args: { filename: "notes.txt", length: 5 } },
    {
      method: "files.completeUploadExternal",
      args: {
        files: [{ id: "F000FILE", title: "notes.txt" }],
        channel_id: CHANNEL,
        initial_comment: "here",
        thread_ts: THREAD,
      },
    },
  ]);
  assert.deepEqual(
    slack.uploaded.map(({ url, data }) => [url, data.toString()]),
    [["https://files.slack.com/upload/v1/ABC123...", "hello"]],
  );
});

test("a fake is built with no token and no network", () => {
  const slack = new FakeSlack();
  assert.equal(slack.token, undefined);
});

// The errors: the same classes and fields as the client throws on the wire.

/** What the real client throws when its `fetch` does this, with no retry. */
async function realError(fetch: FetchFunction, rejectRateLimitedCalls = false): Promise<unknown> {
  const client = new WebClient(undefined, {
    fetch,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls,
    logLevel: "error" as never,
  });
  try {
    await client.apiCall("chat.update", {});
  } catch (error) {
    return error;
  }
  throw new Error("the real client did not throw");
}

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status === 200,
    status,
    statusText: "x",
    url: "https://slack.com/api/chat.update",
    headers: {
      get: (name: string) => headers[name] ?? null,
      entries: () => Object.entries(headers),
    },
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  };
}

/** The fields a provider can tell an error by. */
function fieldsOf(error: unknown): unknown {
  assert.ok(error instanceof Error);
  const own = error as Error & Record<string, unknown>;
  const original = own.original as (Error & { cause?: Error & { code?: string } }) | undefined;
  return {
    class: error.constructor.name,
    name: error.name,
    message: error.message,
    code: own.code,
    data: own.data,
    retryAfter: own.retryAfter,
    statusCode: own.statusCode,
    original: original && { name: original.name, message: original.message },
    cause: original?.cause && { code: original.cause.code, message: original.cause.message },
  };
}

test("a rejected call is the platform error the client throws", async () => {
  const real = await realError(async () =>
    response(200, JSON.stringify({ ok: false, error: "channel_not_found" })),
  );
  const fake = rejected("channel_not_found");
  assert.ok(fake instanceof WebAPIPlatformError);
  assert.deepEqual(fieldsOf(fake), fieldsOf(real));
  assert.equal(fake.code, "slack_webapi_platform_error");
  assert.equal(fake.data.error, "channel_not_found");
});

test("a connection reset is a request error whose cause carries the system code", async () => {
  const real = await realError(async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
  });
  const fake = connectionReset();
  assert.ok(fake instanceof WebAPIRequestError);
  assert.deepEqual(fieldsOf(fake), fieldsOf(real));
  assert.equal(fake.code, "slack_webapi_request_error");
});

test("a timeout is a request error wrapping the TimeoutError the client's own timer raises", async () => {
  // `timeout` makes the client pass `AbortSignal.timeout`, which aborts `fetch` with this.
  const client = new WebClient(undefined, {
    timeout: 5,
    retryConfig: { retries: 0 },
    logLevel: "error" as never,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  });
  // The timer of `AbortSignal.timeout` does not keep the event loop alive, and on Node 22 the
  // loop ends before it fires when nothing else is pending.
  const awake = setInterval(() => {}, 1000);
  try {
    const real = await client.apiCall("chat.update", {}).catch((error: unknown) => error);
    assert.deepEqual(fieldsOf(timedOut()), fieldsOf(real));
  } finally {
    clearInterval(awake);
  }
});

test("a rate limit is the error the client throws when it rejects rate limited calls", async () => {
  const real = await realError(async () => response(429, "", { "retry-after": "3" }), true);
  const fake = rateLimited(3);
  assert.ok(fake instanceof WebAPIRateLimitedError);
  assert.deepEqual(fieldsOf(fake), fieldsOf(real));
});

test("an http error is the error the client throws on a status other than 200", async () => {
  const real = await realError(async () => response(500, ""));
  const fake = httpError(500, "x");
  assert.ok(fake instanceof WebAPIHTTPError);
  assert.equal(fake.statusCode, 500);
  assert.equal(fieldsOf(fake) && (fieldsOf(real) as { class: string }).class, "WebAPIHTTPError");
});

test("an answer is a copy: changing it changes no later answer", async () => {
  const slack = new FakeSlack();
  const first = (await slack.auth.test()) as unknown as JsonObject;
  first.user_id = "changed";
  assert.equal(((await slack.auth.test()) as unknown as JsonObject).user_id, BOT);
});

// The normalisation of what reaches the funnel.

test("the recorded arguments drop the token and the empty fields", async () => {
  const slack = new FakeSlack();
  await slack.chat.postMessage({
    channel: CHANNEL,
    text: "hi",
    token: "xoxb-per-call",
    thread_ts: undefined,
    username: null as unknown as string,
  });
  assert.deepEqual(slack.apiCalls[0]?.args, { channel: CHANNEL, text: "hi" });
});

test("blocks and chunks given as JSON strings are kept as parsed values", async () => {
  const slack = new FakeSlack();
  await slack.apiCall("chat.postMessage", {
    channel: CHANNEL,
    text: "hi",
    blocks: JSON.stringify([{ type: "divider" }]),
  });
  await slack.apiCall("chat.appendStream", {
    channel: CHANNEL,
    ts: "1.1",
    chunks: JSON.stringify([{ type: "markdown_text", text: "[]" }]),
  });
  assert.deepEqual(slack.apiCalls[0]?.args.blocks, [{ type: "divider" }]);
  assert.deepEqual(slack.apiCalls[1]?.args.chunks, [{ type: "markdown_text", text: "[]" }]);
});

test("a text that looks like JSON is not parsed", async () => {
  const slack = new FakeSlack();
  await slack.chat.postMessage({ channel: CHANNEL, text: "[1, 2]" });
  assert.equal(slack.apiCalls[0]?.args.text, "[1, 2]");
});

test("the recorded call is a copy of what the caller passed", async () => {
  const slack = new FakeSlack();
  const blocks = [{ type: "divider" }];
  await slack.chat.postMessage({ channel: CHANNEL, text: "hi", blocks });
  blocks.push({ type: "divider" });
  assert.deepEqual(slack.apiCalls[0]?.args.blocks, [{ type: "divider" }]);
  assert.deepEqual(slack.messageBlocks(), [[{ type: "divider" }]]);
});

test("a value that is not JSON is refused instead of being kept as text", async () => {
  const slack = new FakeSlack();
  await assert.rejects(
    slack.apiCall("chat.postMessage", { channel: CHANNEL, text: "x", blocks: [new Date()] }),
    TypeError,
  );
});

// How the fake numbers, answers and refuses.

const START: JsonObject = {
  channel: CHANNEL,
  thread_ts: THREAD,
  recipient_team_id: "T000TEAM",
  recipient_user_id: "U000ALICE",
  chunks: [{ type: "markdown_text", text: "one" }],
};

test("an open stream refuses an edit and a delete, a closed one refuses an append and a stop", async () => {
  const slack = new FakeSlack();
  await slack.apiCall("chat.startStream", START);
  const ts = "1790000000.000001";
  const refusal = async (call: Promise<unknown>) =>
    call.then(
      () => null,
      (error: unknown) => (error as WebAPIPlatformError).data.error,
    );
  assert.equal(
    await refusal(slack.chat.update({ channel: CHANNEL, ts, text: "x" })),
    "streaming_state_conflict",
  );
  assert.equal(await refusal(slack.chat.delete({ channel: CHANNEL, ts })), "cant_delete_message");
  await slack.chat.stopStream({ channel: CHANNEL, ts });
  assert.equal(
    await refusal(slack.chat.appendStream({ channel: CHANNEL, ts, chunks: [] })),
    "message_not_in_streaming_state",
  );
  assert.equal(
    await refusal(slack.chat.stopStream({ channel: CHANNEL, ts })),
    "message_not_in_streaming_state",
  );
  await slack.chat.update({ channel: CHANNEL, ts, text: "x" });
  assert.equal(slack.messages.get(ts)?.updated, true);
});

test("a stream that expires counts as stopped for the push and refuses an append", async () => {
  const slack = new FakeSlack();
  await slack.apiCall("chat.startStream", START);
  assert.equal(slack.pushes(), 0);
  slack.expire("1790000000.000001");
  assert.equal(slack.pushes(), 1);
  await assert.rejects(
    slack.chat.appendStream({ channel: CHANNEL, ts: "1790000000.000001", chunks: [] }),
    WebAPIPlatformError,
  );
});

test("a post is a push and an edit is not", async () => {
  const slack = new FakeSlack();
  await slack.chat.postMessage({ channel: CHANNEL, text: "a" });
  await slack.chat.update({
    channel: CHANNEL,
    ts: "1790000000.000001",
    text: "b",
    blocks: [{ type: "markdown", text: "b" }],
  });
  assert.equal(slack.pushes(), 1);
  assert.deepEqual(slack.messageTexts(), ["b"]);
  assert.equal(slack.messages.get("1790000000.000001")?.text, "b");
});

/** The text of each message as `conversations.replies` reads it back. */
async function repliesText(slack: FakeSlack): Promise<unknown[]> {
  const read = (await slack.conversations.replies({ channel: CHANNEL, ts: THREAD })) as unknown as {
    messages: JsonObject[];
  };
  return read.messages.map((message) => message.text);
}

test("a stream's text is read back as Slack reads it", async () => {
  const slack = new FakeSlack();
  await slack.apiCall("chat.startStream", {
    ...START,
    chunks: [
      { type: "markdown_text", text: "## Title\n\n**bold** and [a link](https://example.org)\n" },
      { type: "markdown_text", text: "- one\n* two\n" },
      { type: "task_update", id: "t1", title: "Bash: ls", status: "in_progress" },
      { type: "task_update", id: "t1", title: "Bash: ls", status: "complete", output: "ok" },
      { type: "task_update", id: "t1", title: "Bash: ls", status: "complete", output: "!" },
    ],
  });
  assert.deepEqual(slack.messageTexts(), [
    "## Title\n\n**bold** and [a link](https://example.org)\n- one\n* two",
  ]);
  assert.deepEqual(await repliesText(slack), [
    "Title\n\n*bold* and <https://example.org|a link>\n• one\n• two Bash: ls",
  ]);
  assert.deepEqual(slack.messageCards(), [
    [{ id: "t1", title: "Bash: ls", status: "complete", output: "ok!" }],
  ]);
});

test("a stream's text carries the title, subtitle and body of each container", async () => {
  const slack = new FakeSlack();
  await slack.apiCall("chat.startStream", {
    ...START,
    chunks: [
      { type: "markdown_text", text: "x" },
      {
        type: "blocks",
        blocks: [
          {
            type: "container",
            title: { type: "plain_text", text: "Edit" },
            subtitle: { type: "plain_text", text: "1 line" },
            child_blocks: [
              {
                type: "rich_text",
                elements: [
                  { type: "rich_text_preformatted", elements: [{ type: "text", text: "diff" }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(await repliesText(slack), ["x Edit 1 line ```diff```"]);
});

test("a task card read from a block is its rich text as plain strings", async () => {
  const slack = new FakeSlack();
  await slack.chat.postMessage({
    channel: CHANNEL,
    text: "t",
    blocks: [
      {
        type: "task_card",
        task_id: "t9",
        title: "Read",
        status: "complete",
        details: {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(slack.messageCards(), [
    [{ id: "t9", title: "Read", status: "complete", details: "ab" }],
  ]);
});

test("the thread read back holds the messages newer than oldest, deleted ones gone", async () => {
  const slack = new FakeSlack();
  await slack.chat.postMessage({ channel: CHANNEL, text: "a" });
  await slack.apiCall("chat.startStream", START);
  await slack.chat.postMessage({ channel: CHANNEL, text: "gone" });
  await slack.chat.delete({ channel: CHANNEL, ts: "1790000000.000003" });
  const all = (await slack.conversations.replies({ channel: CHANNEL, ts: THREAD })) as unknown as {
    messages: JsonObject[];
  };
  assert.deepEqual(
    all.messages.map((m) => [m.ts, m.user, m.text, m.streaming_state]),
    [
      ["1790000000.000001", BOT, "a", undefined],
      ["1790000000.000002", BOT, "one", "in_progress"],
    ],
  );
  const later = (await slack.conversations.replies({
    channel: CHANNEL,
    ts: THREAD,
    oldest: "1790000000.000001",
  })) as unknown as { messages: JsonObject[] };
  assert.deepEqual(
    later.messages.map((m) => m.ts),
    ["1790000000.000002"],
  );
});

// How a test scripts and holds a call.

test("a delay holds each call before it is recorded", async () => {
  const slack = new FakeSlack();
  slack.delay = 0.02;
  const call = slack.auth.test();
  assert.deepEqual(slack.apiCalls, []);
  await call;
  assert.equal(slack.apiCalls.length, 1);
});

test("a slow answer after apply has applied the call when it comes back", async () => {
  const slack = new SlowAfterApply();
  slack.slowMethod = "chat.postMessage";
  slack.slowFor = 0.02;
  const call = slack.chat.postMessage({ channel: CHANNEL, text: "a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(slack.postedTs, ["1790000000.000001"]);
  await call;
});

// The clock.

test("advance wakes the sleepers that are due in the order they began to sleep", async () => {
  const clock = new FakeClock();
  const woke: string[] = [];
  const late = clock.sleep(10).then(() => woke.push("began first, due later"));
  const early = clock.sleep(1).then(() => woke.push("began second, due sooner"));
  const pending = clock.sleep(100).then(() => woke.push("not due"));
  await clock.advance(10);
  await Promise.all([late, early]);
  assert.deepEqual(woke, ["began first, due later", "began second, due sooner"]);
  void pending;
});

test("a sleep that is aborted rejects and is not woken later", async () => {
  const clock = new FakeClock();
  const abort = new AbortController();
  const sleeping = clock.sleep(5, abort.signal);
  abort.abort(new Error("cancelled"));
  await assert.rejects(sleeping, /cancelled/);
  await clock.advance(10);
  await assert.rejects(clock.sleep(1, abort.signal), /cancelled/);
});

// The blocks of a stopped stream, read back. The recording of a stopped stream
// (api-conversations-replies-stream, 2026-09-29) is the expectation; the text each of its plain
// runs was streamed as is read from the recording's own `text` field, which keeps the blank lines.
async function readBlocks(slack: FakeSlack, ts: string): Promise<JsonObject[]> {
  const read = (await slack.conversations.replies({ channel: CHANNEL, ts })) as unknown as {
    messages: { ts: string; blocks: JsonObject[] }[];
  };
  const found = read.messages.find((message) => message.ts === ts);
  assert.ok(found);
  return found.blocks;
}

/** A block without its `block_id`, which Slack picks at random. */
function withoutId(block: JsonObject | undefined): JsonObject {
  assert.ok(block);
  const { block_id, ...rest } = block;
  assert.equal(typeof block_id, "string");
  return rest;
}

test("a stopped stream of plain words reads back the blocks the recording shows", async () => {
  const recorded = slackPayload("api-conversations-replies-stream").messages as {
    text: string;
    blocks: JsonObject[];
  }[];
  const blocks = recorded[0]?.blocks ?? [];
  const runs: [string, JsonObject | undefined][] = [
    ["Let me look at the repository.\n\n", blocks[0]],
    ["Done.", blocks.at(-1)],
  ];
  for (const [streamed, expected] of runs) {
    assert.ok(recorded[0]?.text.includes(streamed.trim()));
    const slack = new FakeSlack();
    await slack.apiCall("chat.startStream", {
      ...START,
      chunks: [{ type: "markdown_text", text: streamed.slice(0, 5) }],
    });
    const ts = "1790000000.000001";
    await slack.chat.appendStream({
      channel: CHANNEL,
      ts,
      chunks: [{ type: "markdown_text", text: streamed.slice(5) }],
    });
    // open: nothing is recorded for it, so none are returned
    assert.deepEqual(await readBlocks(slack, ts), []);
    await slack.chat.stopStream({ channel: CHANNEL, ts });
    assert.deepEqual(withoutId((await readBlocks(slack, ts))[0]), withoutId(expected));
    assert.equal((await readBlocks(slack, ts)).length, 1);
  }
});

test("a stream that expired reads back its blocks like one that was stopped", async () => {
  const slack = new FakeSlack();
  await slack.apiCall("chat.startStream", START);
  slack.expire("1790000000.000001");
  assert.equal((await readBlocks(slack, "1790000000.000001")).length, 1);
});
