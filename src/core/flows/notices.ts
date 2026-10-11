/**
 * The notices the daemon owes a channel from an earlier version, posted once the chat is
 * connected.
 */
import type { ChatProvider } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import type { StateStore } from "../state.ts";
import * as texts from "../texts.ts";

export const logger = getLogger("awaydesk.core.flows.notices");

/**
 * The v1-to-v2 migration notice, once per channel, top-level: not a reply to any message. A
 * channel whose post failed keeps its flag for the next start.
 */
export async function postUpgradeNotices(
  chat: ChatProvider,
  state: Pick<StateStore, "pendingNotices" | "clearNotice">,
): Promise<void> {
  for (const channelId of state.pendingNotices()) {
    try {
      await chat.channel(channelId).notice(texts.UPGRADE_NOTICE);
    } catch (error) {
      logger.warning(`could not post the upgrade notice in ${channelId}: ${errorName(error)}`);
      continue;
    }
    state.clearNotice(channelId);
  }
}
