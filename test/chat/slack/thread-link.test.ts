/**
 * `SlackThread.link`: the permalink of the thread, labelled for the markup it stands in.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import { logger } from "../../../src/chat/slack/thread.ts";
import { CHANNEL, rejected, THREAD } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

const PERMALINK = "https://example.slack.com/archives/C000CHAN/p1780000000000001";

test("a notice link is mrkdwn, a reference link is Markdown", async () => {
  const { slack, thread } = madeChat();
  assert.equal(await thread.link("Session", "notice"), `<${PERMALINK}|Session>`);
  assert.equal(await thread.link("Session", "reference"), `[Session](${PERMALINK})`);
  assert.deepEqual(slack.callsTo("chat.getPermalink"), [
    { channel: CHANNEL, message_ts: THREAD },
    { channel: CHANNEL, message_ts: THREAD },
  ]);
});

test("the label is written as the caller gave it", async () => {
  const { thread } = madeChat();
  assert.equal(await thread.link("a [b] <c>", "reference"), `[a [b] <c>](${PERMALINK})`);
});

test("a permalink that cannot be read is null and logged by its code", async (t) => {
  const { slack, thread } = madeChat();
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  slack.responses["chat.getPermalink"] = rejected("message_not_found");
  assert.equal(await thread.link("Session", "notice"), null);
  assert.deepEqual(warnings, [
    `could not get a permalink for ${CHANNEL}/${THREAD}: message_not_found`,
  ]);
});

test("an answer with no permalink is null", async () => {
  const { slack, thread } = madeChat();
  slack.responses["chat.getPermalink"] = { ok: true };
  assert.equal(await thread.link("Session", "reference"), null);
});
