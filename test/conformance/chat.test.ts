/**
 * The conformance suite of the chat seam (`chat.ts`), run against every provider: the memory chat
 * of the tests, and the Slack provider over its fake client. The suite includes the owner check:
 * a message, a click and a form from someone else never arrive.
 *
 * Where Slack stands: its listeners still call the core directly (`sessions`, `approvals`,
 * `holds`) and never `ChatInbound`, so every check of what reaches the inbound is `todo` for it,
 * and its adapter builds only the payloads it can build today (a message). The owner checks of
 * the Slack listeners are `test/chat/slack/app/owner-checks.test.ts`.
 */
import type { App, Receiver } from "@slack/bolt";
import { ChannelGuard } from "../../src/chat/slack/app/guards.ts";
import { SlackChat } from "../../src/chat/slack/thread.ts";
import type { Clock } from "../../src/clock.ts";
import {
  AGENT,
  CHANNEL,
  type FakeSlack,
  rejected,
  STRANGER,
  THREAD,
} from "../support/fake-slack.ts";
import { memoryChat, OWNER, SOMEONE } from "../support/memory-chat.ts";
import { type Body, message, reply, type World, worldOf } from "../support/slack-app.ts";
import {
  type ChatRig,
  chatConformance,
  type Person,
  type Said,
  type Scope,
  type Shown,
} from "./chat.ts";

// ---- the memory chat

const STEADY: Clock = { sleep: async () => {}, time: () => 1_780_000_000 };

function memoryPerson(person: ReturnType<ReturnType<typeof memoryChat>["as"]>): Person {
  return {
    says: async (channel, text, options) => {
      const sent = await person.says(channel, text, options);
      return { id: sent.id, ref: sent.ref };
    },
    answers: async (asked, answer) => {
      await person.answers(asked.requestId, answer);
    },
    picks: async (listed, row) => {
      await person.picks(listed.message, row);
    },
  };
}

async function memoryRig(): Promise<ChatRig> {
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
  const channel = chat.openChannel("work");
  return {
    provider,
    channel,
    thread: chat.openThread(channel),
    owner: memoryPerson(chat.as(OWNER)),
    other: memoryPerson(chat.as(SOMEONE)),
    read: (scope) =>
      chat.messages(scope.channel, scope.thread).map((m) => ({
        id: m.id,
        text: m.text,
        pressable: m.pressable,
        ownerOnly: false,
      })),
    settle: async () => {},
    refuseWrites: () => chat.removeChannel(channel),
    removeChannel: (gone) => chat.removeChannel(gone),
    failLookups: () => chat.failChannelLookups(),
  };
}

// ---- the Slack provider

const STAGE_2 = "stage 2 moves this listener behind ChatInbound";

/** The calls that write in Slack, refused when the chat refuses writes. */
const WRITES = [
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
  "chat.update",
];

/** Whether a message's blocks hold a control. */
function pressable(blocks: unknown): boolean {
  return JSON.stringify(blocks).includes('"action_id"');
}

/** What `scope` shows of the fake workspace: the messages of the daemon, and its ephemeral lines. */
function slackRead(slack: FakeSlack, scope: Scope): Shown[] {
  const here = (args: Body): boolean =>
    args.channel === scope.channel && (args.thread_ts ?? undefined) === scope.thread;
  const shown: Shown[] = [];
  const posts = slack.callsTo("chat.postMessage");
  for (const [index, args] of posts.entries()) {
    const ts = slack.postedTs[index];
    const held = ts === undefined ? undefined : slack.messages.get(ts);
    if (!here(args) || held === undefined || held.deleted) continue;
    shown.push({
      id: held.ts,
      text: `${held.text}\n${JSON.stringify(held.blocks)}`,
      pressable: pressable(held.blocks),
      ownerOnly: false,
    });
  }
  for (const [index, args] of slack.callsTo("chat.startStream").entries()) {
    const ts = slack.streamTs[index];
    const held = ts === undefined ? undefined : slack.messages.get(ts);
    if (!here(args) || ts === undefined || held === undefined || held.deleted) continue;
    const at = slack.createdTs.indexOf(ts);
    shown.push({
      id: ts,
      text: [
        slack.messageTexts()[at],
        JSON.stringify(slack.messageCards()[at]),
        JSON.stringify(held.blocks),
      ].join("\n"),
      pressable: pressable(held.blocks),
      ownerOnly: false,
    });
  }
  for (const args of slack.callsTo("chat.postEphemeral")) {
    if (!here(args)) continue;
    shown.push({
      id: null,
      text: `${args.text}\n${JSON.stringify(args.blocks)}`,
      pressable: pressable(args.blocks),
      ownerOnly: true,
    });
  }
  return shown;
}

function slackPerson(world: World, app: () => App, user: string): Person {
  let sequence = 0;
  const dispatch = async (body: Body): Promise<void> => {
    app()
      .processEvent({ body, ack: async () => {} })
      .catch(() => {});
    await world.idle();
  };
  return {
    says: async (channel, text, options): Promise<Said> => {
      sequence += 1;
      if (options?.thread === undefined) {
        const ts = `1790100000.${String(sequence).padStart(6, "0")}${user === STRANGER ? 1 : 0}`;
        await dispatch(message(text, { user, channel, ts }));
        return { id: ts, ref: { channel, thread: ts } };
      }
      const body = reply(text, options.thread, { user, channel });
      await dispatch(body);
      return { id: String(body.event.ts), ref: { channel, thread: options.thread } };
    },
    // A click and a form are read by listeners that still call the core: their payloads are
    // built from the request the core holds, which the stage that moves them behind
    // `ChatInbound` replaces by the request id and the message the seam gives.
    answers: async () => {
      throw new Error(STAGE_2);
    },
    picks: async () => {
      throw new Error(STAGE_2);
    },
  };
}

async function slackRig(t: Parameters<typeof worldOf>[0]): Promise<ChatRig> {
  const world = worldOf(t);
  let built: App | null = null;
  const receiver: Receiver = {
    init: (app) => {
      built = app;
    },
    start: async () => {},
    stop: async () => {},
  };
  const provider = new SlackChat({
    slack: world.slack,
    replies: world.slack,
    identity: world.identity,
    agent: () => AGENT,
    limiter: world.limiter,
    clock: world.slackClock,
    app: {
      core: () => world.core,
      config: world.config,
      guard: new ChannelGuard(world.slack, world.identity),
      home: world.home,
      uploads: world.uploads,
      receiver,
    },
  });
  const app = (): App => {
    if (built === null) throw new Error("the Slack app was not built");
    return built;
  };
  const refuse = (...methods: string[]) => {
    for (const method of methods) world.slack.responses[method] = rejected("channel_not_found");
  };
  return {
    provider,
    channel: CHANNEL,
    thread: { channel: CHANNEL, thread: THREAD },
    owner: slackPerson(world, app, world.identity.ownerUserId),
    other: slackPerson(world, app, STRANGER),
    read: (scope) => slackRead(world.slack, scope),
    settle: async () => {
      await world.slackClock.advance(2);
      await world.idle();
    },
    refuseWrites: () => refuse(...WRITES),
    removeChannel: () => refuse("conversations.info"),
    failLookups: () => {
      world.slack.responses["conversations.info"] = rejected("ratelimited");
    },
  };
}

chatConformance("the memory chat", memoryRig);

chatConformance("the Slack provider", slackRig, {
  todo: {
    inbound: STAGE_2,
    folded:
      "Slack's sink folds a run of calls itself (core Fold) and does not rewrite a stream that already shows the line, so the words an update carries are not drawn (reply/sinks.ts, streamShows)",
    endReplyBody:
      "FakeSlack's chat.stopStream keeps no blocks, so what a stream showed is not read back (test/support/fake-slack.ts)",
  },
});
