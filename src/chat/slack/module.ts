/**
 * The Slack module: the chat registry's entry for Slack. `build` makes everything of the Slack
 * side that does not need the core (the clients, the identity `auth.test` gives, the provider,
 * the thread deleter, the Home tab, the channel guard, the uploads folder); what needs the core
 * is read through `context.core()` when it is first used, which is after `build` returned.
 */

import type { Receiver } from "@slack/bolt";
import {
  type ChatContext,
  type ChatEntry,
  ConfigError,
  type Listings,
  type Names,
  type SessionsPort,
} from "../../core/port.ts";
import { ChatError, type ChatProvider } from "../seam.ts";
import type { Fetch } from "./app/answers.ts";
import { socketReceiver } from "./app/app.ts";
import { ChannelGuard, type Identity } from "./app/guards.ts";
import { prepareUploads, uploadsDir } from "./attachments.ts";
import { type DeleterState, ThreadDeleter } from "./delete.ts";
import { Home } from "./home.ts";
import { type ClientOptions, repliesClient, sharedClient } from "./reply/clients.ts";
import { describe } from "./reply/errors.ts";
import { UpdateLimiter } from "./reply/limiter.ts";
import { SlackChat } from "./thread.ts";

/** The client of the Slack packages every call goes through; its type is all this file names. */
export type SlackClient = ReturnType<typeof sharedClient>;

/** The Slack clients of the daemon, one constructor for each way it calls. */
export interface Clients {
  /** The shared client and the one replies are written with, on the bot token. */
  bot(token: string): readonly [shared: SlackClient, replies: SlackClient];
  /** The owner's own client, on the user token. */
  owner(token: string): SlackClient;
}

/**
 * The daemon's two Slack clients on one token (the retry policy is in `reply/clients.ts`): the
 * shared one for everything but a reply, and the one replies are written with.
 */
export function makeClients(
  botToken: string,
  options: ClientOptions = {},
): readonly [shared: SlackClient, replies: SlackClient] {
  return [sharedClient(botToken, options), repliesClient(botToken, options)];
}

export const CLIENTS: Clients = {
  bot: (token) => makeClients(token),
  owner: (token) => sharedClient(token),
};

/** What a test replaces; the real thing is the default of each. */
export interface SlackOptions {
  readonly clients?: Clients | undefined;
  /** Where Slack's payloads come from: `socketReceiver`. */
  readonly receiver?: ((appToken: string) => Receiver) | undefined;
  /** The folder of the files saved from messages: `$TMPDIR/awaydesk`. */
  readonly uploads?: string | undefined;
  /** How a file is downloaded. */
  readonly fetch?: Fetch | undefined;
  /** `!open`'s listings. */
  readonly listings?: Listings | undefined;
  /** Wall-clock seconds, as a Slack ts counts them. */
  readonly now?: (() => number) | undefined;
}

/** The text of a field `auth.test` must answer, which a log line and an identity rely on. */
export function authField(
  answer: { readonly user_id?: string | undefined; readonly team_id?: string | undefined },
  key: "user_id" | "team_id",
): string {
  const value = answer[key];
  if (typeof value !== "string" || value === "") throw new Error(`auth.test answered no ${key}`);
  return value;
}

/**
 * What deletes a thread for the Home tab, when the owner's user token is configured. The token
 * must be the owner's own, in the bot's workspace: it deletes as whoever it belongs to.
 */
export async function deleter(
  userToken: string | null,
  slack: SlackClient,
  identity: Identity,
  state: DeleterState,
  sessions: Pick<SessionsPort, "release" | "free">,
  names: () => Names,
  clients: Pick<Clients, "owner"> = CLIENTS,
): Promise<ThreadDeleter | null> {
  if (userToken === null) return null;
  const owner = clients.owner(userToken);
  const who = await owner.auth.test();
  if (
    authField(who, "user_id") !== identity.ownerUserId ||
    authField(who, "team_id") !== identity.teamId
  ) {
    throw new ConfigError("SLACK_USER_TOKEN must be the owner's own token, in the bot's workspace");
  }
  return new ThreadDeleter(slack, owner, {
    botUserId: identity.botUserId,
    ownerUserId: identity.ownerUserId,
    state,
    names,
    release: (channelId, threadId) => sessions.release(channelId, threadId),
    free: (channelId, threadId) => sessions.free(channelId, threadId),
  });
}

/** The variable `context` must hold for `name`: the daemon does not start without the required. */
function variable(context: ChatContext, name: string): string {
  const value = context.variables[name];
  if (value === undefined) throw new ConfigError(`${name} is not set`);
  return value;
}

/** The shape of each token, checked before Slack is called: a swapped pair is told at once. */
function checkTokens(context: ChatContext): void {
  if (!variable(context, "SLACK_BOT_TOKEN").startsWith("xoxb-")) {
    throw new ConfigError("SLACK_BOT_TOKEN must be the Bot User OAuth Token (xoxb-...)");
  }
  if (!variable(context, "SLACK_APP_TOKEN").startsWith("xapp-")) {
    throw new ConfigError("SLACK_APP_TOKEN must be the app-level token (xapp-...)");
  }
  const userToken = context.variables.SLACK_USER_TOKEN;
  if (userToken !== undefined && !userToken.startsWith("xoxp-")) {
    throw new ConfigError("SLACK_USER_TOKEN must be the User OAuth Token (xoxp-...)");
  }
}

/** The registry's entry for Slack. */
export function slackChat(options: SlackOptions = {}): ChatEntry {
  return {
    required: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_OWNER_USER_ID"],
    optional: ["SLACK_USER_TOKEN"],
    async build(context: ChatContext): Promise<ChatProvider> {
      checkTokens(context);
      try {
        return await assemble(options, context);
      } catch (error) {
        // The daemon logs a start that failed by the name of its error: Slack's code, as before.
        if (error instanceof ConfigError || error instanceof ChatError) throw error;
        throw new ChatError(describe(error), { cause: error });
      }
    },
  };
}

/** Everything of the Slack side that does not need the core. */
async function assemble(options: SlackOptions, context: ChatContext): Promise<ChatProvider> {
  const botToken = variable(context, "SLACK_BOT_TOKEN");
  const appToken = variable(context, "SLACK_APP_TOKEN");
  const clients = options.clients ?? CLIENTS;
  const [slack, replySlack] = clients.bot(botToken);
  const auth = await slack.auth.test();
  const identity: Identity = {
    ownerUserId: variable(context, "SLACK_OWNER_USER_ID"),
    teamId: authField(auth, "team_id"),
    botUserId: authField(auth, "user_id"),
  };
  const limiter = new UpdateLimiter({ clock: context.steady });
  // What the Slack side asks of the core is read here when it is asked: the core is built
  // after this provider is, and `context.core()` is not ready until then.
  const state = {
    thread: (channelId: string, threadId: string) =>
      context.core().state.thread(channelId, threadId),
    channels: () => context.core().state.channels(),
    threads: () => context.core().state.threads(),
    removeThread: (channelId: string, threadId: string) =>
      context.core().state.removeThread(channelId, threadId),
  };
  // The provider is made last, from these parts; they ask it for the names when they show a
  // line, which is after the core exists.
  const names = (): Names => chat.names();
  const threadDeleter = await deleter(
    context.variables.SLACK_USER_TOKEN ?? null,
    slack,
    identity,
    state,
    {
      release: (channelId, threadId) => context.core().sessions.release(channelId, threadId),
      free: (channelId, threadId) => context.core().sessions.free(channelId, threadId),
    },
    names,
    clients,
  );
  const home = new Home(slack, {
    ownerUserId: identity.ownerUserId,
    teamId: identity.teamId,
    state,
    names,
    sessionsOf: (directory) => context.core().agent.listSessions(directory),
    ...(threadDeleter !== null && {
      delete: (channelId, threadId) => threadDeleter.delete(channelId, threadId),
      clean: (channelId) => threadDeleter.clean(channelId),
    }),
    clock: context.clock,
  });
  const uploads = options.uploads ?? uploadsDir();
  await prepareUploads(uploads);
  const chat = new SlackChat({
    slack,
    replies: replySlack,
    identity,
    limiter,
    clock: context.clock,
    steady: context.steady,
    agent: () => context.core().agent,
    app: {
      core: () => context.core(),
      config: { botToken, allowedRoot: context.allowedRoot },
      guard: new ChannelGuard(slack, identity),
      home,
      uploads,
      receiver: (options.receiver ?? socketReceiver)(appToken),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(options.listings !== undefined && { listings: options.listings }),
      ...(options.now !== undefined && { now: options.now }),
    },
  });
  return chat;
}
