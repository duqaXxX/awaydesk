/**
 * `SlackThread.endReply`: a reply a stop left unfinished is ended where it stands, with the
 * note as its last line. The longer cases (the block cap, a card left running) are in
 * `repair.test.ts`, which drives the same code through the core's repair.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import { CHANNEL } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

const MESSAGE = "1790000000.000001";
const NOTE = "stopped for a test";
const BODY = [{ type: "rich_text", block_id: "b0", elements: [] }];

test("endReply stops the stream, reads the message back and adds the note", async () => {
  const { slack, thread } = madeChat();
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: MESSAGE, blocks: BODY }],
  };
  await thread.endReply(MESSAGE, NOTE);
  assert.deepEqual(
    slack.apiCalls.map((call) => call.method),
    ["chat.stopStream", "conversations.replies", "chat.update"],
  );
  assert.deepEqual(slack.callsTo("chat.stopStream"), [{ channel: CHANNEL, ts: MESSAGE }]);
  assert.deepEqual(slack.callsTo("conversations.replies"), [
    { channel: CHANNEL, ts: MESSAGE, limit: 1 },
  ]);
  assert.deepEqual(slack.callsTo("chat.update"), [
    {
      channel: CHANNEL,
      ts: MESSAGE,
      text: NOTE,
      blocks: [...BODY, { type: "context", elements: [{ type: "mrkdwn", text: NOTE }] }],
    },
  ]);
});

test("endReply closes the cards left running as errors", async () => {
  const { slack, thread } = madeChat();
  const cards = ["pending", "in_progress", "complete"].map((status, i) => ({
    type: "task_card",
    task_id: `t${i}`,
    status,
  }));
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: MESSAGE, blocks: cards }],
  };
  await thread.endReply(MESSAGE, NOTE);
  const [update] = slack.callsTo("chat.update");
  assert.ok(update);
  assert.deepEqual(
    (update.blocks as Array<{ status?: string }>).slice(0, 3).map((block) => block.status),
    ["error", "error", "complete"],
  );
});

test("endReply never rejects and leaves a message that is gone alone", async () => {
  const { slack, thread } = madeChat();
  slack.responses["conversations.replies"] = { ok: true, messages: [] };
  await thread.endReply(MESSAGE, NOTE);
  assert.deepEqual(slack.callsTo("chat.update"), []);
  slack.responses["conversations.replies"] = new Error("network down");
  await thread.endReply(MESSAGE, NOTE);
  assert.deepEqual(slack.callsTo("chat.update"), []);
});
