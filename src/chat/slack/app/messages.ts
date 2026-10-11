/**
 * A message the owner wrote, read from Slack's payload into the message the core is told of
 * (`InboundMessage`): its text as typed and with the composer's marks removed, whether it
 * carries files or was spoken, and the prompt its files make. What the message means, where it
 * is routed and in what order it is sent are the core's (`core/flows/messages.ts`).
 *
 * Ordering. The core takes a thread's messages in the order they were handed over, although
 * files take a while to download. The provider keeps its part: from the moment the listener's
 * checks are over to the call `ChatInbound.message`, nothing is awaited (`(sync)` in `app.ts`),
 * and `content` is read by the core inside the message's own turn.
 */

import type { PromptContent } from "../../../agent/seam.ts";
import { fill, named } from "../../../core/port.ts";
import { strip } from "../../../text.ts";
import type { InboundMessage } from "../../seam.ts";
import {
  type DownloadedImage,
  DownloadFailed,
  imagesRefusal,
  isImage,
  limitFor,
  promptFor,
  refusal,
  save,
} from "../attachments.ts";
import { mrkdwnEscape } from "../reply/escape.ts";
import * as slackTexts from "../texts.ts";
import type { Answers, AppParts } from "./answers.ts";
import { items, type Payload, str, text } from "./wire.ts";

// Slack sends a link as <url|label> or <url> (message formatting reference, read 2026-09-25).
// Mentions (<@U…>, <#C…>) stay as sent: naming them would need a scope the app does not have.
const LINK = /<((?:https?|mailto):[^|>]+)(?:\|([^>]+))?>/g;
const SCHEME = /^(?:https?:\/\/|mailto:)/;

function link(_whole: string, url: string, label: string | undefined): string {
  if (label === undefined) return url;
  // A link Slack made from a typed name carries that name as its label; one the owner named
  // keeps its address, which the agent needs to open it.
  return url.replace(SCHEME, "") === label ? label : `${label} (${url})`;
}

/** The text as the owner typed it, with the address of any link the owner named. */
export function slackUnescape(sent: string): string {
  return sent
    .replace(LINK, link)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

// The parts of a composer message a word is read through. A quote or a list is left out: what
// opens it is not what the owner typed first.
const READ_THROUGH = new Set(["rich_text_section", "rich_text_preformatted"]);
// What Slack writes in a message's text around code, bold, italic, strikethrough.
const MARKS = "`*_~";

/** The first element of a list, or an empty record for anything else. */
function firstOf(value: unknown): Record<string, unknown> {
  const head: unknown = Array.isArray(value) ? value[0] : undefined;
  return typeof head === "object" && head !== null ? (head as Record<string, unknown>) : {};
}

/**
 * The text a composer message opens with, without its formatting; null for a message that opens
 * with anything else (a quote, a list, an emoji, a mention) or has no composer block.
 */
function firstRun(blocks: unknown): string | null {
  const block = firstOf(blocks);
  const part = block.type === "rich_text" ? firstOf(block.elements) : {};
  const leaf =
    typeof part.type === "string" && READ_THROUGH.has(part.type) ? firstOf(part.elements) : {};
  if (leaf.type !== "text") return null;
  return typeof leaf.text === "string" ? leaf.text : "";
}

/**
 * `text` without the marks around the run it opens with, when that run starts with `!`: the
 * composer's block says what the run is (`firstRun`), the text holds the rest as the owner sent
 * it. Empty when the message does not open with a formatted `!`, or when the text does not read as
 * its marks, that run, then the same marks closing it or the message.
 */
export function unformatted(text: string, blocks: unknown): string {
  const run = firstRun(blocks);
  const stripped = strip(text);
  const at = stripped.indexOf("!");
  const opening = at === -1 ? stripped : stripped.slice(0, at);
  const body = at === -1 ? "" : stripped.slice(at);
  if (!run?.startsWith("!") || !opening || [...opening].some((c) => !MARKS.includes(c))) {
    return "";
  }
  if (!body.startsWith(run)) return "";
  const after = body.slice(run.length);
  const closing = [...opening].reverse().join("");
  if (after.startsWith(closing)) return run + after.slice(closing.length);
  if (after.endsWith(closing)) return run + after.slice(0, after.length - closing.length);
  return "";
}

/** A Slack file object of a message: wire data, read field by field. */
type SlackFile = Readonly<Record<string, unknown>>;

/**
 * The files a message carries. A `files` that is not a list of objects throws: such a message
 * never becomes a prompt, and never a word either.
 */
export function filesOf(event: Payload): SlackFile[] {
  const files = event.files;
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new TypeError("the message's files are not a list");
  return items(files).map((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      throw new TypeError("a file of the message is not an object");
    }
    return file as SlackFile;
  });
}

/**
 * The prompt for `sent` and its files; null, after telling the owner why, when any file cannot
 * reach the agent: the message is sent whole or not at all.
 */
async function withAttachments(
  parts: AppParts,
  answers: Answers,
  channel: string,
  threadTs: string,
  sent: string,
  files: readonly SlackFile[],
): Promise<PromptContent | null> {
  const { fetch, uploads } = parts;
  const refuse = async (file: SlackFile, reason: string): Promise<void> => {
    const name = mrkdwnEscape(str(file.name || file.id));
    await answers.tellOwner(
      channel,
      threadTs,
      fill(named(slackTexts.UPLOAD_FAILED, parts.names), { name, reason }),
    );
  };

  for (const file of files) {
    const reason = refusal(file, parts.names);
    if (reason !== null) {
      await refuse(file, reason);
      return null;
    }
  }
  const together = imagesRefusal(files, parts.names);
  if (together !== null) {
    await answers.tellOwner(channel, threadTs, together);
    return null;
  }
  const fetched = await Promise.allSettled(
    files.map((file) =>
      fetch({
        url: str(file.url_private_download),
        mimetype: str(file.mimetype),
        limit: limitFor(file),
      }),
    ),
  );
  // Nothing is saved until every file arrived: a failed message leaves no copy behind.
  for (const [index, outcome] of fetched.entries()) {
    if (outcome.status === "fulfilled") continue;
    if (outcome.reason instanceof DownloadFailed) {
      await refuse(
        files[index] as SlackFile,
        fill(slackTexts.UPLOAD_DOWNLOAD, { error: outcome.reason.message }),
      );
      return null;
    }
    throw outcome.reason;
  }
  const images: DownloadedImage[] = [];
  const paths: string[] = [];
  for (const [index, outcome] of fetched.entries()) {
    const file = files[index] as SlackFile;
    if (outcome.status !== "fulfilled") continue;
    if (isImage(file)) {
      images.push({ mediaType: str(file.mimetype), data: outcome.value });
      continue;
    }
    try {
      paths.push(await save(uploads, file, outcome.value));
    } catch (error) {
      if (!(error instanceof DownloadFailed)) throw error;
      await refuse(file, error.message);
      return null;
    }
  }
  return promptFor(sent, images, paths);
}

/**
 * The message `event` is, for the core: written in `channel`, in the thread `threadTs`, with
 * the timestamp `ts`. With `spoken` (a clip's transcript) it is literal whatever its text; so is
 * a message with files, whose `content` downloads them when the core takes the message's turn.
 * Throws when the event's `files` are not a list of objects.
 */
export function inboundMessage(
  parts: AppParts,
  answers: Answers,
  channel: string,
  threadTs: string,
  ts: string,
  event: Payload,
  options: { readonly spoken?: boolean } = {},
): InboundMessage {
  const sent = slackUnescape(text(event.text) ?? "");
  const files = filesOf(event);
  return {
    ref: { channel, thread: threadTs },
    id: ts,
    topLevel: threadTs === ts,
    text: sent,
    // The composer's blocks tell a mark around a `!` from the text alone.
    plain: unformatted(sent, event.blocks) || sent,
    literal: files.length > 0 || (options.spoken ?? false),
    content: async () =>
      files.length > 0 ? withAttachments(parts, answers, channel, threadTs, sent, files) : sent,
  };
}
