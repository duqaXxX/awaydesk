/**
 * The scenes: each one causes the events a claim needs, through the daemon's own back end
 * (`ClaudeBackend`, `ClaudeSession`).
 *
 * Claude Code is real (the SDK's bundled CLI, the owner's login, Haiku); nothing of Slack is in
 * play, since an SDK release changes nothing on the Slack side. What a claim checks is what the
 * daemon receives: the session events the back end gives the core, and the few pure functions of
 * the daemon that turn them into what the owner would see (`preview`, `gitState`, `resumeBlocks`,
 * `promptFor`). A scene reads the raw SDK only where its claim is about a raw shape the back end
 * hides, and says so.
 *
 * Sessions take no setting source, so nothing of the owner's settings, hooks or permission rules
 * is in play, and each works in a temporary folder whose transcripts the run removes again.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, type UUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../src/agent/claude/backend.ts";
import { CAPABILITIES } from "../src/agent/claude/capabilities.ts";
import { directorySessions, projectsDir } from "../src/agent/claude/listing.ts";
import { AsyncQueue } from "../src/agent/claude/session.ts";
import { locate } from "../src/agent/claude/trust.ts";
import type {
  AgentSession,
  PermissionAnswer,
  PermissionRequest,
  PromptContent,
  QuestionAnswer,
  QuestionRequest,
  Repository,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../src/agent/seam.ts";
import { ResumeRefused } from "../src/agent/seam.ts";
import { promptFor } from "../src/chat/slack/attachments.ts";
import { resumeBlocks } from "../src/chat/slack/resume.ts";
import * as slackTexts from "../src/chat/slack/texts.ts";
import { gitState } from "../src/core/footer.ts";
import { preview } from "../src/core/reply/previews.ts";
import * as texts from "../src/core/texts.ts";
import { isRecord, records } from "../src/values.ts";
import { type Observation, observation } from "./claims.ts";
import { notOffered, UNAVAILABLE } from "./commands.ts";

// The model the fixture recorder uses: the cheapest that runs every scene. The alias, as the
// daemon's own sessions name a model.
const PROBE_MODEL = "haiku";
const RESUME_THREAD = "1700000000.000200";
const TURN_LIMIT = 180_000;
const COUNT_TO = 2000;
// A turn is over once nothing has been said for this long: the one that follows a stopped task
// or an interrupt, which no event announces.
const QUIET_MS = 1500;
const QUIET_LIMIT = 60_000;
// How long the background wake scene waits for the turn a command's end opens.
const WAKE_LIMIT = 120_000;

export type Log = (line: string) => void;
type Seen = Record<string, Observation>;

/** A wait ran out: the machine was slow, or the network, and the scene learned nothing. */
export class ProbeTimeout extends Error {
  override readonly name = "TimeoutError";
}

/** The session ended while a scene waited on it. */
class SessionLost extends Error {
  override readonly name = "SessionLost";
}

/**
 * Failures of the machine the probe runs on, not of the SDK: a wait past its limit, the network
 * (a system error carries a code such as ECONNRESET). Such a scene learned nothing, so its claims
 * are UNPROVEN rather than BROKEN.
 */
export function isEnvironment(error: unknown): boolean {
  if (error instanceof ProbeTimeout) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9_]+$/.test(code);
}

// Each scene and the claims it observes: the one place a claim id meets its scene.
// `test/probe/probe.test.ts` checks that together they cover `CLAIMS` exactly.
export const SCENES: Readonly<Record<string, readonly string[]>> = {
  "first turn": ["P1", "P2", "P3", "P17"],
  image: ["P4"],
  file: ["P5"],
  "bash and approval": ["P10", "P11"],
  previews: ["P13"],
  "background and stop": ["P12"],
  interrupt: ["P8"],
  resume: ["P6", "P7"],
  "model and effort resume": ["P15", "P16"],
  "setup model resume": ["P18"],
  "model command after setModel": ["P27", "P28"],
  bypass: ["P9"],
  "working folder": ["P14"],
  replay: ["P19"],
  "effort commands": ["P26"],
  goal: ["P20"],
  compact: ["P21", "P22"],
  "commands not offered": ["P23"],
  "computer use": ["P24"],
  "background wake": ["P25"],
  "config folder listing": ["P29"],
};

/** `text` without any path of this machine, one line, cut to `limit` characters. */
function scrub(text: string, roots: readonly string[], limit = 160): string {
  let clean = text;
  for (const root of roots) clean = clean.split(root).join("<tmp>");
  clean = clean.split(homedir()).join("<home>").replace(/\s+/g, " ");
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function ofType<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

/** What was written in `events`: the pieces of the texts streamed and the texts sent whole. */
function writtenIn(events: readonly SessionEvent[]): string {
  return events
    .flatMap((event) => (event.type === "text" || event.type === "text_delta" ? [event.text] : []))
    .join("");
}

/** The numbers written one per line: a sentence that names a number does not count. */
export function counted(text: string): Set<number> {
  const numbers = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\d+$/.test(line.trim())) numbers.add(Number(line.trim()));
  }
  return numbers;
}

/** A valid 1x1 red PNG, built here so the probe ships no binary file. */
export function onePixelPng(): Uint8Array {
  const chunk = (kind: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); // width
  header.writeUInt32BE(1, 4); // height
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, no interlace
  const pixels = deflateSync(Buffer.from([0, 0xff, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The owner's side: approves every tool and declines every question, and keeps what was asked. */
class Owner implements RequestHandler {
  readonly asked: PermissionRequest[] = [];

  async permission(request: PermissionRequest): Promise<PermissionAnswer> {
    this.asked.push(request);
    return { allow: true };
  }

  async question(_request: QuestionRequest): Promise<QuestionAnswer> {
    return { answered: false, message: "declined by the probe" };
  }
}

/** One turn: the prompt's id and every event from the send to the end of the turn. */
interface Turn {
  readonly id: string;
  readonly events: readonly SessionEvent[];
}

/** A session and everything it said, in order, with the waits a scene needs. */
class Live {
  readonly session: AgentSession;
  readonly events: SessionEvent[] = [];
  ended = false;
  readonly #wake: (() => void)[] = [];

  constructor(session: AgentSession) {
    this.session = session;
    void (async () => {
      for await (const event of session.events) {
        this.events.push(event);
        this.#poke();
      }
      this.ended = true;
      this.#poke();
    })();
  }

  #poke(): void {
    for (const wake of this.#wake.splice(0)) wake();
  }

  /** Whether `done` held of the events from `from` on before `ms` passed or the session ended. */
  async until(
    from: number,
    done: (events: SessionEvent[]) => boolean,
    ms: number,
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (done(this.events.slice(from))) return true;
      const left = deadline - Date.now();
      if (this.ended || left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Waits until nothing has been said for QUIET_MS, or QUIET_LIMIT has passed. */
  async quiet(): Promise<void> {
    const deadline = Date.now() + QUIET_LIMIT;
    for (;;) {
      const seen = this.events.length;
      await new Promise<void>((resolve) => setTimeout(resolve, QUIET_MS));
      if (this.events.length === seen || this.ended || Date.now() >= deadline) return;
    }
  }

  /**
   * Sends `content` once the session is quiet and returns the events up to the end of the owner's
   * turn it starts. Throws ProbeTimeout past TURN_LIMIT and SessionLost when the session ends.
   */
  async turn(content: PromptContent): Promise<Turn> {
    await this.quiet();
    const from = this.events.length;
    const id = randomUUID();
    await this.session.send({ id, content });
    const over = (events: SessionEvent[]) =>
      events.some((event) => event.type === "turn_ended" && event.startedBy === "owner");
    const done = await this.until(from, over, TURN_LIMIT);
    const events = this.events.slice(from);
    if (done) {
      const end = events.findIndex(
        (event) => event.type === "turn_ended" && event.startedBy === "owner",
      );
      return { id, events: events.slice(0, end + 1) };
    }
    if (this.ended) throw new SessionLost("the session ended during a turn");
    throw new ProbeTimeout("a turn did not end in time");
  }
}

/** Where the run stands: the back end, the folders and every session it opened. */
class Stage {
  readonly log: Log;
  readonly root: string;
  readonly workdir: string;
  readonly models: string;
  readonly uploads: string;
  readonly home: string;
  readonly backend: ClaudeBackend;
  readonly owner = new Owner();
  readonly lives: Live[] = [];
  main!: Live;

  constructor(log: Log, root: string, home: string) {
    this.log = log;
    this.root = root;
    this.home = home;
    this.workdir = join(root, "work");
    this.models = join(root, "models");
    this.uploads = join(root, "uploads");
    this.backend = new ClaudeBackend({ home });
  }

  options(folder: string, over: Partial<StartOptions> = {}): StartOptions {
    return {
      folder,
      resume: null,
      settingsSources: [],
      model: PROBE_MODEL,
      effort: null,
      ...over,
    };
  }

  /** Starts a session; rejects with ResumeRefused when Claude Code will not resume one. */
  async open(folder: string, over: Partial<StartOptions> = {}): Promise<Live> {
    const live = new Live(await this.backend.start(this.options(folder, over), this.owner));
    this.lives.push(live);
    return live;
  }

  /** Permission requests received since `mark`, as their tool names. */
  askedSince(mark: number): string[] {
    return this.owner.asked.slice(mark).map((request) => request.toolName);
  }

  scrubbed(text: string, limit = 160): string {
    return scrub(text, [this.root], limit);
  }

  /** After a scene that raised: stop what it left running, so the next one starts on a quiet session. */
  async recover(): Promise<void> {
    try {
      await this.main.session.interrupt();
    } catch {
      // The session may be gone: the next scene says so.
    }
    await this.main.quiet();
  }
}

/**
 * Runs a scene. One that raises did cause its events and saw them fail, since a break in the SDK
 * most often shows as a call that rejects; a failure of the machine instead (a timeout, the
 * network) learned nothing. Its claims record which, with the error's name.
 */
async function attempt(name: string, s: Stage, scene: () => Promise<Seen>): Promise<Seen> {
  const claims = SCENES[name] ?? [];
  s.log(`scene: ${name}`);
  let seen: Seen;
  try {
    seen = await scene();
  } catch (error) {
    const named = error instanceof Error ? error.name : typeof error;
    const said = error instanceof Error ? ` ${s.scrubbed(error.message, 100)}` : "";
    const detail = `scene raised ${named}:${said}`;
    s.log(`scene ${name}: ${detail}`);
    await s.recover();
    const caused = !isEnvironment(error);
    return Object.fromEntries(claims.map((claim) => [claim, observation(caused, false, detail)]));
  }
  const unknown = Object.keys(seen).filter((claim) => !claims.includes(claim));
  if (unknown.length > 0) {
    throw new RangeError(
      `scene ${name} observed claims it does not own: ${unknown.sort().join(", ")}`,
    );
  }
  return seen;
}

/**
 * P17: the setup message is built from these fields, so each entry must carry the first two and
 * every entry that supports effort must list its levels. Read on the raw initialization result:
 * `info()` gives an entry with no `displayName` its `value` in its place, which would hide the
 * very absence this claim is about.
 */
export function modelsListed(models: readonly unknown[]): Observation {
  const entries = models.filter(isRecord);
  const named =
    entries.length > 0 &&
    entries.length === models.length &&
    entries.every((m) => m.value && m.displayName);
  const levels = entries
    .filter((m) => m.supportsEffort)
    .every((m) => Array.isArray(m.supportedEffortLevels) && m.supportedEffortLevels.length > 0);
  const detail =
    named && levels
      ? ""
      : `models: ${JSON.stringify(entries.slice(0, 2).map((m) => Object.keys(m).sort()))}`;
  return observation(true, named && levels, detail);
}

/** The raw initialization result's models: a Claude Code process started and asked, no prompt sent. */
async function rawModels(s: Stage): Promise<readonly unknown[]> {
  const input = new AsyncQueue<SDKUserMessage>();
  const raw = query({
    prompt: input,
    options: { cwd: s.workdir, settingSources: [], model: PROBE_MODEL },
  });
  try {
    const init: unknown = await raw.initializationResult();
    return isRecord(init) ? records(init.models) : [];
  } finally {
    input.end();
    raw.close();
  }
}

async function firstTurn(s: Stage, word: string): Promise<Seen> {
  const turn = await s.main.turn(
    `Remember this code word: ${word}. Reply with the single word: ready`,
  );
  // The session names itself when Claude Code answers its first prompt.
  const started = ofType(s.main.events, "session_started")[0];
  const ended = ofType(turn.events, "turn_ended")[0];
  const about = await s.main.session.info();
  const usage = await s.main.session.contextUsage();
  const status =
    about.models.length > 0 &&
    about.commands.length > 0 &&
    usage.model !== null &&
    usage.percentage !== null;
  return {
    P1: observation(
      true,
      (started?.agentVersion ?? null) !== null,
      `cli ${started?.agentVersion ?? "none"}`,
    ),
    P3: observation(true, (ended?.sessionId ?? null) !== null),
    P2: observation(
      true,
      status,
      status
        ? ""
        : `${about.models.length} models, ${about.commands.length} commands, usage ${usage.model ?? "none"}`,
    ),
    P17: modelsListed(await rawModels(s)),
  };
}

async function imageTurn(s: Stage): Promise<Seen> {
  // In English: a model may answer in the language of the owner's settings, and none loads here.
  const content = promptFor(
    "Reply with one English word: what colour is this image?",
    [{ mediaType: "image/png", data: onePixelPng() }],
    [],
  );
  const turn = await s.main.turn(content);
  const reply = writtenIn(turn.events) || (ofType(turn.events, "turn_ended")[0]?.finalText ?? "");
  // The pixel is red: naming its colour shows Claude received the image. A reply alone does not,
  // since an error such as `API Error: 400` is a reply too.
  const named = /\bred\b/i.test(reply);
  return { P4: observation(true, named, named ? "" : s.scrubbed(reply, 80)) };
}

async function fileTurn(s: Stage): Promise<Seen> {
  const token = randomBytes(4).toString("hex");
  const path = join(s.uploads, "probe-note.txt");
  await writeFile(path, `${token}\n`);
  const turn = await s.main.turn(
    promptFor("Read the attached file and reply with its content only.", [], [path]),
  );
  const reply = writtenIn(turn.events) + (ofType(turn.events, "turn_ended")[0]?.finalText ?? "");
  return { P5: observation(true, reply.includes(token)) };
}

async function bashTurn(s: Stage): Promise<Seen> {
  const mark = s.owner.asked.length;
  const marker = join(s.workdir, "probe-ran.txt");
  const turn = await s.main.turn(
    "Use the Bash tool to run exactly this command: echo ok > probe-ran.txt\nThen reply: done",
  );
  // A Bash call is known by the permission request the CLI sends for it, whatever its title;
  // its card is built from the call's two events.
  const asked = s.askedSince(mark);
  const called = asked.includes("Bash");
  const detail = called ? "" : `permission requests: ${asked.join(", ") || "none"}`;
  const bash = ofType(turn.events, "call_started").find((event) => event.toolName === "Bash");
  const finished = ofType(turn.events, "call_ended").some((event) => event.callId === bash?.callId);
  return {
    P10: observation(called, bash !== undefined && finished, detail),
    P11: observation(called, existsSync(marker), detail),
  };
}

async function previews(s: Stage): Promise<Seen> {
  const mark = s.owner.asked.length;
  const turn = await s.main.turn(
    "One tool call per step. 1) Use the Write tool to create preview.txt with the lines " +
      "alpha, beta and gamma. 2) Use the Edit tool on preview.txt to replace beta with delta. " +
      "Then reply: done",
  );
  const asked = s.askedSince(mark);
  const called = asked.includes("Write") && asked.includes("Edit");
  const names = new Map(
    ofType(turn.events, "call_started").map((event) => [event.callId, event.toolName]),
  );
  const shownBy = (tool: string) =>
    ofType(turn.events, "call_ended")
      .filter((event) => names.get(event.callId) === tool)
      .map((event) => preview(tool, event.fileChange, s.workdir))
      .find((found) => found !== null) ?? null;
  const write = shownBy("Write");
  const edit = shownBy("Edit");
  // Both previews built: the shapes they read are still the measured ones.
  const shown =
    write?.title === "Write(preview.txt)" &&
    edit?.title === "Update(preview.txt)" &&
    write.summary.startsWith("Wrote 3 lines") &&
    edit.summary === "Added 1 line, removed 1 line";
  let detail = "";
  if (!called) detail = `permission requests: ${asked.join(", ")}`;
  else if (!shown) {
    // What the previews said instead: a changed wording or shape is visible at once.
    const other = [write, edit]
      .map((found) => (found ? `${found.title} ${found.summary}` : "no preview"))
      .join("; ");
    detail = `previews: ${s.scrubbed(other)}`;
  }
  return { P13: observation(called, shown, detail) };
}

async function backgroundStop(s: Stage): Promise<Seen> {
  const from = s.main.events.length;
  await s.main.turn(
    "Use the Bash tool with run_in_background set to true to run: tail -f /dev/null\n" +
      "Do not wait for it. Reply: started",
  );
  const startedTask = () =>
    ofType(s.main.events.slice(from), "task_started").find((event) => event.kind === "command");
  if (!(await s.main.until(from, () => startedTask() !== undefined, 20_000))) {
    return { P12: observation(false, false, "no background command started") };
  }
  const taskId = startedTask()?.taskId ?? "";
  const stopFrom = s.main.events.length;
  await s.main.session.stopTask(taskId);
  // The end is a notification or a terminal patch, whichever Claude Code sends first.
  const gone = await s.main.until(
    stopFrom,
    (events) =>
      events.some(
        (event) =>
          (event.type === "task_ended" && event.taskId === taskId) ||
          (event.type === "task_updated" && event.taskId === taskId && event.terminal),
      ),
    30_000,
  );
  return {
    P12: observation(true, gone, gone ? "" : "the task did not end within 30 s of the stop"),
  };
}

async function interrupt(s: Stage): Promise<Seen> {
  await s.main.quiet();
  const from = s.main.events.length;
  // Long enough that Haiku cannot finish it in the second or two a stop takes to arrive.
  await s.main.session.send({
    id: randomUUID(),
    content: `Without using any tool, reply with the numbers from 1 to ${COUNT_TO}, one per line, and nothing else.`,
  });
  const reached = await s.main.until(from, (events) => counted(writtenIn(events)).has(20), 60_000);
  if (!reached) {
    const start = s.scrubbed(writtenIn(s.main.events.slice(from)), 80);
    return { P8: observation(false, false, `the reply never reached 20: ${start}`) };
  }
  await s.main.session.interrupt();
  const ended = await s.main.until(
    from,
    (events) => events.some((event) => event.type === "turn_ended"),
    60_000,
  );
  const events = s.main.events.slice(from);
  const finished = counted(writtenIn(events)).has(COUNT_TO);
  const ending = ofType(events, "turn_ended")[0]?.ending;
  let detail = "";
  if (finished) detail = `the reply ran to ${COUNT_TO}: the interrupt did nothing`;
  else if (!ended) detail = "the turn did not end within 60 s of the stop";
  else if (ending !== "interrupted")
    detail = `the turn ended as ${ending ?? "none"}, not interrupted`;
  return { P8: observation(true, ended && !finished && ending === "interrupted", detail) };
}

async function resume(s: Stage, word: string, sessionId: string | null): Promise<Seen> {
  if (sessionId === null) return { P6: observation(false, false, "no session id stored") };
  const listed = await s.backend.listSessions(s.workdir);
  // The picker as the daemon builds it: the first turn's thread holds this session, so it takes
  // no row and is counted in the line under the list.
  const holding = new Set([sessionId]);
  const free = listed.filter((entry) => !holding.has(entry.id));
  const held = listed.length - free.length;
  const picker = JSON.stringify(resumeBlocks(s.workdir, free, held, new Date(), RESUME_THREAD));
  const countedLine =
    held === 1
      ? slackTexts.RESUME_OPEN_ONE
      : texts.fill(slackTexts.RESUME_OPEN_MANY, { count: held });
  const known = listed.some((entry) => entry.id === sessionId);
  const inPicker =
    held >= 1 && picker.includes(countedLine) && !picker.includes(sessionId.slice(0, 8));
  const seen: Seen = { P6: observation(true, known && inPicker) };
  let resumed: Live;
  try {
    resumed = await s.open(s.workdir, { resume: sessionId });
  } catch (error) {
    if (error instanceof ResumeRefused)
      return { ...seen, P7: observation(false, false, "the resume was refused") };
    throw error;
  }
  const turn = await resumed.turn("What was the code word I gave you? Reply with the word only.");
  const reply = writtenIn(turn.events) + (ofType(turn.events, "turn_ended")[0]?.finalText ?? "");
  await resumed.session.close();
  return { ...seen, P7: observation(true, reply.includes(word)) };
}

/** The id of the session `events` belong to, from the turn that ended them. */
function sessionIdOf(events: readonly SessionEvent[]): string | null {
  return ofType(events, "turn_ended").at(-1)?.sessionId ?? null;
}

/** The model the live session reports before it has said anything: no token is spent asking. */
async function modelOf(live: Live): Promise<string> {
  return (await live.session.contextUsage()).model ?? "none";
}

/**
 * P15: a resumed session keeps the model set with `/model`. P16: it loses the effort set live
 * (`setEffort`, which the TypeScript back end applies with no reconnect), and `Options.effort`
 * restores it. A session starts on Claude Code's default model, which is not Haiku: the model is
 * set before any prompt is sent, and each resume is asked its model before it is sent one, so no
 * turn runs on another model than Haiku.
 */
async function modelEffortResume(s: Stage): Promise<Seen> {
  const first = await s.open(s.models, { model: null });
  const before = await modelOf(first);
  if (before.includes("haiku")) {
    await first.session.close();
    const detail = `the default model is already ${before}`;
    return { P15: observation(false, false, detail), P16: observation(false, false, detail) };
  }
  await first.turn("/model haiku");
  const chosen = await modelOf(first);
  if (!chosen.includes("haiku")) {
    return {
      P15: observation(true, false, `/model haiku left the session on ${chosen}`),
      P16: observation(false, false, "the model was not set"),
    };
  }
  await first.session.setEffort("low");
  const turn = await first.turn("Reply with the single word: ok");
  const live = ofType(turn.events, "effort_observed").at(-1)?.level ?? null;
  const sessionId = sessionIdOf(turn.events);
  await first.session.close();
  if (sessionId === null) {
    const detail = "no session id came";
    return { P15: observation(false, false, detail), P16: observation(false, false, detail) };
  }

  // The plain resume: no model and no effort passed.
  let plain: Live;
  try {
    plain = await s.open(s.models, { resume: sessionId, model: null });
  } catch (error) {
    if (!(error instanceof ResumeRefused)) throw error;
    const detail = "the resume was refused";
    return { P15: observation(false, false, detail), P16: observation(false, false, detail) };
  }
  const kept = await modelOf(plain);
  const modelKept = kept.includes("haiku");
  let lost: string | null = null;
  if (modelKept) {
    const plainTurn = await plain.turn("Reply with the single word: ok");
    lost = ofType(plainTurn.events, "effort_observed").at(-1)?.level ?? null;
  }
  await plain.session.close();
  const p15 = observation(true, modelKept, modelKept ? "" : `the resumed session reports ${kept}`);
  if (!modelKept)
    return {
      P15: p15,
      P16: observation(false, false, "no turn was sent on a model that is not Haiku"),
    };

  // The resume that passes the effort back.
  const restored = await s.open(s.models, { resume: sessionId, model: null, effort: "low" });
  const restoredTurn = await restored.turn("Reply with the single word: ok");
  const back = ofType(restoredTurn.events, "effort_observed").at(-1)?.level ?? null;
  await restored.session.close();

  const holds = live === "low" && lost !== "low" && back === "low";
  const detail = holds
    ? ""
    : `after setEffort: ${live ?? "none"}; after the plain resume: ${lost ?? "none"}; after the effort resume: ${back ?? "none"}`;
  return { P15: p15, P16: observation(true, holds, detail) };
}

/**
 * P18: a model set with `/model` (what the setup's Start does) survives a resume that passes
 * none. The session starts on the default model, so Haiku showing after the resume can only come
 * from the session's own record.
 */
async function setupModelResume(s: Stage): Promise<Seen> {
  const first = await s.open(s.models, { model: null });
  const before = await modelOf(first);
  if (before.includes("haiku")) {
    await first.session.close();
    return { P18: observation(false, false, `the default model is already ${before}`) };
  }
  await first.session.setModel(PROBE_MODEL);
  const chosen = await modelOf(first);
  if (!chosen.includes("haiku")) {
    await first.session.close();
    return { P18: observation(true, false, `setModel left the session on ${chosen}`) };
  }
  const turn = await first.turn("Reply with the single word: ok");
  const sessionId = sessionIdOf(turn.events);
  await first.session.close();
  if (sessionId === null) return { P18: observation(false, false, "no session id came") };
  let resumed: Live;
  try {
    resumed = await s.open(s.models, { resume: sessionId, model: null });
  } catch (error) {
    if (error instanceof ResumeRefused)
      return { P18: observation(false, false, "the resume was refused") };
    throw error;
  }
  const kept = await modelOf(resumed);
  await resumed.session.close();
  return {
    P18: observation(
      true,
      kept.includes("haiku"),
      kept.includes("haiku") ? "" : `the resumed session reports ${kept}`,
    ),
  };
}

/**
 * P27: with a model named in the project settings, after the SDK's `setModel()` a `/model` to that
 * model's alias leaves the next request on the `setModel` model (issue #333). The daemon no longer calls
 * `setModel`, so the scene reads the raw SDK. The startup model, which is not Haiku, runs no
 * request: the two commands cost nothing and the one-word turn runs on Haiku while the limit
 * stands. P28 rides on the same run: the command is sent under a uuid of its own, as the daemon
 * sends it, and Claude Code ends its turn with a `command_lifecycle` `completed` naming it. P28
 * does not depend on P27's precondition: without it the command goes out alone and P27 is UNPROVEN.
 */
async function modelCommandAfterSetModel(s: Stage): Promise<Seen> {
  const input = new AsyncQueue<SDKUserMessage>();
  // The override shows through only for the model the settings name (measured 2026-10-16), so the
  // scene names one: a project settings file in a folder of its own, read alone.
  const cwd = join(s.workdir, "model-settings");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
  const raw = query({ prompt: input, options: { cwd, settingSources: ["project"] } });
  const say = (content: string, uuid?: UUID) =>
    input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...(uuid !== undefined && { uuid }),
    });
  const commandId = randomUUID();
  let completed = false;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    raw.close();
  }, TURN_LIMIT);
  try {
    const init: unknown = await raw.initializationResult();
    const listed = isRecord(init) ? records(init.models) : [];
    const usage: unknown = await raw.getContextUsage();
    const startup = isRecord(usage) && typeof usage.model === "string" ? usage.model : "none";
    const alias = listed.find(
      (entry) => entry.value !== "default" && entry.resolvedModel === startup,
    )?.value;
    // P27 needs a startup model that is not Haiku and an alias that names it; P28 needs neither,
    // so the command goes out whatever the alias and the scene ends at its `completed` then.
    const precondition = !startup.includes("haiku") && typeof alias === "string";
    if (precondition) await raw.setModel(PROBE_MODEL);
    say(`/model ${typeof alias === "string" ? alias : "default"}`, commandId);
    let results = 0;
    const ranOn: string[] = [];
    try {
      for await (const record of raw) {
        const seen: unknown = record;
        if (!isRecord(seen)) continue;
        if (seen.type === "command_lifecycle" && seen.state === "completed") {
          completed ||= seen.command_uuid === commandId;
          if (!precondition && completed) break;
        }
        if (seen.type === "assistant" && results === 1 && isRecord(seen.message)) {
          if (typeof seen.message.model === "string") ranOn.push(seen.message.model);
        }
        if (seen.type !== "result" || !precondition) continue;
        results += 1;
        if (results === 2) break;
        say("Reply with the single word: ok");
      }
    } catch (error) {
      if (!late) throw error;
    }
    if (late) throw new ProbeTimeout("the turns did not end in time");
    const ended = observation(true, completed, completed ? "" : "no completed named the command");
    if (!precondition) {
      const detail = `no alias other than Haiku names the startup model ${startup}`;
      return { P27: observation(false, false, detail), P28: ended };
    }
    if (ranOn.length === 0) {
      return { P27: observation(false, false, "the turn named no model"), P28: ended };
    }
    const holds = ranOn.every((model) => model.includes("haiku"));
    return {
      P27: observation(true, holds, holds ? "" : `the turn ran on ${ranOn.join(", ")}`),
      P28: ended,
    };
  } finally {
    clearTimeout(timer);
    input.end();
    raw.close();
  }
}

async function bypass(s: Stage): Promise<Seen> {
  const mode = CAPABILITIES.permissionModes;
  if (mode.bypass === null)
    return { P9: observation(false, false, "the back end has no bypass mode") };
  // The mode is the CLI's own: it shows only as a command that runs with no permission request.
  await s.main.session.setPermissionMode(mode.bypass);
  const mark = s.owner.asked.length;
  const marker = join(s.workdir, "bypass-ran.txt");
  let turn: Turn;
  try {
    turn = await s.main.turn(
      "Use the Bash tool to run exactly this command: echo ok > bypass-ran.txt\nThen reply: done",
    );
  } finally {
    await s.main.session.setPermissionMode(mode.default);
  }
  const called =
    ofType(turn.events, "call_started").some((event) => event.toolName === "Bash") &&
    existsSync(marker);
  const asked = s.askedSince(mark);
  return {
    P9: observation(
      called,
      asked.length === 0,
      asked.length > 0 ? `asked for ${asked.join(", ")}` : called ? "" : "no Bash call",
    ),
  };
}

/** Whether `path` is `base` or lies below it. */
function inside(base: string, path: string): boolean {
  const way = relative(base, path);
  return way !== ".." && !way.startsWith(`..${sep}`) && !isAbsolute(way);
}

function initRepo(path: string, branch: string): void {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  const made = spawnSync("git", ["init", "-q", "-b", branch, path], { env });
  if (made.status !== 0) throw new Error("git init failed");
}

async function workingFolder(s: Stage): Promise<Seen> {
  // Last: the session stays in the child folder, where the other scenes' files do not go.
  const app = join(s.workdir, "app");
  const branch = `probe-${randomBytes(3).toString("hex")}`;
  await mkdir(app);
  initRepo(app, branch);
  const turn = await s.main.turn(
    "Use the Bash tool to run exactly this command: cd app\nThen reply: done",
  );
  // A `cd` inside the working folder asks for no approval (measured 2026-09-27, 2.1.283): the
  // call shows on its card only.
  const called = ofType(turn.events, "call_started").some((event) => event.toolName === "Bash");
  const where = ofType(turn.events, "folder_changed").at(-1)?.folder ?? null;
  const moved = where !== null && (await realpath(where)) === (await realpath(app));
  // The probe's own folders stand for trusted ones: the owner's record of trusted folders knows
  // none of them, and the repository made above lies inside the session's folder.
  const here = await realpath(s.workdir);
  const repository = async (folder: string): Promise<Repository | null> => {
    try {
      const found = await locate(folder);
      return found !== null && inside(here, found.key) ? found : null;
    } catch {
      return null;
    }
  };
  const [shownBranch] = where === null ? [null] : await gitState(where, repository);
  const shown = shownBranch === branch;
  const detail = `folder moved: ${moved}, branch shown: ${shown}`;
  return { P14: observation(called, moved && shown, moved && shown ? "" : detail) };
}

async function replay(s: Stage): Promise<Seen> {
  const turn = await s.main.turn("Reply with the single word: ready");
  const echoed = turn.events.findIndex(
    (event) => event.type === "prompt_taken" && event.promptId === turn.id,
  );
  // Events keep the order of the records they come from, so the order here is the stream's.
  const streamed = turn.events.findIndex(
    (event) =>
      event.type === "message_started" ||
      event.type === "text_started" ||
      event.type === "text_delta",
  );
  if (echoed < 0) return { P19: observation(true, false, "no prompt_taken carried the uuid sent") };
  const early = streamed < 0 || echoed < streamed;
  return {
    P19: observation(
      true,
      early,
      early ? "" : "the replay came after the turn's first stream event",
    ),
  };
}

/**
 * P26: the result of `/effort` and of `/model` names the command in `local_command`, so the back
 * end says the level each set (`effort_changed`), and the PostModelSwitch hook before the result
 * of `/model` gives the model it switched to (`model_changed`). The scene crosses to Sonnet and
 * back, since `/model haiku` on a session already on Haiku may switch nothing. The session ends
 * on `auto`, the default it started with, and on the model it started on; no command costs a
 * token.
 */
async function effortCommands(s: Stage): Promise<Seen> {
  const levels: (string | null | undefined)[] = [];
  for (const command of ["/effort low", "/model haiku", "/effort auto"]) {
    const turn = await s.main.turn(command);
    const changed = ofType(turn.events, "effort_changed");
    levels.push(changed.length === 1 ? changed[0]?.level : undefined);
  }
  const holds = levels[0] === "low" && levels[1] === null && levels[2] === "auto";
  const detail = holds
    ? ""
    : `the level each command said: ${levels.map((l) => (l === undefined ? "no event" : String(l))).join(", ")}`;
  const models: (string | undefined)[] = [];
  for (const command of ["/model sonnet", "/model haiku"]) {
    const turn = await s.main.turn(command);
    const changed = ofType(turn.events, "model_changed");
    const before =
      turn.events.findIndex((event) => event.type === "model_changed") <
      turn.events.findIndex((event) => event.type === "turn_ended");
    models.push(changed.length === 1 && before ? changed[0]?.model : undefined);
  }
  const switched = models[0] !== undefined && models[1] !== undefined && models[0] !== models[1];
  const said = switched
    ? ""
    : `the model each command said: ${models.map((m) => m ?? "no event").join(", ")}`;
  return { P26: observation(true, holds && switched, [detail, said].filter(Boolean).join("; ")) };
}

async function goal(s: Stage): Promise<Seen> {
  // A goal met by its first turn, so the scene is one turn and leaves no goal behind.
  const condition = "Reply with the single word tick.";
  const line = `Goal set: ${condition}`;
  const turn = await s.main.turn(`/goal ${condition}`);
  const first = turn.events.find((event) => event.type === "text" || event.type === "text_delta");
  const reply = writtenIn(turn.events);
  // The line is a message no `message_start` announced, which the back end gives whole.
  const opens = first?.type === "text" && first.text.startsWith(line);
  const once = reply.split("Goal set:").length === 2 && reply.length > line.length;
  const detail =
    opens && once ? "" : `opens with the line: ${opens}, once and with a reply: ${once}`;
  return { P20: observation(true, opens && once, detail) };
}

async function compact(s: Stage): Promise<Seen> {
  // Runs last of the session's scenes: the session it leaves holds a summary in place of them.
  const turn = await s.main.turn("/compact");
  const at = (type: SessionEvent["type"]) => turn.events.findIndex((event) => event.type === type);
  const boundary = at("compacted");
  const result = at("turn_ended");
  // The frames that start a reply: nothing of one comes before the boundary.
  const starts = turn.events.findIndex((event) =>
    ["message_started", "text_started", "text_delta", "text", "call_started"].includes(event.type),
  );
  const compacted = ofType(turn.events, "compacted")[0];
  const shown = boundary >= 0 && (starts < 0 || boundary < starts) && result > boundary;
  const announced = at("compaction_started") >= 0 && at("compaction_started") < boundary;
  return {
    P21: observation(
      true,
      shown,
      shown
        ? `tokens ${compacted?.tokensBefore ?? "none"} to ${compacted?.tokensAfter ?? "none"}`
        : `the turn's events: ${turn.events.map((event) => event.type).join(",")}`,
    ),
    P22: observation(true, announced, announced ? "" : "no compaction_started before the boundary"),
  };
}

/** Sends every command the limits page lists as not offered, as the daemon sends a `!name`. */
async function commandsNotOffered(s: Stage): Promise<Seen> {
  const answered = new Map<string, string>();
  for (const name of notOffered()) {
    const turn = await s.main.turn(`/${name}`);
    answered.set(
      name,
      writtenIn(turn.events) + (ofType(turn.events, "turn_ended")[0]?.finalText ?? ""),
    );
  }
  // Each costs no tokens: Claude Code answers it itself.
  const offered = [...answered]
    .filter(([, text]) => !text.includes(UNAVAILABLE))
    .map(([name]) => `/${name}`);
  let detail = `${answered.size} commands sent`;
  if (offered.length > 0) detail += `; answered otherwise: ${offered.join(", ")}`;
  return { P23: observation(true, offered.length === 0, detail) };
}

/** The server a probe session declares and its folder's entry switches off: the scene's control. */
const CONTROL_SERVER = "control";

/** How long a session gets to register its servers before the list is read. */
const SERVERS_SETTLE_MS = 4000;

/**
 * What a session's servers say about computer use. The control is a server the session declares
 * and the folder's entry in `.claude.json` switches off: listed as `disabled`, it shows that entry
 * was read, so the absence of a computer-use server beside it is about computer use and not about
 * an entry nobody read.
 */
export function judgeComputerUse(
  servers: readonly { readonly name: string; readonly status: string }[],
): Observation {
  const listed =
    servers.map((server) => `${server.name} ${server.status}`).join(", ") || "no server";
  if (servers.find((server) => server.name === CONTROL_SERVER)?.status !== "disabled") {
    return observation(false, false, `the folder's entry was not read: ${listed}`);
  }
  const computer = servers.some((server) => /computer/i.test(server.name));
  return observation(true, !computer, computer ? `listed: ${listed}` : "");
}

/**
 * Starts a session in a folder whose entry switches computer use on, and reads the servers it
 * lists; no prompt is sent. The entry sits in a temporary home given to the Claude Code process
 * (`HOME`), so the owner's `~/.claude.json` is neither read nor changed. The claim is about a raw
 * list the back end does not expose, which is why this scene reads the SDK itself.
 */
async function computerUse(s: Stage): Promise<Seen> {
  const home = join(s.root, "computer-use-home");
  const folder = join(s.root, "computer-use");
  await mkdir(home);
  await mkdir(folder);
  const entry = { enabledMcpServers: ["computer-use"], disabledMcpServers: [CONTROL_SERVER] };
  await writeFile(join(home, ".claude.json"), JSON.stringify({ projects: { [folder]: entry } }));
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  // It would send Claude Code to another folder for its configuration.
  delete env.CLAUDE_CONFIG_DIR;
  const input = new AsyncQueue<SDKUserMessage>();
  const raw = query({
    prompt: input,
    options: {
      cwd: folder,
      settingSources: [],
      model: PROBE_MODEL,
      env,
      mcpServers: { [CONTROL_SERVER]: { command: process.execPath, args: ["-e", ""] } },
    },
  });
  try {
    await raw.initializationResult();
    // Some servers register after the session starts: absence is read once they had time to.
    await new Promise<void>((resolve) => setTimeout(resolve, SERVERS_SETTLE_MS));
    return { P24: judgeComputerUse(await raw.mcpServerStatus()) };
  } finally {
    input.end();
    raw.close();
  }
}

/**
 * P25: what a raw stream says of the first turn Claude Code opened by itself, which a result
 * whose origin is `task-notification` closes. The claim holds while no user record of that
 * origin came in that turn, since such a record would carry the text that woke it (recorded
 * absent on Claude Code 2.1.300: `test/fixtures/sdk/background-forms.jsonl`). Unproven when no
 * such turn came.
 */
export function judgeWake(records: readonly unknown[]): Observation {
  let woke: string[] = [];
  for (const record of records) {
    if (!isRecord(record)) continue;
    const kind = isRecord(record.origin) ? record.origin.kind : null;
    if (record.type === "user" && kind === "task-notification") {
      woke.push(JSON.stringify(isRecord(record.message) ? record.message.content : null));
    }
    if (record.type !== "result") continue;
    if (kind === "task-notification") {
      const said = woke.length === 0;
      return observation(true, said, said ? "" : `a user record came first: ${woke[0]}`);
    }
    woke = []; // a turn of the owner's: what came in it opened none of Claude Code's own
  }
  return observation(false, false, "no turn opened by a task's notification");
}

/**
 * Runs a command in the background and reads the raw stream up to the turn its end opens. The
 * back end turns neither a user record of origin `task-notification` nor a result's origin into
 * an event of its own, which is why this scene reads the SDK itself. The session may run Bash
 * alone.
 */
async function backgroundWake(s: Stage): Promise<Seen> {
  const folder = join(s.root, "wake");
  await mkdir(folder);
  const input = new AsyncQueue<SDKUserMessage>();
  // The owner's login, as for every session of the probe; no setting source.
  const raw = query({
    prompt: input,
    options: {
      cwd: folder,
      settingSources: [],
      model: PROBE_MODEL,
      // As the daemon passes it (`src/agent/claude/session.ts`): Claude Code re-emits each
      // prompt it takes, a task's notification folded into a running turn included.
      extraArgs: { "replay-user-messages": null },
      canUseTool: async (toolName, toolInput) =>
        toolName === "Bash"
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "the probe allows Bash alone" },
    },
  });
  const records: unknown[] = [];
  let late = false;
  // A turn that never comes learns nothing: the stream is closed, and the claim is unproven.
  const timer = setTimeout(() => {
    late = true;
    raw.close();
  }, WAKE_LIMIT);
  try {
    input.push({
      type: "user",
      message: {
        role: "user",
        content:
          "Use the Bash tool with run_in_background set to true to run `sleep 3; echo done`. " +
          "Then reply with the single word: started. When you are told the command finished, " +
          "reply with the single word: finished.",
      },
      parent_tool_use_id: null,
    });
    try {
      for await (const record of raw) {
        records.push(record);
        // Read as any record of Claude Code's is: unknown, narrowed where it is read.
        const seen: unknown = record;
        const origin = isRecord(seen) && isRecord(seen.origin) ? seen.origin.kind : null;
        if (record.type === "result" && origin === "task-notification") break;
      }
    } catch (error) {
      if (!late) throw error;
    }
    return { P25: judgeWake(records) };
  } finally {
    clearTimeout(timer);
    input.end();
    raw.close();
  }
}

/**
 * P29: the SDK's listing reads the folder `CLAUDE_CONFIG_DIR` names from the process environment,
 * the only way it takes one (`ListSessionsOptions` has no such option, sdk.d.ts 0.3.301). A
 * session cannot show it: a fresh folder has no login. So a transcript of the shape Claude Code
 * writes is placed in a folder of its own and listed with the variable pointing there, which
 * needs no token. The variable is put back whatever happens, since the scenes after this one
 * start sessions that inherit the environment.
 */
export async function configFolderListing(root: string): Promise<Seen> {
  const config = join(root, "login");
  const project = join(root, "listed");
  await mkdir(project);
  const folder = join(config, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(folder, { recursive: true });
  const id = randomUUID();
  const line = {
    type: "user",
    timestamp: "2026-10-17T10:00:00.000Z",
    sessionId: id,
    uuid: randomUUID(),
    parentUuid: null,
    message: { role: "user", content: "a question" },
  };
  await writeFile(join(folder, `${id}.jsonl`), `${JSON.stringify(line)}\n`);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const found = await directorySessions(project);
    const listed = found.some((entry) => entry.id === id);
    return { P29: observation(true, listed, listed ? "" : `${found.length} sessions listed`) };
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

/**
 * Removes the transcripts the probe's sessions left under Claude Code's projects folder: only
 * the folders whose name holds this run's random temporary folder. Anything else is left alone.
 */
async function forgetSessions(root: string, log: Log): Promise<void> {
  const projects = projectsDir();
  const mine = basename(root);
  let removed = 0;
  try {
    for (const entry of await readdir(projects)) {
      if (entry.includes(mine)) {
        await rm(join(projects, entry), { recursive: true, force: true });
        removed += 1;
      }
    }
  } catch {
    // No projects folder: no transcripts.
  }
  log(`removed ${removed} transcript folders`);
}

/** Runs every scene on a fresh back end and returns what each claim's scene saw. */
export async function runScenes(log: Log): Promise<Seen> {
  const seen: Seen = {};
  const root = await realpath(await mkdtemp(join(tmpdir(), "awaydesk-probe-")));
  try {
    // The owner's own `~/.claude.json` is not read: Chrome stays off for these sessions.
    const home = join(root, "home");
    await mkdir(home);
    await writeFile(join(home, ".claude.json"), "{}");
    const s = new Stage(log, root, home);
    for (const folder of [s.workdir, s.models, s.uploads]) await mkdir(folder);
    const word = randomBytes(3).toString("hex");
    try {
      s.main = await s.open(s.workdir);
      Object.assign(seen, await attempt("first turn", s, () => firstTurn(s, word)));
      const sessionId = sessionIdOf(s.main.events);
      Object.assign(seen, await attempt("image", s, () => imageTurn(s)));
      Object.assign(seen, await attempt("file", s, () => fileTurn(s)));
      Object.assign(seen, await attempt("bash and approval", s, () => bashTurn(s)));
      Object.assign(seen, await attempt("previews", s, () => previews(s)));
      Object.assign(seen, await attempt("background and stop", s, () => backgroundStop(s)));
      Object.assign(seen, await attempt("interrupt", s, () => interrupt(s)));
      Object.assign(seen, await attempt("resume", s, () => resume(s, word, sessionId)));
      Object.assign(seen, await attempt("model and effort resume", s, () => modelEffortResume(s)));
      Object.assign(seen, await attempt("setup model resume", s, () => setupModelResume(s)));
      Object.assign(
        seen,
        await attempt("model command after setModel", s, () => modelCommandAfterSetModel(s)),
      );
      Object.assign(seen, await attempt("bypass", s, () => bypass(s)));
      Object.assign(seen, await attempt("working folder", s, () => workingFolder(s)));
      Object.assign(seen, await attempt("replay", s, () => replay(s)));
      Object.assign(seen, await attempt("effort commands", s, () => effortCommands(s)));
      Object.assign(seen, await attempt("goal", s, () => goal(s)));
      Object.assign(seen, await attempt("compact", s, () => compact(s)));
      Object.assign(seen, await attempt("commands not offered", s, () => commandsNotOffered(s)));
      Object.assign(seen, await attempt("computer use", s, () => computerUse(s)));
      Object.assign(seen, await attempt("background wake", s, () => backgroundWake(s)));
      Object.assign(
        seen,
        await attempt("config folder listing", s, () => configFolderListing(s.root)),
      );
    } finally {
      await Promise.allSettled(s.lives.map((live) => live.session.close()));
      await forgetSessions(root, log);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return seen;
}
