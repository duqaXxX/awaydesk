/**
 * Invariant 3, "no message content in logs", from the Slack listener to the reply written back.
 * A mutation run of 2026-10-11 made the message listener of `buildApp` log `message.text`, and
 * no test failed: the claim rested on a reading of the logging calls.
 *
 * Every line the daemon writes is captured at the lowest level, while the owner's text travels
 * the paths below, and none may hold it. The markers are strings no code of the daemon produces.
 *
 * Covered: a prompt at top level, its reply (the agent's text, streamed and final), a prompt in
 * the thread, a message from someone else, `!bind` with a path, `!help` with a filter, and the
 * free text of a question's form. Not covered: the text of a file or a clip the owner attaches,
 * the Home tab's search box, `!resume`, `!open`, and a failure's own wording (a line that quotes
 * an error message is the error's, which `errorName` keeps out of the log by design).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { setLevel, setWriter } from "../../../../src/log.ts";
import { CHANNEL, OTHER_THREAD, STRANGER, THREAD } from "../../../support/fake-slack.ts";
import { type Item, sdkMessages } from "../../../support/sessions.ts";
import {
  type Body,
  FORM_THREAD,
  message,
  onReviewPage,
  QUESTIONS,
  reply,
  submitOn,
  worldOf,
} from "../../../support/slack-app.ts";

const PROMPT = "mk-prompt-7f3a91";
const ANSWER = "mk-reply-c42e08";
const IN_THREAD = "mk-thread-90d1b6";
const STRANGERS = "mk-stranger-5e27ad";
const FOLDER = "mk-folder-31ab84";
const FILTER = "mk-filter-a8c0f2";
const OTHER = "mk-other-62de19";
const MARKERS = [PROMPT, ANSWER, IN_THREAD, STRANGERS, FOLDER, FILTER, OTHER];

/** The recorded `tools` turn with the agent's closing text replaced by `text`, in every record that carries it. */
function turnSaying(text: string): Item[] {
  let streamed = false;
  return sdkMessages("tools").map((item): Item => {
    if (!("record" in item)) return item;
    const record = structuredClone(item.record) as Body;
    const delta = record.event?.delta;
    if (record.type === "stream_event" && delta?.type === "text_delta") {
      delta.text = streamed ? "" : text;
      streamed = true;
    }
    if (record.type === "assistant") {
      for (const block of record.message.content) if (block.type === "text") block.text = text;
    }
    if (record.type === "result") record.result = text;
    return { record };
  });
}

test("no log line at any level holds a prompt, a reply or an owner's word", async (t) => {
  const world = worldOf(t);
  // `worldOf` restores the writer it replaced when the test ends; the level is the file's own.
  const lines: string[] = [];
  setWriter((line) => lines.push(line));
  setLevel("DEBUG");
  t.after(() => setLevel("INFO"));

  await world.dispatch(message(`please read ${PROMPT}`, { ts: THREAD }));
  world.clients[0]?.answer(turnSaying(ANSWER));
  await world.until(() => JSON.stringify(world.slack.apiCalls).includes(ANSWER));
  await world.idle();
  // The text really travelled: the agent was sent the prompt and Slack was sent the reply.
  assert.deepEqual(world.queries(), [`please read ${PROMPT}`]);
  assert.ok(JSON.stringify(world.slack.apiCalls).includes(ANSWER));

  await world.dispatch(reply(`and then ${IN_THREAD}`, THREAD));
  await world.dispatch(message(`let me in ${STRANGERS}`, { user: STRANGER, ts: OTHER_THREAD }));
  await world.dispatch(message(`!bind ${join(world.root, FOLDER)}`));
  await world.dispatch(message(`!help ${FILTER}`));

  const [approvalId, pending] = world.approvals.open(CHANNEL, FORM_THREAD, "Colour", QUESTIONS);
  const values = {
    q1: {
      answer: { type: "checkboxes", selected_options: [{ value: "0" }, { value: "other" }] },
    },
    o1: { other: { type: "plain_text_input", value: OTHER } },
  };
  const review = await onReviewPage(world, approvalId, "1", values);
  await world.dispatch(submitOn(review, {}));
  assert.ok(pending.decided); // fails here, not at the 300 s timeout, when the form is not read
  assert.deepEqual(await pending.decision, {
    answered: true,
    answers: { "Colour?": "blue", "Sizes?": ["s", OTHER] },
    notes: {},
  });
  await world.idle();

  // The capture works: the daemon logs the setup it accepted and the stranger it ignored.
  assert.ok(lines.length > 0);
  for (const line of lines) {
    for (const marker of MARKERS)
      assert.ok(!line.includes(marker), `a log line holds ${marker}: ${line}`);
  }
});
