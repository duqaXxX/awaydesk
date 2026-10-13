import assert from "node:assert/strict";
import { test } from "node:test";
import type { Preview, TaskStatus, TaskUpdate } from "../../../src/chat/seam.ts";
import { Fold, shownPreview } from "../../../src/core/reply/fold.ts";
import { STOPPED } from "../../../src/core/reply/words.ts";

function call(
  id: string,
  name: string,
  status: TaskStatus = "in_progress",
  fields: Partial<TaskUpdate> = {},
): TaskUpdate {
  return {
    id,
    title: `${name}: ${id}`,
    status,
    details: null,
    output: null,
    name,
    task: false,
    calls: 0,
    preview: null,
    folded: null,
    ...fields,
  };
}

function preview(title: string, summary: string, body: string, language: "" | "diff"): Preview {
  return { title, summary, body, language, plain: false };
}

function shown(cards: TaskUpdate[]): [string, string, string][] {
  return cards.map((card) => [card.id, card.status, card.title]);
}

// A run is one card (issue #299, the terminal's form captured on Claude Code 2.1.296): the call
// that runs now, then the counts of what ended.

test("a single call is one card: the call while it runs, its count once it ended", () => {
  const fold = new Fold();
  assert.deepEqual(shown(fold.task(call("a", "Bash"))), [["fold:a", "in_progress", "Bash: a"]]);
  assert.deepEqual(shown(fold.task(call("a", "Bash", "complete"))), [
    ["fold:a", "complete", "Ran 1 shell command"],
  ]);
});

test("the card shows the call that runs, and nothing of the calls before it", () => {
  const fold = new Fold();
  fold.task(call("a", "Bash"));
  fold.task(call("a", "Bash", "complete"));
  assert.deepEqual(shown(fold.task(call("b", "Read"))), [["fold:a", "in_progress", "Read: b"]]);
  assert.deepEqual(shown(fold.task(call("b", "Read", "complete"))), [
    ["fold:a", "complete", "Ran 1 shell command, read 1 file"],
  ]);
});

test("the counts are joined by a comma and only the first takes a capital", () => {
  const fold = new Fold();
  fold.task(call("a", "Read", "complete"));
  fold.task(call("b", "Bash", "complete"));
  fold.task(call("c", "Grep", "complete"));
  fold.task(call("d", "Grep", "complete"));
  const [card] = fold.task(call("e", "Bash", "complete"));
  assert.equal(card?.title, "Read 1 file, ran 2 shell commands, Grep ×2");
});

test("a failed command is counted with the others, with no mark", () => {
  const fold = new Fold();
  fold.task(call("a", "Read", "complete"));
  fold.task(call("b", "Bash"));
  assert.deepEqual(shown(fold.task(call("b", "Bash", "error", { output: "Exit code 1" }))), [
    ["fold:a", "complete", "Read 1 file, ran 1 shell command"],
  ]);
});

test("counts of failures alone show as an error card", () => {
  const fold = new Fold();
  const cards = fold.task(call("a", "Bash", "error", { output: "Exit code 1" }));
  assert.deepEqual(shown(cards), [["fold:a", "error", "Ran 1 shell command"]]);
});

test("a failed call of a tool the terminal has no count for keeps a card that says why", () => {
  const fold = new Fold();
  fold.task(call("a", "Bash", "complete"));
  fold.task(call("w", "WebFetch"));
  const cards = fold.task(call("w", "WebFetch", "error", { output: "404" }));
  assert.deepEqual(
    cards.map((card) => [card.id, card.status, card.title, card.output, card.folded]),
    [
      ["w", "error", "WebFetch: w", "404", null],
      ["fold:a", "complete", "Ran 1 shell command", null, "Ran 1 shell command"],
    ],
  );
});

test("the card of a run carries no details and no output", () => {
  const fold = new Fold();
  const cards = fold.task(call("a", "Bash", "in_progress", { details: "doing" }));
  cards.push(...fold.task(call("a", "Bash", "error", { output: "Exit code 1" })));
  cards.push(...fold.task(call("b", "Read")));
  assert.ok(cards.every((card) => card.details === null && card.output === null));
});

test("calls running together show the last one started that still runs", () => {
  const fold = new Fold();
  fold.task(call("a", "Read"));
  assert.deepEqual(shown(fold.task(call("b", "Read"))), [["fold:a", "in_progress", "Read: b"]]);
  // b ends first: a, still running, is the call shown.
  assert.deepEqual(shown(fold.task(call("b", "Read", "complete"))), [
    ["fold:a", "in_progress", "Read: a"],
  ]);
  assert.deepEqual(shown(fold.task(call("a", "Read", "complete"))), [
    ["fold:a", "complete", "Read 2 files"],
  ]);
});

test("text ends the run", () => {
  const fold = new Fold();
  fold.task(call("a", "Bash", "complete"));
  fold.text();
  assert.deepEqual(shown(fold.task(call("b", "Bash"))), [["fold:b", "in_progress", "Bash: b"]]);
  // A call of the earlier run still updates that run's card.
  assert.deepEqual(fold.task(call("a", "Bash", "complete")), []);
});

test("the line that replaces the card is its counts, and a running call has none", () => {
  const fold = new Fold();
  assert.equal(fold.task(call("a", "Bash"))[0]?.folded, null);
  assert.equal(fold.task(call("a", "Bash", "complete"))[0]?.folded, "Ran 1 shell command");
  assert.equal(fold.task(call("b", "Read"))[0]?.folded, null);
  assert.equal(
    fold.task(call("b", "Read", "complete"))[0]?.folded,
    "Ran 1 shell command, read 1 file",
  );
});

test("a call with a card of its own passes through and ends the run", () => {
  const fold = new Fold();
  fold.task(call("a", "Bash", "complete"));
  const agent = call("t", "Skill", "in_progress", { task: true, details: "Read: x" });
  assert.deepEqual(fold.task(agent), [agent]);
  assert.deepEqual(shown(fold.task(call("b", "Bash"))), [["fold:b", "in_progress", "Bash: b"]]);
});

test("an edit that ends with a preview keeps the card that showed it", () => {
  const fold = new Fold();
  fold.task(call("e", "Edit"));
  const view = preview("Update(notes.txt)", "Added 1 line", "1 +x", "diff");
  const cards = fold.task(call("e", "Edit", "complete", { preview: view }));
  assert.deepEqual(
    cards.map((card) => [card.id, shownPreview(card), card.folded]),
    [["fold:e", view, null]],
  );
  // The run is over: the next call starts one of its own.
  assert.deepEqual(shown(fold.task(call("b", "Bash"))), [["fold:b", "in_progress", "Bash: b"]]);
});

test("an edit that arrives ended ends the run and is not counted", () => {
  // Issue #136: the renderer sends an Edit only once it has ended.
  const fold = new Fold();
  fold.task(call("a", "Bash"));
  fold.task(call("a", "Bash", "complete"));
  const view = preview("Update(notes.txt)", "Added 1 line", "1 +x", "diff");
  const done = call("e", "Edit", "complete", { preview: view });
  assert.deepEqual(fold.task(done), [done]); // as it came: nothing of the run changes
  assert.deepEqual(shown(fold.task(call("b", "Bash"))), [["fold:b", "in_progress", "Bash: b"]]);
});

test("an edit that arrives failed has a card of its own that says why", () => {
  const fold = new Fold();
  fold.task(call("a", "Bash"));
  fold.task(call("a", "Bash", "complete"));
  const failed = call("e", "Edit", "error", { output: "No such file" });
  assert.deepEqual(fold.task(failed), [failed]);
});

test("the only call of a run that becomes a task keeps the run's card", () => {
  const fold = new Fold();
  fold.task(call("b", "Bash"));
  const cards = fold.task(
    call("b", "Bash", "in_progress", { task: true, details: "Running in background" }),
  );
  assert.deepEqual(
    cards.map((card) => [card.id, card.task, card.details]),
    [["fold:b", true, "Running in background"]],
  );
  // Later states of that call keep going to the card it took.
  assert.deepEqual(
    fold.task(call("b", "Bash", "complete", { task: true })).map((card) => card.id),
    ["fold:b"],
  );
});

test("a call that becomes a task after others ended gets a card under their counts", () => {
  const fold = new Fold();
  fold.task(call("a", "Read", "complete"));
  fold.task(call("b", "Bash"));
  const cards = fold.task(
    call("b", "Bash", "in_progress", { task: true, details: "Running in background" }),
  );
  assert.deepEqual(
    cards.map((card) => [card.id, card.title, card.task]),
    [
      ["b", "Bash: b", true],
      ["fold:a", "Read 1 file", false],
    ],
  );
});

test("a stopped call keeps its card and its word", () => {
  const fold = new Fold();
  fold.task(call("a", "Bash"));
  const cards = fold.task(call("a", "Bash", "complete", { output: STOPPED }));
  assert.deepEqual(
    cards.map((card) => [card.id, card.output, card.folded]),
    [["fold:a", STOPPED, null]],
  );
});

test("a call that leaves a run with a call still running gets a card of its own", () => {
  const fold = new Fold();
  fold.task(call("a", "Read"));
  fold.task(call("b", "Skill"));
  const cards = fold.task(call("b", "Skill", "in_progress", { task: true, calls: 1 }));
  assert.deepEqual(
    cards.map((card) => [card.id, card.title]),
    [
      ["b", "Skill: b"],
      ["fold:a", "Read: a"],
    ],
  );
  // Each keeps to its own card from here on.
  assert.deepEqual(
    fold.task(call("b", "Skill", "complete", { task: true })).map((c) => c.id),
    ["b"],
  );
  assert.deepEqual(shown(fold.task(call("a", "Read", "complete"))), [
    ["fold:a", "complete", "Read 1 file"],
  ]);
});

test("two calls that become tasks never share a card", () => {
  const fold = new Fold();
  fold.task(call("a", "Skill"));
  fold.task(call("b", "Skill"));
  const first = fold.task(call("b", "Skill", "in_progress", { task: true, calls: 1 }));
  const second = fold.task(call("a", "Skill", "in_progress", { task: true, calls: 1 }));
  assert.ok(first[0]?.title === "Skill: b" && second[0]?.title === "Skill: a");
  assert.notEqual(first[0]?.id, second[0]?.id);
});

test("a counted call that stops folding leaves the line to the calls that remain", () => {
  const fold = new Fold();
  fold.task(call("a", "Skill", "complete"));
  fold.task(call("b", "Read"));
  fold.task(call("a", "Skill", "complete", { task: true, calls: 1 }));
  const cards = fold.task(call("b", "Read", "complete"));
  assert.deepEqual(
    cards.map((card) => [card.title, card.folded]),
    [["Read 1 file", "Read 1 file"]],
  );
});
