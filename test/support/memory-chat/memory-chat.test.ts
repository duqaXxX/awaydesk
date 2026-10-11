/**
 * The memory chat's own behaviour, beyond what the conformance suite asks of any provider: the
 * names it makes, the date it records, what a reply shows, the calls it records for a capability
 * it lacks, and the chat outliving a provider.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatInbound, TaskUpdate } from "../../../src/chat/seam.ts";
import { memoryChat, OWNER } from "../memory-chat.ts";

let now = 1_780_000_000;
const CLOCK = { sleep: async () => {}, time: () => now };

const NOBODY: ChatInbound = {
  message: async () => {},
  answer: async () => true,
  picked: async () => {},
};

async function built(chat = memoryChat()) {
  const provider = await chat.build({
    variables: {},
    allowedRoot: "/work",
    clock: CLOCK,
    steady: CLOCK,
    core: () => {
      throw new Error("the memory chat never reads the core");
    },
  });
  return { chat, provider, channel: chat.openChannel("work") };
}

function line(id: string, title: string, folded: string | null = null): TaskUpdate {
  return {
    id,
    title,
    status: "complete",
    details: null,
    output: null,
    name: "Read",
    task: false,
    calls: 0,
    preview: null,
    folded,
  };
}

test("its names are no numbers, and a thread is dated from the clock of its context", async () => {
  const { chat, provider, channel } = await built();
  await provider.start(NOBODY);
  now = 1_780_000_100;
  const sent = await chat.as(OWNER).says(channel, "hello");
  for (const name of [sent.id, sent.ref.thread, channel]) {
    assert.ok(Number.isNaN(Number(name)), `${name} reads as a number`);
  }
  assert.equal(provider.openedAt(sent.ref), 1_780_000_100);
  assert.equal(provider.openedAt({ channel, thread: "nothing" }), null);
});

test("a reply is one message: text and task lines in order, the footer, then what runs", async () => {
  const { chat, provider, channel } = await built();
  const ref = chat.openThread(channel);
  const reply = provider.thread(ref).openReply(() => {});
  await reply.text("First words\n\n");
  await reply.task(line("a", "Read a.txt"));
  await reply.text("More words");
  await reply.task(line("a", "Read a.txt (again)"));
  await reply.task(line("b", "Read b.txt", "Read 1 file"));
  await reply.task(line("c", "Read c.txt", ""));
  assert.deepEqual(chat.texts(channel, ref.thread).slice(1), [
    "First words\n[complete] Read a.txt (again)\nMore words\n[complete] Read b.txt\n[complete] Read c.txt",
  ]);
  await reply.finish([]);
  await reply.closeOut({
    bypass: true,
    model: "model-a",
    effort: null,
    folder: "/work",
    branch: null,
    changes: [3, 1],
    sessionTokens: null,
    contextPercent: 12,
    sessionLimit: null,
    weekLimit: null,
  });
  reply.setRunning("1 shell");
  assert.deepEqual(chat.texts(channel, ref.thread).slice(1), [
    "First words\n[complete] Read a.txt (again)\nMore words\nRead 1 file\nbypass · model-a · /work · +3 -1 · 12% context\n1 shell",
  ]);
  reply.setLatest(false);
  assert.ok(!chat.texts(channel, ref.thread).join().includes("1 shell"));
});

test("a task line shows its preview under it, since that is where an answer is kept", async () => {
  const { chat, provider, channel } = await built();
  const ref = chat.openThread(channel);
  const reply = provider.thread(ref).openReply(() => {});
  await reply.task({
    ...line("a", "Ask"),
    preview: {
      title: "User answered the questions:",
      summary: "",
      body: "· Which colour? → blue",
      language: "",
      plain: true,
    },
  });
  await reply.task({
    ...line("b", "Edit notes.txt"),
    preview: {
      title: "Update(notes.txt)",
      summary: "Added 1 line",
      body: "1 + a",
      language: "diff",
      plain: false,
    },
  });
  assert.deepEqual(chat.texts(channel, ref.thread).slice(1), [
    "[complete] Ask\nUser answered the questions:\n· Which colour? → blue\n" +
      "[complete] Edit notes.txt\nUpdate(notes.txt)\nAdded 1 line\n1 + a",
  ]);
});

test("a call for a capability it lacks is recorded and changes nothing", async () => {
  const { chat, provider, channel } = await built();
  const thread = provider.thread(chat.openThread(channel));
  await thread.showStatus("working");
  await thread.clearStatus();
  thread.showActivity("Reading", "is reading");
  await thread.acknowledge("msg-1");
  assert.deepEqual(chat.strayCalls(), [
    "showStatus working",
    "clearStatus",
    "showActivity Reading",
    "acknowledge msg-1",
  ]);
  assert.equal(chat.messages(channel).length, 1, "only the old thread's root");
});

test("the chat outlives a provider: a new one over the same entry sees the threads", async () => {
  const { chat, provider, channel } = await built();
  await provider.start(NOBODY);
  now = 1_780_000_200;
  const sent = await chat.as(OWNER).says(channel, "before the restart");
  await provider.stop();
  const next = await built(chat);
  assert.equal(chat.provider, next.provider);
  assert.equal(next.provider.openedAt(sent.ref), 1_780_000_200);
  assert.deepEqual(chat.texts(channel), ["before the restart"]);
});

test("a thread that is not there takes no message", async () => {
  const { chat, channel } = await built();
  await assert.rejects(chat.as(OWNER).says(channel, "hi", { thread: "nothing" }), /no thread/);
});
