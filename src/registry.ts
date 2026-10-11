/**
 * The agents and the chats the daemon can run, by the name `AWAYDESK_AGENT` and `AWAYDESK_CHAT`
 * select them with. The one file outside the two modules that names them: `main` takes each
 * module from here, and a test passes its own registry through `run`'s options.
 */
import { claudeAgent } from "./agent/claude/module.ts";
import type { AgentEntry } from "./agent/seam.ts";
import { slackChat } from "./chat/slack/module.ts";
import type { ChatEntry } from "./core/port.ts";

export interface Registry {
  readonly agents: Readonly<Record<string, AgentEntry>>;
  readonly chats: Readonly<Record<string, ChatEntry>>;
  /** The entries taken when the owner's file does not set the variable that selects one. */
  readonly defaults: { readonly agent: string; readonly chat: string };
}

export const REGISTRY: Registry = {
  agents: { claude: claudeAgent() },
  chats: { slack: slackChat() },
  defaults: { agent: "claude", chat: "slack" },
};
