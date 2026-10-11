/**
 * `guideText`: the guide is made of parts, each shown only when the pair declares what it
 * describes. `FULL_GUIDE` is the guide of `main` with Claude and Slack's names in it, written
 * out; the parts are never used to build an expectation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type GuideOffer, guideText } from "../../src/core/guide.ts";
import { EVERYTHING_OFFERED } from "../support/guide-offer.ts";
import { NAMES } from "../support/names.ts";

const FULL_GUIDE = [
  "**awaydesk**",
  "This channel runs Claude Code on your Mac, in one folder, and answers you alone. One Slack thread is one Claude Code session: a top-level message starts a new one, and a reply inside its thread continues it, even days later.",
  "",
  "**Get started**",
  "1. `!bind` lists the folders Claude Code trusts, with a Bind button each; `!bind <folder>` binds one by its path relative to your allowed root: `!bind my-project`. Claude Code must trust that folder first: open `claude` there once in the terminal and accept. `!bind` works only as a top-level message in the channel.",
  "2. Write a message in the channel: it opens a session, and its reply appears in a thread of its own, growing as Claude works, with a line for each tool it uses. Reply inside that thread to continue the same session. Attach images or files to a message: Claude sees a JPEG, PNG, GIF or WebP image directly (other image types are refused) and reads a text, code, PDF, JSON, XML, YAML or notebook file from a copy saved on this Mac; other files are refused.",
  "3. Before that first message is sent, the thread asks for the **Model**, the **Effort** (`Default` leaves Claude Code's own choice) and **Bypass permissions**; **Start** sends your message with those choices, and `!stop` cancels it instead.",
  "",
  "**Commands**",
  "Claude Code's commands start with `!` instead of `/`: `!compact`, `!model opus`. They run inside a session's thread, where `!help` lists every command that session offers, and `!help <text>` filters the list; typed in the channel, `!help` lists awaydesk's own words instead. `!clear` (`!reset`, `!new`) is refused inside a thread (one thread is one session): start a fresh session with a new top-level message instead.",
  "",
  "**Approvals and questions**",
  "When Claude Code asks permission, the request shows what will run, with **Approve** and **Deny**; a very long one shows its start and its end and says how much it leaves out. A question from Claude comes with **Answer**, which opens a short form, and **Skip**.",
  "",
  "**Sessions**",
  "`!status` typed in the channel lists the folder and every session still live, each linked to its thread; inside a thread it shows that session's directory, mode and the footer's values. `!stop` typed in the channel stops every running session and its background tasks; inside a thread it stops only that one. `!resume`, typed in the channel only, lists this folder's twenty newest sessions, from the terminal too, each with the start of its id and a **Resume** button; `!resume <id>` (that start is enough), or `!resume <title>` for a session that has one, resumes it in the thread of your `!resume` message. To continue a session in the terminal, run the `Terminal:` command `!status` shows in its thread.",
  "",
  "**Files**",
  "`!open`, sent inside a session's thread, offers the files changed in that session and a search over the folder's files; choosing one shares it into the thread, where Slack opens it in its file viewer, with Markdown rendered. `!open <path>` opens that file, and `!open <words>` the file whose path contains them, or lists the files that do. The search reads the folder from disk and leaves out what `.gitignore` excludes inside a git repository. A file over 1 MB is not opened.",
  "",
  "**Bypass**",
  "`!bypass on`, sent inside a session's thread, lets Claude Code run every tool without asking in that session, until `!bypass off`; a restart of awaydesk keeps it. The footer shows ⚡ bypass while it is on.",
  "",
  "`!guide` shows this text again.",
].join("\n");

const EVERYTHING = EVERYTHING_OFFERED;

const FULL_LINES = FULL_GUIDE.split("\n");

function linesOf(offer: Partial<GuideOffer>): string[] {
  return guideText(NAMES, { ...EVERYTHING, ...offer }).split("\n");
}

/** The lines the variant lost and the lines it gained, in their order, blank lines apart. */
function difference(variant: readonly string[]): { removed: string[]; added: string[] } {
  const kept = new Set(variant);
  const had = new Set(FULL_LINES);
  return {
    removed: FULL_LINES.filter((line) => line !== "" && !kept.has(line)),
    added: variant.filter((line) => line !== "" && !had.has(line)),
  };
}

function line(startsWith: string): string {
  const found = FULL_LINES.find((candidate) => candidate.startsWith(startsWith));
  assert.ok(found !== undefined, startsWith);
  return found;
}

const STEP_ONE = line("1. `!bind`");
const STEP_THREE = line("3. Before that first message");
const COMMANDS = ["**Commands**", line("Claude Code's commands start")];
const APPROVALS = line("When Claude Code asks permission");
const SESSIONS = line("`!status` typed in the channel");
const FILES = ["**Files**", line("`!open`, sent inside")];
const BYPASS = ["**Bypass**", line("`!bypass on`")];

const EFFORT = "the **Effort** (`Default` leaves Claude Code's own choice)";
const STEP_THREE_HEAD = "3. Before that first message is sent, the thread asks for ";
const STEP_THREE_TAIL =
  "; **Start** sends your message with those choices, and `!stop` cancels it instead.";

test("with everything offered the guide is the one the owner reads today", () => {
  assert.equal(guideText(NAMES, EVERYTHING), FULL_GUIDE);
});

test("the guide never has two blank lines in a row, whatever is left out", () => {
  for (const key of Object.keys(EVERYTHING) as (keyof GuideOffer)[]) {
    assert.ok(
      !linesOf({ [key]: false })
        .join("\n")
        .includes("\n\n\n"),
      key,
    );
  }
  const nothing = Object.fromEntries(Object.keys(EVERYTHING).map((key) => [key, false]));
  const bare = guideText(NAMES, nothing as unknown as GuideOffer);
  assert.ok(!bare.includes("\n\n\n"));
  assert.ok(bare.startsWith("**awaydesk**\n") && bare.endsWith("`!guide` shows this text again."));
});

test("without folderTrust the first step names no trust", () => {
  const { removed, added } = difference(linesOf({ folderTrust: false }));
  assert.deepEqual(removed, [STEP_ONE]);
  assert.deepEqual(added, [
    "1. `!bind` lists the folders under your allowed root, with a Bind button each; `!bind <folder>` binds one by its path relative to your allowed root: `!bind my-project`. `!bind` works only as a top-level message in the channel.",
  ]);
});

test("without models the third step leaves the Model out", () => {
  const { removed, added } = difference(linesOf({ models: false }));
  assert.deepEqual(removed, [STEP_THREE]);
  assert.deepEqual(added, [
    `${STEP_THREE_HEAD}${EFFORT} and **Bypass permissions**${STEP_THREE_TAIL}`,
  ]);
});

test("without efforts the third step leaves the Effort out", () => {
  const { removed, added } = difference(linesOf({ efforts: false }));
  assert.deepEqual(removed, [STEP_THREE]);
  assert.deepEqual(added, [
    `${STEP_THREE_HEAD}the **Model** and **Bypass permissions**${STEP_THREE_TAIL}`,
  ]);
});

test("without bypass the third step and the Bypass section leave it out", () => {
  const { removed, added } = difference(linesOf({ bypass: false }));
  assert.deepEqual(removed, [STEP_THREE, ...BYPASS]);
  assert.deepEqual(added, [`${STEP_THREE_HEAD}the **Model** and ${EFFORT}${STEP_THREE_TAIL}`]);
});

test("without commands the Commands section is gone", () => {
  const { removed, added } = difference(linesOf({ commands: false }));
  assert.deepEqual(removed, COMMANDS);
  assert.deepEqual(added, []);
});

test("without questions the section is titled and worded for approvals alone", () => {
  const { removed, added } = difference(linesOf({ questions: false }));
  assert.deepEqual(removed, ["**Approvals and questions**", APPROVALS]);
  assert.deepEqual(added, [
    "**Approvals**",
    "When Claude Code asks permission, the request shows what will run, with **Approve** and **Deny**; a very long one shows its start and its end and says how much it leaves out.",
  ]);
  assert.ok(APPROVALS.startsWith(added[1] ?? ""), "the first sentence is the same");
});

test("without backgroundTasks the stop sentence names no background task", () => {
  const { removed, added } = difference(linesOf({ backgroundTasks: false }));
  assert.deepEqual(removed, [SESSIONS]);
  assert.deepEqual(added, [SESSIONS.replace(" and its background tasks", "")]);
});

test("without sessionListing the Sessions section says nothing of !resume", () => {
  const { removed, added } = difference(linesOf({ sessionListing: false }));
  assert.deepEqual(removed, [SESSIONS]);
  const from = SESSIONS.indexOf(" `!resume`, typed in the channel only");
  const to = SESSIONS.indexOf(" To continue a session in the terminal");
  assert.ok(from > 0 && to > from);
  assert.deepEqual(added, [SESSIONS.slice(0, from) + SESSIONS.slice(to)]);
  assert.ok(added[0]?.includes("inside a thread it stops only that one. To continue"));
});

test("without fileUpload the Files section is gone", () => {
  const { removed, added } = difference(linesOf({ fileUpload: false }));
  assert.deepEqual(removed, FILES);
  assert.deepEqual(added, []);
});

// Step 3's list: each of the seven combinations of the three items, and none.

const STEP_THREE_LISTS: readonly [Pick<GuideOffer, "models" | "efforts" | "bypass">, string][] = [
  [
    { models: true, efforts: true, bypass: true },
    `the **Model**, ${EFFORT} and **Bypass permissions**`,
  ],
  [{ models: true, efforts: true, bypass: false }, `the **Model** and ${EFFORT}`],
  [{ models: true, efforts: false, bypass: true }, "the **Model** and **Bypass permissions**"],
  [{ models: false, efforts: true, bypass: true }, `${EFFORT} and **Bypass permissions**`],
  [{ models: true, efforts: false, bypass: false }, "the **Model**"],
  [{ models: false, efforts: true, bypass: false }, EFFORT],
  [{ models: false, efforts: false, bypass: true }, "**Bypass permissions**"],
];

test("step 3 lists the items on offer, joined as English joins a list", () => {
  for (const [offer, list] of STEP_THREE_LISTS) {
    const step = linesOf(offer).filter((candidate) => candidate.startsWith("3. "));
    assert.deepEqual(step, [`${STEP_THREE_HEAD}${list}${STEP_THREE_TAIL}`], JSON.stringify(offer));
  }
});

test("step 3 is left out when none of its items is offered", () => {
  const lines = linesOf({ models: false, efforts: false, bypass: false });
  assert.deepEqual(
    lines.filter((candidate) => /^\d\. /.test(candidate)).map((candidate) => candidate.slice(0, 2)),
    ["1.", "2."],
  );
  assert.ok(!lines.join("\n").includes("**Start**"));
});
