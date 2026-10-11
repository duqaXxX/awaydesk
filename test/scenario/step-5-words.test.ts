/**
 * Step 5 of the scenario the memory chat carries: the daemon's words, typed as messages. The
 * plain agent has one permission mode, keeps a list of its sessions and offers two commands of
 * its own; the memory chat shares no file and puts a line for the owner alone in the thread.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { guideText } from "../../src/core/guide.ts";
import { shellQuote } from "../../src/core/sessions/directory.ts";
import * as texts from "../../src/core/texts.ts";
import { fill, named } from "../../src/core/texts.ts";
import { hold, say } from "../support/plain-agent.ts";
import { NAMES, World } from "./world.ts";

/** The thread of a first message, once its reply has ended. */
async function session(world: World, text = "first"): Promise<string> {
  world.script(say("Hello."));
  const thread = await world.open(text);
  await world.ended(thread);
  return thread;
}

/** The channel's own lines (its main view), as kind and text. */
function channelLines(world: World): ReadonlyArray<readonly [string, string]> {
  return world.chat.messages(world.channel).map((m) => [m.kind, m.text] as const);
}

test("!status in the channel lists the folder and the live sessions, and in a thread that session's state", async (t) => {
  const world = World.make(t);
  await world.start();
  await world.owner.says(world.channel, "!status");
  assert.deepEqual(channelLines(world), [
    ["message", "!status"],
    [
      "reference",
      `${fill(texts.STATUS_CHANNEL_HEADER, { directory: world.folder })}\n${texts.STATUS_CHANNEL_EMPTY}`,
    ],
  ]);

  const thread = await session(world);
  await world.owner.says(world.channel, "!status");
  const row = fill(texts.STATUS_CHANNEL_ROW, {
    link: fill(texts.STATUS_CHANNEL_LINK_FALLBACK, { thread_ts: thread }),
    activity: texts.STATUS_CHANNEL_IDLE,
  });
  // The clock is the daemon's: the session answered a moment ago.
  const since = fill(texts.STATUS_CHANNEL_SINCE, { ago: "just now" });
  assert.deepEqual(channelLines(world).slice(-1), [
    [
      "reference",
      `${fill(texts.STATUS_CHANNEL_HEADER, { directory: world.folder })}\n${row}${since}`,
    ],
  ]);

  // In the thread it answers the session, in a message of the thread (this chat has no line for
  // the owner alone); the footer's values are the ones this agent reports.
  const id = world.plain.sessions.at(-1)?.id as string;
  await world.owner.says(world.channel, "!status", { thread });
  assert.deepEqual(world.kinds(thread).slice(-1), [
    [
      "reference",
      [
        fill(texts.STATUS, { directory: world.folder, session: id }),
        fill(texts.STATUS_TERMINAL, {
          // The folder is quoted for a shell where it needs it, as a Windows path does.
          command: `\`cd ${shellQuote(world.folder)} && plain --resume ${id}\``,
        }),
        fill(named(texts.STATUS_STATE, NAMES), {
          mode: "standard",
          version: "plain-1.0",
          activity: texts.ACTIVITY_IDLE,
        }),
        "Effort: `full`",
      ].join("\n"),
    ],
  ]);
  await world.finish();
});

test("!stop ends the turn that runs, in a thread or in the channel, and says so where it was typed", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Working"), hold());
  const thread = await world.open("take your time");
  await world.until(() => world.shown(thread).length === 3, "the reply under way");

  await world.owner.says(world.channel, "!stop", { thread });
  await world.ended(thread);
  // The reply ends where it stood, with its footer, and the answer is a message under it.
  assert.deepEqual(world.kinds(thread).slice(2), [
    ["reply", `Working\nfull · ${world.folder}`],
    ["message", "!stop"],
    ["notice", texts.STOPPED_THREAD],
  ]);
  await world.owner.says(world.channel, "!stop", { thread });
  assert.deepEqual(world.kinds(thread).slice(-1), [["notice", texts.NOTHING_TO_STOP_THREAD]]);

  // The channel's word stops every session; with none running it says so.
  world.script(say("Again"), hold());
  await world.owner.says(world.channel, "again", { thread });
  await world.until(
    () => world.chat.messages(world.channel, thread).filter((m) => m.kind === "reply").length === 2,
    "the second reply",
  );
  await world.owner.says(world.channel, "!stop");
  assert.deepEqual(channelLines(world).slice(-2), [
    ["message", "!stop"],
    ["notice", texts.STOPPED_CHANNEL],
  ]);
  await world.ended(thread, 2);
  await world.owner.says(world.channel, "!stop");
  assert.deepEqual(channelLines(world).slice(-1), [["notice", texts.NOTHING_TO_STOP]]);
  await world.finish();
});

// The words of the daemon this pair can serve: no bypass mode and no file upload, so `!bypass`
// and `!open` are refused when typed and the help does not offer them. It keeps no record of
// trust: the `!bind` line is the one that speaks of none.
const OFFERED_WORDS = texts.HELP_WORDS_ANY.map((line) => named(line, NAMES)).filter(
  (line) => !line.startsWith("`!bypass") && !line.startsWith("`!open"),
);

test("!help lists the daemon's words and the plain agent's two commands, and none of Claude's", async (t) => {
  const world = World.make(t);
  await world.start();
  const thread = await session(world);

  await world.owner.says(world.channel, "!help", { thread });
  const help = world.shown(thread).at(-1) as string;
  assert.equal(
    help,
    [
      texts.HELP_OWN,
      texts.HELP_RULE,
      ...OFFERED_WORDS,
      named(texts.HELP_AGENT, NAMES),
      "`!count <text>` Count the words",
      "`!echo <text>` Say the text back",
    ].join("\n"),
  );
  assert.ok(!/claude|anthropic|compact|\bmodel\b/i.test(help), help);

  // In the channel the agent's commands are not listed, and the text says where they are.
  await world.owner.says(world.channel, "!help");
  assert.equal(
    channelLines(world).at(-1)?.[1],
    [texts.HELP_OWN, texts.HELP_RULE, ...OFFERED_WORDS, named(texts.HELP_UNBOUND, NAMES)].join(
      "\n",
    ),
  );
  await world.finish();
});

test("!help lists only the words this agent and this chat can serve", async (t) => {
  const world = World.make(t);
  await world.start();
  const thread = await session(world);
  await world.owner.says(world.channel, "!help", { thread });
  const help = world.shown(thread).at(-1) as string;
  // No bypass mode and no file upload: both words are refused here, and the list offers them.
  assert.ok(!help.includes("`!bypass on|off`"), help);
  assert.ok(!help.includes("`!open [file]`"), help);
  await world.finish();
});

test("an agent command typed with ! reaches the agent as the command it names", async (t) => {
  const world = World.make(t);
  await world.start();
  const thread = await session(world);

  await world.owner.says(world.channel, "!echo hello there", { thread });
  await world.ended(thread, 2);
  assert.equal(world.prompts().at(-1), "/echo hello there");
  assert.equal(world.shown(thread).at(-1), `hello there\nfull · ${world.folder}`);
  await world.finish();
});

test("!bypass is refused by an agent with one permission mode, and !open by a chat that shares no file", async (t) => {
  const world = World.make(t);
  await world.start();
  const thread = await session(world);

  await world.owner.says(world.channel, "!bypass on", { thread });
  await world.owner.says(world.channel, "!bypass off", { thread });
  assert.deepEqual(world.kinds(thread).slice(3), [
    ["message", "!bypass on"],
    ["notice", named(texts.BYPASS_UNAVAILABLE, NAMES)],
    ["message", "!bypass off"],
    ["notice", named(texts.BYPASS_UNAVAILABLE, NAMES)],
  ]);
  assert.equal(
    named(texts.BYPASS_UNAVAILABLE, NAMES),
    "Plain has no mode that runs tools without asking, so there is no bypass to switch.",
  );

  await world.owner.says(world.channel, "!open", { thread });
  assert.deepEqual(world.kinds(thread).slice(-1), [
    ["notice", named(texts.OPEN_UNAVAILABLE, NAMES)],
  ]);
  assert.equal(
    named(texts.OPEN_UNAVAILABLE, NAMES),
    "Memory chat cannot show a file here, so `!open` does nothing.",
  );

  // Typed in the channel, each says where it belongs.
  await world.owner.says(world.channel, "!bypass on");
  await world.owner.says(world.channel, "!open");
  assert.deepEqual(channelLines(world).slice(-4), [
    ["message", "!bypass on"],
    ["notice", texts.BYPASS_TOP_LEVEL],
    ["message", "!open"],
    ["notice", texts.OPEN_TOP_LEVEL],
  ]);
  await world.finish();
});

test("!bind binds the channel to a folder by its path, or from the list of folders", async (t) => {
  const world = World.make(t);
  await world.start();
  const other = world.makeFolder("other");
  const third = world.makeFolder("third");

  await world.owner.says(world.channel, "!bind other");
  assert.deepEqual(channelLines(world).slice(-1), [
    ["notice", fill(texts.BIND_OK, { directory: other })],
  ]);
  await world.owner.says(world.channel, "!bind ../elsewhere");
  assert.deepEqual(channelLines(world).slice(-1), [
    ["notice", fill(texts.BIND_OUTSIDE, { path: "../elsewhere", root: world.root })],
  ]);

  // The agent keeps no record of trust: every folder under the root is offered, under the title
  // that says so.
  await world.owner.says(world.channel, "!bind");
  const list = world.chat.lists().at(-1);
  assert.equal(list?.title, fill(texts.BIND_LIST_ANY, { root: world.root }));
  assert.deepEqual(
    list?.list.type === "folders" ? [list.list.root, list.list.folders, list.list.bound] : null,
    [world.root, [world.root, world.folder, other, third].sort(), other],
  );
  // Picking the folder the channel has says so; picking another binds it.
  assert.equal(await world.owner.picks(list?.message as string, other), true);
  await world.until(
    () =>
      channelLines(world).some(
        ([, text]) => text === fill(texts.BIND_ALREADY, { directory: other }),
      ),
    "the answer to the pick",
  );
  assert.equal(await world.owner.picks(list?.message as string, third), true);
  await world.until(
    () =>
      channelLines(world).some(([, text]) => text === fill(texts.BIND_OK, { directory: third })),
    "the bind",
  );
  // The list is withdrawn through the channel: no thread is asked for from its message id.
  assert.deepEqual(world.chat.strayCalls(), []);
  assert.equal(world.chat.message(list?.message as string), null);

  // The next message starts its session in the folder the channel is bound to.
  const thread = await session(world, "in the third");
  assert.equal(world.plain.starts[0]?.folder, third);
  assert.ok(thread);
  await world.finish();
});

test("!resume lists the folder's sessions, a pick resumes one in a thread and the next message continues it", async (t) => {
  const world = World.make(t);
  await world.start();
  world.store.remember(world.folder, "plain-old", "An older talk", 1_000_000_000);

  await world.owner.says(world.channel, "!resume");
  const list = world.chat.lists().at(-1);
  assert.equal(list?.title, fill(texts.RESUME_LIST, { directory: world.folder }));
  assert.deepEqual(
    list?.list.type === "sessions" ? list.list.sessions.map((s) => [s.id, s.title]) : null,
    [["plain-old", "An older talk"]],
  );
  const resumeThread = list?.list.type === "sessions" ? list.list.thread.thread : "";

  assert.equal(await world.owner.picks(list?.message as string, "plain-old"), true);
  await world.until(() => world.shown(resumeThread).length === 2, "the confirmation");
  assert.deepEqual(world.shown(resumeThread), [
    "!resume",
    fill(texts.RESUME_OK, { title: "An older talk" }),
  ]);
  assert.deepEqual(world.chat.lists(), []);

  // No setup is asked for a session that already exists; the agent resumes it.
  world.script(say("Back again."));
  await world.owner.says(world.channel, "carry on", { thread: resumeThread });
  await world.ended(resumeThread);
  assert.deepEqual(
    world.plain.starts.map((start) => start.resume),
    ["plain-old"],
  );
  assert.deepEqual(world.prompts(), ["carry on"]);
  await world.finish();
});

test("!guide describes only what this agent and this chat can serve", async (t) => {
  const world = World.make(t);
  await world.start();
  await world.owner.says(world.channel, "!guide");
  const guide = channelLines(world).at(-1)?.[1] ?? "";
  // What the two modules declare: `PLAIN_CAPABILITIES` has two effort levels, questions, commands
  // and session listing, and no model list, bypass mode, background task or record of trust; the
  // memory chat has no file upload.
  assert.equal(
    guide,
    guideText(NAMES, {
      folderTrust: false,
      models: false,
      efforts: true,
      bypass: false,
      commands: true,
      questions: true,
      backgroundTasks: false,
      sessionListing: true,
      fileUpload: false,
    }),
  );
  // No bypass mode, no file upload, no model list, no record of trust: the guide names none.
  assert.ok(!/bypass/i.test(guide), "the guide names bypass");
  assert.ok(!guide.includes("`!open`") && !guide.includes("**Files**"), "the guide names !open");
  assert.ok(!/\*\*Model\*\*/.test(guide), "the guide names the model");
  assert.ok(!/trust/i.test(guide), "the guide names trust");
  assert.ok(!guide.includes("background task"), "the guide names background tasks");
  // What they do declare is there, in the words of the pair.
  for (const sentence of [
    "1. `!bind` lists the folders under your allowed root, with a Bind button each;",
    "the thread asks for the **Effort** (`Default` leaves Plain's own choice); **Start** sends",
    "Plain's commands start with `!` instead of `/`: `!echo hello`, `!count one two`.",
    "**Approvals and questions**",
    "A question from Plain comes with **Answer**",
    "`!stop` typed in the channel stops every running session; inside a thread it stops only that one.",
    "`!resume`, typed in the channel only, lists",
  ]) {
    assert.ok(guide.includes(sentence), sentence);
  }
  await world.finish();
});
