/**
 * The conformance suite of the agent seam, run against every back end: the Claude back end over
 * its fake query, and the plain agent of the tests. The two harnesses below play each back end:
 * the Claude one with the recorded wire records (`test/fixtures/sdk/`), the plain one with its
 * own steps.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { CAPABILITIES } from "../../src/agent/claude/capabilities.ts";
import { claudeAgent } from "../../src/agent/claude/module.ts";
import { logger, type QueryFunction } from "../../src/agent/claude/session.ts";
import type { AgentBackend, AgentContext } from "../../src/agent/seam.ts";
import { systemClock } from "../../src/clock.ts";
import {
  ask,
  type Batch,
  END,
  type FakeQuery,
  type FakeScript,
  FakeSdk,
  fail,
} from "../support/fake-query.ts";
import { type JsonObject, sdkRecords } from "../support/fixtures.ts";
import {
  call,
  effort,
  fail as failedRequest,
  hold,
  PLAIN_CAPABILITIES,
  type PlainAgent,
  type PlainStep,
  PlainStore,
  plainAgent,
  question,
  say,
} from "../support/plain-agent.ts";
import {
  type AgentHarness,
  type AgentWorld,
  agentConformance,
  type PlayedQuestion,
  type PlayedTool,
  type Told,
} from "./agent.ts";

const CONTEXT: AgentContext = { variables: {}, clock: systemClock };

// The Claude back end.
//
// Every turn is cut from a recording and kept in the shape the CLI wrote it; only the session
// id and the words are the test's own. `tools.jsonl` is a turn with two tool calls and a closing
// message, `ask-answered.jsonl` one that asks a question, `interrupt.jsonl` one the owner
// stopped. The indexes name records of those files and are checked when the module loads.

const TOOLS = sdkRecords("tools");
const ASKED = sdkRecords("ask-answered");
const INTERRUPTED = sdkRecords("interrupt");

function record(records: readonly JsonObject[], index: number, ...is: string[]): JsonObject {
  const found = records[index];
  if (found === undefined || !is.every((word) => JSON.stringify(found).includes(word))) {
    throw new Error(`the recording does not hold record ${index} as these tests read it`);
  }
  return found;
}

function blocksOf(item: JsonObject): JsonObject[] {
  const message = item.message as JsonObject | undefined;
  return Array.isArray(message?.content) ? (message.content as JsonObject[]) : [];
}

// The first message of `tools.jsonl`: it opens, thinks, and calls Bash (records 12 to 19).
const OPENING = [...TOOLS.slice(0, 12)];
const BASH_CALL = TOOLS.slice(12, 20);
const BASH_BLOCK = blocksOf(record(TOOLS, 19, "tool_use", "Bash"))[0] as JsonObject;
const BASH_ID = String(BASH_BLOCK.id);
const BASH_INPUT = BASH_BLOCK.input as Record<string, unknown>;
const BASH_RESULT = record(TOOLS, 24, "tool_result", BASH_ID);
const TEXT_START = record(TOOLS, 68, "content_block_start", '"text"');
const TEXT_DELTA = record(TOOLS, 69, "text_delta");
const TEXT_MESSAGE = record(TOOLS, 74, "The notes.txt");
const TEXT_END = TOOLS.slice(75, 78);
const RESULT = record(TOOLS, 78, '"type":"result"', "end_turn");
const REJECTION = record(INTERRUPTED, 32, "tool_result", "user-rejected");
const INTERRUPT_NOTE = record(INTERRUPTED, 33, "Request interrupted");
const INTERRUPT_RESULT = record(INTERRUPTED, 34, "aborted_tools");
const ASK_AT = ASKED.findIndex((item) =>
  blocksOf(item).some((block) => block.type === "tool_use" && block.name === "AskUserQuestion"),
);
const ASK_BLOCK = blocksOf(ASKED[ASK_AT] as JsonObject)[0] as JsonObject;

function withSession(records: readonly JsonObject[], id: string): JsonObject[] {
  return records.map((item) => ("session_id" in item ? { ...item, session_id: id } : item));
}

/** `records` with the text of the one message that writes, whatever the recording said. */
function speak(records: readonly JsonObject[], text: string): JsonObject[] {
  const pieces = text.match(/\S+\s*|\s+/g) ?? [];
  const out: JsonObject[] = [];
  let placed = false;
  for (const item of records) {
    const event = item.event as JsonObject | undefined;
    const delta = event?.delta as JsonObject | undefined;
    if (delta?.type === "text_delta") {
      if (placed) continue;
      placed = true;
      for (const piece of pieces) {
        out.push({ ...item, event: { ...event, delta: { ...delta, text: piece } } });
      }
    } else if (item.type === "assistant" && blocksOf(item).some((block) => block.type === "text")) {
      const message = item.message as JsonObject;
      out.push({ ...item, message: { ...message, content: [{ type: "text", text }] } });
    } else if (item.type === "result") {
      out.push({ ...item, result: text });
    } else {
      out.push(item);
    }
  }
  return out;
}

const FINISH = [TEXT_MESSAGE, ...TEXT_END, RESULT];

type Kind = "say" | "hang" | "other";

interface Play {
  readonly kind: Kind;
  readonly batch: Batch;
}

class ClaudeWorld implements AgentWorld {
  readonly folder: string;
  readonly otherFolder: string;
  readonly #root: string;
  readonly #home: string;
  readonly #config: string;
  readonly #previousConfig: string | undefined;
  readonly #sdk: FakeSdk;
  readonly #query: QueryFunction;
  readonly #plays: Play[] = [];
  // The kind of each turn played, by the index of the query that plays them.
  readonly #kinds = new Map<number, Kind[]>();
  readonly #interrupted = new Set<string>();
  #nextStart: FakeScript | null = null;
  #usage = false;
  #sessions = 0;
  #current: AgentBackend;

  constructor(root: string) {
    this.#root = root;
    this.#home = join(root, "home");
    this.#config = join(root, "config");
    this.folder = join(root, "project");
    this.otherFolder = join(root, "other");
    this.#previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = this.#config;
    this.#sdk = new FakeSdk((index) => this.#script(index));
    this.#query = (params) => {
      const query = this.#sdk.query(params) as FakeQuery;
      const interrupt = query.interrupt.bind(query);
      query.interrupt = async () => {
        const result = await interrupt();
        this.#endHungTurn(query);
        return result;
      };
      return query;
    };
    this.#current = this.#build();
  }

  static async create(t: TestContext): Promise<ClaudeWorld> {
    // A lost process is logged as an error; the log is not what these tests look at.
    t.mock.method(logger, "error", () => undefined);
    const root = await realpath(await mkdtemp(join(tmpdir(), "awaydesk-conformance-")));
    for (const folder of ["home", "project", "other"]) await mkdir(join(root, folder));
    await writeFile(join(root, "home", ".claude.json"), "{}");
    return new ClaudeWorld(root);
  }

  #build(): AgentBackend {
    return claudeAgent({ query: this.#query, home: this.#home }).build(CONTEXT);
  }

  /** What the query that starts now plays: the next start's script, the usage answer, or the plays. */
  #script(index: number): FakeScript {
    const start = this.#nextStart;
    if (start !== null) {
      this.#nextStart = null;
      return start;
    }
    if (this.#usage) {
      this.#usage = false;
      return { turns: [sdkRecords("usage")] };
    }
    const plays = this.#plays.splice(0);
    this.#kinds.set(
      index,
      plays.map((play) => play.kind),
    );
    return { turns: plays.map((play) => play.batch) };
  }

  get backend(): AgentBackend {
    return this.#current;
  }

  restart(): AgentBackend {
    this.#current = this.#build();
    return this.#current;
  }

  running(): number {
    return this.#sdk.queries.filter((query) => !query.closed).length;
  }

  #sessionId(): string {
    this.#sessions += 1;
    return `68da9311-0000-4000-8000-${String(this.#sessions).padStart(12, "0")}`;
  }

  say(text: string): void {
    const records = [...OPENING, TEXT_START, TEXT_DELTA, ...FINISH];
    this.#plays.push({ kind: "say", batch: withSession(speak(records, text), this.#sessionId()) });
  }

  callTool(answer: "allow" | "deny", after: string): PlayedTool {
    return this.#playBash(answer, after, false);
  }

  giveUpTool(after: string): PlayedTool {
    return this.#playBash("deny", after, true);
  }

  #playBash(answer: "allow" | "deny", after: string, giveUp: boolean): PlayedTool {
    // What the CLI writes once it has the owner's answer: the tool's result or its rejection.
    const result =
      answer === "allow"
        ? BASH_RESULT
        : {
            ...REJECTION,
            message: {
              role: "user",
              content: [{ ...blocksOf(REJECTION)[0], tool_use_id: BASH_ID }],
            },
          };
    const rest = [
      TOOLS[20] as JsonObject,
      result,
      ...TOOLS.slice(55, 57),
      ...TOOLS.slice(58, 68),
      TEXT_START,
      TEXT_DELTA,
      ...FINISH,
    ];
    const id = this.#sessionId();
    this.#plays.push({
      kind: "other",
      batch: [
        ...withSession([...OPENING, ...BASH_CALL], id),
        ask({
          toolName: "Bash",
          input: BASH_INPUT,
          toolUseID: BASH_ID,
          requestId: "request-1",
          ...(giveUp && { giveUp }),
        }),
        ...withSession(speak(rest, after), id),
      ],
    });
    return { toolName: "Bash", input: BASH_INPUT };
  }

  askQuestion(): readonly PlayedQuestion[] {
    const input = ASK_BLOCK.input as Record<string, unknown>;
    const id = this.#sessionId();
    this.#plays.push({
      kind: "other",
      batch: [
        ...withSession(ASKED.slice(0, ASK_AT + 1), id),
        ask({ toolName: "AskUserQuestion", input, toolUseID: String(ASK_BLOCK.id) }),
        ...withSession(ASKED.slice(ASK_AT + 1), id),
      ],
    });
    const questions = input.questions as readonly JsonObject[];
    return questions.map((asked) => ({
      text: String(asked.question),
      options: (asked.options as readonly JsonObject[]).map((option) => String(option.label)),
      multiSelect: asked.multiSelect === true,
    }));
  }

  hangTurn(text: string): void {
    const records = speak([...OPENING, TEXT_START, TEXT_DELTA], text);
    this.#plays.push({ kind: "hang", batch: withSession(records, this.#sessionId()) });
  }

  command(): { readonly prompt: string; readonly includes: string } {
    this.#plays.push({ kind: "other", batch: withSession(sdkRecords("usage"), this.#sessionId()) });
    return { prompt: "/usage", includes: "Current session" };
  }

  effortCommand(to: "level" | "default"): { readonly prompt: string; readonly level: string } {
    const level = to === "level" ? "low" : (CAPABILITIES.effortDefault ?? "");
    const recorded = sdkRecords("effort-model-commands").slice(0, 3);
    const batch = recorded.map((item) =>
      item.type === "result"
        ? { ...item, result: `Effort level set to ${level} (this session only)` }
        : item,
    );
    this.#plays.push({ kind: "other", batch: withSession(batch, this.#sessionId()) });
    return { prompt: `/effort ${level}`, level };
  }

  failTurn(): string {
    this.#plays.push({
      kind: "other",
      batch: withSession(sdkRecords("api-error-500"), this.#sessionId()),
    });
    return "API Error: 500";
  }

  /** The records the CLI writes when the owner stops the turn that waits. */
  #endHungTurn(query: FakeQuery): void {
    const index = this.#sdk.queries.indexOf(query);
    const turn = query.sent.length - 1;
    const key = `${index}:${turn}`;
    if (this.#kinds.get(index)?.[turn] !== "hang" || this.#interrupted.has(key)) return;
    this.#interrupted.add(key);
    query.inject(withSession([INTERRUPT_NOTE, INTERRUPT_RESULT], this.#sessionId()));
  }

  die(): void {
    const live = this.#sdk.queries.findLast((query) => !query.closed);
    live?.inject([END]);
  }

  failStart(error: Error): void {
    this.#nextStart = { initError: error, start: [fail(error)] };
  }

  refuseResume(): void {
    const failure = new Error("Claude Code returned an error result: No conversation found");
    const refusal = { ...INTERRUPT_RESULT, is_error: true };
    this.#nextStart = { initError: failure, start: [refusal, fail(failure)] };
  }

  told(): readonly Told[] {
    return this.#sdk.queries.flatMap((query) =>
      query.permissionResults.map((result): Told => {
        if (result.behavior === "deny") {
          return { allow: false, message: result.message, input: null };
        }
        return { allow: true, message: null, input: result.updatedInput ?? null };
      }),
    );
  }

  async persist(folder: string, sessionId: string, at: number): Promise<void> {
    const directory = join(this.#config, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(directory, { recursive: true });
    const line = {
      type: "user",
      timestamp: new Date(at).toISOString(),
      sessionId,
      uuid: randomUUID(),
      parentUuid: null,
      gitBranch: "main",
      message: { role: "user", content: "A question" },
    };
    const path = join(directory, `${sessionId}.jsonl`);
    await writeFile(path, `${JSON.stringify(line)}\n`);
    await utimes(path, at / 1000, at / 1000);
  }

  async trust(folder: string): Promise<void> {
    const projects = { [folder]: { hasTrustDialogAccepted: true } };
    await writeFile(join(this.#home, ".claude.json"), JSON.stringify({ projects }));
  }

  arrangeUsage(): void {
    this.#usage = true;
  }

  async dispose(): Promise<void> {
    if (this.#previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = this.#previousConfig;
    await rm(this.#root, { recursive: true, force: true });
  }
}

agentConformance("Claude back end", {
  // The fake query accepts any resume unless refuseResume() scripts a refusal, and the record
  // Claude Code checks is a transcript the fake does not write.
  refusesUnrecordedResume: false,
  capabilities: CAPABILITIES,
  create: (t) => ClaudeWorld.create(t),
} satisfies AgentHarness);

// The plain agent.

const FOLDER = "/srv/alice/app";
const OTHER = "/srv/alice/elsewhere";
const COLOUR: PlayedQuestion = {
  text: "Which colour do you prefer?",
  options: ["Red", "Blue"],
  multiSelect: false,
};
const LS = { command: "ls" };

class PlainWorld implements AgentWorld {
  readonly folder = FOLDER;
  readonly otherFolder = OTHER;
  readonly #store = new PlainStore();
  readonly #turns: PlainStep[][] = [];
  readonly #entry = plainAgent({ store: this.#store, turns: this.#turns });
  #current: PlainAgent;

  constructor() {
    this.#current = this.#build();
  }

  #build(): PlainAgent {
    this.#entry.build(CONTEXT);
    const agent = this.#entry.built.at(-1);
    if (agent === undefined) throw new Error("the entry built nothing");
    return agent;
  }

  get backend(): PlainAgent {
    return this.#current;
  }

  restart(): AgentBackend {
    this.#current = this.#build();
    return this.#current;
  }

  running(): number {
    return this.#entry.built.reduce((sum, agent) => sum + agent.running.length, 0);
  }

  say(text: string): void {
    this.#turns.push([say(text)]);
  }

  callTool(_answer: "allow" | "deny", after: string): PlayedTool {
    this.#turns.push([call("Shell", LS, { permission: true, output: "a.txt" }), say(after)]);
    return { toolName: "Shell", input: LS };
  }

  giveUpTool(after: string): PlayedTool {
    this.#turns.push([call("Shell", LS, { permission: true, giveUp: true }), say(after)]);
    return { toolName: "Shell", input: LS };
  }

  askQuestion(): readonly PlayedQuestion[] {
    this.#turns.push([question(COLOUR.text, COLOUR.options), say("Noted.")]);
    return [COLOUR];
  }

  hangTurn(text: string): void {
    this.#turns.push([say(text), hold()]);
  }

  // A command takes no turn of the script.
  command(): { readonly prompt: string; readonly includes: string } {
    return { prompt: "/echo hello", includes: "hello" };
  }

  effortCommand(to: "level" | "default"): { readonly prompt: string; readonly level: string } {
    const level = to === "level" ? "full" : (PLAIN_CAPABILITIES.effortDefault ?? "");
    this.#turns.push([effort(level)]);
    return { prompt: "set the effort", level };
  }

  failTurn(): string {
    this.#turns.push([failedRequest("The request failed.")]);
    return "The request failed.";
  }

  die(): void {
    this.#entry.built
      .flatMap((agent) => agent.running)
      .at(-1)
      ?.kill();
  }

  failStart(error: Error): void {
    this.#current.failNextStart(error);
  }

  // The agent refuses a session it does not hold on its own.
  refuseResume(): void {}

  told(): readonly Told[] {
    return this.#entry.built
      .flatMap((agent) => agent.sessions)
      .flatMap((session) => session.answers)
      .map(({ request, answer }): Told => {
        if ("allow" in answer) {
          return answer.allow
            ? {
                allow: true,
                message: null,
                input: request.type === "permission" ? request.input : null,
              }
            : { allow: false, message: answer.message, input: null };
        }
        return answer.answered
          ? { allow: true, message: null, input: { answers: answer.answers } }
          : { allow: false, message: answer.message, input: null };
      });
  }

  async persist(folder: string, sessionId: string, at: number): Promise<void> {
    this.#store.remember(folder, sessionId, "A question", at);
  }

  async dispose(): Promise<void> {}
}

agentConformance("plain agent", {
  refusesUnrecordedResume: true,
  capabilities: PLAIN_CAPABILITIES,
  create: async () => new PlainWorld(),
} satisfies AgentHarness);
