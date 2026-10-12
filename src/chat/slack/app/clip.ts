/**
 * An audio clip the owner sent: held until Slack has its transcript (`voice.ts`), then sent as
 * the message the owner would have typed.
 */
import { fill, named, texts } from "../../../core/port.ts";
import { strip } from "../../../text.ts";
import { DownloadFailed } from "../attachments.ts";
import { describe } from "../reply/errors.ts";
import { mrkdwnEscape } from "../reply/escape.ts";
import { Task } from "../reply/tasks.ts";
import * as slackTexts from "../texts.ts";
import * as voice from "../voice.ts";
import { type Answers, type AppParts, isCancelled, logger } from "./answers.ts";
import { isOwner } from "./guards.ts";
import { inboundMessage } from "./messages.ts";
import { type Payload, record, str, text } from "./wire.ts";

/** An audio clip the owner sent, held until Slack has its transcript. */
export interface WaitingClip {
  readonly channel: string;
  readonly threadTs: string;
  readonly ts: string;
  readonly event: Payload;
  /** Gives the wait up after `voice.WAIT_SECONDS`. */
  expiry: Task<void> | null;
}

export class Clips {
  private readonly parts: AppParts;
  private readonly answers: Answers;
  // Clips waiting for their transcript, by file id. In memory only: a restart forgets them,
  // and the owner sends the clip again.
  private readonly clips = new Map<string, WaitingClip>();

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
  }

  /**
   * An audio clip is a prompt once Slack has its transcript, which Slack writes when asked:
   * until then it waits, and the owner is told what to do. Where a typed message would be
   * refused, the clip is refused at once, before any wait.
   */
  async takeClip(
    channel: string,
    threadTs: string,
    ts: string,
    event: Payload,
    file: Payload,
  ): Promise<void> {
    const { identity, sessions, state } = this.parts;
    if (!isOwner(identity, text(file.user), text(file.user_team))) {
      await this.answers.tellOwner(
        channel,
        threadTs,
        named(slackTexts.CLIP_NOT_YOURS, this.parts.names),
      );
      return;
    }
    if (threadTs !== ts && sessions.get(channel, threadTs) === null) {
      await this.answers.tellOwner(channel, threadTs, texts.NOT_A_SESSION);
      return;
    }
    if (threadTs === ts && state.channel(channel) === null) {
      await this.parts.inbound.unbound(channel);
      return;
    }
    const waiting: WaitingClip = { channel, threadTs, ts, event, expiry: null };
    if (voice.ready(file)) {
      await this.sendClip(waiting, file);
      return;
    }
    const fileId = str(file.id);
    // the same file sent again: one wait, the later one
    this.clips.get(fileId)?.expiry?.cancel();
    waiting.expiry = new Task((signal) => this.giveUp(fileId, signal));
    this.clips.set(fileId, waiting);
    await this.answers.tellOwner(
      channel,
      threadTs,
      named(slackTexts.CLIP_WAITING, this.parts.names),
    );
  }

  private async giveUp(fileId: string, signal: AbortSignal): Promise<void> {
    await this.parts.clock.sleep(voice.WAIT_SECONDS, signal);
    // (sync) Taken out with nothing awaited since the sleep: a transcript that arrives now
    // finds no clip, and one that arrived a moment ago cancelled this wait.
    const waiting = this.clips.get(fileId);
    if (waiting === undefined) return;
    this.clips.delete(fileId);
    // Whole minutes: 300 seconds are 5 whichever way a tie rounds (`Math.round` goes up, Python's
    // `round` to even).
    const minutes = Math.round(voice.WAIT_SECONDS / 60);
    await this.answers.tellOwner(
      waiting.channel,
      waiting.threadTs,
      fill(named(slackTexts.CLIP_NOT_SENT, this.parts.names), { minutes }),
    );
  }

  /** Send the clip's transcript as the message the owner would have typed. */
  private async sendClip(waiting: WaitingClip, file: Payload): Promise<void> {
    let heard = voice.preview(file);
    if (heard === null) {
      let body: Uint8Array;
      try {
        body = await this.parts.fetch({
          url: str(file.vtt),
          mimetype: "text/vtt",
          limit: voice.VTT_LIMIT,
        });
      } catch (error) {
        if (!(error instanceof DownloadFailed)) throw error;
        await this.answers.tellOwner(
          waiting.channel,
          waiting.threadTs,
          fill(named(slackTexts.CLIP_UNREADABLE, this.parts.names), {
            reason: mrkdwnEscape(error.message),
          }),
        );
        return;
      }
      // A byte that is no UTF-8 becomes U+FFFD.
      heard = voice.vttText(new TextDecoder("utf-8").decode(body));
    }
    if (!heard) {
      await this.answers.tellOwner(
        waiting.channel,
        waiting.threadTs,
        named(slackTexts.CLIP_EMPTY, this.parts.names),
      );
      return;
    }
    const typed = strip(text(waiting.event.text) ?? "");
    // the composer's blocks describe the typed text alone
    const { blocks: _blocks, ...rest } = waiting.event;
    const said: Payload = { ...rest, text: typed ? `${typed}\n\n${heard}` : heard, files: [] };
    await this.parts.inbound.message(
      inboundMessage(
        this.parts,
        this.answers,
        waiting.channel,
        waiting.threadTs,
        waiting.ts,
        said,
        { spoken: true },
      ),
    );
  }

  /**
   * Slack changed a file: the one inbound path with no user and no channel in it. It acts only
   * on a clip the owner's own message left waiting, and checks the owner and the channel again
   * on the file Slack now describes.
   */
  onFileChange = async (event: Payload): Promise<void> => {
    const { slack, identity } = this.parts;
    const fileId = str(event.file_id || record(event.file).id || "");
    if (!this.clips.has(fileId)) return;
    let file: Payload;
    try {
      const answer = await slack.files.info({ file: fileId });
      if (typeof answer.file !== "object" || answer.file === null) {
        throw new TypeError("files.info answered no file");
      }
      file = answer.file as Payload;
    } catch (error) {
      if (isCancelled(error)) throw error;
      logger.warning(`could not read a waiting clip: ${describe(error)}`);
      return;
    }
    // (sync) Slack sends the event several times while it writes one transcript: the first
    // that finds it complete takes the clip, with nothing awaited in between.
    const waiting = this.clips.get(fileId);
    if (waiting === undefined || !voice.ready(file)) return;
    this.clips.delete(fileId);
    waiting.expiry?.cancel();
    const user = text(file.user);
    const team = text(file.user_team);
    if (!isOwner(identity, user, team)) {
      await this.answers.tellOwner(
        waiting.channel,
        waiting.threadTs,
        named(slackTexts.CLIP_NOT_YOURS, this.parts.names),
      );
      return;
    }
    // The channel is read again: its members can have changed while the clip waited.
    if (!(await this.answers.admitted(user, team, waiting.channel, waiting.threadTs))) return;
    await this.answers.replyOnFailure(waiting.channel, waiting.threadTs, () =>
      this.sendClip(waiting, file),
    );
  };

  /**
   * Give every wait up without a word: the daemon is stopping. A timer of Node's keeps the
   * process alive until it fires.
   */
  close(): void {
    for (const waiting of this.clips.values()) waiting.expiry?.cancel();
    this.clips.clear();
  }
}
