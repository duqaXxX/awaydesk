/**
 * `SlackThread.tell`: a line for the owner alone under their message, or with `stays` a post in
 * the thread. It never rejects, does nothing once the provider stopped, and tells the thread's
 * status line that the app wrote.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  resetStatusFlags,
  THREAD_STATUS_AFTER_WRITE_SECONDS,
} from "../../../src/chat/slack/reply/status.ts";
import { logger } from "../../../src/chat/slack/thread.ts";
import { CHANNEL, OWNER, rejected, THREAD } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

const TEXT = "That word needs a session: *bind* a folder first.";
const BLOCKS = [{ type: "context", elements: [{ type: "mrkdwn", text: TEXT }] }];

test("tell is a line only the owner sees, under the thread", async () => {
  const { slack, thread } = madeChat();
  await thread.tell(TEXT);
  assert.deepEqual(slack.callsTo("chat.postEphemeral"), [
    { channel: CHANNEL, user: OWNER, text: TEXT, blocks: BLOCKS, thread_ts: THREAD },
  ]);
  assert.deepEqual(slack.callsTo("chat.postMessage"), []);
});

test("tell with stays is a post in the thread", async () => {
  const { slack, thread } = madeChat();
  await thread.tell(TEXT, { stays: true });
  assert.deepEqual(slack.callsTo("chat.postMessage"), [
    {
      channel: CHANNEL,
      text: TEXT,
      blocks: BLOCKS,
      unfurl_links: false,
      unfurl_media: false,
      thread_ts: THREAD,
    },
  ]);
  assert.deepEqual(slack.callsTo("chat.postEphemeral"), []);
});

test("tell never rejects: a refusal is logged by its code", async (t) => {
  const { slack, thread } = madeChat();
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  slack.responses["chat.postEphemeral"] = rejected("channel_not_found");
  await thread.tell(TEXT);
  assert.deepEqual(warnings, [`could not reach the owner in ${CHANNEL}: channel_not_found`]);
});

test("tell does nothing once the provider stopped", async () => {
  const { slack, chat, thread } = madeChat();
  await chat.stop();
  await thread.tell(TEXT);
  await thread.tell(TEXT, { stays: true });
  assert.deepEqual(slack.apiCalls, []);
});

test("a tell clears the thread's status, which is set again", async () => {
  const { slack, clock, thread } = madeChat();
  thread.showActivity("Working…", "is working…");
  await clock.advance(0);
  await thread.tell(TEXT);
  await clock.advance(THREAD_STATUS_AFTER_WRITE_SECONDS);
  assert.equal(slack.callsTo("assistant.threads.setStatus").length, 2);
});
