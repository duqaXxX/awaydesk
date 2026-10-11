/**
 * `SlackThread.rewrite`: a message of the daemon's turned into a grey notice with nothing left
 * to press, an edit on the budget every reply draws from.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ChatError } from "../../../src/chat/seam.ts";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import { CHANNEL, rejected } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

const MESSAGE = "1780000000.000009";
const TEXT = "Set up: sonnet, high effort.";

test("rewrite replaces the message with a notice, after taking a token of the budget", async () => {
  const taken: number[] = [];
  const { slack, thread } = madeChat({
    limiter: {
      acquire: async () => {
        taken.push(slack.apiCalls.length);
      },
      refund: async () => {},
    },
  });
  await thread.rewrite(MESSAGE, TEXT);
  assert.deepEqual(taken, [0]);
  assert.deepEqual(slack.callsTo("chat.update"), [
    {
      channel: CHANNEL,
      ts: MESSAGE,
      text: TEXT,
      blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: TEXT }] }],
    },
  ]);
});

test("rewrite rejects with a ChatError named by Slack's code", async () => {
  const { slack, thread } = madeChat();
  slack.responses["chat.update"] = rejected("message_not_found");
  await assert.rejects(
    thread.rewrite(MESSAGE, TEXT),
    (error: unknown) => error instanceof ChatError && error.name === "message_not_found",
  );
});
