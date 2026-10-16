/**
 * The question form while it is open (issue #325). Other is the last option of the list and its
 * text field shows only while Other is chosen; Notes shows once something is chosen. Slack
 * dispatches a `block_actions` payload when the choice changes (input block `dispatch_action`;
 * block_actions payload and `views.update` references, read 2026-10-16) and the daemon redraws
 * the form in one `views.update`; typing in Other or Notes only reaches the draft. What the owner
 * filled lives in the provider's memory (`BuiltApp.drafts`); the view's `private_metadata` names
 * the request, the form's generation and its page; only the newest form of a request is valid.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "../../../../src/agent/seam.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import { texts } from "../../../../src/core/port.ts";
import { AsyncEvent, CHANNEL, rejected, STRANGER } from "../../../support/fake-slack.ts";
import {
  answerClick,
  type Body,
  FORM_THREAD,
  formAction,
  ModalSlack,
  QUESTIONS,
  submitAsShown,
  submitOn,
  worldOf,
} from "../../../support/slack-app.ts";

const [SINGLE, MULTI] = QUESTIONS as [Question, Question];

const radio = (block: string, value: string): Body => ({
  [block]: { answer: { type: "radio_buttons", selected_option: { value } } },
});
const boxes = (block: string, value: string): Body => ({
  [block]: { answer: { type: "checkboxes", selected_options: [{ value }] } },
});
const other = (block: string, value: string | null): Body => ({
  [block]: { other: { type: "plain_text_input", value } },
});
const notes = (value: string | null): Body => ({
  n0: { notes: { type: "plain_text_input", value } },
});

/** The ids of the input blocks of the view, in order. */
const idsOf = (view: Body): string[] =>
  (view.blocks as Body[]).filter((b) => b.type === "input").map((b) => b.block_id);

/** A world whose form for `questions` is open on screen, as Answer opens it. */
async function openForm(
  t: Parameters<typeof worldOf>[0],
  questions: readonly Question[] = [SINGLE],
) {
  const world = worldOf(t);
  const [approvalId, pending] = world.approvals.open(CHANNEL, FORM_THREAD, "Colour", questions);
  const modal = new ModalSlack(world.slack);
  await world.dispatch(answerClick(approvalId));
  return { world, modal, pending, approvalId };
}

type Open = Awaited<ReturnType<typeof openForm>>;

/** The owner changes the choice, or types in a field, in the form as it stands. */
const choose = (o: Open, values: Body, block = "q0"): Body =>
  formAction(
    o.modal.view,
    values,
    { id: "answer", block, type: "radio_buttons" },
    { hash: o.modal.hash },
  );
const typeIn = (o: Open, id: "other" | "notes", block: string, values: Body): Body =>
  formAction(o.modal.view, values, { id, block, type: "plain_text_input" }, { hash: o.modal.hash });
const type = (o: Open, values: Body): Body => typeIn(o, "other", "o0", values);
/** Next or Submit in the form `view` (the one on screen unless said). */
const submit = (o: Open, values: Body, view: Body = o.modal.view): Body => submitOn(view, values);

const inputsOf = (view: Body): Body[] => (view.blocks as Body[]).filter((b) => b.type === "input");
const draftOf = (o: Open) => o.world.built.drafts.get(o.approvalId);

test("the form names its request, its generation and its page in private_metadata", async (t) => {
  const o = await openForm(t);
  assert.deepEqual(JSON.parse(o.modal.view.private_metadata as string), {
    a: o.approvalId,
    c: CHANNEL,
    h: FORM_THREAD,
    g: 1,
    n: 0,
  });
  assert.equal(o.world.built.drafts.size, 1);
});

test("a question opens with its choice alone, required", async (t) => {
  const o = await openForm(t);
  assert.deepEqual(idsOf(o.modal.view), ["q0"]);
  assert.equal(inputsOf(o.modal.view)[0]?.optional, undefined);
});

test("choosing Other shows its field and Notes with one update", async (t) => {
  const o = await openForm(t);
  const shown = o.modal.hash;
  await o.world.dispatch(choose(o, radio("q0", "other")));
  assert.equal(o.modal.calls.length, 1);
  const [hash, view] = o.modal.calls[0] as [string, Body];
  assert.equal(hash, shown); // the hash of the view the payload came from
  assert.deepEqual(idsOf(view), ["q0", "o0", "n0"]);
  const inputs = inputsOf(view);
  assert.equal(inputs[0]?.element.initial_option.value, "other");
  assert.equal(inputs[1]?.element.max_length, 300);
  assert.equal(inputs[2]?.element.max_length, 300);
  assert.equal(JSON.parse(view.private_metadata as string).a, o.approvalId);
  assert.deepEqual(draftOf(o)?.other, new Set([0]));
});

test("choosing an option shows Notes and no Other field", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "1")));
  assert.equal(o.modal.calls.length, 1);
  assert.deepEqual(idsOf(o.modal.view), ["q0", "n0"]);
  assert.equal(inputsOf(o.modal.view)[0]?.element.initial_option.value, "1");
});

test("choosing an option after Other removes its field; Other again finds the text", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "other")));
  await o.world.dispatch(type(o, { ...radio("q0", "other"), ...other("o0", "mauve") }));
  await o.world.dispatch(choose(o, { ...radio("q0", "1"), ...other("o0", "mauve") }));
  assert.deepEqual(idsOf(o.modal.view), ["q0", "n0"]);
  assert.deepEqual(draftOf(o)?.other, new Set());
  assert.equal(draftOf(o)?.typed.get(0), "mauve"); // kept in the draft
  await o.world.dispatch(choose(o, radio("q0", "other")));
  assert.deepEqual(idsOf(o.modal.view), ["q0", "o0", "n0"]);
  assert.equal(inputsOf(o.modal.view)[1]?.element.initial_value, "mauve");
});

test("a multi select shows the Other field while Other is ticked, Notes while any is", async (t) => {
  const o = await openForm(t, [MULTI]);
  const tick = (...values: string[]): Body => ({
    q0: {
      answer: { type: "checkboxes", selected_options: values.map((value) => ({ value })) },
    },
  });
  await o.world.dispatch(choose(o, tick("0")));
  assert.deepEqual(idsOf(o.modal.view), ["q0", "n0"]);
  await o.world.dispatch(choose(o, tick("0", "other")));
  assert.deepEqual(idsOf(o.modal.view), ["q0", "o0", "n0"]);
  await o.world.dispatch(choose(o, tick("0")));
  assert.deepEqual(idsOf(o.modal.view), ["q0", "n0"]);
  await o.world.dispatch(choose(o, tick()));
  assert.deepEqual(idsOf(o.modal.view), ["q0"]);
});

test("unticking everything removes Notes and keeps the note in the draft", async (t) => {
  const o = await openForm(t, [MULTI]);
  const ticked = boxes("q0", "0");
  await o.world.dispatch(choose(o, ticked));
  await o.world.dispatch(typeIn(o, "notes", "n0", { ...ticked, ...notes("both") }));
  await o.world.dispatch(
    choose(o, { q0: { answer: { type: "checkboxes", selected_options: [] } }, ...notes("both") }),
  );
  assert.deepEqual(idsOf(o.modal.view), ["q0"]);
  assert.equal(draftOf(o)?.notes.get(0), "both");
  await o.world.dispatch(choose(o, ticked));
  assert.equal(inputsOf(o.modal.view)[1]?.element.initial_value, "both");
});

test("typing in Other or Notes reaches the draft and redraws nothing", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "other")));
  assert.equal(o.modal.calls.length, 1);
  const chosen = radio("q0", "other");
  await o.world.dispatch(type(o, { ...chosen, ...other("o0", "m") }));
  await o.world.dispatch(type(o, { ...chosen, ...other("o0", "mo") }));
  await o.world.dispatch(
    typeIn(o, "notes", "n0", { ...chosen, ...other("o0", "mo"), ...notes("darker") }),
  );
  assert.equal(o.modal.calls.length, 1);
  assert.equal(draftOf(o)?.typed.get(0), "mo");
  assert.equal(draftOf(o)?.notes.get(0), "darker");
});

test("a hash_conflict or a closed form is ignored", async (t) => {
  const o = await openForm(t);
  const body = choose(o, radio("q0", "other"));
  body.view.hash = "1790000000.stale"; // a newer view than the payload's
  await o.world.dispatch(body);
  assert.equal(o.modal.calls.length, 1);
  assert.deepEqual(o.modal.written, []);
  o.world.slack.responses["views.update"] = rejected("not_found");
  await o.world.dispatch(choose(o, radio("q0", "other")));
  assert.deepEqual(o.world.ephemerals(), []);
});

test("a stranger's change does nothing", async (t) => {
  const o = await openForm(t);
  const body = choose(o, radio("q0", "other"));
  Object.assign(body.user, { id: STRANGER });
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
  assert.equal(draftOf(o)?.other.size, 0);
});

test("a form of another callback is left alone", async (t) => {
  const o = await openForm(t);
  const body = choose(o, radio("q0", "other"));
  body.view.callback_id = "something_else";
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
});

test("an old form, whose request is gone, tells the owner instead of closing silently", async (t) => {
  const o = await openForm(t);
  // The metadata the previous version wrote: the ids with the whole draft beside them.
  const old = JSON.stringify({
    a: "no-such-request",
    c: CHANNEL,
    h: FORM_THREAD,
    n: 0,
    p: {},
    t: {},
  });
  const body = submit(o, radio("q0", "0"));
  body.view.private_metadata = old;
  await o.world.dispatch(body);
  assert.deepEqual(o.world.ephemerals(), [texts.APPROVAL_GONE]);
  assert.ok(!o.pending.decided);
});

/** The decision of a pending request after `values` were submitted on the form on screen. */
async function sent(o: Open, values: Body) {
  await o.world.dispatch(submit(o, values));
  await o.world.idle();
  assert.ok(o.pending.decided);
  return o.pending.decision;
}

test("notes travel with the option picked", async (t) => {
  const o = await openForm(t);
  assert.deepEqual(await sent(o, { ...radio("q0", "0"), ...notes("darker") }), {
    answered: true,
    answers: { "Colour?": "red" },
    notes: { "Colour?": "darker" },
  });
});

test("a single select with Other sends the typed text, and its notes", async (t) => {
  const o = await openForm(t);
  assert.deepEqual(
    await sent(o, { ...radio("q0", "other"), ...other("o0", " mauve "), ...notes("why") }),
    { answered: true, answers: { "Colour?": "mauve" }, notes: { "Colour?": "why" } },
  );
});

test("a multi select with Other sends the labels and the typed text, and its notes", async (t) => {
  const o = await openForm(t, [MULTI]);
  const state = {
    q0: {
      answer: { type: "checkboxes", selected_options: [{ value: "0" }, { value: "other" }] },
    },
    ...other("o0", "xl"),
    ...notes("both"),
  };
  assert.deepEqual(await sent(o, state), {
    answered: true,
    answers: { "Sizes?": ["s", "xl"] },
    notes: { "Sizes?": "both" },
  });
});

test("text typed before another option was chosen is not sent", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "other")));
  await o.world.dispatch(type(o, { ...radio("q0", "other"), ...other("o0", "mauve") }));
  await o.world.dispatch(choose(o, radio("q0", "1")));
  assert.deepEqual(await sent(o, radio("q0", "1")), {
    answered: true,
    answers: { "Colour?": "blue" },
    notes: {},
  });
});

test("notes alone send nothing and ask for a choice", async (t) => {
  const o = await openForm(t);
  const response = await o.world.dispatch(submit(o, notes("something else")));
  assert.deepEqual(response.body, {
    response_action: "errors",
    errors: { q0: slackTexts.QUESTION_MISSING },
  });
  assert.ok(!o.pending.decided);
});

test("nothing at all still says to choose an option or type an answer", async (t) => {
  const o = await openForm(t);
  const response = await o.world.dispatch(submit(o, {}));
  assert.deepEqual(response.body, {
    response_action: "errors",
    errors: { q0: slackTexts.QUESTION_MISSING },
  });
  assert.equal(slackTexts.QUESTION_MISSING, "Choose an option or type your own answer.");
});

/** The multi select's boxes ticked, as the state of block q0. */
const tick = (...values: string[]): Body => ({
  q0: { answer: { type: "checkboxes", selected_options: values.map((value) => ({ value })) } },
});

/** A change whose payload carries the hash of a view that is no longer on screen. */
function late(o: Open, values: Body): Body {
  const body = choose(o, values);
  body.view.hash = "1790000000.stale";
  return body;
}

test("a multi select whose redraw was dropped does not send a note the owner cannot see", async (t) => {
  const o = await openForm(t, [MULTI]);
  await o.world.dispatch(choose(o, tick("0")));
  await o.world.dispatch(typeIn(o, "notes", "n0", { ...tick("0"), ...notes("secret") }));
  await o.world.dispatch(choose(o, { ...tick(), ...notes("secret") })); // Notes goes
  assert.deepEqual(idsOf(o.modal.view), ["q0"]);
  await o.world.dispatch(late(o, tick("1"))); // refused: hash_conflict
  assert.deepEqual(idsOf(o.modal.view), ["q0"]);
  const response = await o.world.dispatch(submitAsShown(o.modal.view, tick("1")));
  const body = response.body as Body;
  assert.equal(body.response_action, "update");
  assert.deepEqual(idsOf(body.view), ["q0", "n0"]);
  assert.equal(inputsOf(body.view)[1]?.element.initial_value, "secret");
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("a single select whose redraw was dropped does not send an Other text the owner cannot see", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "other")));
  await o.world.dispatch(type(o, { ...radio("q0", "other"), ...other("o0", "mauve") }));
  await o.world.dispatch(choose(o, radio("q0", "1"))); // Other's field goes
  assert.deepEqual(idsOf(o.modal.view), ["q0", "n0"]);
  await o.world.dispatch(late(o, radio("q0", "other"))); // refused: hash_conflict
  const response = await o.world.dispatch(submitAsShown(o.modal.view, radio("q0", "other")));
  const body = response.body as Body;
  assert.equal(body.response_action, "update");
  assert.deepEqual(idsOf(body.view), ["q0", "o0", "n0"]);
  assert.equal(inputsOf(body.view)[1]?.element.initial_value, "mauve");
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("an Other text of spaces alone is an error on its field", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "other")));
  const response = await o.world.dispatch(
    submit(o, { ...radio("q0", "other"), ...other("o0", "   ") }),
  );
  assert.deepEqual(response.body, {
    response_action: "errors",
    errors: { o0: slackTexts.QUESTION_MISSING },
  });
  assert.ok(!o.pending.decided);
});

test("a change of the choice after the daemon stopped redraws nothing", async (t) => {
  const o = await openForm(t);
  o.world.chat.halt();
  await o.world.dispatch(choose(o, radio("q0", "other")));
  assert.deepEqual(o.modal.calls, []);
  assert.deepEqual(draftOf(o)?.other, new Set([0])); // read before the stop check, as kept
});

test("Later then Answer reopens the form with the answers already given", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  await o.world.dispatch(submit(o, radio("q0", "1"))); // Next: page two is on screen
  // The owner closes the form (Later) and clicks Answer again.
  await o.world.dispatch(answerClick(o.approvalId));
  const reopened = o.modal.view;
  assert.equal(o.world.built.drafts.size, 1);
  assert.equal(reopened.submit.text, "Review"); // still the second page
});

test("the first page keeps its pick when the form is reopened", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "1")));
  await o.world.dispatch(answerClick(o.approvalId));
  const first = (o.modal.view.blocks as Body[]).find((b) => b.type === "input");
  assert.equal(first?.element.initial_option.value, "1");
});

test("a draft goes when its request is answered, skipped or gone, and the app closes", async (t) => {
  const answered = await openForm(t);
  await answered.world.dispatch(submit(answered, radio("q0", "0")));
  assert.equal(answered.world.built.drafts.size, 0);

  const skipped = await openForm(t);
  const skip = { type: "button", action_id: "question_skip", value: skipped.approvalId };
  const click = answerClick(skipped.approvalId);
  click.actions[0] = skip;
  await skipped.world.dispatch(click);
  assert.equal(skipped.world.built.drafts.size, 0);

  const gone = await openForm(t);
  gone.world.approvals.giveUp(gone.approvalId);
  await gone.world.dispatch(submit(gone, radio("q0", "0")));
  assert.equal(gone.world.built.drafts.size, 0);

  // A request that ended some other way (`!stop`) is dropped at the next Answer.
  const left = await openForm(t);
  const [second] = left.world.approvals.open(CHANNEL, FORM_THREAD, "Size", [SINGLE]);
  left.world.approvals.giveUp(left.approvalId);
  await left.world.dispatch(answerClick(second));
  assert.deepEqual([...left.world.built.drafts.keys()], [second]);

  left.world.built.close();
  assert.equal(left.world.built.drafts.size, 0);
});

const STALE = slackTexts.QUESTION_STALE;

test("only the newest form of a request is valid: the older one's Next sends nothing", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  const older = o.modal.view;
  await o.world.dispatch(answerClick(o.approvalId)); // Answer again, say on another device
  const response = await o.world.dispatch(submit(o, radio("q0", "0"), older));
  assert.deepEqual(response.body, { response_action: "errors", errors: { q0: STALE } });
  assert.equal(STALE, "This form was opened again. Use the newest one.");
  assert.ok(!o.pending.decided);
  assert.equal(draftOf(o)?.picks.size, 0); // nothing was written
});

test("the older form's changes are ignored, with no update", async (t) => {
  const o = await openForm(t);
  const older = o.modal.view;
  await o.world.dispatch(answerClick(o.approvalId));
  await o.world.dispatch(
    formAction(older, radio("q0", "other"), { id: "answer", block: "q0", type: "radio_buttons" }),
  );
  assert.deepEqual(o.modal.calls, []);
  assert.equal(draftOf(o)?.picks.size, 0);
  assert.equal(draftOf(o)?.other.size, 0);
});

test("the older form cannot send what the newer one holds", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  const older = o.modal.view; // page one, nothing filled
  await o.world.dispatch(answerClick(o.approvalId));
  const newer = o.modal.view;
  // The newer form goes on to page two and ticks a box there.
  const next = await o.world.dispatch(submit(o, radio("q0", "0"), newer));
  const second = (next.body as Body).view as Body;
  await o.world.dispatch(
    formAction(second, boxes("q1", "0"), { id: "answer", block: "q1", type: "checkboxes" }),
  );
  // Both questions now hold an answer, yet the older form's Next sends nothing.
  const response = await o.world.dispatch(submit(o, radio("q0", "0"), older));
  assert.equal((response.body as Body).response_action, "errors");
  await o.world.idle();
  assert.ok(!o.pending.decided);
});

test("a late keystroke from the page Next already left writes nothing", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  const first = o.modal.view;
  const blue = radio("q0", "other");
  const next = await o.world.dispatch(submit(o, { ...blue, ...other("o0", "mauve") }, first));
  assert.equal(((next.body as Body).view as Body).submit.text, "Review");
  // The `mau` keystroke was handled after the submission, from the form as page one had it.
  await o.world.dispatch(
    formAction(
      first,
      { ...blue, ...other("o0", "mau") },
      { id: "other", block: "o0", type: "plain_text_input" },
    ),
  );
  const kept = draftOf(o);
  assert.equal(kept?.typed.get(0), "mauve");
  assert.equal(kept?.active, 1);
});

test("a form the first versions opened is stale when its request is still open", async (t) => {
  const o = await openForm(t);
  const old = submit(o, radio("q0", "0"));
  old.view.private_metadata = JSON.stringify({ a: o.approvalId, c: CHANNEL, h: FORM_THREAD });
  const response = await o.world.dispatch(old);
  assert.deepEqual(response.body, { response_action: "errors", errors: { q0: STALE } });
  assert.ok(!o.pending.decided);
});

test("a form that could not open leaves the older one valid", async (t) => {
  const o = await openForm(t);
  const older = o.modal.view;
  o.world.slack.responses["views.open"] = { ok: false, error: "expired_trigger_id" };
  await o.world.dispatch(answerClick(o.approvalId));
  await o.world.dispatch(
    formAction(
      older,
      { ...radio("q0", "1") },
      { id: "answer", block: "q0", type: "radio_buttons" },
    ),
  );
  assert.deepEqual(draftOf(o)?.picks.get(0), [1]);
});

test("Answer on a request that is gone leaves another request's draft alone", async (t) => {
  const o = await openForm(t);
  const [gone] = o.world.approvals.open(CHANNEL, FORM_THREAD, "Size", [SINGLE]);
  o.world.approvals.giveUp(gone);
  await o.world.dispatch(answerClick(gone));
  assert.deepEqual(o.world.ephemerals(), [texts.APPROVAL_GONE]);
  assert.deepEqual([...o.world.built.drafts.keys()], [o.approvalId]);
});

test("Later then Answer finds the boxes ticked, the text under Other and the notes typed", async (t) => {
  const o = await openForm(t, [MULTI]);
  const tick = (...values: string[]): Body => ({
    q0: {
      answer: { type: "checkboxes", selected_options: values.map((value) => ({ value })) },
    },
  });
  await o.world.dispatch(choose(o, tick("1", "other")));
  await o.world.dispatch(typeIn(o, "other", "o0", { ...tick("1", "other"), ...other("o0", "xl") }));
  await o.world.dispatch(
    typeIn(o, "notes", "n0", { ...tick("1", "other"), ...other("o0", "xl"), ...notes("both") }),
  );
  await o.world.dispatch(answerClick(o.approvalId));
  const inputs = inputsOf(o.modal.view);
  assert.deepEqual(
    inputs[0]?.element.initial_options.map((x: Body) => x.value),
    ["1", "other"],
  );
  assert.equal(inputs[1]?.element.initial_value, "xl");
  assert.equal(inputs[2]?.element.initial_value, "both");
});

test("Later then Answer finds the notes of a single select too", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "1")));
  await o.world.dispatch(typeIn(o, "notes", "n0", { ...radio("q0", "1"), ...notes("darker") }));
  await o.world.dispatch(answerClick(o.approvalId));
  const inputs = inputsOf(o.modal.view);
  assert.equal(inputs[0]?.element.initial_option.value, "1");
  assert.equal(inputs[1]?.element.initial_value, "darker");
});

test("a change in a form whose request is gone drops its draft", async (t) => {
  const o = await openForm(t);
  assert.equal(o.world.built.drafts.size, 1);
  o.world.approvals.giveUp(o.approvalId);
  await o.world.dispatch(choose(o, radio("q0", "1")));
  assert.equal(o.world.built.drafts.size, 0);
});

test("a stranger's note changes nothing", async (t) => {
  const o = await openForm(t);
  const body = formAction(
    o.modal.view,
    { ...radio("q0", "1"), ...notes("x") },
    { id: "notes", block: "n0", type: "plain_text_input" },
    { user: { id: STRANGER } },
  );
  await o.world.dispatch(body);
  assert.equal(draftOf(o)?.notes.size, 0);
});

test("a late keystroke from page one leaves page two's fields as they are", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  const first = o.modal.view;
  const next = await o.world.dispatch(submit(o, radio("q0", "0"), first));
  const second = (next.body as Body).view as Body;
  const ticked = boxes("q1", "0");
  await o.world.dispatch(
    formAction(second, ticked, { id: "answer", block: "q1", type: "checkboxes" }),
  );
  const noted = { n1: { notes: { type: "plain_text_input", value: "both" } } };
  await o.world.dispatch(
    formAction(
      second,
      { ...ticked, ...noted },
      { id: "notes", block: "n1", type: "plain_text_input" },
    ),
  );
  const before = draftOf(o);
  assert.deepEqual(before?.picks.get(1), [0]);
  // The page-one keystroke, handled after the owner went on and ticked page two.
  await o.world.dispatch(
    formAction(first, radio("q0", "other"), { id: "answer", block: "q0", type: "radio_buttons" }),
  );
  const after = draftOf(o);
  assert.deepEqual(after?.picks, before?.picks);
  assert.deepEqual(after?.other, before?.other);
  assert.deepEqual(after?.typed, before?.typed);
  assert.deepEqual(after?.notes, before?.notes);
  assert.equal(after?.active, 1);
});

test("a form that fails to open after a newer one opened leaves the newer one valid", async (t) => {
  const world = worldOf(t);
  const [approvalId, pending] = world.approvals.open(CHANNEL, FORM_THREAD, "Colour", [SINGLE]);
  // The first Answer's views.open (generation 1) fails, the second's (generation 2) succeeds,
  // and both are held until the second Answer was clicked.
  world.slack.responses["views.open"] = (args) => {
    const metadata = (args.view as Body).private_metadata as string;
    if (JSON.parse(metadata).g === 1) return rejected("expired_trigger_id");
    return { ok: true, view: { id: "V000FORM", hash: "1790000000.h1" } };
  };
  const gate = new AsyncEvent();
  world.slack.gate = gate;
  world.slack.gateMethod = "views.open";
  await world.dispatch(answerClick(approvalId));
  await world.dispatch(answerClick(approvalId));
  gate.set();
  await world.idle();
  const opened = (world.slack.callsTo("views.open") as Body[]).map((call) => call.view as Body);
  const newer = opened.find((view) => JSON.parse(view.private_metadata).g === 2) as Body;
  await world.dispatch(submitOn(newer, radio("q0", "1")));
  assert.ok(pending.decided);
  assert.deepEqual(await pending.decision, {
    answered: true,
    answers: { "Colour?": "blue" },
    notes: {},
  });
});
