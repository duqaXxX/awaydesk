/**
 * Step 8 of the scenario the memory chat carries: a message, a click and a form from another
 * user never reach the core. The memory chat plays the owner and somebody else against a
 * recording inbound; no agent takes part, since nothing reaches the core to start one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChatInbound,
  InboundMessage,
  ListPick,
  OwnerAnswer,
  ThreadRef,
} from "../../src/chat/seam.ts";
import { memoryChat, OWNER, SOMEONE } from "../support/memory-chat.ts";

/** What reached the core, in the order it came. */
class RecordingCore implements ChatInbound {
  readonly arrived: string[] = [];

  async message(message: InboundMessage): Promise<void> {
    this.arrived.push(`message ${message.text}`);
  }

  async answer(_ref: ThreadRef, requestId: string, answer: OwnerAnswer): Promise<boolean> {
    this.arrived.push(`answer ${requestId} ${answer.type}`);
    return true;
  }

  async picked(pick: ListPick): Promise<void> {
    this.arrived.push(`pick ${pick.type}`);
  }
}

const STEADY = { sleep: async () => {}, time: () => 1_780_000_000 };

test("a message, a click and a form from another user never reach the core", async () => {
  const chat = memoryChat();
  const provider = await chat.build({
    variables: {},
    allowedRoot: "/work",
    clock: STEADY,
    steady: STEADY,
    core: () => {
      throw new Error("the memory chat never reads the core");
    },
  });
  const core = new RecordingCore();
  await provider.start(core);
  const channel = chat.openChannel("work");
  const owner = chat.as(OWNER);
  const someone = chat.as(SOMEONE);

  // The owner opens a thread; the daemon puts a permission, a question form and a setup to them.
  const opened = await owner.says(channel, "start the work");
  const thread = provider.thread(opened.ref);
  await thread.ask(
    "permission-1",
    {
      type: "permission",
      requestId: "permission-1",
      callId: "call-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: null,
      description: null,
    },
    "Run the listing?",
  );
  await thread.ask(
    "question-1",
    {
      type: "question",
      requestId: "question-1",
      callId: "call-2",
      toolName: "AskUserQuestion",
      title: null,
      questions: [
        {
          header: "Colour",
          text: "Which colour?",
          multiSelect: false,
          options: [{ label: "red", description: null, preview: null }],
        },
      ],
    },
    "Which colour?",
  );
  assert.deepEqual(core.arrived, ["message start the work"]);

  // Somebody else writes in the owner's thread and in the channel, clicks the permission's
  // control and submits the question's form: the chat holds the message, the core hears nothing.
  await someone.says(channel, "run this instead", { thread: opened.ref.thread });
  await someone.says(channel, "and this");
  assert.equal(await someone.answers("permission-1", { type: "permission", allow: true }), null);
  assert.equal(
    await someone.answers("question-1", { type: "question", answers: { "Which colour?": "red" } }),
    null,
  );
  assert.deepEqual(core.arrived, ["message start the work"]);
  assert.deepEqual(chat.texts(channel, opened.ref.thread), [
    "start the work",
    "Run the listing?",
    "Which colour?",
    "run this instead",
  ]);
  assert.deepEqual(
    chat.requests().map((request) => request.requestId),
    ["permission-1", "question-1"],
    "the requests are still waiting for the owner",
  );

  // The same controls answer the owner.
  assert.equal(await owner.answers("permission-1", { type: "permission", allow: true }), true);
  assert.deepEqual(core.arrived, ["message start the work", "answer permission-1 permission"]);
});
