/**
 * The question form while it is open (issue #325). In a single select an option and a text under
 * Other exclude each other, live: Slack dispatches a `block_actions` payload for each change
 * (input block `dispatch_action`, `dispatch_action_config` `on_character_entered`; block_actions
 * payload and `views.update` references, read 2026-10-16), and the daemon empties the other field
 * in one `views.update`, giving its block a new id because Slack keeps an input's value while the
 * block id stays. What the owner filled lives in the provider's memory (`BuiltApp.drafts`); the
 * view's `private_metadata` names the request, the form's generation and its page; only the
 * newest form of a request is valid.
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

/** The owner picks an option / types under Other in the form as it stands. */
const choose = (o: Open, values: Body, block = "q0"): Body =>
  formAction(
    o.modal.view,
    values,
    { id: "answer", block, type: "radio_buttons" },
    { hash: o.modal.hash },
  );
const type = (o: Open, values: Body, block = "o0"): Body =>
  formAction(
    o.modal.view,
    values,
    { id: "other", block, type: "plain_text_input" },
    { hash: o.modal.hash },
  );
/** Next or Submit in the form `view` (the one on screen unless said). */
const submit = (o: Open, values: Body, view: Body = o.modal.view): Body => submitOn(view, values);

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

test("both fields take 300 characters", async (t) => {
  const o = await openForm(t);
  const inputs = (o.modal.view.blocks as Body[]).filter((b) => b.type === "input");
  assert.deepEqual(
    inputs.slice(1).map((b) => b.element.max_length),
    [300, 300],
  );
});

test("picking an option empties the text under Other with one update", async (t) => {
  const o = await openForm(t);
  const shown = o.modal.hash;
  await o.world.dispatch(
    choose(o, { ...radio("q0", "1"), ...other("o0", "mauve"), ...notes("n") }),
  );
  assert.equal(o.modal.calls.length, 1);
  const [hash, view] = o.modal.calls[0] as [string, Body];
  assert.equal(hash, shown); // the hash of the view the payload came from
  assert.deepEqual(idsOf(view), ["q0", "o0.1", "n0"]);
  const blocks = (view.blocks as Body[]).filter((b) => b.type === "input");
  assert.equal(blocks[0]?.element.initial_option.value, "1"); // the pick stays
  assert.equal(blocks[1]?.element.initial_value, undefined);
  assert.equal(blocks[2]?.element.initial_value, "n"); // notes are never cleared
  assert.equal(JSON.parse(view.private_metadata as string).a, o.approvalId);
});

test("typing under Other empties the option, and the next keystroke makes no call", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(type(o, { ...radio("q0", "0"), ...other("o0", "m") }));
  assert.equal(o.modal.calls.length, 1);
  assert.deepEqual(idsOf(o.modal.view), ["q0.1", "o0", "n0"]);
  const blocks = (o.modal.view.blocks as Body[]).filter((b) => b.type === "input");
  assert.equal(blocks[0]?.element.initial_option, undefined);
  assert.equal(blocks[1]?.element.initial_value, "m");
  // The form as it stands now: the radio is empty, the next character changes nothing else.
  await o.world.dispatch(type(o, other("o0", "mo")));
  assert.equal(o.modal.calls.length, 1);
});

test("nothing to clear, nothing updated", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "1")));
  await o.world.dispatch(type(o, other("o0", "mauve")));
  await o.world.dispatch(type(o, { ...radio("q0", "1"), ...other("o0", "") }));
  assert.deepEqual(o.modal.calls, []);
});

test("a multi-select keeps the option and the text: nothing is cleared", async (t) => {
  const o = await openForm(t, [MULTI]);
  const state = { ...boxes("q0", "0"), ...other("o0", "xl") };
  for (const [id, block] of [
    ["answer", "q0"],
    ["other", "o0"],
  ] as const) {
    const body = formAction(o.modal.view, state, { id, block, type: "plain_text_input" });
    await o.world.dispatch(body);
  }
  assert.deepEqual(o.modal.calls, []);
});

test("a hash_conflict or a closed form is ignored", async (t) => {
  const o = await openForm(t);
  const body = type(o, { ...radio("q0", "0"), ...other("o0", "m") });
  body.view.hash = "1790000000.stale"; // a newer view than the payload's
  await o.world.dispatch(body);
  assert.equal(o.modal.calls.length, 1);
  assert.deepEqual(o.modal.written, []);
  o.world.slack.responses["views.update"] = rejected("not_found");
  await o.world.dispatch(type(o, { ...radio("q0", "0"), ...other("o0", "m") }));
  assert.deepEqual(o.world.ephemerals(), []);
});

test("a stranger's change does nothing", async (t) => {
  const o = await openForm(t);
  const body = type(o, { ...radio("q0", "0"), ...other("o0", "m") });
  Object.assign(body.user, { id: STRANGER });
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
});

test("a form of another callback is left alone", async (t) => {
  const o = await openForm(t);
  const body = type(o, { ...radio("q0", "0"), ...other("o0", "m") });
  body.view.callback_id = "something_else";
  await o.world.dispatch(body);
  assert.deepEqual(o.modal.calls, []);
});

test("Submit reads the blocks of the revision on screen", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(type(o, { ...radio("q0", "0"), ...other("o0", "m") })); // radio now q0.1
  await o.world.dispatch(submit(o, { ...radio("q0.1", "1"), ...other("o0", "") }));
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "blue" },
    notes: {},
  });
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

test("notes travel with the option picked", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(submit(o, { ...radio("q0", "0"), ...notes("darker") }));
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "red" },
    notes: { "Colour?": "darker" },
  });
});

test("notes with an option and a text under Other travel in a multi-select", async (t) => {
  const o = await openForm(t, [MULTI]);
  await o.world.dispatch(
    submit(o, { ...boxes("q0", "0"), ...other("o0", "xl"), ...notes("both") }),
  );
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Sizes?": ["s", "xl"] },
    notes: { "Sizes?": "both" },
  });
});

for (const [name, values] of [
  ["notes alone", notes("something else")],
  ["a text under Other and notes", { ...other("o0", "mauve"), ...notes("darker") }],
] as const) {
  test(`${name} with no option picked asks for an option`, async (t) => {
    const o = await openForm(t);
    const response = await o.world.dispatch(submit(o, values));
    assert.deepEqual(response.body, {
      response_action: "errors",
      errors: { q0: slackTexts.QUESTION_NOTES_NEED_OPTION },
    });
    assert.equal(slackTexts.QUESTION_NOTES_NEED_OPTION, "Pick an option to add notes to it.");
    assert.ok(!o.pending.decided);
  });
}

test("a multi-select with a text and notes but no option asks for an option too", async (t) => {
  const o = await openForm(t, [MULTI]);
  const response = await o.world.dispatch(submit(o, { ...other("o0", "xl"), ...notes("both") }));
  assert.deepEqual(response.body, {
    response_action: "errors",
    errors: { q0: slackTexts.QUESTION_NOTES_NEED_OPTION },
  });
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

// Next clicked within the round trip of the clearing update carries both the option and the text.
test("both carried at Submit: the option picked last wins", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(type(o, other("o0", "mauve")));
  const both = { ...radio("q0", "1"), ...other("o0", "mauve") };
  await o.world.dispatch(choose(o, both)); // picked last; the update that clears Other is in flight
  await o.world.dispatch(submit(o, both));
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "blue" },
    notes: {},
  });
});

test("both carried at Submit: the text typed last wins", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "1")));
  const both = { ...radio("q0", "1"), ...other("o0", "mauve") };
  await o.world.dispatch(type(o, both)); // typed last; the update that clears the radio is in flight
  await o.world.dispatch(submit(o, both));
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "mauve" },
    notes: {},
  });
});

test("Later then Answer reopens the form with the answers already given", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  await o.world.dispatch(submit(o, radio("q0", "1"))); // Next: page two is on screen
  // The owner closes the form (Later) and clicks Answer again.
  await o.world.dispatch(answerClick(o.approvalId));
  const reopened = o.modal.view;
  assert.equal(o.world.built.drafts.size, 1);
  assert.equal(reopened.submit.text, "Submit"); // still the second page
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
  assert.equal(o.world.built.drafts.get(o.approvalId)?.picks.size, 0); // nothing was written
});

test("the older form's changes are ignored, with no update", async (t) => {
  const o = await openForm(t);
  const older = o.modal.view;
  await o.world.dispatch(answerClick(o.approvalId));
  await o.world.dispatch(
    formAction(
      older,
      { ...radio("q0", "0"), ...other("o0", "x") },
      {
        id: "other",
        block: "o0",
        type: "plain_text_input",
      },
    ),
  );
  assert.deepEqual(o.modal.calls, []);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.picks.size, 0);
  assert.equal(o.world.built.drafts.get(o.approvalId)?.typed.size, 0);
});

test("the older form cannot send what the newer one holds", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  const older = o.modal.view; // page one, nothing filled
  await o.world.dispatch(answerClick(o.approvalId));
  const newer = o.modal.view;
  // The newer form goes on to page two and types under Other there.
  const next = await o.world.dispatch(submit(o, radio("q0", "0"), newer));
  const second = (next.body as Body).view as Body;
  await o.world.dispatch(
    formAction(second, other("o1", "x"), { id: "other", block: "o1", type: "plain_text_input" }),
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
  await o.world.dispatch(type(o, other("o0", "blue")));
  const next = await o.world.dispatch(submit(o, other("o0", "blue"), first));
  assert.equal(((next.body as Body).view as Body).submit.text, "Submit");
  // The `blu` keystroke was handled after the submission, from the form as page one had it.
  await o.world.dispatch(
    formAction(first, other("o0", "blu"), { id: "other", block: "o0", type: "plain_text_input" }),
  );
  const kept = o.world.built.drafts.get(o.approvalId);
  assert.equal(kept?.typed.get(0), "blue");
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
  assert.deepEqual(o.world.built.drafts.get(o.approvalId)?.picks.get(0), [1]);
});

test("an error after an exclusion names the block now on screen", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(type(o, { ...radio("q0", "0"), ...other("o0", "m") })); // radio now q0.1
  const response = await o.world.dispatch(
    submit(o, {
      "q0.1": { answer: { type: "radio_buttons", selected_option: null } },
      ...other("o0", ""),
    }),
  );
  assert.deepEqual(response.body, {
    response_action: "errors",
    errors: { "q0.1": slackTexts.QUESTION_MISSING },
  });
});

test("a change in Notes is never the last change, nor does it run the exclusion", async (t) => {
  const o = await openForm(t);
  const both = { ...radio("q0", "1"), ...other("o0", "mauve") };
  await o.world.dispatch(choose(o, both)); // the option last; Other is being emptied
  assert.equal(o.modal.calls.length, 1);
  const withNotes = { ...both, ...notes("darker") };
  await o.world.dispatch(
    formAction(o.modal.view, withNotes, { id: "notes", block: "n0", type: "plain_text_input" }),
  );
  assert.equal(o.modal.calls.length, 1); // no second update
  assert.equal(o.world.built.drafts.get(o.approvalId)?.last.get(0), "choice");
  await o.world.dispatch(submit(o, withNotes));
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "blue" },
    notes: { "Colour?": "darker" },
  });
});

test("Answer on a request that is gone leaves another request's draft alone", async (t) => {
  const o = await openForm(t);
  const [gone] = o.world.approvals.open(CHANNEL, FORM_THREAD, "Size", [SINGLE]);
  o.world.approvals.giveUp(gone);
  await o.world.dispatch(answerClick(gone));
  assert.deepEqual(o.world.ephemerals(), [texts.APPROVAL_GONE]);
  assert.deepEqual([...o.world.built.drafts.keys()], [o.approvalId]);
});

test("Later then Answer finds the notes typed, the boxes ticked and the text under Other", async (t) => {
  const o = await openForm(t, [MULTI]);
  const field = (id: string, block: string, type: string, values: Body): Body =>
    formAction(o.modal.view, values, { id, block, type });
  const state = {
    ...boxes("q0", "1"),
    ...other("o0", "xl"),
    ...notes("both"),
  };
  await o.world.dispatch(field("answer", "q0", "checkboxes", boxes("q0", "1")));
  await o.world.dispatch(
    field("other", "o0", "plain_text_input", { ...boxes("q0", "1"), ...other("o0", "xl") }),
  );
  await o.world.dispatch(field("notes", "n0", "plain_text_input", state));
  assert.deepEqual(o.modal.calls, []); // only the single select's exclusion redraws
  await o.world.dispatch(answerClick(o.approvalId));
  const inputs = (o.modal.view.blocks as Body[]).filter((b) => b.type === "input");
  assert.deepEqual(
    inputs[0]?.element.initial_options.map((x: Body) => x.value),
    ["1"],
  );
  assert.equal(inputs[1]?.element.initial_value, "xl");
  assert.equal(inputs[2]?.element.initial_value, "both");
});

test("Later then Answer finds the notes of a single select too", async (t) => {
  const o = await openForm(t);
  await o.world.dispatch(choose(o, radio("q0", "1")));
  const typedNotes = formAction(
    o.modal.view,
    { ...radio("q0", "1"), ...notes("darker") },
    { id: "notes", block: "n0", type: "plain_text_input" },
  );
  await o.world.dispatch(typedNotes);
  assert.deepEqual(o.modal.calls, []);
  await o.world.dispatch(answerClick(o.approvalId));
  const inputs = (o.modal.view.blocks as Body[]).filter((b) => b.type === "input");
  assert.equal(inputs[0]?.element.initial_option.value, "1");
  assert.equal(inputs[2]?.element.initial_value, "darker");
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
  assert.equal(o.world.built.drafts.get(o.approvalId)?.notes.size, 0);
});

test("the older form's Next names the block it shows, not the one the draft expects", async (t) => {
  const o = await openForm(t);
  const older = o.modal.view; // form A: its radio block is `q0`
  await o.world.dispatch(answerClick(o.approvalId)); // form B
  // In B the owner picks, then types under Other: the exclusion moves the draft to `q0.1`.
  await o.world.dispatch(type(o, { ...radio("q0", "0"), ...other("o0", "m") }));
  assert.deepEqual(idsOf(o.modal.view), ["q0.1", "o0", "n0"]);
  const response = await o.world.dispatch(submit(o, radio("q0", "0"), older));
  assert.deepEqual(response.body, { response_action: "errors", errors: { q0: STALE } });
});

test("a late keystroke from page one leaves page two's fields as they are", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  const first = o.modal.view;
  const next = await o.world.dispatch(submit(o, radio("q0", "0"), first));
  const second = (next.body as Body).view as Body;
  const onSecond = (id: string, block: string, type: string, values: Body): Body =>
    formAction(second, values, { id, block, type });
  const ticked = boxes("q1", "0");
  await o.world.dispatch(onSecond("answer", "q1", "checkboxes", ticked));
  await o.world.dispatch(
    onSecond("other", "o1", "plain_text_input", { ...ticked, ...other("o1", "xl") }),
  );
  const noted = { n1: { notes: { type: "plain_text_input", value: "both" } } };
  await o.world.dispatch(
    onSecond("notes", "n1", "plain_text_input", { ...ticked, ...other("o1", "xl"), ...noted }),
  );
  const before = o.world.built.drafts.get(o.approvalId);
  assert.deepEqual(before?.picks.get(1), [0]);
  // The page-one keystroke, handled after the owner went on and typed on page two.
  await o.world.dispatch(
    formAction(first, other("o0", "blu"), { id: "other", block: "o0", type: "plain_text_input" }),
  );
  const after = o.world.built.drafts.get(o.approvalId);
  assert.deepEqual(after?.picks, before?.picks);
  assert.deepEqual(after?.typed, before?.typed);
  assert.deepEqual(after?.notes, before?.notes);
  assert.deepEqual(after?.last, before?.last);
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
