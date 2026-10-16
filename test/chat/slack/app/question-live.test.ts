/**
 * The question form of a single select while it is open (issue #325): an option and a text under
 * Other exclude each other, live. Slack dispatches a `block_actions` payload for each change
 * (input block `dispatch_action`, `dispatch_action_config` `on_character_entered`; block_actions
 * payload and `views.update` references, read 2026-10-16); the daemon empties the other field in
 * one `views.update`, giving its block a new id because Slack keeps an input's value while the
 * block id stays.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "../../../../src/agent/seam.ts";
import { type Draft, loadDraft, newDraft } from "../../../../src/chat/slack/requests.ts";
import { CHANNEL, rejected, STRANGER } from "../../../support/fake-slack.ts";
import {
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
const other = (block: string, value: string | null): Body => ({
  [block]: { other: { type: "plain_text_input", value } },
});
const notes = (value: string | null): Body => ({
  n0: { notes: { type: "plain_text_input", value } },
});

/** The ids of the input blocks of the view, in order. */
const idsOf = (view: Body): string[] =>
  (view.blocks as Body[]).filter((b) => b.type === "input").map((b) => b.block_id);

function openForm(t: Parameters<typeof worldOf>[0], questions: readonly Question[] = [SINGLE]) {
  const world = worldOf(t);
  const [approvalId, pending] = world.approvals.open(CHANNEL, FORM_THREAD, "Colour", questions);
  const modal = new ModalSlack(world.slack);
  return { world, modal, pending, draft: newDraft(approvalId, CHANNEL, FORM_THREAD) };
}

const choice = (draft: Draft, values: Body, block = "q0"): Body =>
  formAction(draft, [SINGLE], values, { id: "answer", block, type: "radio_buttons" });
const typing = (draft: Draft, values: Body, block = "o0"): Body =>
  formAction(draft, [SINGLE], values, { id: "other", block, type: "plain_text_input" });

test("picking an option empties the text under Other with one update", async (t) => {
  const { world, modal, draft } = openForm(t);
  await world.dispatch(
    choice(draft, { ...radio("q0", "1"), ...other("o0", "mauve"), ...notes("n") }),
  );
  assert.equal(modal.calls.length, 1);
  const [hash, view] = modal.calls[0] as [string, Body];
  assert.equal(hash, "1790000000.h0"); // the hash of the view the payload came from
  assert.deepEqual(idsOf(view), ["q0", "o0.1", "n0"]);
  const [choiceBlock, otherBlock, notesBlock] = (view.blocks as Body[]).filter(
    (b) => b.type === "input",
  );
  assert.deepEqual(choiceBlock?.element.initial_option.value, "1"); // the pick stays
  assert.equal(otherBlock?.element.initial_value, undefined);
  assert.equal(notesBlock?.element.initial_value, "n"); // notes are never cleared
});

test("typing under Other empties the option, and the next keystroke makes no call", async (t) => {
  const { world, modal, draft } = openForm(t);
  await world.dispatch(typing(draft, { ...radio("q0", "0"), ...other("o0", "m") }));
  assert.equal(modal.calls.length, 1);
  const view = modal.view;
  assert.deepEqual(idsOf(view), ["q0.1", "o0", "n0"]);
  const [choiceBlock, otherBlock] = (view.blocks as Body[]).filter((b) => b.type === "input");
  assert.equal(choiceBlock?.element.initial_option, undefined);
  assert.equal(otherBlock?.element.initial_value, "m");
  // The form as it stands now: the radio is empty, the next character changes nothing else.
  const shown = loadDraft(view.private_metadata as string);
  assert.deepEqual(shown.revisions.get(0), [1, 0]);
  await world.dispatch(typing(shown, other("o0", "mo")));
  assert.equal(modal.calls.length, 1);
});

test("nothing to clear, nothing updated", async (t) => {
  const { world, modal, draft } = openForm(t);
  await world.dispatch(choice(draft, radio("q0", "1")));
  await world.dispatch(typing(draft, other("o0", "mauve")));
  await world.dispatch(typing(draft, { ...radio("q0", "1"), ...other("o0", "") }));
  assert.deepEqual(modal.calls, []);
});

test("a multi-select keeps the option and the text: nothing is cleared", async (t) => {
  const { world, modal, draft } = openForm(t, [MULTI]);
  const state = {
    q0: { answer: { type: "checkboxes", selected_options: [{ value: "0" }] } },
    ...other("o0", "xl"),
  };
  for (const [id, block] of [
    ["answer", "q0"],
    ["other", "o0"],
  ] as const) {
    await world.dispatch(
      formAction(draft, [MULTI], state, { id, block, type: "plain_text_input" }),
    );
  }
  assert.deepEqual(modal.calls, []);
});

test("a hash_conflict or a closed form is ignored", async (t) => {
  const { world, modal, draft } = openForm(t);
  const body = typing(draft, { ...radio("q0", "0"), ...other("o0", "m") });
  body.view.hash = "1790000000.stale"; // a newer view than the payload's
  await world.dispatch(body);
  assert.equal(modal.calls.length, 1);
  assert.deepEqual(modal.written, []);
  world.slack.responses["views.update"] = rejected("not_found");
  await world.dispatch(typing(draft, { ...radio("q0", "0"), ...other("o0", "m") }));
  assert.deepEqual(world.ephemerals(), []);
});

test("a stranger's change does nothing", async (t) => {
  const { world, modal, draft } = openForm(t);
  const body = typing(draft, { ...radio("q0", "0"), ...other("o0", "m") });
  Object.assign(body.user, { id: STRANGER });
  await world.dispatch(body);
  assert.deepEqual(modal.calls, []);
});

test("a form of another request, or of no draft, is left alone", async (t) => {
  const { world, modal, draft } = openForm(t);
  const body = typing(draft, { ...radio("q0", "0"), ...other("o0", "m") });
  body.view.callback_id = "something_else";
  await world.dispatch(body);
  const stale = typing(newDraft("gone", CHANNEL, FORM_THREAD), {
    ...radio("q0", "0"),
    ...other("o0", "m"),
  });
  await world.dispatch(stale);
  const broken = typing(draft, { ...radio("q0", "0"), ...other("o0", "m") });
  broken.view.private_metadata = "not json";
  await world.dispatch(broken);
  assert.deepEqual(modal.calls, []);
});

test("Submit reads the blocks of the revision on screen", async (t) => {
  const { world, pending, draft } = openForm(t);
  const shown = { ...draft, revisions: new Map([[0, [2, 1] as const]]) };
  await world.dispatch(
    formBody("view_submission", shown, { ...radio("q0.2", "1"), ...other("o0.1", "") }),
  );
  assert.deepEqual(await pending.decision, {
    answered: true,
    answers: { "Colour?": "blue" },
    notes: {},
  });
});

test("notes alone answer the question, and travel with an option too", async (t) => {
  const alone = openForm(t);
  await alone.world.dispatch(formBody("view_submission", alone.draft, notes("something else")));
  assert.deepEqual(await alone.pending.decision, {
    answered: true,
    answers: {},
    notes: { "Colour?": "something else" },
  });
  const both = openForm(t);
  await both.world.dispatch(
    formBody("view_submission", both.draft, { ...radio("q0", "0"), ...notes("darker") }),
  );
  assert.deepEqual(await both.pending.decision, {
    answered: true,
    answers: { "Colour?": "red" },
    notes: { "Colour?": "darker" },
  });
});
