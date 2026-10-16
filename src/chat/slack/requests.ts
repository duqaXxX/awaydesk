/**
 * The agent's permission requests and questions as Slack draws them: the approval message, the
 * one-line question with Answer and Skip, the form that asks it one question at a time, and the
 * answered question that replaces a request. Every limit here is Slack's. What is pending and
 * what the answer is belong to `core/requests.ts`.
 *
 * Everything the model wrote (the title, the description, the input, a question's header) goes
 * to Slack with `&`, `<` and `>` escaped and a zero-width space after each backtick, so no
 * `<url|label>` can hide what it links and no text can close its code block.
 */

import type { PermissionRequest, Question, QuestionOption } from "../../agent/seam.ts";
import { answerOf, type Names, named, oneLine, texts } from "../../core/port.ts";
import { PY_SPACE, strip } from "../../text.ts";
import { isRecord } from "../../values.ts";
import { shownAsWritten } from "./reply/escape.ts";
import * as slackTexts from "./texts.ts";

export const SECTION_LIMIT = 3000;
export const MESSAGE_BLOCKS = 50; // Slack's limit on blocks in one message
export const OPTION_TEXT_LIMIT = 75;
export const LABEL_LIMIT = 2000; // an input block's label
const TAB_LIMIT = 40; // a question's header in the tab row

export const APPROVAL_ALLOW = "approval_allow";
export const APPROVAL_DENY = "approval_deny";
export const QUESTION_OPEN = "question_open";
export const QUESTION_SKIP = "question_skip";
export const QUESTION_FORM = "question_form";
/** The Edit buttons of the review page: `question_edit_{n}`, n a question's index. */
export const QUESTION_EDIT = /^question_edit_(\d+)$/;
// Text typed under Other and in Notes, per question. The draft lives in the daemon's memory
// (`Requests`), so Slack's 3,000 characters of private_metadata bound neither.
export const TYPED_LIMIT = 300;
export const NOTES_LIMIT = 300;
// The value of the Other option; the others carry their index in the question's options.
const OTHER_VALUE = "other";

type Block = Record<string, unknown>;
type Answers = Record<string, string | string[]>;

const RUNS = new RegExp(`[${PY_SPACE}]+`);

/** The first `limit` characters, counted in code points as Slack counts them. */
function head(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

function length(text: string): number {
  return Array.from(text).length;
}

function cut(text: string, limit: number): string {
  return length(text) <= limit ? text : `${head(text, limit - 1)}…`;
}

/** `text` with every run of white space as one space. */
function squeezed(text: string): string {
  return strip(text).split(RUNS).join(" ");
}

function button(actionId: string, label: string, value: string, style?: string): Block {
  const entry: Block = {
    type: "button",
    action_id: actionId,
    value,
    text: { type: "plain_text", text: label },
  };
  if (style) entry.style = style;
  return entry;
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** `text` in pieces that each fit `limit` once shown as written, never splitting an escape. */
function codeChunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let size = 0;
  for (const char of text) {
    // Only these four change when shown as written; any other code point stays one character.
    const width = "&<>`".includes(char) ? length(shownAsWritten(char)) : 1;
    if (size + width > limit) {
      chunks.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += char;
    size += width;
  }
  return chunk !== "" || chunks.length === 0 ? [...chunks, chunk] : chunks;
}

function code(chunk: string): Block {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `\`\`\`\n${shownAsWritten(chunk)}\n\`\`\`` },
  };
}

/**
 * The request the owner approves: everything the tool will run with, never cut silently, since
 * Approve hands the agent the whole input whatever was shown.
 */
export function approvalBlocks(
  approvalId: string,
  request: PermissionRequest,
  names: Names,
): Block[] {
  const heading = request.title
    ? shownAsWritten(request.title)
    : texts.fill(named(slackTexts.APPROVAL_PROMPT, names), {
        tool: shownAsWritten(request.toolName),
      });
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: head(heading, SECTION_LIMIT) } },
  ];
  if (request.description) {
    blocks.push(context(head(shownAsWritten(request.description), SECTION_LIMIT)));
  }
  const detail = JSON.stringify(request.input, null, 2);
  const chunks = codeChunks(detail, SECTION_LIMIT - length("```\n\n```"));
  const room = MESSAGE_BLOCKS - blocks.length - 1; // the actions block closes it
  let codeBlocks: Block[];
  if (chunks.length > room) {
    // Past one message, the start and the end stay (a payload hides at the end of padding)
    // and a line says how much is not shown, so the owner can Deny rather than guess.
    const shown = chunks.slice(0, room - 2);
    const tail = chunks.at(-1) as string;
    const hidden = chunks.slice(room - 2, -1).reduce((total, chunk) => total + length(chunk), 0);
    const notice = texts.fill(slackTexts.APPROVAL_CUT, { count: hidden.toLocaleString("en-US") });
    codeBlocks = [...shown.map(code), context(notice), code(tail)];
  } else {
    codeBlocks = chunks.map(code);
  }
  blocks.push(...codeBlocks, {
    type: "actions",
    elements: [
      button(APPROVAL_ALLOW, "Approve", approvalId, "primary"),
      button(APPROVAL_DENY, "Deny", approvalId, "danger"),
    ],
  });
  return blocks;
}

/**
 * An answered request as the terminal keeps it, for a question whose answers the reply cannot
 * show: `User answered Claude's questions:`, then `· question → answer` per question, with no
 * buttons left to press.
 */
export function answeredBlocks(
  questions: readonly Question[],
  answers: Readonly<Record<string, string | readonly string[]>>,
  names: Names,
): Block[] {
  const lines = [slackTexts.RECORD_MARK + named(texts.ANSWERED, names)];
  for (const q of questions) {
    const answer = Object.hasOwn(answers, q.text) ? (answers[q.text] as string | string[]) : "";
    const shown = typeof answer === "string" ? answer : answer.join(", ");
    lines.push(`${texts.NESTED}· ${shownAsWritten(q.text)} → ${shownAsWritten(shown)}`);
  }
  // A context element holds at most 3,000 characters; long questions and answers are cut.
  return [context(cut(lines.join("\n"), SECTION_LIMIT))];
}

/**
 * The request in the channel: one line naming the questions, with Answer (which opens the form)
 * and Skip. It stays one line however many questions the agent asks.
 */
export function questionBlocks(
  approvalId: string,
  questions: readonly Question[],
  names: Names,
): Block[] {
  const headers = questions.map((q) => `*${shownAsWritten(q.header || q.text)}*`).join(" · ");
  const count =
    questions.length === 1
      ? named(slackTexts.QUESTIONS_ONE, names)
      : texts.fill(named(slackTexts.QUESTIONS_MANY, names), { count: questions.length });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: head(`${count}: ${headers}`, SECTION_LIMIT) },
    },
    {
      type: "actions",
      elements: [
        button(QUESTION_OPEN, slackTexts.QUESTION_ANSWER, approvalId, "primary"),
        button(QUESTION_SKIP, "Skip", approvalId),
      ],
    },
  ];
}

/**
 * What the owner filled in the form so far, kept by the provider in memory (`Requests`) while
 * the request is open: option indexes picked, the questions whose Other option is chosen, and the
 * text typed under Other and the notes, per question. A text or a note stays here when its field
 * leaves the screen, so choosing Other again shows it again.
 */
export interface Draft {
  readonly approvalId: string;
  readonly channelId: string;
  readonly threadTs: string;
  /**
   * The generation of the form that is valid: every Answer opens a new one and makes the older
   * forms of the request stale (`Requests.onQuestionOpen`).
   */
  readonly generation: number;
  /** The question on screen in the valid form. */
  readonly active: number;
  /** Whether the review page was reached: from then on the footer reads Review on every page. */
  readonly reviewed: boolean;
  readonly picks: ReadonlyMap<number, readonly number[]>;
  /** The questions whose Other option is chosen. */
  readonly other: ReadonlySet<number>;
  readonly typed: ReadonlyMap<number, string>;
  readonly notes: ReadonlyMap<number, string>;
}

/** A draft of the request `approvalId` posted in this thread, with nothing filled in unless given. */
export function newDraft(
  approvalId: string,
  channelId: string,
  threadTs: string,
  filled: Partial<
    Pick<Draft, "generation" | "active" | "reviewed" | "picks" | "other" | "typed" | "notes">
  > = {},
): Draft {
  return {
    approvalId,
    channelId,
    threadTs,
    generation: filled.generation ?? 0,
    active: filled.active ?? 0,
    reviewed: filled.reviewed ?? false,
    picks: filled.picks ?? new Map(),
    other: filled.other ?? new Set(),
    typed: filled.typed ?? new Map(),
    notes: filled.notes ?? new Map(),
  };
}

/**
 * What a form carries in its `private_metadata`: the request it answers, its generation and the
 * page it shows. Only the newest form of a request is valid (`Draft.generation`), so everything
 * else lives in the draft. The page names the blocks the payload's state belongs to: a late
 * change from a page Next has left carries the old one and is ignored.
 */
export type FormIds = Pick<
  Draft,
  "approvalId" | "channelId" | "threadTs" | "generation" | "active"
>;

export function dumpIds(ids: FormIds): string {
  return JSON.stringify({
    a: ids.approvalId,
    c: ids.channelId,
    h: ids.threadTs,
    g: ids.generation,
    n: ids.active,
  });
}

/**
 * The ids `dumpIds` wrote; throws on anything else. Generation and page are read when they are
 * there: the metadata of an earlier version has no generation (0, older than any form now open)
 * and may carry a whole draft beside the ids, which is left unread.
 */
export function loadIds(dumped: string): FormIds {
  const data: unknown = JSON.parse(dumped);
  if (!isRecord(data) || ![data.a, data.c, data.h].every((id) => typeof id === "string")) {
    throw new Error("malformed form");
  }
  return {
    approvalId: data.a as string,
    channelId: data.c as string,
    threadTs: data.h as string,
    generation: data.g === undefined ? 0 : index(data.g),
    active: data.n === undefined ? 0 : index(data.n),
  };
}

function index(value: unknown): number {
  const found = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  if (!/^\d+$/.test(found)) throw new Error("malformed form");
  return Number(found);
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The draft with what the question on screen shows now: Slack sends the form's state with Next
 * and Submit, and with a dispatched action, but only for the blocks on screen. The Other and
 * Notes fields leave the screen with the choice, so a field the state does not carry keeps what
 * the draft holds.
 */
export function absorb(draft: Draft, stateValues: unknown): Draft {
  const at = draft.active;
  const values = fieldsOf(stateValues);
  const picked = fieldsOf(fieldsOf(values[`q${at}`]).answer);
  const single = fieldsOf(picked.selected_option);
  const several = picked.selected_options;
  const chosen: unknown[] =
    Array.isArray(several) && several.length > 0
      ? several
      : Object.keys(single).length > 0
        ? [single]
        : [];
  const values_ = chosen.map((o) => fieldsOf(o).value);
  const picks = new Map(draft.picks);
  picks.set(at, values_.filter((v) => v !== OTHER_VALUE).map(index));
  const other = new Set(draft.other);
  if (values_.includes(OTHER_VALUE)) other.add(at);
  else other.delete(at);
  return {
    ...draft,
    picks: new Map([...picks].filter(([, v]) => v.length > 0)),
    other,
    typed: withField(draft.typed, at, fieldsOf(fieldsOf(values[`o${at}`]).other)),
    notes: withField(draft.notes, at, fieldsOf(fieldsOf(values[`n${at}`]).notes)),
  };
}

/** `kept` with question `at` set to what `field` holds; unchanged when the field is not on screen. */
function withField(
  kept: ReadonlyMap<number, string>,
  at: number,
  field: Record<string, unknown>,
): Map<number, string> {
  const next = new Map(kept);
  if (Object.keys(field).length === 0) return next;
  const value = typeof field.value === "string" ? strip(field.value) : "";
  if (value === "") next.delete(at);
  else next.set(at, value);
  return next;
}

function answerAt(
  draft: Draft,
  questions: readonly Question[],
  at: number,
): string | string[] | null {
  const question = questions[at];
  if (question === undefined) throw new RangeError(`no question ${at}`);
  const picked = draft.picks.get(at) ?? [];
  if (!draft.other.has(at)) return answerOf(question, picked, undefined);
  // Other chosen with no text is no answer, even beside options picked in a multi select.
  const typed = draft.typed.get(at);
  return typed === undefined ? null : answerOf(question, picked, typed);
}

/**
 * Whether a note belongs to the answer of question `at`: only a real option carries one, so Other
 * alone shows no Notes field and sends no note.
 */
function takesNotes(draft: Draft, at: number): boolean {
  return (draft.picks.get(at) ?? []).length > 0;
}

/** An option, or Other with its text, makes an answer, as in the terminal. */
export function isAnswered(draft: Draft, questions: readonly Question[], at: number): boolean {
  return answerAt(draft, questions, at) !== null;
}

/** The index of the first question with no answer, else null. */
export function firstIncomplete(draft: Draft, questions: readonly Question[]): number | null {
  const found = questions.findIndex((_, at) => !isAnswered(draft, questions, at));
  return found === -1 ? null : found;
}

/**
 * Every question's answer by its text and the notes added to it by the question's text, or null
 * while one question is unanswered. A note kept for a question with no answer, or whose answer
 * is Other alone, is not sent.
 */
export function draftAnswers(
  draft: Draft,
  questions: readonly Question[],
): { answers: Answers; notes: Record<string, string> } | null {
  const answers: [string, string | string[]][] = [];
  const notes: [string, string][] = [];
  for (const [at, question] of questions.entries()) {
    const answer = answerAt(draft, questions, at);
    if (answer === null) return null;
    answers.push([question.text, answer]);
    const note = draft.notes.get(at);
    if (note !== undefined && takesNotes(draft, at)) notes.push([question.text, note]);
  }
  return { answers: Object.fromEntries(answers), notes: Object.fromEntries(notes) };
}

/**
 * An option's preview as it is shown: its own lines, with no blank line around them; empty when
 * it holds nothing to read.
 */
function previewOf(option: QuestionOption): string {
  const preview = option.preview ?? "";
  return strip(preview) !== "" ? preview.replace(/^\n+|\n+$/g, "") : "";
}

/**
 * Whether an option says more than a choice holds: Slack caps an option object's `text` and
 * `description` at 75 characters each (option object reference, read 2026-10-03), and it has no
 * place for a `preview`.
 */
function saysMore(question: Question): boolean {
  return question.options.some(
    (option) =>
      length(squeezed(option.label)) > OPTION_TEXT_LIMIT ||
      length(squeezed(option.description ?? "")) > OPTION_TEXT_LIMIT ||
      previewOf(option) !== "",
  );
}

function optionEntry(at: number, option: QuestionOption, described: boolean): Block {
  const entry: Block = {
    text: { type: "plain_text", text: oneLine(option.label, OPTION_TEXT_LIMIT) },
    value: String(at),
  };
  // Slack refuses an empty text: a description of blanks alone is none.
  const description = oneLine(option.description ?? "", OPTION_TEXT_LIMIT);
  if (described && description !== "") {
    entry.description = { type: "plain_text", text: description };
  }
  return entry;
}

function bold(text: string): Block {
  return { type: "text", text: cut(text, SECTION_LIMIT), style: { bold: true } };
}

/**
 * An option with every word the agent wrote for it, as one rich text block: its label in bold,
 * its description, and its preview in a preformatted element, which keeps its line breaks. Rich
 * text shows its text as written, so nothing in it is read as markup (a modal takes no
 * `markdown` block; block references, read 2026-10-03). The reference names no limit for a rich
 * text element's text: a section's is kept for each.
 */
function optionWhole(option: QuestionOption): Block {
  const parts: Block[] = [bold(oneLine(option.label, SECTION_LIMIT))];
  const description = strip(option.description ?? "");
  if (description !== "")
    parts.push({ type: "text", text: `\n${cut(description, SECTION_LIMIT)}` });
  const elements: Block[] = [{ type: "rich_text_section", elements: parts }];
  const preview = previewOf(option);
  if (preview !== "") {
    const shown = { type: "text", text: cut(preview, SECTION_LIMIT) };
    elements.push({ type: "rich_text_preformatted", elements: [shown] });
  }
  return { type: "rich_text", elements };
}

/** A question's header for the tab row: cut, not escaped. */
function tabName(question: Question, at: number): string {
  const header = cut(squeezed(question.header), TAB_LIMIT);
  return header !== "" ? header : texts.fill(slackTexts.QUESTION_TAB_UNNAMED, { number: at + 1 });
}

/**
 * The terminal's tab row, as one context line: each question's header with `☒` once answered
 * and `☐` before, the page on screen in bold, then `✔ Submit` (bold on the review page).
 */
function tabRow(draft: Draft, questions: readonly Question[]): Block {
  const cells = questions.map((question, at) => {
    const cell = `${isAnswered(draft, questions, at) ? "☒" : "☐"} ${shownAsWritten(tabName(question, at))}`;
    return at === draft.active ? `*${cell}*` : cell;
  });
  const review = draft.active === questions.length;
  cells.push(review ? `*${slackTexts.QUESTION_TAB_SUBMIT}*` : slackTexts.QUESTION_TAB_SUBMIT);
  return context(cells.join("   "));
}

/** The page that ends a form of several questions: every answer, to read before it is sent. */
function reviewView(draft: Draft, questions: readonly Question[], names: Names): Block {
  const sections = questions.map((question, at) => {
    const answer = answerAt(draft, questions, at);
    const shown = typeof answer === "string" ? answer : (answer ?? []).join(", ");
    let lines = `● ${question.text}\n→ ${shown}`;
    // A note kept for a question with no answer, or answered by Other alone, is not sent, so the
    // page does not show it.
    const noted = draft.notes.get(at);
    if (answer !== null && noted !== undefined && takesNotes(draft, at)) {
      lines += `\n${slackTexts.QUESTION_NOTES}: ${noted}`;
    }
    // Cut as written, on the room the escaped text takes, so no escape is split.
    const [first = "", ...rest] = codeChunks(lines, SECTION_LIMIT - 1);
    const text = `${shownAsWritten(first)}${rest.length > 0 ? "…" : ""}`;
    // One action id per question: Slack wants them unique within a view.
    const edit = button(`question_edit_${at}`, slackTexts.QUESTION_EDIT, String(at));
    return { type: "section", text: { type: "mrkdwn", text }, accessory: edit };
  });
  return {
    type: "modal",
    callback_id: QUESTION_FORM,
    private_metadata: dumpIds(draft),
    title: { type: "plain_text", text: named(slackTexts.QUESTION_TITLE, names) },
    submit: { type: "plain_text", text: slackTexts.QUESTION_SUBMIT_ALL },
    close: { type: "plain_text", text: slackTexts.QUESTION_CLOSE },
    blocks: [
      tabRow(draft, questions),
      { type: "section", text: { type: "mrkdwn", text: slackTexts.QUESTION_REVIEW_HEADING } },
      ...sections,
    ],
  };
}

/**
 * The form, one question at a time, as the terminal's tabs: with several questions a tab row
 * (one context line) names them and tells which are answered, the button reads `Next (1/3)` and
 * leads to the next question (whether or not the others have an answer), and `Review` on the
 * last opens a page that lists every answer with an Edit button (`reviewView`), whose `Submit
 * answers` sends. Once the review was reached (`Draft.reviewed`) every page's button reads
 * `Review`. One question has none of that and its `Submit` sends. Each question needs an answer
 * before the next. The question shows as radio buttons, or checkboxes when several may be
 * picked, each option with its description, and Other as the last option, as the terminal's list
 * ends with its own row for a typed answer (tools reference: "type your own text through the
 * Other row"). The choice is required. While Other is chosen its text field shows, required too;
 * Notes shows while a real option is chosen, not for Other alone. When an option says more than
 * a choice holds (`saysMore`), the question and every option are shown whole above the choice,
 * which keeps the labels alone under the question's header (issue #47).
 */
export function questionView(draft: Draft, questions: readonly Question[], names: Names): Block {
  const blocks: Block[] = [];
  const count = questions.length;
  const at = draft.active;
  if (count > 1 && at === count) return reviewView(draft, questions, names);
  const question = questions[at];
  if (question === undefined) throw new RangeError(`no question ${at}`);
  if (count > 1) blocks.push(tabRow(draft, questions));
  const whole = saysMore(question);
  let label = oneLine(question.text, LABEL_LIMIT);
  if (whole) {
    const asked = { type: "rich_text_section", elements: [bold(label)] };
    blocks.push({ type: "rich_text", elements: [asked] });
    blocks.push(...question.options.map(optionWhole));
    // A header of blanks alone would leave the choice an empty label, which Slack refuses.
    const header = strip(question.header);
    label = oneLine(header !== "" ? header : slackTexts.QUESTION_ANSWER, LABEL_LIMIT);
  }
  const options = question.options.map((o, i) => optionEntry(i, o, !whole));
  const otherOption: Block = {
    text: { type: "plain_text", text: slackTexts.QUESTION_OTHER },
    description: { type: "plain_text", text: slackTexts.QUESTION_OTHER_HINT },
    value: OTHER_VALUE,
  };
  const wantsOther = draft.other.has(at);
  const element: Block = {
    type: question.multiSelect ? "checkboxes" : "radio_buttons",
    action_id: "answer",
    options: [...options, otherOption],
  };
  const real = (draft.picks.get(at) ?? []).flatMap((i) => options[i] ?? []);
  const picked = [...real, ...(wantsOther ? [otherOption] : [])];
  if (picked.length > 0 && question.multiSelect) {
    element.initial_options = picked;
  } else if (picked.length > 0) {
    element.initial_option = picked[0];
  }
  // A change of the choice redraws the form (`Requests.onQuestionChoice`): Other's field and
  // Notes come and go with it. The two text fields only report to the draft, so that a form
  // closed with Close and opened again finds what was typed.
  blocks.push({
    type: "input",
    block_id: `q${at}`,
    dispatch_action: true,
    label: { type: "plain_text", text: label },
    element,
  });
  const typing = { trigger_actions_on: ["on_character_entered"] };
  if (wantsOther) {
    const other: Block = {
      type: "plain_text_input",
      action_id: "other",
      max_length: TYPED_LIMIT,
      placeholder: { type: "plain_text", text: slackTexts.QUESTION_OTHER_HINT },
      dispatch_action_config: typing,
    };
    const typed = draft.typed.get(at);
    if (typed) other.initial_value = typed;
    blocks.push({
      type: "input",
      block_id: `o${at}`,
      dispatch_action: true,
      label: { type: "plain_text", text: slackTexts.QUESTION_YOUR_ANSWER },
      element: other,
    });
  }
  if (real.length > 0) {
    const notes: Block = {
      type: "plain_text_input",
      action_id: "notes",
      max_length: NOTES_LIMIT,
      placeholder: { type: "plain_text", text: slackTexts.QUESTION_NOTES_HINT },
      dispatch_action_config: typing,
    };
    const noted = draft.notes.get(at);
    if (noted) notes.initial_value = noted;
    blocks.push({
      type: "input",
      block_id: `n${at}`,
      optional: true,
      dispatch_action: true,
      label: { type: "plain_text", text: slackTexts.QUESTION_NOTES },
      element: notes,
    });
  }
  const last = at === count - 1;
  return {
    type: "modal",
    callback_id: QUESTION_FORM,
    private_metadata: dumpIds(draft),
    title: { type: "plain_text", text: named(slackTexts.QUESTION_TITLE, names) },
    submit: {
      type: "plain_text",
      text:
        count === 1
          ? "Submit"
          : last || draft.reviewed
            ? slackTexts.QUESTION_REVIEW
            : texts.fill(slackTexts.QUESTION_NEXT, { number: at + 1, count }),
    },
    close: { type: "plain_text", text: slackTexts.QUESTION_CLOSE },
    blocks,
  };
}

/**
 * The question form once its channel is refused: `told` alone, with no Submit and no draft.
 * Slack lets an app close a modal only in answer to a submission, so the open one is replaced.
 */
export function refusedView(told: string, names: Names): Block {
  return {
    type: "modal",
    title: { type: "plain_text", text: named(slackTexts.QUESTION_TITLE, names) },
    close: { type: "plain_text", text: slackTexts.QUESTION_CLOSE },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: told } }],
  };
}
