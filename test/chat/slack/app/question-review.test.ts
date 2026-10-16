/**
 * The review page of the question form (issue #325): it lists every answer, each with an Edit
 * button that opens that question's page, and Next or Review brings the owner back to it. Edit is
 * a button of the form: its block_actions payload and the `views.update` it answers follow the
 * references read 2026-10-16 (block_actions payload of a modal, `views.update` with `hash`);
 * `formAction` builds the payload, `ModalSlack` is Slack's side of the modal. Next and Review
 * answer the submission with `response_action: update`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "../../../../src/agent/seam.ts";
import type { Draft } from "../../../../src/chat/slack/requests.ts";
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

/** The Edit button of question `target` on the review page `view`. */
function editClick(o: Open, target: number, view: Body = o.modal.view): Body {
  return formAction(
    view,
    {},
    { id: `question_edit_${target}`, type: "button" },
    { hash: o.modal.hash },
  );
}

const inputs = (view: Body): Body[] =>
  (view.blocks as Body[]).filter((block) => block.type === "input");
/** The tab row, a context line. */
const tabs = (view: Body): string =>
  (((view.blocks as Body[])[0] as Body).elements as Body[])[0]?.text;
const pageOf = (view: Body): number => JSON.parse(view.private_metadata as string).n;
const draftOf = (o: Open) => o.world.built.drafts.get(o.approvalId);

/** All three questions answered and the review on screen. */
async function atReview(t: Parameters<typeof worldOf>[0]) {
  const o = await openForm(t, THREE);
  await forward(o, { ...radio("q0", "1"), ...noted("n0", "darker") });
  await forward(o, { ...boxes("q1", "0", "other"), ...typed("o1", "xl") });
  await forward(o, radio("q2", "1"));
  return o;
}

test("Next moves to the next page and the last page's Review opens the review", async (t) => {
  const o = await openForm(t, THREE);
  const second = await forward(o, radio("q0", "0"));
  assert.equal(pageOf(second), 1);
  assert.equal(second.submit.text, "Next (2/3)");
  assert.equal(tabs(second), "☒ Colour   *☐ Sizes*   ☐ Shape   ✔ Submit");
  assert.equal(draftOf(o)?.reviewed, false);
  await forward(o, boxes("q1", "0"));
  const review = await forward(o, radio("q2", "0"));
  assert.equal(pageOf(review), 3);
  assert.equal(review.submit.text, "Submit answers");
  assert.equal(review.close.text, "Close");
  assert.equal(tabs(review), "☒ Colour   ☒ Sizes   ☒ Shape   *✔ Submit*");
  assert.equal(draftOf(o)?.reviewed, true);
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("the last question's Review lists every answer with an Edit button and sends nothing", async (t) => {
  const o = await openForm(t, QUESTIONS);
  await forward(o, radio("q0", "1"));
  const review = await forward(o, { ...boxes("q1", "0", "other"), ...typed("o1", "xl") });
  await o.world.idle();
  assert.ok(!o.pending.decided);
  assert.equal(pageOf(review), 2);
  const blocks = (review.blocks as Body[]).slice(1);
  assert.deepEqual(
    blocks.map((block) => block.text?.text),
    ["*Review your answers*", "● Colour?\n→ blue", "● Sizes?\n→ s, xl"],
  );
  assert.deepEqual(
    blocks.slice(1).map((block) => [block.accessory.action_id, block.accessory.text.text]),
    [
      ["question_edit_0", "Edit"],
      ["question_edit_1", "Edit"],
    ],
  );
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

test("Edit opens that question's page with its answers as stored", async (t) => {
  const o = await atReview(t);
  const shown = o.modal.hash;
  await o.world.dispatch(editClick(o, 1));
  const [hash, view] = o.modal.calls.at(-1) as [string, Body];
  assert.equal(hash, shown); // the hash of the view the click came from
  assert.equal(pageOf(view), 1);
  const page = inputs(o.modal.view);
  assert.deepEqual(
    page[0]?.element.initial_options.map((option: Body) => option.value),
    ["0", "other"],
  );
  assert.equal(page.length, 3); // the choice, Other's field and Notes
  assert.equal(draftOf(o)?.active, 1);
  await o.world.dispatch(editClick(o, 0, view)); // not the review page any more: ignored
  assert.equal(pageOf(o.modal.view), 1);
});

test("a second Edit from the same review page changes nothing", async (t) => {
  const o = await atReview(t);
  const review = o.modal.view;
  await o.world.dispatch(editClick(o, 0, review));
  const calls = o.modal.calls.length;
  await o.world.dispatch(editClick(o, 1, review)); // the review page it came from is gone
  assert.equal(o.modal.calls.length, calls);
  assert.equal(pageOf(o.modal.view), 0);
  assert.equal(draftOf(o)?.active, 0);
});

test("Edit shows the notes kept with the answer", async (t) => {
  const o = await atReview(t);
  await o.world.dispatch(editClick(o, 0));
  assert.equal(inputs(o.modal.view)[1]?.element.initial_value, "darker");
});

test("from a page opened by Edit the footer reads Review, and Review goes back to the review", async (t) => {
  const o = await atReview(t);
  await o.world.dispatch(editClick(o, 0));
  assert.equal(o.modal.view.submit.text, "Review");
  const review = await forward(o, radio("q0", "0")); // red replaces blue
  assert.equal(pageOf(review), 3);
  assert.equal((review.blocks as Body[])[2]?.text.text, "● Colour?\n→ red\nNotes: darker");
  await o.world.dispatch(submitOn(review, {}));
  await o.world.idle();
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "red", "Sizes?": ["s", "xl"], "Shape?": "square" },
    notes: { "Colour?": "darker" },
  });
});

test("Review on a page opened by Edit validates the page like any other", async (t) => {
  const o = await atReview(t);
  await o.world.dispatch(editClick(o, 2));
  const response = await o.world.dispatch(submitOn(o.modal.view, {}));
  const body = response.body as Body;
  assert.equal(body.response_action, "errors");
  assert.equal(pageOf(o.modal.view), 2);
});

test("once the review was reached every page's footer reads Review", async (t) => {
  const o = await atReview(t);
  for (const target of [0, 1]) {
    await o.world.dispatch(editClick(o, target));
    assert.equal(o.modal.view.submit.text, "Review");
    await forward(o, target === 0 ? radio("q0", "1") : boxes("q1", "0"));
  }
});

test("Next after Edit goes to the first question with no answer when one is missing", async (t) => {
  const o = await atReview(t);
  await o.world.dispatch(editClick(o, 0));
  // The draft lost the answer of the second question while the page was open.
  const kept = draftOf(o) as NonNullable<ReturnType<typeof draftOf>>;
  (o.world.built.drafts as Map<string, Draft>).set(o.approvalId, {
    ...kept,
    picks: new Map([...kept.picks].filter(([at]) => at !== 1)),
    other: new Set(),
  });
  const next = await forward(o, radio("q0", "1"));
  assert.equal(pageOf(next), 1);
  assert.ok(!JSON.stringify(next).includes(slackTexts.QUESTION_MISSING));
  assert.equal(next.submit.text, "Review");
});

test("the last page's Review goes to the first question left with no answer", async (t) => {
  const o = await openForm(t, THREE);
  await forward(o, radio("q0", "0"));
  await forward(o, boxes("q1", "0"));
  // The draft lost the second answer (a form reopened from a stale draft, say).
  const kept = draftOf(o) as NonNullable<ReturnType<typeof draftOf>>;
  (o.world.built.drafts as Map<string, Draft>).set(o.approvalId, {
    ...kept,
    picks: new Map([[0, [0]]]),
  });
  const next = await forward(o, radio("q2", "0"));
  assert.equal(pageOf(next), 1);
  assert.ok(!JSON.stringify(next).includes(slackTexts.QUESTION_MISSING));
  assert.equal(tabs(next), "☒ Colour   *☐ Sizes*   ☒ Shape   ✔ Submit");
  assert.equal(draftOf(o)?.reviewed, false);
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("one question: Submit sends, with no tab row, no review and no Edit", async (t) => {
  const o = await openForm(t, [QUESTIONS[0] as Question]);
  const view = o.modal.view;
  assert.equal(view.submit.text, "Submit");
  assert.equal(view.close.text, "Close");
  assert.ok((view.blocks as Body[]).every((block) => block.type === "input"));
  await o.world.dispatch(submitOn(view, radio("q0", "0")));
  await o.world.idle();
  assert.ok(o.pending.decided);
});

test("a stranger's Edit does nothing", async (t) => {
  const o = await atReview(t);
  const calls = o.modal.calls.length;
  const body = editClick(o, 0);
  Object.assign(body.user, { id: STRANGER });
  await o.world.dispatch(body);
  assert.equal(o.modal.calls.length, calls);
  assert.equal(draftOf(o)?.active, 3);
});

test("an Edit from another workspace does nothing", async (t) => {
  const o = await atReview(t);
  const calls = o.modal.calls.length;
  const body = editClick(o, 0);
  body.user.team_id = "T000OTHER";
  await o.world.dispatch(body);
  assert.equal(o.modal.calls.length, calls);
  assert.equal(draftOf(o)?.active, 3);
});

test("an Edit of an older form is ignored", async (t) => {
  const o = await atReview(t);
  const older = o.modal.view;
  await o.world.dispatch(answerClick(o.approvalId)); // Answer again: a newer form, same page
  const calls = o.modal.calls.length;
  await o.world.dispatch(editClick(o, 0, older));
  assert.equal(o.modal.calls.length, calls);
  assert.equal(draftOf(o)?.active, 3);
});

test("an Edit from a form that is not on the review page is ignored", async (t) => {
  const o = await openForm(t, QUESTIONS);
  const calls = o.modal.calls.length;
  await o.world.dispatch(editClick(o, 1));
  assert.equal(o.modal.calls.length, calls);
  assert.equal(draftOf(o)?.active, 0);
});

test("an Edit for a question the form does not have is ignored", async (t) => {
  const o = await atReview(t);
  const calls = o.modal.calls.length;
  await o.world.dispatch(editClick(o, 3));
  assert.equal(o.modal.calls.length, calls);
  assert.equal(draftOf(o)?.active, 3);
});

test("an Edit whose request is gone does nothing", async (t) => {
  const o = await atReview(t);
  o.world.approvals.giveUp(o.approvalId);
  const calls = o.modal.calls.length;
  await o.world.dispatch(editClick(o, 0));
  assert.equal(o.modal.calls.length, calls);
  assert.equal(o.world.built.drafts.size, 0);
});

test("an Edit Slack refuses leaves the draft on the review page", async (t) => {
  const o = await atReview(t);
  const before = draftOf(o);
  const stale = editClick(o, 0);
  stale.view.hash = "1790000000.stale";
  await o.world.dispatch(stale);
  assert.deepEqual(o.modal.written, []);
  assert.equal(draftOf(o)?.active, 3);
  assert.deepEqual(draftOf(o), before);
  o.world.slack.responses["views.update"] = rejected("not_found");
  await o.world.dispatch(editClick(o, 0));
  assert.deepEqual(o.world.ephemerals(), []);
  assert.deepEqual(draftOf(o), before);
});

test("an Edit Slack refuses after Submit answers does not bring the draft back", async (t) => {
  const o = await atReview(t);
  const review = o.modal.view;
  o.world.slack.gate = new AsyncEvent();
  o.world.slack.gateMethod = "views.update";
  const edit = o.world.dispatch(editClick(o, 0, review));
  await o.world.slack.gated.wait(); // the update is on its way
  await o.world.dispatch(submitOn(review, {}));
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.equal(o.world.built.drafts.size, 0);
  o.world.slack.responses["views.update"] = rejected("not_found");
  o.world.slack.gate.set();
  await edit;
  await o.world.idle();
  assert.equal(o.world.built.drafts.size, 0);
});

test("a form closed and opened again after the review keeps reading Review", async (t) => {
  const o = await atReview(t);
  await o.world.dispatch(editClick(o, 0));
  await o.world.dispatch(answerClick(o.approvalId)); // Close, then Answer
  const reopened = (o.world.slack.callsTo("views.open") as Body[]).at(-1)?.view as Body;
  o.modal.view = reopened;
  assert.equal(pageOf(reopened), 0);
  assert.equal(reopened.submit.text, "Review");
  const review = await forward(o, radio("q0", "0"));
  assert.equal(pageOf(review), 3);
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
