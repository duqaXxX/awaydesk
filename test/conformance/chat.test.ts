/**
 * The conformance suite of the chat seam (`chat.ts`), run against every provider: the memory chat
 * of the tests, and the Slack provider over its fake client. The suite includes the owner check:
 * a message, a click and a form from someone else never arrive.
 *
 * Where Slack stands: every listener tells the core through `ChatInbound`, and the adapter builds
 * the payloads Slack would send (the recorded click and form fixtures, through the builders of
 * `test/support/slack-app.ts`). The owner checks of each Slack listener are also
 * `test/chat/slack/app/owner-checks.test.ts`.
 */
import type { App, Receiver } from "@slack/bolt";
import type { Question } from "../../src/agent/seam.ts";
import type { ThreadRef } from "../../src/chat/seam.ts";
import { ChannelGuard } from "../../src/chat/slack/app/guards.ts";
import { BIND_ACTION } from "../../src/chat/slack/bind.ts";
import { HOLD_CANCEL, HOLD_CONTINUE } from "../../src/chat/slack/hold.ts";
import {
  APPROVAL_ALLOW,
  APPROVAL_DENY,
  newDraft,
  QUESTION_SKIP,
} from "../../src/chat/slack/requests.ts";
import { RESUME_ACTION } from "../../src/chat/slack/resume.ts";
import { SETUP_START } from "../../src/chat/slack/setup.ts";
import { SlackChat } from "../../src/chat/slack/thread.ts";
import type { Clock } from "../../src/clock.ts";
import type { CorePort } from "../../src/core/port.ts";
import type { Pending } from "../../src/core/requests.ts";
import {
  AGENT,
  CHANNEL,
  type FakeSlack,
  rejected,
  STRANGER,
  THREAD,
} from "../support/fake-slack.ts";
import { memoryChat, OWNER, SOMEONE } from "../support/memory-chat.ts";
import {
  type Body,
  clickIn,
  formBody,
  message,
  picked,
  reply,
  setupState,
  type World,
  worldOf,
} from "../support/slack-app.ts";
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
    ownerOnlyNotices: false,
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

/** The calls that write in Slack, refused when the chat refuses writes. */
const WRITES = [
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
  "chat.update",
  "reactions.add",
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

/** What a click or a form names of `user`: the user's id, in the owner's workspace. */
function userOf(user: string, world: World): Body {
  return user === world.identity.ownerUserId ? {} : { id: user };
}

function slackPerson(
  world: World,
  app: () => App | null,
  asked: Map<string, Pending>,
  user: string,
): Person {
  let sequence = 0;
  const dispatch = async (body: Body): Promise<void> => {
    // The chat delivers nothing before the connection opens.
    const built = app();
    if (built === null) return;
    built.processEvent({ body, ack: async () => {} }).catch(() => {});
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
    // The button of each request carries its request id; the question's form carries it in the
    // draft it rides on, and Slack's listener looks the question up in what the core holds.
    answers: async (request, answer): Promise<void> => {
      const { ref, requestId, message: shownAt } = request;
      const click = (actionId: string): Body =>
        clickIn(actionId, requestId, ref.channel, ref.thread, {
          messageTs: shownAt,
          user: userOf(user, world),
        });
      switch (answer.type) {
        case "permission":
          await dispatch(click(answer.allow ? APPROVAL_ALLOW : APPROVAL_DENY));
          return;
        case "hold":
          await dispatch(click(answer.send ? HOLD_CONTINUE : HOLD_CANCEL));
          return;
        case "setup": {
          const { model, effort, bypass } = answer.selection;
          const body = click(SETUP_START);
          body.state = { values: setupState(model, effort, bypass) };
          await dispatch(body);
          return;
        }
        case "question": {
          if (answer.answers === null) {
            await dispatch(click(QUESTION_SKIP));
            return;
          }
          if (request.request.type !== "question") throw new Error("a question's answer");
          const { questions } = request.request;
          asked.set(requestId, pendingOf(ref, questions));
          const draft = newDraft(requestId, ref.channel, ref.thread);
          // The option each question was answered with, by its place in the question's list.
          const values = Object.assign(
            {},
            ...questions.map((question, at) => {
              const label = answer.answers?.[question.text];
              const index = question.options.findIndex((option) => option.label === label);
              if (index === -1) throw new Error(`no option ${String(label)} in the question`);
              return picked(at, String(index));
            }),
          );
          const body = formBody("view_submission", draft, values, userOf(user, world));
          await dispatch(body);
          return;
        }
      }
    },
    picks: async (list, row): Promise<void> => {
      const { channel, message: shownAt } = list;
      // A list posted in the channel is a message of the channel: its thread is its own ts.
      const value = (): string =>
        list.list.type === "sessions" ? `${row}@${list.list.thread.thread}` : row;
      const actionId = list.list.type === "sessions" ? RESUME_ACTION : BIND_ACTION;
      await dispatch(
        clickIn(actionId, value(), channel, shownAt, {
          messageTs: shownAt,
          user: userOf(user, world),
        }),
      );
    },
  };
}

/** The request the core holds for a question the daemon asked, as the form's listener reads it. */
function pendingOf(ref: ThreadRef, questions: readonly Question[]): Pending {
  return {
    channelId: ref.channel,
    threadId: ref.thread,
    title: "A request",
    questions,
    decision: new Promise(() => {}),
    decided: false,
    messageTs: null,
  };
}

async function slackRig(t: Parameters<typeof worldOf>[0]): Promise<ChatRig> {
  const world = worldOf(t);
  let built: App | null = null;
  // The questions the checks asked: the core holds each under the id the check chose.
  const asked = new Map<string, Pending>();
  const core: CorePort = {
    ...world.core,
    approvals: {
      questions: (id, channel, thread) => {
        const pending = asked.get(id);
        if (pending === undefined) return world.approvals.questions(id, channel, thread);
        const same = pending.channelId === channel && pending.threadId === thread;
        return same && pending.questions?.length ? pending.questions : null;
      },
    },
  };
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
      core: () => core,
      config: world.config,
      guard: new ChannelGuard(world.slack, world.identity),
      home: world.home,
      uploads: world.uploads,
      receiver,
    },
  });
  const app = (): App | null => built;
  const refuse = (...methods: string[]) => {
    for (const method of methods) world.slack.responses[method] = rejected("channel_not_found");
  };
  return {
    provider,
    channel: CHANNEL,
    thread: { channel: CHANNEL, thread: THREAD },
    owner: slackPerson(world, app, asked, world.identity.ownerUserId),
    other: slackPerson(world, app, asked, STRANGER),
    ownerOnlyNotices: true,
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

chatConformance("the Slack provider", slackRig);
