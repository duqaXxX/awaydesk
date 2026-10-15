/**
 * A run of tool calls as one card: the call that runs now, then the counts of what ended. The
 * terminal draws a run the same way (captured on Claude Code 2.1.296, 2026-10-13): one live line
 * for the call that runs, nothing for the calls before it, and when the run has ended one grey
 * line of counts with no mark, `Read 1 file, ran 4 shell commands`, a failed call counted with
 * the others. A stream can only append and a card is what Slack updates in place, so the line is
 * a card whose title changes.
 *
 * A run is the calls between two pieces of text. Its card shows the last call started that
 * still runs; with none running it shows the counts of every call that ended, which is also the
 * line that replaces the card once the reply's body has ended.
 *
 * A call with a view of its own never folds: an Edit or a Write that ended well (its preview), a
 * subagent the call waits for or a background command (its task card), a stopped call, and a
 * failed call of a tool the terminal was not seen to count (its card says why). It gets a card
 * of its own, or keeps the run's when it was the run's only call, and the run takes no new call
 * after it. An Edit or a Write reaches the fold only once it has ended (the renderer holds it
 * until then).
 *
 * The card carries no `output`, and no `details` but the command of each call the terminal
 * times (`startedAt` set): Slack appends both to what a card already holds (measured
 * 2026-10-01), so a card that is reused keeps its text in its title, and each such call adds its
 * command line to what the card lists.
 */
import type { Preview, TaskStatus, TaskUpdate } from "../../chat/seam.ts";
import { failsCounted, folded } from "./previews.ts";
import { STOPPED } from "./words.ts";

export const ENDED: readonly TaskStatus[] = ["complete", "error"];
export const SEPARATOR = ", ";
// The most command lines a run's card lists: its last ones, as a subagent's card lists its calls.
const RUN_COMMANDS = 10;

/**
 * The preview, on a call that finished well and only there: a failed, running or task card keeps
 * its own view whatever it carries, so no path can show a preview over an error.
 */
export function shownPreview(update: TaskUpdate): Preview | null {
  return update.status === "complete" && !update.task ? update.preview : null;
}

/**
 * Whether a call is drawn on its run's card rather than on a card of its own. A call that failed
 * is counted with the others only where the terminal was seen to count it so (a command that
 * exits with an error, `previews.failsCounted`); any other failed call keeps a card that says
 * why.
 */
export function folds(update: TaskUpdate): boolean {
  if (update.status === "error" && !failsCounted(update.name)) return false;
  return (
    update.name !== "" && !update.task && shownPreview(update) === null && update.output !== STOPPED
  );
}

/**
 * Ended calls as counts in the terminal's words, joined as it joins them: a comma between two
 * counts, and a capital on the first alone. A failed call is counted with the others.
 */
export function counts(calls: readonly TaskUpdate[]): string {
  // In the order each name first ended, as the terminal lists them.
  const byName = new Map<string, number>();
  for (const call of calls) byName.set(call.name, (byName.get(call.name) ?? 0) + 1);
  return [...byName].map(([name, n], index) => folded(name, n, index === 0)).join(SEPARATOR);
}

interface Run {
  /** In the order they started. */
  calls: Map<string, TaskUpdate>;
  /** In the order they ended. */
  ended: string[];
  /** The run's card id, once it has one. */
  card: string | null;
  /** Whether a new call still joins it. */
  open: boolean;
}

function newRun(): Run {
  return { calls: new Map(), ended: [], card: null, open: true };
}

function samePreview(a: Preview | null, b: Preview | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.title === b.title &&
    a.summary === b.summary &&
    a.body === b.body &&
    a.language === b.language &&
    a.plain === b.plain
  );
}

/** Whether two states of a line say the same, field by field. */
function sameUpdate(a: TaskUpdate | undefined, b: TaskUpdate): boolean {
  return (
    a !== undefined &&
    a.id === b.id &&
    a.title === b.title &&
    a.status === b.status &&
    a.details === b.details &&
    a.output === b.output &&
    a.name === b.name &&
    a.task === b.task &&
    a.calls === b.calls &&
    a.folded === b.folded &&
    a.startedAt === b.startedAt &&
    samePreview(a.preview, b.preview)
  );
}

function remove(list: string[], item: string): void {
  const index = list.indexOf(item);
  if (index !== -1) list.splice(index, 1);
}

/**
 * Turns the calls of one reply into the cards that show them. `task` returns the cards a call's
 * new state changes, in the order they are to appear; `text` ends the run.
 */
export class Fold {
  /** Call id to its run. */
  private readonly runs = new Map<string, Run>();
  /** Call id to the card that is its own. */
  private readonly own = new Map<string, string>();
  private current: Run | null = null;
  private readonly sent = new Map<string, TaskUpdate>();

  /** Text was written: the calls after it are a new run. */
  text(): void {
    if (this.current !== null) this.current.open = false;
  }

  task(update: TaskUpdate): TaskUpdate[] {
    const own = this.own.get(update.id);
    if (own !== undefined) return this.changed([{ ...update, id: own }]);
    let run = this.runs.get(update.id);
    if (run === undefined) {
      if (!folds(update)) {
        this.text();
        this.own.set(update.id, update.id);
        return this.changed([update]);
      }
      if (this.current === null || !this.current.open) this.current = newRun();
      run = this.current;
      this.runs.set(update.id, run);
    } else if (!folds(update)) {
      return this.changed([this.leave(run, update), ...this.draw(run)]);
    }
    run.calls.set(update.id, update);
    if (!ENDED.includes(update.status)) {
      remove(run.ended, update.id);
    } else if (!run.ended.includes(update.id)) {
      run.ended.push(update.id);
    }
    return this.changed(this.draw(run));
  }

  /**
   * A call that no longer folds gets a card of its own. The run's only call keeps the run's
   * card, which showed it. The run takes no new call.
   */
  private leave(run: Run, update: TaskUpdate): TaskUpdate {
    run.calls.delete(update.id);
    this.runs.delete(update.id);
    remove(run.ended, update.id);
    run.open = false;
    let card = update.id;
    if (run.calls.size === 0 && run.card !== null) {
      card = run.card;
      run.card = null;
    }
    this.own.set(update.id, card);
    return { ...update, id: card };
  }

  /** The run's card as it stands: the call that runs now, else the counts of what ended. */
  private draw(run: Run): TaskUpdate[] {
    const first = run.calls.values().next().value;
    if (first === undefined) return [];
    // Named after the run's first call: a call that takes a card of its own is named by its id.
    run.card ??= `fold:${first.id}`;
    // The command of each timed call of the run, which the card lists when it is expanded.
    const lines = [...run.calls.values()].flatMap((call) =>
      call.startedAt !== null && call.details !== null ? [call.details] : [],
    );
    const details = lines.length === 0 ? null : lines.slice(-RUN_COMMANDS).join("\n");
    const running = [...run.calls.values()].filter((call) => !ENDED.includes(call.status));
    const now = running.at(-1);
    // A call still running when the reply's body ends has no count yet and stays a card.
    if (now !== undefined) {
      return [card(run.card, now.title, now.status, now.name, null, now.startedAt, details)];
    }
    const ended = run.ended.flatMap((id) => run.calls.get(id) ?? []);
    const line = counts(ended);
    const status: TaskStatus = ended.some((call) => call.status === "complete")
      ? "complete"
      : "error";
    return [card(run.card, line, status, "", line, null, details)];
  }

  private changed(cards: TaskUpdate[]): TaskUpdate[] {
    const out = cards.filter((card) => !sameUpdate(this.sent.get(card.id), card));
    for (const card of out) this.sent.set(card.id, card);
    return out;
  }
}

/** A run's card: a title and a state, and the line that replaces it at the reply's end. */
function card(
  id: string,
  title: string,
  status: TaskStatus,
  name: string,
  line: string | null,
  startedAt: number | null,
  details: string | null,
): TaskUpdate {
  return {
    id,
    title,
    status,
    details,
    output: null,
    name,
    task: false,
    calls: 0,
    preview: null,
    folded: line,
    startedAt,
  };
}
