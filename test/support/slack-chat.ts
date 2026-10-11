/**
 * A `SlackChat` over `FakeSlack` for the tests of the provider's own members: the thread and the
 * channel it hands out, with the clock the status line counts on.
 */
import { SlackChat, type SlackChatOptions } from "../../src/chat/slack/thread.ts";
import { AGENT, BOT, CHANNEL, FakeClock, FakeSlack, OWNER, TEAM, THREAD } from "./fake-slack.ts";

export interface MadeChat {
  readonly slack: FakeSlack;
  readonly clock: FakeClock;
  readonly chat: SlackChat;
  /** The thread `THREAD` of `CHANNEL`. */
  readonly thread: ReturnType<SlackChat["thread"]>;
}

/** A provider over a fresh fake workspace; `extra` replaces or adds options. */
export function madeChat(extra: Partial<SlackChatOptions> = {}): MadeChat {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const chat = new SlackChat({
    slack,
    replies: slack,
    identity: { teamId: TEAM, ownerUserId: OWNER, botUserId: BOT },
    agent: () => AGENT,
    limiter: { acquire: async () => {}, refund: async () => {} },
    clock,
    ...extra,
  });
  return { slack, clock, chat, thread: chat.thread({ channel: CHANNEL, thread: THREAD }) };
}
