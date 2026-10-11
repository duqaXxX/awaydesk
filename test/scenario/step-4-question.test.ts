/**
 * Step 4 of the scenario the memory chat carries: the agent asks a question with two options,
 * the owner answers, the agent receives the answer, and the answer stays in the thread as the
 * record of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { named } from "../../src/core/texts.ts";
import { question, say } from "../support/plain-agent.ts";
import { NAMES, World } from "./world.ts";

test("the agent asks a question with two options, the owner answers and the agent receives it", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(
    say("Asking."),
    question("Which colour?", ["red", "blue"], { header: "Colour" }),
    say("Noted."),
  );
  const thread = await world.open("pick one");
  const asked = await world.request("question", thread);

  // The request is a message of the thread with a control, and says what the agent called it.
  assert.equal(asked.title, "Ask");
  assert.deepEqual(asked.request.type === "question" ? asked.request.questions : null, [
    {
      header: "Colour",
      text: "Which colour?",
      multiSelect: false,
      options: [
        { label: "red", description: null, preview: null },
        { label: "blue", description: null, preview: null },
      ],
    },
  ]);
  assert.deepEqual(world.kinds(thread).at(-2), ["request", "Ask"]);

  const answer = { "Which colour?": "blue" };
  assert.equal(
    await world.owner.answers(asked.requestId, { type: "question", answers: answer }),
    true,
  );
  await world.ended(thread);

  // The agent got the answer, once, as the owner gave it.
  assert.deepEqual(
    world.plain.sessions[1]?.answers.map((a) => a.answer),
    [{ answered: true, answers: answer }],
  );

  // The request is gone and the answer stays in the reply, under the line of the call that asked.
  assert.deepEqual(world.chat.requests(), []);
  assert.equal(
    world.shown(thread).at(-1),
    `Asking.\n[complete] Ask\n${named(texts.ANSWERED, NAMES)}\n· Which colour? → blue\n` +
      `Noted.\nfull · ${world.folder}`,
  );
  await world.finish();
});

test("a question the owner skips ends the call with the daemon's words", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(question("Which colour?", ["red", "blue"]), say("Fine."));
  const thread = await world.open("pick one");
  const asked = await world.request("question", thread);

  await world.owner.answers(asked.requestId, { type: "question", answers: null });
  await world.ended(thread);

  assert.deepEqual(
    world.plain.sessions[1]?.answers.map((a) => a.answer),
    [{ answered: false, message: texts.SKIP_MESSAGE }],
  );
  assert.deepEqual(world.chat.requests(), []);
  assert.equal(world.shown(thread).at(-1), `[error] Ask\nFine.\nfull · ${world.folder}`);
  await world.finish();
});
