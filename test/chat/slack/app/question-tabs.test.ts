/**
 * The tabs of the question form (issue #325): a row of buttons, one per question and a Submit
 * tab, that jump to a page with every answer kept, as the terminal's tab row does. A tab is a
 * button of the form: its block_actions payload and the `views.update` it answers follow the
 * references read 2026-10-16 (block_actions payload of a modal, `views.update` with `hash`);
 * `formAction` builds the payload, `ModalSlack` is Slack's side of the modal. Next and Review
 * answer the submission with `response_action: update`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "../../../../src/agent/seam.ts";
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

/** A tab click: the tab for `target` (the question count is Submit) on the form `view`. */
function tabClick(o: Open, target: number, values: Body, view: Body = o.modal.view): Body {
  return formAction(
    view,
    values,
    { id: `question_tab_${target}`, block: "tabs", type: "button" },
    { hash: o.modal.hash },
  );
}

const inputs = (view: Body): Body[] =>
  (view.blocks as Body[]).filter((block) => block.type === "input");
/** The tab row as text: the primary button in brackets. */
const tabs = (view: Body): string =>
  (((view.blocks as Body[])[0] as Body).elements as Body[])
    .map((b) => (b.style === "primary" ? `[${b.text.text}]` : b.text.text))
    .join(" | ");
const pageOf = (view: Body): number => JSON.parse(view.private_metadata as string).n;

test("a tab keeps the answers of both pages, Other, Notes and a multi-select included", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, { ...radio("q0", "1"), ...noted("n0", "darker") });
  // Nothing was reported live on page two: the click itself carries what is typed there.
  const state = { ...boxes("q1", "0", "other"), ...typed("o1", "xl"), ...noted("n1", "both") };
  await o.world.dispatch(tabClick(o, 0, state));
  assert.equal(o.modal.written.length, 1);
  const first = inputs(o.modal.view);
  assert.equal(first[0]?.element.initial_option.value, "1");
  assert.equal(first[1]?.element.initial_value, "darker");
  assert.equal(tabs(o.modal.view), "[☒ Colour] | ☒ Sizes | ✔ Submit");
  // Forward again: page two shows what it had when the tab was clicked.
  const second = await forward(o, radio("q0", "1"));
  const again = inputs(second);
  assert.deepEqual(
    again[0]?.element.initial_options.map((option: Body) => option.value),
    ["0", "other"],
  );
  assert.equal(again[1]?.element.initial_value, "xl");
  assert.equal(again[2]?.element.initial_value, "both");
});

test("a tab updates the view the click came from, with its hash", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const shown = o.modal.hash;
  await o.world.dispatch(tabClick(o, 0, boxes("q1", "0")));
  const [hash, view] = o.modal.calls[0] as [string, Body];
  assert.equal(hash, shown);
  assert.equal(pageOf(view), 0);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 0);
});

test("a tab goes to any page, forward too, and never validates the page it leaves", async (t) => {
  const o = await openForm(t, THREE);
  // Page one is left with nothing chosen and a note alone: no error, the page changes.
  await o.world.dispatch(tabClick(o, 2, noted("n0", "only notes")));
  assert.equal(pageOf(o.modal.view), 2);
  assert.equal(o.modal.written.length, 1);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.notes.get(0), "only notes");
  assert.equal(tabs(o.modal.view), "☐ Colour | ☐ Sizes | [☐ Shape] | ✔ Submit");
});

test("the tab of the page on screen does nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const before = o.world.built.drafts.get(o.approvalId);
  await o.world.dispatch(tabClick(o, 1, boxes("q1", "1")));
  assert.deepEqual(o.modal.calls, []);
  assert.equal(o.world.built.drafts.get(o.approvalId), before);
});

test("the Submit tab opens the review page when every question has an answer", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "1"));
  await o.world.dispatch(tabClick(o, 2, boxes("q1", "0")));
  assert.equal(pageOf(o.modal.view), 2);
  assert.equal(o.modal.view.submit.text, "Submit answers");
  assert.equal(tabs(o.modal.view), "☒ Colour | ☒ Sizes | [✔ Submit]");
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("the Submit tab goes to the first question with no answer, with no error text", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  await o.world.dispatch(tabClick(o, 2, {})); // page two is left empty
  await o.world.dispatch(tabClick(o, 3, radio("q2", "0")));
  assert.equal(pageOf(o.modal.view), 1);
  assert.ok(!JSON.stringify(o.modal.view).includes(slackTexts.QUESTION_MISSING));
  assert.equal(tabs(o.modal.view), "☒ Colour | [☐ Sizes] | ☒ Shape | ✔ Submit");
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("the Submit tab on a page that is itself the first gap changes nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await o.world.dispatch(tabClick(o, 2, {}));
  assert.deepEqual(o.modal.calls, []);
  assert.equal(pageOf(o.modal.view), 0);
});

test("Next moves on even when every question already has an answer", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  await o.world.dispatch(tabClick(o, 0, boxes("q1", "1")));
  // Both questions are answered now; Next on the first page still goes to the second.
  const second = await forward(o, radio("q0", "0"));
  assert.equal(pageOf(second), 1);
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("the last question's Review opens the review page and sends nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "1"));
  const review = await forward(o, { ...boxes("q1", "0", "other"), ...typed("o1", "xl") });
  await o.world.idle();
  assert.ok(!o.pending.decided);
  assert.equal(pageOf(review), 2);
  assert.equal(review.submit.text, "Submit answers");
  assert.equal(tabs(review), "☒ Colour | ☒ Sizes | [✔ Submit]");
  const texts = (review.blocks as Body[]).slice(1).map((block) => block.text?.text);
  assert.deepEqual(texts.slice(0, 3), [
    "*Review your answers*",
    "● Colour?\n→ blue",
    "● Sizes?\n→ s, xl",
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

test("a tab from the review page returns to that question with its answer", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  await forward(o, boxes("q1", "1"));
  await forward(o, radio("q2", "1"));
  assert.equal(tabs(o.modal.view), "☒ Colour | ☒ Sizes | ☒ Shape | [✔ Submit]");
  await o.world.dispatch(tabClick(o, 2, {}));
  const last = o.modal.view;
  assert.equal(pageOf(last), 2);
  assert.equal(inputs(last)[0]?.element.initial_option.value, "1");
  assert.equal(last.submit.text, "Review");
});

test("jumping from the third question to the first, a change shows in the review", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  await forward(o, boxes("q1", "1"));
  await o.world.dispatch(tabClick(o, 0, radio("q2", "0")));
  assert.equal(pageOf(o.modal.view), 0);
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

test("one question: Submit sends, with no tabs, no review and no Previous", async (t) => {
  const o = await openForm(t, [QUESTIONS[0] as Question]);
  const view = o.modal.view;
  assert.equal(view.submit.text, "Submit");
  assert.ok((view.blocks as Body[]).every((block) => block.type === "input"));
  await o.world.dispatch(submitOn(view, radio("q0", "0")));
  await o.world.idle();
  assert.ok(o.pending.decided);
});

test("a stranger's tab does nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const body = tabClick(o, 0, boxes("q1", "0"));
  Object.assign(body.user, { id: STRANGER });
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 1);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.picks.has(1), false);
});

test("a tab from another workspace does nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const body = tabClick(o, 0, boxes("q1", "0"));
  body.user.team_id = "T000OTHER";
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
});

test("a tab of an older form is ignored", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const older = o.modal.view;
  await o.world.dispatch(answerClick(o.approvalId)); // Answer again: a newer form, same page
  const before = o.modal.calls.length;
  await o.world.dispatch(tabClick(o, 0, boxes("q1", "0"), older));
  assert.equal(o.modal.calls.length, before);
  const kept = o.world.built.drafts.get(o.approvalId);
  assert.equal(kept?.active, 1);
  assert.equal(kept?.picks.has(1), false); // nothing from the older form was written
});

test("a tab from a page the draft has left is ignored", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  const second = o.modal.view;
  await forward(o, boxes("q1", "0"));
  const before = o.modal.calls.length;
  await o.world.dispatch(tabClick(o, 0, boxes("q1", "1"), second));
  assert.equal(o.modal.calls.length, before);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 2);
});

test("a tab whose request is gone does nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  o.world.approvals.giveUp(o.approvalId);
  await o.world.dispatch(tabClick(o, 0, boxes("q1", "0")));
  assert.deepEqual(o.modal.calls, []);
  assert.equal(o.world.built.drafts.size, 0);
});

test("a tab that meets a hash_conflict is dropped and the page stays the draft's", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "0"));
  const body = tabClick(o, 0, boxes("q1", "1"));
  body.view.hash = "1790000000.stale";
  await o.world.dispatch(body);
  assert.equal(o.modal.calls.length, 1);
  assert.deepEqual(o.modal.written, []);
  const kept = o.world.built.drafts.get(o.approvalId);
  assert.equal(kept?.active, 1); // the screen still shows page two
  assert.deepEqual(kept?.picks.get(1), [1]); // and what it held is kept
  o.world.slack.responses["views.update"] = rejected("not_found");
  await o.world.dispatch(tabClick(o, 0, boxes("q1", "1")));
  assert.deepEqual(o.world.ephemerals(), []);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.active, 1);
});

test("a refused tab does not undo a Next that moved the draft on meanwhile", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  const second = o.modal.view;
  const gate = new AsyncEvent();
  o.world.slack.gate = gate;
  o.world.slack.gateMethod = "views.update";
  o.world.slack.responses["views.update"] = rejected("hash_conflict");
  await o.world.dispatch(tabClick(o, 0, boxes("q1", "0"))); // held in Slack's call
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
