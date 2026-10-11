/**
 * `SlackThread.acknowledge`: the check mark on a message of the owner's that took effect.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import { logger } from "../../../src/chat/slack/thread.ts";
import { CHANNEL, rejected, THREAD } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

const MESSAGE = "1780000000.000009";

test("acknowledge adds the check mark to the message", async () => {
  const { slack, thread } = madeChat();
  await thread.acknowledge(MESSAGE);
  assert.deepEqual(slack.callsTo("reactions.add"), [
    { channel: CHANNEL, name: "white_check_mark", timestamp: MESSAGE },
  ]);
  assert.notEqual(MESSAGE, THREAD);
});

test("acknowledge never rejects: a refusal is logged by its code", async (t) => {
  const { slack, thread } = madeChat();
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  slack.responses["reactions.add"] = rejected("already_reacted");
  await thread.acknowledge(MESSAGE);
  assert.deepEqual(warnings, [`could not react to a word in ${CHANNEL}: already_reacted`]);
});

test("acknowledge does nothing once the provider stopped", async () => {
  const { slack, chat, thread } = madeChat();
  await chat.stop();
  await thread.acknowledge(MESSAGE);
  assert.deepEqual(slack.apiCalls, []);
});
