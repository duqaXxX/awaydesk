/**
 * The list of what still runs in a thread: one card under the thread's last reply at rest, above
 * the footer, with a title and a line per task. Each test replays a recording over the real
 * Slack provider on the fake Slack and reads the card back from the blocks of the messages.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../support/fixtures.ts";
import { harnessFor, isResult, sdkMessages } from "../../support/sessions.ts";
import {
  inside,
  isReport,
  renamedBackground,
  splitBackground,
  splitNestedBackground,
  workerHolds,
} from "./helpers.ts";

const LIST_ID = "running-list";

/** The list's card among a message's blocks, as the fake read it back. */
function card(blocks: readonly JsonObject[]): JsonObject | null {
  return blocks.find((block) => block.block_id === LIST_ID) ?? null;
}

/** The text of a card's details: its lines, one per line. */
function linesOf(block: JsonObject | null): string[] {
  const details = block?.details as JsonObject | undefined;
  if (details === undefined) return [];
  const sections = details.elements as JsonObject[];
  return sections
    .flatMap((section) => section.elements as JsonObject[])
    .map((element) => String(element.text))
    .join("")
    .split("\n");
}

/** Which message of the thread holds the card, by position among the replies' messages. */
function holders(blocks: readonly (readonly JsonObject[])[]): number[] {
  return blocks.flatMap((message, index) => (card(message) === null ? [] : [index]));
}

const answer = sdkMessages("foreground");

test("a reply that waits on a command shows the list and no footer, and the end removes it; the end of the session draws the footer", async (t) => {
  const [first, notice, injected] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).length === 1);
  const blocks = h.slack.messageBlocks().at(-1) ?? [];
  const list = card(blocks);
  assert.equal(list?.type, "task_card");
  assert.equal(list?.task_id, LIST_ID);
  assert.equal(list?.title, "1 shell still running");
  assert.equal(list?.status, "in_progress");
  assert.deepEqual(linesOf(list), ["Sleep for 5 seconds then print done"]);
  // The session has not ended: the list is the message's last block and no footer sits below it.
  assert.equal(blocks.at(-1)?.type, "task_card");
  assert.ok(!blocks.some((block) => block.type === "divider"));
  assert.ok(!JSON.stringify(h.slack.messageBlocks()).includes("⏳"));
  h.clients[0]?.inject([...notice, ...injected]);
  await h.until(() => holders(h.slack.messageBlocks()).length === 0);
  await h.until(() => session.idle);
  await h.sleep(3);
  assert.equal(h.slack.messageBlocks().at(-1)?.at(-2)?.type, "divider");
  assert.ok(!JSON.stringify(h.slack.messageBlocks()).includes("⏳"));
});

test("a subagent, then the command it left running: the list follows, a task's end takes its line off", async (t) => {
  const [first, work, report, later, second] = splitNestedBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).length === 1);
  let list = card(h.slack.messageBlocks().at(-1) ?? []);
  assert.equal(list?.title, "1 agent still running");
  assert.deepEqual(linesOf(list), ["general-purpose  Launch background sleep command"]);
  // The agent ends and the command it started goes on alone: the agent's line is gone. (The
  // command counts from the agent's end on: a task started inside a call is promoted then.)
  h.clients[0]?.inject([...work, ...report]);
  await h.until(
    () => card(h.slack.messageBlocks().at(-1) ?? [])?.title === "1 shell still running",
  );
  list = card(h.slack.messageBlocks().at(-1) ?? []);
  assert.deepEqual(linesOf(list), ["Sleep for 20 seconds then echo done"]);
  assert.equal(holders(h.slack.messageBlocks()).length, 1);
  // The last task's end takes the card off.
  h.clients[0]?.inject(later);
  h.clients[0]?.inject(second);
  await h.until(() => session.idle && holders(h.slack.messageBlocks()).length === 0, 3.0);
  assert.ok(!JSON.stringify(h.slack.messageBlocks()).includes("⏳"));
});

test("two commands: a line each, in the order they started, and one end takes its own off", async (t) => {
  const [first, notice] = splitBackground();
  const [firstB] = renamedBackground();
  const h = harnessFor(t)({ turns: [first, firstB] });
  const session = h.session();
  await (await session.submit("start A")).done.wait();
  await (await session.submit("start B")).done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).join() === "1");
  const list = card(h.slack.messageBlocks().at(-1) ?? []);
  assert.equal(list?.title, "2 shells still running");
  assert.equal(linesOf(list).length, 2);
  // The recordings give both commands one description: tell them apart as the session stores
  // them (`recordTask` keeps `[kind, description]`), keeping the order they started in.
  const tasks = inside(session).tasks;
  tasks.set("bny2rux7d", ["command", "first sleeper"]);
  tasks.set("bc41other", ["command", "second sleeper"]);
  // A reply is registered for a task when its turn closes, a nested task's at its start: the
  // map of replies can hold the tasks in another order than they started in. Put it so.
  const replies = inside(session).taskReplies;
  const firstReply = replies.get("bny2rux7d");
  assert.ok(firstReply !== undefined);
  replies.delete("bny2rux7d");
  replies.set("bny2rux7d", firstReply);
  assert.deepEqual([...replies.keys()], ["bc41other", "bny2rux7d"]);
  inside(session).showRunning();
  await h.until(() =>
    linesOf(card(h.slack.messageBlocks().at(-1) ?? [])).includes("first sleeper"),
  );
  assert.deepEqual(linesOf(card(h.slack.messageBlocks().at(-1) ?? [])), [
    "first sleeper",
    "second sleeper",
  ]);
  h.clients[0]?.inject(notice); // A ends
  await h.until(
    () => card(h.slack.messageBlocks().at(-1) ?? [])?.title === "1 shell still running",
  );
  assert.deepEqual(linesOf(card(h.slack.messageBlocks().at(-1) ?? [])), ["second sleeper"]);
  assert.equal(holders(h.slack.messageBlocks()).length, 1);
});

test("a long description is cut to one line of 80, and a task with none shows its call's title", async (t) => {
  // No recording holds a description over 80 characters or an empty one: the session's records
  // are set as `recordTask` stores them (`[kind, description]`) through the test interface.
  const [first] = splitBackground();
  const [firstB] = renamedBackground();
  const h = harnessFor(t)({ turns: [first, firstB] });
  const session = h.session();
  await (await session.submit("start A")).done.wait();
  await (await session.submit("start B")).done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).join() === "1");
  const tasks = inside(session).tasks;
  tasks.set("bny2rux7d", ["command", `${"long ".repeat(40)}end`]);
  tasks.set("bc41other", ["subagent", ""]);
  const fallback = inside(session).taskReplies.get("bc41other")?.taskTitle("bc41other");
  assert.ok(typeof fallback === "string" && fallback !== "", "the reply has a title for the task");
  const shown = inside(session).runningList();
  assert.equal(shown?.lines.length, 2);
  assert.ok(
    (shown?.lines[0] ?? "").length <= 80 && (shown?.lines[0] ?? "").startsWith("long long"),
  );
  assert.ok(!(shown?.lines[0] ?? "").includes("end"), "the description is cut");
  assert.equal(shown?.lines[1], fallback);
  inside(session).showRunning();
  await h.until(() =>
    linesOf(card(h.slack.messageBlocks().at(-1) ?? [])).includes(String(fallback)),
  );
});

test("a reply written below takes the list once it rests, and the first loses it", async (t) => {
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first, answer] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).length === 1);
  assert.deepEqual(holders(h.slack.messageBlocks()), [0]);
  await (await session.submit("and now?")).done.wait();
  await h.until(
    () => h.slack.messageBlocks().length === 2 && holders(h.slack.messageBlocks()).length === 1,
  );
  await h.until(() => holders(h.slack.messageBlocks())[0] === 1);
  assert.deepEqual(holders(h.slack.messageBlocks()), [1]);
  // The first reply carries no footer, with the list taken off by an edit: B's command still runs.
  const firstBlocks = h.slack.messageBlocks()[0] ?? [];
  assert.ok(!firstBlocks.some((block) => block.type === "divider"));
  assert.ok(!JSON.stringify(h.slack.messageBlocks()).includes("⏳"));
});

test("while the reply written below is still a stream, the list stays on the first", async (t) => {
  const [first] = splitBackground();
  const tools = sdkMessages("tools");
  const result = tools.findLastIndex((item) => isResult(item));
  assert.ok(result > 0);
  const h = harnessFor(t)({ turns: [first, tools.slice(0, result)] });
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).length === 1);
  const second = await session.submit("list the files");
  await h.until(() => h.slack.streamTs.length === 2);
  await h.sleep(0.2);
  assert.deepEqual(holders(h.slack.messageBlocks()), [0], "the stream below holds none");
  h.clients[0]?.inject(tools.slice(result));
  await second.done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).join() === "1");
});

test("a report turn opened below the owner's message: the list sits under the prompt's reply (Task 3)", async (t) => {
  // H waits on task A; B is started by the owner's next message, so H is not the last reply when
  // A's notification arrives. The owner's prompt is told to the places and submitted, its reply
  // exists with no message, and the report turn opens R below it: the thread reads H, the
  // message that started B, B's reply, the prompt, R, then the prompt's reply.
  const [first, notice, injected] = splitBackground();
  const [firstB] = renamedBackground();
  const h = harnessFor(t)({ turns: [first, firstB, answer] });
  const session = h.session();
  await (await session.submit("start A")).done.wait();
  await (await session.submit("start B")).done.wait();
  h.clients[0]?.inject(notice);
  await h.idle();
  const prompt = await session.submit("and now?");
  await workerHolds(h, session, prompt);
  h.clients[0]?.inject(injected);
  await prompt.done.wait();
  await h.until(() => inside(session).active === null);
  await h.idle();
  const replies = h.replies();
  const report = replies.findIndex(isReport);
  assert.ok(report > 1, replies.join("\n---\n"));
  assert.equal(report, replies.length - 2, "the prompt's reply is written below the report");
  // B still runs: its list sits under the prompt's reply, the last, and nowhere else.
  await h.until(() => holders(h.slack.messageBlocks()).join() === String(replies.length - 1));
  const list = card(h.slack.messageBlocks().at(-1) ?? []);
  assert.equal(list?.title, "1 shell still running");
  assert.deepEqual(linesOf(list), ["Sleep for 5 seconds then print done"]);
  assert.equal(card(h.slack.messageBlocks()[report] ?? []), null, "the report shows none");
  assert.ok(!JSON.stringify(h.slack.messageBlocks()).includes("⏳"));
  // B still runs: the session has not ended, and no reply shows a footer.
  assert.deepEqual(
    h.slack.messageBlocks().map((blocks) => blocks.filter((b) => b.type === "divider").length),
    [0, 0, 0, 0],
  );
});

test("a task with no description and an empty title shows its id", async (t) => {
  // The title a reply holds for a task can be an empty string; `??` would keep it. The session's
  // record is set as `recordTask` stores it, and the renderer's answer is the one a line with no
  // title gives.
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("start A")).done.wait();
  await h.until(() => holders(h.slack.messageBlocks()).join() === "0");
  inside(session).tasks.set("bny2rux7d", ["command", ""]);
  const renderer = inside(session).taskReplies.get("bny2rux7d");
  assert.ok(renderer !== undefined);
  t.mock.method(renderer, "taskTitle", () => "");
  assert.deepEqual(inside(session).runningList()?.lines, ["bny2rux7d"]);
});
