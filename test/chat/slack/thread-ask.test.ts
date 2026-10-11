/**
 * `SlackThread.ask` for the two requests the core's own flows put: the same-folder hold and a
 * session's setup. A permission and a question are in `thread.test.ts`.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ModelInfo } from "../../../src/agent/seam.ts";
import { ChatError, type HoldRequest, type SetupRequest } from "../../../src/chat/seam.ts";
import { holdBlocks } from "../../../src/chat/slack/hold.ts";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import { SETUP_EFFORT, SETUP_START, setupBlocks } from "../../../src/chat/slack/setup.ts";
import { CHANNEL, OTHER_THREAD, rejected, THREAD } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

// biome-ignore lint/suspicious/noExplicitAny: a Slack payload read in a test
type Json = Record<string, any>;

const HOLD: HoldRequest = {
  type: "hold",
  requestId: "hold-1",
  other: { channel: CHANNEL, thread: OTHER_THREAD },
  link: "<https://example.slack.com/archives/C000CHAN/p1780000000000002|Session>",
};

const MODELS: readonly ModelInfo[] = [
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: null,
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
];

const SETUP: SetupRequest = {
  type: "setup",
  requestId: "setup-1",
  models: MODELS,
  efforts: [],
  bypassOffered: true,
  selection: { model: "sonnet", effort: "high", bypass: false },
};

test("a hold is posted in the thread with its two buttons and answers with its ts", async () => {
  const { slack, thread } = madeChat();
  const ts = await thread.ask("hold-1", HOLD, "Another session is working here");
  const [post, ...more] = slack.callsTo("chat.postMessage");
  assert.equal(more.length, 0);
  assert.deepEqual(post, {
    channel: CHANNEL,
    thread_ts: THREAD,
    text: "Another session is working here",
    blocks: holdBlocks("hold-1", HOLD.link),
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.equal(ts, slack.postedTs.at(-1));
});

test("a setup is posted in the thread with its controls and answers with its ts", async () => {
  const { slack, thread } = madeChat();
  const ts = await thread.ask("setup-1", SETUP, "Set up this session");
  const [post, ...more] = slack.callsTo("chat.postMessage");
  assert.equal(more.length, 0);
  assert.deepEqual(post, {
    channel: CHANNEL,
    thread_ts: THREAD,
    text: "Set up this session",
    blocks: setupBlocks("setup-1", SETUP, SETUP.selection),
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.equal(ts, slack.postedTs.at(-1));
});

test("a setup is drawn as its request says: no Bypass checkbox and the agent's efforts", async () => {
  const { slack, thread } = madeChat();
  const request: SetupRequest = {
    ...SETUP,
    models: [],
    efforts: ["brief", "full"],
    bypassOffered: false,
    selection: { model: "default", effort: "default", bypass: false },
  };
  await thread.ask("setup-1", request, "Set up this session");
  const blocks = slack.callsTo("chat.postMessage").at(-1)?.blocks as Json[];
  const actions = blocks.find((block) => block.type === "actions") as Json;
  const ids = (actions.elements as Json[]).map((element) => element.action_id);
  assert.deepEqual(ids, [SETUP_EFFORT, SETUP_START]);
  const efforts = (actions.elements as Json[])[0]?.options as Json[];
  assert.deepEqual(
    efforts.map((option) => option.value),
    ["default", "brief", "full"],
  );
});

test("a request Slack refuses rejects with a ChatError named by its code", async () => {
  const { slack, thread } = madeChat();
  slack.responses["chat.postMessage"] = rejected("channel_not_found");
  await assert.rejects(
    thread.ask("hold-1", HOLD, "Another session is working here"),
    (error: unknown) => error instanceof ChatError && error.name === "channel_not_found",
  );
});
