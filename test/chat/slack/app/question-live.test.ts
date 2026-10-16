/**
 * The question form while it is open (issue #325). In a single select an option and a text under
 * Other exclude each other, live: Slack dispatches a `block_actions` payload for each change
 * (input block `dispatch_action`, `dispatch_action_config` `on_character_entered`; block_actions
 * payload and `views.update` references, read 2026-10-16), and the daemon empties the other field
 * in one `views.update`, giving its block a new id because Slack keeps an input's value while the
 * block id stays. What the owner filled lives in the provider's memory (`BuiltApp.drafts`); the
 * view's `private_metadata` names the request alone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "../../../../src/agent/seam.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import { texts } from "../../../../src/core/port.ts";
import { CHANNEL, rejected, STRANGER } from "../../../support/fake-slack.ts";
import {
  answerClick,
  type Body,
  FORM_THREAD,
  formAction,
  formBody,
  ModalSlack,
  QUESTIONS,
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
const submit = (o: Open, values: Body, view: Body = o.modal.view): Body => {
  const ids = { approvalId: o.approvalId, channelId: CHANNEL, threadTs: FORM_THREAD };
  const body = formBody("view_submission", ids, values);
  body.view.private_metadata = view.private_metadata;
  return body;
};

test("the form names its request, its page and its block revisions in private_metadata", async (t) => {
  const o = await openForm(t);
  assert.deepEqual(JSON.parse(o.modal.view.private_metadata as string), {
    a: o.approvalId,
    c: CHANNEL,
    h: FORM_THREAD,
    n: 0,
    r: {},
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

test("two forms of one request each keep their own page", async (t) => {
  const o = await openForm(t, [...QUESTIONS]);
  const a = o.modal.view; // form A, on page one
  await o.world.dispatch(answerClick(o.approvalId)); // Answer clicked again: form B
  const b = o.modal.view;
  // B goes on to page two and ticks a box there.
  const next = await o.world.dispatch(submit(o, radio("q0", "0"), b));
  const onB = (next.body as Body).view as Body;
  assert.equal(onB.submit.text, "Submit");
  await o.world.dispatch(
    formAction(onB, boxes("q1", "0"), { id: "answer", block: "q1", type: "checkboxes" }),
  );
  assert.deepEqual(o.world.built.drafts.get(o.approvalId)?.picks.get(1), [0]);
  // A, still on page one, picks an option: read from A's own page, B's page-two answer kept.
  await o.world.dispatch(
    formAction(a, radio("q0", "1"), { id: "answer", block: "q0", type: "radio_buttons" }),
  );
  const kept = o.world.built.drafts.get(o.approvalId);
  assert.deepEqual(kept?.picks.get(0), [1]);
  assert.deepEqual(kept?.picks.get(1), [0]);
  // A's Next is no error keyed on a block A does not show: with B's answer on page two the form
  // is complete, and both answers reach the agent.
  const response = await o.world.dispatch(submit(o, radio("q0", "1"), a));
  assert.equal(response.body, null);
  await o.world.idle();
  assert.ok(o.pending.decided);
  assert.deepEqual(await o.pending.decision, {
    answered: true,
    answers: { "Colour?": "blue", "Sizes?": ["s"] },
    notes: {},
  });
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
