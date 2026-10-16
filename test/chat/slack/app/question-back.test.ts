/**
 * The way back in the question form and its review page (issue #325). The terminal keeps a
 * question's answer when the owner returns to its tab, and ends a form of several questions on
 * `Review your answers`. Back is a button of the form: its block_actions payload and the
 * `views.update` it answers follow the references read 2026-10-16 (block_actions payload of a
 * modal, `views.update` with `hash`); `formAction` builds the payload, `ModalSlack` is Slack's
 * side of the modal. Next and Review answer the submission with `response_action: update`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "../../../../src/agent/seam.ts";
import { QUESTION_BACK } from "../../../../src/chat/slack/requests.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import { AsyncEvent, CHANNEL, rejected, STRANGER } from "../../../support/fake-slack.ts";
import {
  answerClick,
  type Body,
  FORM_THREAD,
  formAction,
  ModalSlack,
  QUESTIONS,
  submitOn,
  worldOf,
} from "../../../support/slack-app.ts";

const SHAPE: Question = {
  text: "Shape?",
  header: "Shape",
  options: [
    { label: "round", description: null, preview: null },
    { label: "square", description: null, preview: null },
  ],
  multiSelect: false,
};
const THREE: readonly Question[] = [...QUESTIONS, SHAPE];

const radio = (block: string, value: string): Body => ({
  [block]: { answer: { type: "radio_buttons", selected_option: { value } } },
});
const boxes = (block: string, ...values: string[]): Body => ({
  [block]: {
    answer: { type: "checkboxes", selected_options: values.map((value) => ({ value })) },
  },
});
const typed = (block: string, value: string): Body => ({
  [block]: { other: { type: "plain_text_input", value } },
});
const noted = (block: string, value: string): Body => ({
  [block]: { notes: { type: "plain_text_input", value } },
});

/** A world whose form for `questions` is open on screen, as Answer opens it. */
async function openForm(t: Parameters<typeof worldOf>[0], questions: readonly Question[]) {
  const world = worldOf(t);
  const [approvalId, pending] = world.approvals.open(CHANNEL, FORM_THREAD, "Colour", questions);
  const modal = new ModalSlack(world.slack);
  await world.dispatch(answerClick(approvalId));
  return { world, modal, pending, approvalId };
}

type Open = Awaited<ReturnType<typeof openForm>>;

/** Next or Review with these values on the form on screen: the view Slack is told to show. */
async function forward(o: Open, values: Body): Promise<Body> {
  const response = await o.world.dispatch(submitOn(o.modal.view, values));
  const body = response.body as Body;
  assert.equal(body.response_action, "update", JSON.stringify(body));
  o.modal.view = body.view as Body;
  return o.modal.view;
}

/** The Back click on the form `view` (the one on screen unless said), with these values. */
function backClick(o: Open, values: Body, view: Body = o.modal.view): Body {
  return formAction(
    view,
    values,
    { id: QUESTION_BACK, block: "back", type: "button" },
    { hash: o.modal.hash },
  );
}

const inputs = (view: Body): Body[] =>
  (view.blocks as Body[]).filter((block) => block.type === "input");
const tabs = (view: Body): string => (view.blocks as Body[])[0]?.elements[0].text;

test("Back keeps the answers of both pages, Other, Notes and a multi-select included", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, { ...radio("q0", "1"), ...noted("n0", "darker") });
  // Nothing was reported live on page two: Back itself carries what is typed there.
  const state = { ...boxes("q1", "0", "1"), ...typed("o1", "xl"), ...noted("n1", "both") };
  await o.world.dispatch(backClick(o, state));
  assert.equal(o.modal.written.length, 1);
  const first = inputs(o.modal.view);
  assert.equal(first[0]?.element.initial_option.value, "1");
  assert.equal(first[2]?.element.initial_value, "darker");
  assert.equal(tabs(o.modal.view), "*☒ Colour*   ☒ Sizes   ✔ Submit");
  // Forward again: page two shows what it had when Back was clicked.
  const second = await forward(o, radio("q0", "1"));
  const again = inputs(second);
  assert.deepEqual(
    again[0]?.element.initial_options.map((option: Body) => option.value),
    ["0", "1"],
  );
  assert.equal(again[1]?.element.initial_value, "xl");
  assert.equal(again[2]?.element.initial_value, "both");
});

test("Back updates the view the click came from, with its hash", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const shown = o.modal.hash;
  await o.world.dispatch(backClick(o, boxes("q1", "0")));
  const [hash, view] = o.modal.calls[0] as [string, Body];
  assert.equal(hash, shown);
  assert.equal(JSON.parse(view.private_metadata as string).n, 0);
  assert.ok((view.blocks as Body[]).every((block) => block.type !== "actions"));
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 0);
});

test("Back never validates: a page left empty is left", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  await o.world.dispatch(backClick(o, noted("n1", "only notes")));
  assert.equal(o.modal.written.length, 1);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.notes.get(1), "only notes");
});

test("Next moves on even when every question already has an answer", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  await o.world.dispatch(backClick(o, boxes("q1", "1")));
  // Both questions are answered now; Next on the first page still goes to the second.
  const second = await forward(o, radio("q0", "0"));
  assert.equal(JSON.parse(second.private_metadata as string).n, 1);
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("the last question's Review opens the review page and sends nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "1"));
  const review = await forward(o, { ...boxes("q1", "0", "1"), ...typed("o1", "xl") });
  await o.world.idle();
  assert.ok(!o.pending.decided);
  assert.equal(JSON.parse(review.private_metadata as string).n, 2);
  assert.equal(review.submit.text, "Submit answers");
  assert.equal(tabs(review), "☒ Colour   ☒ Sizes   *✔ Submit*");
  const texts = (review.blocks as Body[]).slice(1).map((block) => block.text?.text);
  assert.deepEqual(texts.slice(0, 3), [
    "*Review your answers*",
    "● Colour?\n→ blue",
    "● Sizes?\n→ s, l, xl",
  ]);
});

test("only Submit answers on the review page sends", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "1"));
  await forward(o, boxes("q1", "0"));
  const response = await o.world.dispatch(submitOn(o.modal.view, {}));
  assert.equal(response.body, null);
  await o.world.idle();
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "blue", "Sizes?": ["s"] },
    notes: {},
  });
  assert.equal(o.world.built.drafts.size, 0);
});

test("Back from the review page returns to the last question with its answer", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  await forward(o, boxes("q1", "1"));
  await forward(o, radio("q2", "1"));
  assert.equal(tabs(o.modal.view), "☒ Colour   ☒ Sizes   ☒ Shape   *✔ Submit*");
  await o.world.dispatch(backClick(o, {}));
  const last = o.modal.view;
  assert.equal(JSON.parse(last.private_metadata as string).n, 2);
  assert.equal(inputs(last)[0]?.element.initial_option.value, "1");
  assert.equal(last.submit.text, "Review");
  assert.equal((last.blocks as Body[]).at(-1)?.elements[0].text.text, "← Sizes");
});

test("going back from the third question to the first, a change shows in the review", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  await forward(o, boxes("q1", "1"));
  await o.world.dispatch(backClick(o, radio("q2", "0")));
  await o.world.dispatch(backClick(o, boxes("q1", "1")));
  assert.equal(JSON.parse(o.modal.view.private_metadata as string).n, 0);
  await forward(o, radio("q0", "1")); // red becomes blue
  await forward(o, boxes("q1", "1"));
  const review = await forward(o, radio("q2", "0"));
  assert.equal((review.blocks as Body[])[2]?.text.text, "● Colour?\n→ blue");
  await o.world.dispatch(submitOn(review, {}));
  await o.world.idle();
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "blue", "Sizes?": ["l"], "Shape?": "round" },
    notes: {},
  });
});

test("one question: Submit sends, with no tabs, no review and no Back", async (t) => {
  const o = await openForm(t, [QUESTIONS[0] as Question]);
  const view = o.modal.view;
  assert.equal(view.submit.text, "Submit");
  assert.ok((view.blocks as Body[]).every((block) => block.type === "input"));
  await o.world.dispatch(submitOn(view, radio("q0", "0")));
  await o.world.idle();
  assert.ok(o.pending.decided);
});

test("a stranger's Back does nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const body = backClick(o, boxes("q1", "0"));
  Object.assign(body.user, { id: STRANGER });
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 1);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.picks.has(1), false);
});

test("a Back from another workspace does nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const body = backClick(o, boxes("q1", "0"));
  body.user.team_id = "T000OTHER";
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
});

test("Back from an older form is ignored", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const older = o.modal.view;
  await o.world.dispatch(answerClick(o.approvalId)); // Answer again: a newer form, same page
  const before = o.modal.calls.length;
  await o.world.dispatch(backClick(o, boxes("q1", "0"), older));
  assert.equal(o.modal.calls.length, before);
  const kept = o.world.built.drafts.get(o.approvalId);
  assert.equal(kept?.active, 1);
  assert.equal(kept?.picks.has(1), false); // nothing from the older form was written
});

test("Back from a page the draft has left is ignored", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  const second = o.modal.view;
  await forward(o, boxes("q1", "0"));
  const before = o.modal.calls.length;
  await o.world.dispatch(backClick(o, boxes("q1", "1"), second));
  assert.equal(o.modal.calls.length, before);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 2);
});

test("a Back whose request is gone does nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  o.world.approvals.giveUp(o.approvalId);
  await o.world.dispatch(backClick(o, boxes("q1", "0")));
  assert.deepEqual(o.modal.calls, []);
  assert.equal(o.world.built.drafts.size, 0);
});

test("a Back that meets a hash_conflict is dropped and the page stays the draft's", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const body = backClick(o, boxes("q1", "1"));
  body.view.hash = "1790000000.stale";
  await o.world.dispatch(body);
  assert.equal(o.modal.calls.length, 1);
  assert.deepEqual(o.modal.written, []);
  const kept = o.world.built.drafts.get(o.approvalId);
  assert.equal(kept?.active, 1); // the screen still shows page two
  assert.deepEqual(kept?.picks.get(1), [1]); // and what it held is kept
  o.world.slack.responses["views.update"] = rejected("not_found");
  await o.world.dispatch(backClick(o, boxes("q1", "1")));
  assert.deepEqual(o.world.ephemerals(), []);
});

test("a refused Back does not undo a Next that moved the draft on meanwhile", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  const second = o.modal.view;
  const gate = new AsyncEvent();
  o.world.slack.gate = gate;
  o.world.slack.gateMethod = "views.update";
  o.world.slack.responses["views.update"] = rejected("hash_conflict");
  await o.world.dispatch(backClick(o, boxes("q1", "0"))); // held in Slack's call
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 0);
  // Next from the same page is accepted while the update is held: the draft moves on.
  const next = await o.world.dispatch(submitOn(second, boxes("q1", "0")));
  assert.equal((next.body as Body).response_action, "update");
  gate.set();
  await o.world.idle();
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 2);
});

test("an older form's Submit answers is stale and sends nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const review = await forward(o, boxes("q1", "0"));
  await o.world.dispatch(answerClick(o.approvalId));
  const response = await o.world.dispatch(submitOn(review, {}));
  const body = response.body as Body;
  assert.equal(body.response_action, "update");
  assert.ok(JSON.stringify(body.view).includes(slackTexts.QUESTION_STALE));
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("a stranger's Submit answers sends nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const review = await forward(o, boxes("q1", "0"));
  await o.world.dispatch(submitOn(review, {}, { id: STRANGER }));
  await o.world.idle();
  assert.ok(!o.pending.decided);
});
