/**
 * Turn an agent's session events into what the owner sees: text as it is written, and one line
 * per tool call or background task. Generic over the events: no branch names a tool, so a tool
 * the agent adds tomorrow renders with no change here. The few tools the terminal shows in words
 * of its own live in `previews`, which falls back to this generic view for any other.
 *
 * The events are the agent seam's (`SessionEvent`). What the SDK's stream repeats or leaves
 * unsaid is settled before they get here, by the back end: a text arrives once, as pieces or
 * whole, and a call's result arrives as its text and as what it did to a file.
 */
import type { Question, SessionEvent } from "../../agent/seam.ts";
import type { Preview, ReplySink, TaskStatus, TaskUpdate } from "../../chat/seam.ts";
import { monotonicClock } from "../../clock.ts";
import { blank } from "../../text.ts";
import { formatTokens } from "../footer.ts";
import * as texts from "../texts.ts";
import {
  ASKERS,
  answered,
  commandLine,
  continued,
  described,
  LAUNCHERS,
  type Launch,
  launchedTogether,
  PREVIEWED,
  preview,
  resuming,
} from "./previews.ts";
import { BACKGROUND, oneLine, STOPPED, splitLines, TITLE_LIMIT } from "./words.ts";

export const OUTPUT_LIMIT = 200;
export const CHILD_LINES = 10;

/** The reply the renderer writes: the chat seam's `ReplySink`. The footer is not its concern. */
export type Sink = ReplySink;

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;
export type TaskStarted = EventOf<"task_started">;
export type TurnEnded = EventOf<"turn_ended">;
/** An event of a task's life. */
export type TaskEvent = EventOf<"task_started" | "task_progress" | "task_updated" | "task_ended">;

function line(
  id: string,
  title: string,
  status: TaskStatus,
  fields: Partial<TaskUpdate> = {},
): TaskUpdate {
  return {
    id,
    title,
    status,
    details: null,
    output: null,
    name: "",
    task: false,
    calls: 0,
    preview: null,
    folded: null,
    startedAt: null,
    ...fields,
  };
}

/** `Name: first non-empty string argument`, whatever the tool. */
export function taskTitle(name: string, input: Readonly<Record<string, unknown>>): string {
  for (const value of Object.values(input)) {
    if (typeof value === "string" && !blank(value)) {
      return oneLine(`${name}: ${value}`, TITLE_LIMIT);
    }
  }
  return name;
}

/** A result's text as a line of its call: its first line that says something, or null. */
export function resultSummary(output: string | null): string | null {
  if (output === null) return null;
  const first = splitLines(output).find((text) => !blank(text)) ?? "";
  return oneLine(first, OUTPUT_LIMIT) || null;
}

export function formatDuration(seconds: number): string {
  const whole = Math.trunc(seconds);
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

/**
 * How a task's end opens the agent's report of it: the notification's own summary, as the
 * terminal prints it (`Agent "..." finished · 10s`), with the duration when there is one.
 */
export function endedLine(summary: string, status: string, durationMs: number | null): string {
  const said = `${status === "failed" ? "✗" : "✓"} ${summary}`;
  return durationMs === null ? said : `${said} · ${formatDuration(durationMs / 1000)}`;
}

export function terminalStatus(status: string): [status: TaskStatus, output: string | null] {
  if (status === "failed") return ["error", null];
  if (status === "stopped" || status === "killed") return ["complete", STOPPED];
  return ["complete", null];
}

export class TurnRenderer {
  readonly #sink: Sink;
  /** The session's folder, which previews name paths from. */
  readonly #cwd: string | null;
  /** The names the texts that name the agent or the chat take. */
  readonly #names: texts.Names;
  readonly #lines = new Map<string, TaskUpdate>();
  /** The lines the sink has been given: a held call's line is in `#lines` before it is drawn. */
  readonly #drawn = new Set<string>();
  readonly #rootOf = new Map<string, string>();
  readonly #children = new Map<string, string[]>();
  readonly #lineOfTask = new Map<string, string>();
  // Tasks started and not yet ended (task id -> line id). Only the lifecycle events say this
  // reliably: a subagent can move to the background without a second `task_started`.
  readonly #running = new Map<string, string>();
  /** Lines of tasks no call started (a command's). */
  readonly #commands = new Set<string>();
  /** Tasks shown on a command's line, not on their own. */
  readonly #nested = new Set<string>();
  // Tasks a call inside another call started (a long command a subagent runs), held aside
  // while that call is open: the root's work, shown on its card through `#child`. A task
  // that ends before its call's result stays here, dropped; one still running at the result
  // outlives its call and leaves (`#outlived`). Kept after the end, so a later event of a
  // dropped one (a `task_updated` after its notification) still finds it.
  readonly #inside = new Set<string>();
  /** The held-aside tasks not yet ended. */
  readonly #aside = new Map<string, TaskStarted>();
  /** Nested calls whose result arrived. */
  readonly #closedCalls = new Set<string>();
  /** Calls of a tool that starts agents, kept from the sink until their task says how it runs. */
  readonly #undecided = new Set<string>();
  // Calls whose agent runs in the background, and lines of tasks in the background no call of
  // this reply started: no card. What the agent does under such a call writes nothing, as in
  // the terminal.
  readonly #launched = new Set<string>();
  // The tasks started in the background whose launch line is not written yet. The terminal
  // writes one line for the agents of one message, so they wait for the message to end and for
  // every held call of it to say how its agent runs; the cards of the message's calls come
  // before them, and anything else the reply writes after them.
  #launches: (Launch & { readonly callId: string })[] = [];
  // The calls whose agent launched in the background and whose result has not come: it names
  // the model the agent runs on, so their launch line waits for it. `close` and the notes that
  // follow a launch write the line without it when the result never comes.
  readonly #awaiting = new Set<string>();
  /** Tasks whose call has not ended: in the foreground, as far as the reply knows. */
  readonly #waited = new Set<string>();
  /** A message of the agent's is being written, at the top level. */
  #messageOpen = false;
  /** A line of the daemon's was written into the reply. */
  #wroteLine = false;
  /** What kind of task each one is, as it said when it started. */
  readonly #kinds = new Map<string, TaskStarted["kind"]>();
  // Tasks in the background under a call that stays a call, counted in its run like any other
  // (captured on Claude Code 2.1.296, 2026-10-14): no card of their own. Each shows by its launch
  // line, in the list of what still runs and by its end line.
  readonly #quiet = new Set<string>();
  // A line of the daemon's inside the reply (an agent's launch, a task's end) is the last thing
  // written. It ends with no break of its own, since a card that follows needs none and Slack
  // draws the empty lines; text that follows is set a paragraph apart.
  #breakOwed = false;
  /** `takePromoted`'s, not yet taken. */
  #promoted: TaskStarted[] = [];
  /** A question's answers, until its call ends. */
  readonly #answers = new Map<string, Preview>();
  #wroteText = false;
  /** Whether the chat shows a text as it is written; without it a text is held until it ends. */
  readonly #streaming: boolean;
  /** The pieces of the text being written, not yet handed to the sink (`streaming` off). */
  #held = "";
  /** The agent's text is the last thing in the reply, no card since. */
  #afterText = false;
  /** The text that just started follows text directly. */
  #breakDue = false;
  /** The end of the last turn fed here, or null: how it ended and its last text. */
  result: TurnEnded | null = null;
  authFailed = false;
  /** The category of the last message the agent wrote itself about a failure, if any. */
  error: string | null = null;
  #closedOut = false;

  /** Whether the session saw a task start before this reply did (an agent a message continues). */
  readonly #startedBefore: (taskId: string) => boolean;
  /** The name of a model by its id, for the model an agent ran on. */
  readonly #modelName: (id: string) => string;
  /** Whether the session saw the task start in an earlier reply and it has ended since. */
  readonly #endedBefore: (taskId: string) => boolean;
  /** Seconds on the clock the chat compares `TaskUpdate.startedAt` with. */
  readonly #now: () => number;
  // Calls that continue an agent that has ended: a line of words and no card, kept by id so that a
  // call that fails can still draw the card that says why.
  readonly #resumed = new Map<string, TaskUpdate>();

  constructor(
    sink: Sink,
    names: texts.Names,
    cwd: string | null = null,
    streaming = true,
    startedBefore: (taskId: string) => boolean = () => false,
    modelName: (id: string) => string = (id) => id,
    endedBefore: (taskId: string) => boolean = () => false,
    now: () => number = () => monotonicClock.time(),
  ) {
    this.#sink = sink;
    this.#names = names;
    this.#cwd = cwd;
    this.#streaming = streaming;
    this.#startedBefore = startedBefore;
    this.#modelName = modelName;
    this.#endedBefore = endedBefore;
    this.#now = now;
  }

  /** One event of the session into the reply. An event that shows nothing is left out. */
  async feed(event: SessionEvent): Promise<void> {
    switch (event.type) {
      case "text_started":
        // Two texts with no card between them (a goal's inner turns, a Stop hook that
        // continues the turn) would run together: the break waits for the first piece, so a
        // text that stays empty adds none.
        await this.#handOver(); // the text before this one has ended
        this.#breakDue = this.#afterText;
        break;
      case "text_delta": {
        const broken = this.#breakDue;
        this.#breakDue = false;
        await this.#text(broken ? `\n\n${event.text}` : event.text, { piece: true });
        break;
      }
      case "message_started":
        if (event.parentCallId === null) this.#messageOpen = true;
        break;
      case "message_ended":
        if (event.parentCallId === null) {
          await this.#handOver();
          this.#messageOpen = false;
          await this.#settleLaunches();
        }
        break;
      case "text":
        // Text that came whole is a command's own output (`Goal set: …` before a goal's first
        // inner turn): like a text that follows another, it needs a break only when text is
        // the last thing written.
        await this.#text((this.#afterText ? "\n\n" : "") + event.text);
        break;
      case "agent_error":
        await this.#failed(event);
        break;
      case "call_started":
        await this.#callStarted(event);
        break;
      case "call_ended":
        await this.#callEnded(event);
        break;
      case "task_started":
        await this.#taskStarted(event);
        break;
      case "task_progress": {
        // A task with no line of its own writes nothing: its call's line, if it had one, is
        // an ended call's.
        const entry = this.lineless(event.taskId)
          ? undefined
          : this.#lines.get(this.#lineOfTask.get(event.taskId) ?? "");
        if (entry !== undefined) {
          await this.#set({ ...entry, details: oneLine(event.description, OUTPUT_LIMIT) });
        }
        break;
      }
      case "task_ended":
        await this.#taskEnded(event.taskId, event.status, event.summary);
        break;
      case "task_updated":
        if (event.terminal && event.status !== null) {
          await this.#taskEnded(event.taskId, event.status, null);
        }
        break;
      case "compacted":
        await this.#compacted(event.tokensBefore, event.tokensAfter);
        break;
      case "turn_ended":
        this.result = event;
        if (!this.#wroteText && event.finalText) {
          await this.#text(event.finalText);
        } else if (!this.#wroteText && this.error !== null) {
          await this.#text(
            texts.fill(texts.named(texts.ERROR_REPLY, this.#names), { error: this.error }),
            { notice: true },
          );
        }
        break;
      default:
        break;
    }
  }

  /** Ids of the tasks that outlive the turn; a later task event fed here updates them. */
  get runningTasks(): string[] {
    return [...this.#running.keys()];
  }

  /**
   * The running tasks that are in the background: every one but a task whose call still waits
   * for it (a long command in the foreground, a subagent the call waits for), which the reply
   * shows on that call's line.
   */
  get backgroundTasks(): string[] {
    return this.runningTasks.filter((taskId) => !this.#waited.has(taskId));
  }

  /** The line title of a task this reply shows, running or ended. */
  taskTitle(taskId: string): string | null {
    return this.#lines.get(this.#lineOfTask.get(taskId) ?? "")?.title ?? null;
  }

  /** Whether this reply shows that task, running or ended: on a line, or as a launch line. */
  shows(taskId: string): boolean {
    const id = this.#lineOfTask.get(taskId);
    return (
      id !== undefined && (this.#quiet.has(taskId) || this.#lines.has(id) || this.#launched.has(id))
    );
  }

  /**
   * Whether this reply shows that task with no line of its own (an agent or a command in the
   * background): nothing here says its end, which is said in words.
   */
  lineless(taskId: string): boolean {
    return this.#quiet.has(taskId) || this.#launched.has(this.#lineOfTask.get(taskId) ?? "");
  }

  /**
   * Whether this task event is of a task held aside or dropped as the work of a call inside
   * another call, a call whose root this reply holds: the agent reports such a task to the
   * subagent, not to the conversation. False for a call this reply never saw, for a task that
   * started after its call's result, and for one that outlived its call.
   */
  nests(event: TaskEvent): boolean {
    if (event.type === "task_started") {
      const call = event.callId;
      return call !== null && this.#rootOf.has(call) && !this.#closedCalls.has(call);
    }
    return this.#inside.has(event.taskId);
  }

  /**
   * The tasks that outlived the nested call that started them since the last call: each is now
   * an ordinary task of this reply (a line, a running task), which the session records as it
   * does any task it saw start.
   */
  takePromoted(): TaskStarted[] {
    const promoted = this.#promoted;
    this.#promoted = [];
    return promoted;
  }

  /**
   * Keep a question's answers for the line of its call, which shows them once the call ends.
   * False when this reply has no line of its own for that call (one asked inside a subagent
   * shows on the subagent's line) or there is no answer to show: the caller keeps the answers
   * elsewhere.
   */
  answered(
    callId: string,
    questions: readonly Pick<Question, "text">[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): boolean {
    const shown = answered(questions, answers, this.#names);
    if (shown === null || !this.#lines.has(callId)) return false;
    this.#answers.set(callId, shown);
    return true;
  }

  /** Whether this reply holds the line of that call, or of the subagent it runs in. */
  owns(callId: string): boolean {
    return this.#lines.has(callId) || this.#rootOf.has(callId) || this.#launched.has(callId);
  }

  /**
   * End the turn's own part of the reply: every open line is closed, except a task still
   * running, whose line stays open until its own end arrives through `feed` or `stopRunning`.
   * Does not end the reply; the caller follows with `closeOut` once it knows nothing more is
   * coming, which can be after more than one call here (a background task's own report turn
   * closes the same reply again).
   */
  async close(signal?: AbortSignal): Promise<void> {
    const interrupted = this.result !== null && this.result.ending === "interrupted";
    await this.#handOver();
    await this.#writeLaunches();
    if (
      !this.#wroteText &&
      !this.#wroteLine &&
      this.#lines.size === 0 &&
      this.#launched.size === 0
    ) {
      // A command that prints nothing (a local one, say) still gets a visible answer.
      await this.#text(interrupted ? texts.STOPPED : texts.named(texts.NO_OUTPUT, this.#names), {
        notice: true,
      });
    }
    const running = new Set(this.#carded().map(([, lineId]) => lineId));
    const closing: TaskUpdate[] = [];
    for (const entry of this.#lines.values()) {
      if (running.has(entry.id)) {
        closing.push({ ...entry, status: "in_progress", details: BACKGROUND, task: true });
      } else if (entry.status === "pending" || entry.status === "in_progress") {
        closing.push({
          ...entry,
          status: "complete",
          output: interrupted ? STOPPED : entry.output,
        });
      }
    }
    for (const entry of closing) this.#lines.set(entry.id, entry);
    await this.#sink.finish(closing, signal);
  }

  /** Whether this reply has already ended. */
  get closedOut(): boolean {
    return this.#closedOut;
  }

  /**
   * End the reply; call after `close`. True when it ended in the chat. A second call is a no-op
   * of the sink's.
   */
  async closeOut(signal?: AbortSignal): Promise<boolean> {
    await this.#handOver();
    this.#closedOut = true;
    return this.#sink.closeOut(signal);
  }

  get sink(): Sink {
    return this.#sink;
  }

  /** The agent's process is gone and its tasks with it: close their lines as stopped. */
  async stopRunning(): Promise<void> {
    for (const taskId of [...this.#running.keys()]) {
      await this.#taskEnded(taskId, "stopped", null);
    }
  }

  /**
   * A note before what follows it: usually the daemon's own line, before the agent's reply even
   * starts. It is not the agent's text, so a local command's result still shows after it. A
   * report turn feeds one into an already-written reply instead (the one that started the task
   * it reports): a blank line still separates it from what is there, as a paragraph break would.
   */
  async feedNotice(text: string, aside = false): Promise<void> {
    await this.#writeLaunches();
    const prefix = this.#wroteText || this.#lines.size > 0 || this.#breakOwed ? "\n\n" : "";
    this.#afterText = false;
    this.#breakOwed = false;
    await this.#handOver();
    await this.#sink.text(`${prefix}${text}\n\n`, { notice: true, ending: false, aside });
  }

  /**
   * What opens a turn the agent starts on its own: the end lines of the tasks it reports. A
   * note as `feedNotice` writes one, and the reply's content: a turn that then says nothing has
   * said this, and gets no line about an answer with no text.
   */
  async feedOpening(text: string, aside = false): Promise<void> {
    await this.feedNotice(text, aside);
    this.#wroteLine = true;
  }

  /**
   * A line of the daemon's among what the reply holds: a task's end, said where the turn is.
   * A paragraph apart from what is before it, and from the text that follows.
   */
  async feedLine(text: string): Promise<void> {
    await this.#writeLaunches();
    await this.#line(text, true);
  }

  /** `aside`: a line about the work, which a chat may draw smaller (a task's end). */
  async #line(text: string, aside = false): Promise<void> {
    const apart = this.#breakOwed || this.#wroteText || this.#lines.size > 0 || this.#wroteLine;
    this.#afterText = false;
    await this.#handOver();
    await this.#sink.text(`${apart ? "\n\n" : ""}${text}`, {
      notice: true,
      ending: false,
      aside,
    });
    this.#breakOwed = true;
    this.#wroteLine = true;
  }

  /** Write the launch lines that wait, once nothing more can join them. */
  async #settleLaunches(): Promise<void> {
    if (!this.#messageOpen && this.#undecided.size === 0 && this.#awaiting.size === 0) {
      await this.#writeLaunches();
    }
  }

  /** The launch line of the agents that wait for one: their own, or one for them all. */
  async #writeLaunches(): Promise<void> {
    if (this.#launches.length === 0) return;
    const launches = this.#launches;
    this.#launches = [];
    this.#awaiting.clear(); // written as it stands: a result that comes later changes nothing
    await this.#line(launchedTogether(launches));
  }

  /** The running tasks that have a line of their own, each with its line's id. */
  #carded(): [taskId: string, lineId: string][] {
    return [...this.#running].filter(([taskId]) => !this.#quiet.has(taskId));
  }

  /** A note of the daemon's after what the reply holds: what was not sent, what a restart dropped. */
  async feedError(text: string): Promise<void> {
    await this.#text(`\n\n${text}`, { notice: true });
  }

  /**
   * The turn was cut short outside the agent's stream (the process died, the session closed):
   * say so in the reply, as the line on how it ended.
   */
  async feedEnding(text: string): Promise<void> {
    await this.#text(`\n\n${text}`, { notice: true, ending: true });
  }

  /** The agent compacted the conversation, on request or on its own: say by how much. */
  async #compacted(before: number | null, after: number | null): Promise<void> {
    const said =
      before !== null && after !== null
        ? texts.fill(texts.COMPACTED, { before: formatTokens(before), after: formatTokens(after) })
        : texts.COMPACTED_PLAIN;
    await this.#text(`${this.#wroteText ? "\n\n" : ""}${said}\n\n`, { notice: true });
  }

  async #failed(event: EventOf<"agent_error">): Promise<void> {
    if (event.parentCallId !== null) {
      // A subagent's own failed request (recorded: `subagent-api-error.jsonl`): like every
      // other text of a subagent it stays out of the reply, whose turn may well go on and
      // succeed. Its words go under the card of the call that started the subagent, the
      // outermost one when subagents nest, so the failure shows whether or not a task event
      // of that subagent ever reaches this reply.
      await this.#childNote(event.parentCallId, event.text);
      return;
    }
    if (event.kind === "authentication") {
      this.authFailed = true;
      const failed = this.#names.login === null ? texts.AUTH_FAILED_NO_LOGIN : texts.AUTH_FAILED;
      await this.#text(texts.named(failed, this.#names), { notice: true });
      return;
    }
    // The agent wrote this message itself: its words name the failure and what to do next, as
    // the terminal shows them. With no words here the turn's end speaks: it repeats them, and
    // `feed` falls back to the category.
    this.error = event.category;
    if (event.text !== "") {
      await this.#text((this.#wroteText ? "\n\n" : "") + event.text, { notice: true });
    }
  }

  async #callStarted(event: EventOf<"call_started">): Promise<void> {
    const title = described(event.toolName, event.input) ?? taskTitle(event.toolName, event.input);
    const parent = event.parentCallId;
    const root = parent === null ? null : (this.#rootOf.get(parent) ?? parent);
    if (root !== null && (this.#lines.has(root) || this.#launched.has(root))) {
      this.#rootOf.set(event.callId, root);
      await this.#child(root, title);
    } else if (this.#continues(event)) {
      // The terminal draws no line for a message to an agent it knows: it writes under the agent
      // that it resumes. The task that starts again under this call finds no card (`#taskStarted`).
      this.#resumed.set(
        event.callId,
        line(event.callId, title, "in_progress", { name: event.toolName }),
      );
      await this.feedLine(resuming(continued(event.toolName, event.input) as string));
    } else if (
      PREVIEWED.has(event.toolName) ||
      ASKERS.has(event.toolName) ||
      LAUNCHERS.has(event.toolName)
    ) {
      // Kept from the sink until it ends: what shows it then is its preview with no card (a
      // question's record, once answered), or a card that says why it failed. An approval has a
      // message of its own. A call that starts an agent is kept until its task starts
      // (`#taskStarted`).
      if (LAUNCHERS.has(event.toolName)) this.#undecided.add(event.callId);
      this.#lines.set(
        event.callId,
        line(event.callId, title, "in_progress", { name: event.toolName }),
      );
      this.#afterText = false;
    } else {
      await this.#set(line(event.callId, title, "in_progress", this.#timed(event)));
    }
  }

  /**
   * Whether the call continues an agent that has ended, which is the case the terminal was seen
   * to word (2026-10-16); a message to one that still runs keeps its card.
   */
  #continues(event: EventOf<"call_started">): boolean {
    const task = continued(event.toolName, event.input);
    if (task === null) return false;
    return this.#lineOfTask.has(task) ? !this.#running.has(task) : this.#endedBefore(task);
  }

  /**
   * A call's fields: its name, and for a call the terminal times, when it began and its command.
   */
  #timed(event: EventOf<"call_started">): Partial<TaskUpdate> {
    const command = commandLine(event.toolName, event.input);
    if (command === null) return { name: event.toolName };
    return { name: event.toolName, details: command, startedAt: this.#now() };
  }

  async #callEnded(event: EventOf<"call_ended">): Promise<void> {
    await this.#outlived(event.callId);
    const model = event.model === null ? null : this.#modelName(event.model);
    if (this.#awaiting.delete(event.callId)) {
      this.#launches = this.#launches.map((launch) =>
        launch.callId === event.callId ? { ...launch, model } : launch,
      );
    }
    const entry = this.#lines.get(event.callId);
    if (entry === undefined) {
      const resumed = this.#resumed.get(event.callId);
      if (resumed !== undefined && event.isError) {
        // The words were drawn; a call that failed says why on a card, as any failed call does.
        await this.#set({ ...resumed, status: "error", output: resultSummary(event.output) });
      }
      await this.#settleLaunches();
      return;
    }
    this.#undecided.delete(event.callId); // no task came: the call shows as any other
    // The call waits for no task any more: one still running is in the background from here.
    for (const [taskId, lineId] of this.#running)
      if (lineId === entry.id) this.#waited.delete(taskId);
    let outliving = this.#carded()
      .filter(([, lineId]) => lineId === entry.id)
      .map(([taskId]) => taskId);
    if (outliving.length > 0 && outliving.every((id) => this.#kinds.get(id) === "command")) {
      // A command left running in the background: its call has ended like any other, and is
      // counted so. The command goes on with no line of its own.
      for (const taskId of outliving) this.#quiet.add(taskId);
      outliving = [];
    }
    if (outliving.length > 0) {
      // The call only launched a task, which is still running: it outlives the call, so its
      // line becomes a task's line and stays open. A task that ends before its call's result
      // (a long command in the foreground) never gets here.
      await this.#set({
        ...entry,
        details: BACKGROUND,
        task: true,
        output: resultSummary(event.output),
      });
    } else if (entry.output === STOPPED) {
      // Its task already ended as stopped; the result that follows only reports the rejection
      // (recorded: `interrupt.jsonl`, CLI 2.1.283), and must not turn a stopped call into a
      // failed one.
    } else {
      const kept = this.#answers.get(event.callId) ?? null;
      this.#answers.delete(event.callId);
      const shown = event.isError
        ? null
        : (kept ?? preview(entry.name, event.fileChange, this.#cwd));
      await this.#set({
        ...entry,
        // The terminal names a subagent's model on its call line; a card has the title.
        title:
          model === null || !LAUNCHERS.has(entry.name) ? entry.title : `${entry.title} · ${model}`,
        status: event.isError ? "error" : "complete",
        output: resultSummary(event.output),
        preview: shown,
      });
    }
    await this.#settleLaunches();
  }

  async #taskStarted(event: TaskStarted): Promise<void> {
    this.#kinds.set(event.taskId, event.kind);
    if (this.nests(event)) {
      // The agent starts a task for a long command a subagent runs in the foreground of its
      // own context (recorded: `subagent-nested-command.jsonl`, CLI 2.1.286). The call already
      // shows on its root's card (`#child`): one work, one line, unless the task outlives the
      // call (`#outlived`).
      this.#inside.add(event.taskId);
      this.#aside.set(event.taskId, event);
      return;
    }
    // An id held aside before, starting again after its call closed, is an ordinary task now:
    // its later events must reach it, or its end would never close its line.
    this.#inside.delete(event.taskId);
    const call = event.callId;
    if (call !== null && this.#resumed.has(call)) {
      // The agent a message continues runs again: no card and no launch line, as the terminal
      // draws none. It is bound to the message's call, a line nothing draws, so that the card
      // it first had (an agent the call waited for) is never reopened by this reply's close.
      this.#launched.add(call);
      this.#bind(event.taskId, call);
      return;
    }
    if (call !== null && this.#launched.has(call)) {
      // The agent of a call already written as a line of text starts again, under that call
      // (recorded: `subagent-nested-background.jsonl`, where the end of a command it left
      // running wakes it): running once more, and no second line.
      this.#bind(event.taskId, call);
      return;
    }
    const held = call !== null && this.#undecided.delete(call) ? this.#lines.get(call) : undefined;
    // A task that started before, here or in an earlier reply, and starts again under another
    // call (an agent a message continues) is that call's work, with no second launch line: a
    // resumed task keeps its id (SDK 0.3.300, `SDKTaskStartedMessage.run_id`).
    const known = this.#lineOfTask.has(event.taskId) || this.#startedBefore(event.taskId);
    const line = call === null ? undefined : this.#lines.get(call);
    if (line !== undefined && event.background === true && !known) {
      await this.#launch(event, line, held !== undefined);
      return;
    }
    // An agent the call waits for: its card, from here on.
    if (held !== undefined) await this.#set(held);
    if (call !== null && this.#lines.has(call)) {
      // A call's task: the agent starts one for a long command in the foreground too
      // (recorded: `interrupt.jsonl`, CLI 2.1.283). The line stays the call's until the call's
      // result arrives with the task still running (`#callEnded`).
      this.#bind(event.taskId, call);
      this.#waited.add(event.taskId);
      return;
    }
    const command = [...this.#running.values()].reverse().find((id) => this.#commands.has(id));
    if (call !== null && command !== undefined && !this.#rootOf.has(call)) {
      // Started by a call this reply never saw while a command's task runs: an agent inside
      // that command (a forked skill typed as a command streams none of its own calls,
      // recorded: `skill-fork-command.jsonl`, CLI 2.1.283). It shows on the command's line, as
      // a subagent's calls show on the subagent's: one work, one line.
      this.#nested.add(event.taskId);
      await this.#child(command, oneLine(event.description, TITLE_LIMIT));
      return;
    }
    await this.#openLine(event);
  }

  /**
   * A task a call of this reply started in the background, whatever its kind (issue #311): its
   * launch line, as text of the reply, and no card. A call held until its task said how it runs
   * (one that starts an agent) is that line alone, as in the terminal; any other call stays a
   * call, counted in its run. The task still runs for this reply, which the list of what still
   * runs reads.
   */
  async #launch(event: TaskStarted, line: TaskUpdate, held: boolean): Promise<void> {
    const call = line.id;
    this.#bind(event.taskId, call);
    if (held) {
      this.#lines.delete(call);
      this.#launched.add(call);
    } else {
      this.#quiet.add(event.taskId);
    }
    // A line of the daemon's: it is not the turn's text, so a turn that says nothing else still
    // gets its last text or its error from the turn's end.
    this.#launches.push({
      callId: call,
      name: line.name,
      agentType: event.agentType,
      description: event.description,
      model: null,
    });
    // The result of the call carries the model, and comes after the task starts.
    if (LAUNCHERS.has(line.name)) this.#awaiting.add(call);
    await this.#settleLaunches();
  }

  /** The task runs for this reply, on that line or under that call. */
  #bind(taskId: string, lineId: string): void {
    this.#lineOfTask.set(taskId, lineId);
    this.#running.set(taskId, lineId);
  }

  async #openLine(event: TaskStarted): Promise<void> {
    const lineId = `task-${event.taskId}`;
    this.#bind(event.taskId, lineId);
    if (event.background === true) {
      // A task in the background whose call this reply does not hold: an agent that started
      // again once the reply of its call had ended (recorded:
      // `subagent-nested-background-mid-turn.jsonl`), or a task a subagent started. No card, as
      // for any task in the background, and no launch line, which belongs under its call.
      this.#launched.add(lineId);
      return;
    }
    if (event.kind === "command") {
      // A command no call of this reply holds: one a subagent left running, or one started
      // before a restart. No card, as for any command in the background.
      this.#quiet.add(event.taskId);
      return;
    }
    if (event.callId === null) this.#commands.add(lineId);
    const title = oneLine(event.description, TITLE_LIMIT);
    const name = event.taskType ?? "task";
    await this.#set(line(lineId, title, "in_progress", { name, task: true }));
  }

  /**
   * A nested call's result: a task it started that is still running outlives it (recorded:
   * `subagent-nested-background.jsonl`, CLI 2.1.286, where the result comes first), and from
   * here is an ordinary background task, as for a call at the top level (`#callEnded`).
   */
  async #outlived(call: string): Promise<void> {
    if (!this.#rootOf.has(call)) return;
    this.#closedCalls.add(call);
    for (const [taskId, started] of [...this.#aside]) {
      if (started.callId === call) {
        this.#aside.delete(taskId);
        this.#inside.delete(taskId);
        // Queued before the line is written: a write that fails must not leave a running
        // task the session never adopts.
        this.#promoted.push(started);
        await this.#openLine(started);
      }
    }
  }

  async #taskEnded(taskId: string, status: string, summary: string | null): Promise<void> {
    if (this.#inside.has(taskId)) {
      this.#aside.delete(taskId); // dropped: it ended before its call's result
      return;
    }
    if (this.#nested.has(taskId)) {
      this.#nested.delete(taskId); // the command's own end closes its line
      return;
    }
    this.#running.delete(taskId);
    this.#waited.delete(taskId);
    const lineId = this.#lineOfTask.get(taskId) ?? `task-${taskId}`;
    // No card: its end is the session's end line.
    if (this.#launched.has(lineId) || this.#quiet.has(taskId)) return;
    const entry =
      this.#lines.get(lineId) ??
      line(lineId, oneLine(summary || taskId, TITLE_LIMIT), "in_progress", {
        name: "task",
        task: true,
      });
    const [final, stopped] = terminalStatus(status);
    await this.#set({
      ...entry,
      status: final,
      details: null,
      output: stopped ?? (summary ? oneLine(summary, OUTPUT_LIMIT) : null),
    });
  }

  async #child(root: string, said: string): Promise<void> {
    const entry = this.#lines.get(root);
    if (entry === undefined) return;
    // A call that runs calls of its own (a subagent) keeps its line once it ends, whether it
    // ran in the foreground or not: the nested calls are its work, not one more call.
    await this.#noted(root, {
      ...entry,
      details: this.#under(root, said),
      task: true,
      calls: entry.calls + 1,
    });
  }

  /** A change to a card from under it: kept, not sent, while the card's call is still held. */
  async #noted(root: string, update: TaskUpdate): Promise<void> {
    if (this.#undecided.has(root)) this.#lines.set(root, update);
    else await this.#set(update);
  }

  /**
   * What a subagent's error message says, as a nested line of its card: not one more call, so
   * the count stays.
   */
  async #childNote(parent: string, words: string): Promise<void> {
    const root = this.#rootOf.get(parent) ?? parent;
    const entry = this.#lines.get(root);
    if (entry === undefined || words === "") return;
    const details = this.#under(root, oneLine(words, 200));
    await this.#noted(root, { ...entry, details, task: true });
  }

  /** The nested lines of a card with `said` added: its last `CHILD_LINES`. */
  #under(root: string, said: string): string {
    const lines = [...(this.#children.get(root) ?? []), said].slice(-CHILD_LINES);
    this.#children.set(root, lines);
    return lines.join("\n");
  }

  async #set(update: TaskUpdate): Promise<void> {
    if (!this.#lines.has(update.id)) {
      // Only a new line puts a card after the text. A line that changes does so where its card
      // sits, and the text stays the last thing in the reply.
      this.#afterText = false;
    }
    this.#lines.set(update.id, update);
    // The calls of the message that started a task keep their run whole: its launch line waits
    // for the message to end, below them.
    if (!this.#messageOpen) await this.#writeLaunches();
    // A card that changes where it sits (a command's call ending under its own launch line)
    // leaves the line of the daemon's last, and its break still owed.
    if (!this.#drawn.has(update.id)) this.#breakOwed = false;
    await this.#handOver();
    this.#drawn.add(update.id);
    await this.#sink.task(update);
  }

  /**
   * Hand the sink the text held since it began, whole: before anything else the sink is given,
   * so it lands in its place. Nothing is held when the chat shows a text as it is written.
   */
  async #handOver(): Promise<void> {
    if (this.#held === "") return;
    const text = this.#held;
    this.#held = "";
    await this.#sink.text(text, { notice: false, ending: false });
  }

  /** `piece`: the next piece of a text being written, which a chat with no streaming waits to have whole. */
  async #text(
    markdown: string,
    options: { notice?: boolean; ending?: boolean; piece?: boolean } = {},
  ): Promise<void> {
    if (markdown === "") return;
    const { notice = false, ending = false, piece = false } = options;
    await this.#writeLaunches();
    if (this.#breakOwed && !markdown.startsWith("\n")) markdown = `\n\n${markdown}`;
    this.#breakOwed = false;
    this.#wroteText = true;
    this.#afterText = !notice; // a notice ends with its own break
    if (piece && !this.#streaming) {
      this.#held += markdown;
      return;
    }
    await this.#handOver();
    await this.#sink.text(markdown, { notice, ending });
  }
}
