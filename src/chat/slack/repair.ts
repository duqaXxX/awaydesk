/**
 * Ends a reply a crashed daemon left open (issue #19): a stream that never stopped or whose
 * cards still run. The core's repair (`core/flows/repair.ts`) runs once on start, right after the
 * provider is built and before the connection opens, and calls this for each open reply through
 * `ThreadChat.endReply`; a graceful stop clears these same fields itself, so a second start finds
 * nothing to do.
 *
 * A reply's message is stopped first (`chat.stopStream`; Slack ends a stream itself 5 minutes
 * after it started, and answers `message_not_in_streaming_state` to a stop then), which is the
 * one notification the message owes; the edit that follows says it stopped and never notifies,
 * and nothing is posted.
 *
 * `conversations.replies` (docs.slack.dev/reference/methods/conversations.replies, read
 * 2026-09-28, confirmed against a real `conversations.replies` response recorded from a real
 * workspace on 2026-09-28, scrubbed and kept as
 * `test/fixtures/slack/api-conversations-replies-by-ts.json`, and of a stopped stream on
 * 2026-09-29, `api-conversations-replies-stream.json`): `ts` set to the reply's own ts, with
 * `limit=1`, returns only that one message (an `oldest`/`latest`/`inclusive` range built around
 * the same ts instead returned the thread's root too).
 */
import type { KnownBlock, WebClient } from "@slack/web-api";
import { getLogger } from "../../log.ts";
import { isRecord, records } from "../../values.ts";
import { contextBlock, RUNNING_LIST_ID } from "./reply/blocks.ts";
import { describe, gone, NOT_STREAMING } from "./reply/errors.ts";
import type { Limiter } from "./reply/limiter.ts";

export const logger = getLogger("awaydesk.chat.slack.repair");

type Block = Record<string, unknown>;

// What a card left running becomes: it never ended, and will not.
const RUNNING_CARD = ["pending", "in_progress"];
// Slack's own cap: the read-back count is Slack's (streamed markdown reads back as several
// blocks), not the sink's, which keeps a margin under it for what it writes itself.
export const SLACK_BLOCKS = 50;

/**
 * Stop the reply's message, then rewrite it: its blocks as Slack keeps them, every card left
 * running closed as an error (a stopped message would show it so anyway, until it is updated:
 * measured 2026-09-28), the list of what still runs taken off (found by its `block_id`), plus the
 * line that says it stopped. Kept within Slack's 50 blocks: at
 * the cap the line goes into the last context block (the footer), or is left out if there is
 * none; a block that holds content is never replaced. A failed read or a message already gone
 * is logged and left alone: never replaced with a shorter form that would lose its content.
 * `note` is the line that says it stopped. Never rejects. False when the message is there and
 * was not rewritten (a failed read, a failed rewrite), so the caller can ask again; a stop that
 * failed is not a reason to, since Slack ends a stream itself and the rewrite says the rest. A
 * message Slack no longer has (`GONE`) counts as ended, and one that already carries `note` in
 * a context block is left as it is: a rewrite whose answer was lost may have landed.
 */
export async function endReply(
  slack: WebClient,
  limiter: Limiter,
  place: { readonly channel: string; readonly threadTs: string },
  messageTs: string,
  note: string,
): Promise<boolean> {
  const { channel: channelId, threadTs } = place;
  // Whether the stream may have been open: a stop that was refused for another reason is not
  // known to have found it over.
  let streamed = true;
  try {
    await slack.chat.stopStream({ channel: channelId, ts: messageTs });
  } catch (error) {
    // the stream is over already when it is: nothing to stop
    if (describe(error) === NOT_STREAMING) {
      streamed = false;
    } else {
      logger.warning(
        `could not stop a crashed reply's stream in ${channelId}/${threadTs}: ${describe(error)}`,
      );
    }
  }
  let answer: unknown;
  try {
    answer = await slack.conversations.replies({ channel: channelId, ts: messageTs, limit: 1 });
  } catch (error) {
    logger.warning(
      `could not read a crashed reply's message in ${channelId}/${threadTs}: ${describe(error)}`,
    );
    return gone(error);
  }
  const messages = records(isRecord(answer) ? answer.messages : undefined);
  const message = messages.find((found) => String(found.ts) === messageTs);
  if (message === undefined) {
    logger.info(`a crashed reply's message is gone in ${channelId}/${threadTs}`);
    return true;
  }
  if (saysStopped(records(message.blocks), note)) return true;
  // The list of what still runs is no card of the reply's own work: it goes, where the card of a
  // call that never ended is closed as an error.
  const read = records(message.blocks);
  const isList = (block: Block): boolean =>
    block.block_id === RUNNING_LIST_ID || block.task_id === RUNNING_LIST_ID;
  const kept = read.filter((block) => !isList(block));
  const callRunning = kept.some(
    (block) => block.type === "task_card" && RUNNING_CARD.includes(String(block.status)),
  );
  // A message kept open only by the list holds a finished answer (its stream is over and no call
  // of it runs): the app did not stop before it, so no note says so.
  const onlyList = kept.length < read.length && !streamed && !callRunning;
  let blocks: Block[] = kept.map((block) =>
    block.type === "task_card" && RUNNING_CARD.includes(String(block.status))
      ? { ...block, status: "error" }
      : block,
  );
  if (!onlyList) {
    if (blocks.length < SLACK_BLOCKS) blocks.push({ ...contextBlock(note) });
    else blocks = sayStoppedInTheFooter(blocks, note);
  }
  try {
    await limiter.acquire();
    await slack.chat.update({
      channel: channelId,
      ts: messageTs,
      text: onlyList && typeof message.text === "string" ? message.text : note,
      // Blocks as Slack read them back, sent back as they are: opaque to the library's types.
      blocks: blocks as unknown as KnownBlock[],
    });
  } catch (error) {
    logger.warning(
      `could not rewrite a crashed reply in ${channelId}/${threadTs}: ${describe(error)}`,
    );
    return gone(error);
  }
  return true;
}

/** Whether a context block's text already ends with `note`: where this file writes it. */
function saysStopped(blocks: Block[], note: string): boolean {
  return blocks.some((block) => {
    if (block.type !== "context") return false;
    const first = records(block.elements)[0];
    return typeof first?.text === "string" && first.text.endsWith(note);
  });
}

/**
 * The blocks with the stopped line added to the text of the last context block; unchanged when
 * the message has none: the edit's own `text` says it.
 */
function sayStoppedInTheFooter(blocks: Block[], note: string): Block[] {
  const index = blocks.findLastIndex((block) => block.type === "context");
  const last = blocks[index];
  if (last === undefined) return blocks;
  const elements = records(last.elements);
  const first = elements[0];
  if (first === undefined || (first.type !== "mrkdwn" && first.type !== "plain_text")) {
    return blocks;
  }
  const text = typeof first.text === "string" ? first.text : "";
  const joined = `${text} · ${note}`.replace(/^[ ·]+/, "");
  const rewritten = { ...last, elements: [{ ...first, text: joined }, ...elements.slice(1)] };
  return blocks.map((block, i) => (i === index ? rewritten : block));
}
