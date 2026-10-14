/**
 * The conformance suite of the agent seam (`src/agent/seam.ts`): `agentConformance` registers
 * `node:test` tests against any back end that a harness can build and play. It checks what the
 * seam promises, capability by capability. A check that makes sense only with a capability is
 * registered with a `skip` that names it for a back end that lacks it, never left out.
 *
 * Where the seam is silent, a check says so in its title ("seam silent") and pins what both
 * back ends do, so that a third one is held to the same behaviour until the seam says otherwise.
 *
 * The harness plays the agent: the suite never knows what a record, a process or a transcript
 * is. Plays (`say`, `callTool`, ...) are arranged BEFORE the session starts, and each prompt
 * sent takes the next one.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, type TestContext, type TestOptions, test } from "node:test";
import type {
  AgentBackend,
  AgentSession,
  Capabilities,
  ListedSession,
  PermissionAnswer,
  PermissionRequest,
  Prompt,
  QuestionAnswer,
  QuestionRequest,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../../src/agent/seam.ts";
import { ResumeRefused } from "../../src/agent/seam.ts";
import { GIT_LAYOUT } from "../support/platform.ts";

type Input = Readonly<Record<string, unknown>>;

/** What the agent was told when a request was answered: a call it may run, or one it may not. */
export interface Told {
  readonly allow: boolean;
  /** The denial's message, null for an allow. */
  readonly message: string | null;
  /** The input the call runs with, or the `answers` of a question; null for a denial. */
  readonly input: Input | null;
}

export interface PlayedTool {
  readonly toolName: string;
  /** The input of the call, which the permission request carries too. */
  readonly input: Input;
}

export interface PlayedQuestion {
  readonly text: string;
  readonly options: readonly string[];
  readonly multiSelect: boolean;
}

/** One fresh instance of the agent under test: its own folders, records and processes. */
export interface AgentWorld {
  /** A folder that exists, where the sessions run. */
  readonly folder: string;
  /** Another folder that exists, where no session ran and the owner trusted nothing. */
  readonly otherFolder: string;
  /** The back end. */
  readonly backend: AgentBackend;
  /** A new back end over the same records, as after the daemon restarted; it becomes `backend`. */
  restart(): AgentBackend;
  /** How many processes the agent holds that were started and not closed or lost. */
  running(): number;
  /** The next prompt: the agent writes `text`, piece by piece or whole. */
  say(text: string): void;
  /**
   * The next prompt: the agent starts a call, asks permission for it, then writes `after`. The
   * test is going to give `answer`, which a back end that replays records needs to know.
   */
  callTool(answer: "allow" | "deny", after: string): PlayedTool;
  /**
   * The next prompt: the agent starts a call, asks permission for it, gives the request up while
   * the handler waits, then writes `after`.
   */
  giveUpTool(after: string): PlayedTool;
  /** The next prompt: the agent asks questions, then writes a word. Returns what it asks. */
  askQuestion(): readonly PlayedQuestion[];
  /** The next prompt: the agent writes `text` and then keeps working until interrupted. */
  hangTurn(text: string): void;
  /** The next prompt is a command of the agent's own: the prompt to send, and a word its output holds. */
  command(): { readonly prompt: string; readonly includes: string };
  /** The next prompt fails as a request of the agent's own does. Returns a word its message holds. */
  failTurn(): string;
  /** The agent's process dies now. */
  die(): void;
  /** The next start fails with `error`, which is no refusal to resume. */
  failStart(error: Error): void;
  /** The next start with a `resume` is refused, as when the agent holds no such session. */
  refuseResume(): void;
  /** What the agent was told by each request answered, in order. */
  told(): readonly Told[];
  /** The agent leaves its record of a session, as it does when the session ran. */
  persist(folder: string, sessionId: string, at: number): Promise<void>;
  /** The owner trusts `folder` in the agent. Needed with `folderTrust`. */
  trust?(folder: string): Promise<void>;
  /** The next read of the usage limits is answered. Needed with `usageLimits`. */
  arrangeUsage?(): void;
  /** Removes what the world made on disk. */
  dispose(): Promise<void>;
}

export interface AgentHarness {
  /** The capabilities the back end declares; the suite checks it declares these. */
  readonly capabilities: Capabilities;
  /**
   * Whether the world refuses a resume of an id the agent holds no record of. A world that
   * accepts any id (a fake that never looks at the record) cannot play the checks that need the
   * refusal, and they are skipped for it.
   */
  readonly refusesUnrecordedResume: boolean;
  create(t: TestContext): Promise<AgentWorld>;
}

const LIMIT = { timeout: 15_000 };
const SETTINGS: StartOptions["settingsSources"] = ["user", "project", "local"];

// Reading a session.

/** Reads a session's events as they come, so that a test looks at what arrived. */
class Recorder {
  readonly seen: SessionEvent[] = [];
  readonly finished: Promise<void>;
  #ended = false;
  #cursor = 0;
  #wake: (() => void) | null = null;

  constructor(session: AgentSession) {
    this.finished = this.#read(session.events);
  }

  async #read(events: AsyncIterable<SessionEvent>): Promise<void> {
    for await (const event of events) {
      this.seen.push(event);
      this.#signal();
    }
    this.#ended = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** The events from the cursor through the first that `matches`; the cursor moves past it. */
  async through(matches: (event: SessionEvent) => boolean, what: string): Promise<SessionEvent[]> {
    for (;;) {
      const at = this.seen.findIndex((event, index) => index >= this.#cursor && matches(event));
      if (at !== -1) {
        const taken = this.seen.slice(this.#cursor, at + 1);
        this.#cursor = at + 1;
        return taken;
      }
      if (this.#ended) assert.fail(`the events ended before ${what}`);
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /** The events of the next turn, up to its `turn_ended`. */
  turn(): Promise<SessionEvent[]> {
    return this.through((event) => event.type === "turn_ended", "a turn ended");
  }

  /** Whether a `turn_ended` arrived that the cursor has not passed. */
  get turnPending(): boolean {
    return this.seen.slice(this.#cursor).some((event) => event.type === "turn_ended");
  }
}

function prompt(content = "go"): Prompt {
  return { id: randomUUID(), content };
}

function startOptions(world: AgentWorld, override: Partial<StartOptions> = {}): StartOptions {
  return {
    folder: world.folder,
    resume: null,
    settingsSources: SETTINGS,
    model: null,
    effort: null,
    ...override,
  };
}

/** A handler that answers as the test says and records what it was asked. */
class Requests implements RequestHandler {
  readonly permissions: PermissionRequest[] = [];
  readonly questions: QuestionRequest[] = [];
  /** The signal each request came with, in the order of `permissions` then `questions` asked. */
  readonly signals: AbortSignal[] = [];
  readonly #permission: (
    request: PermissionRequest,
    signal: AbortSignal,
  ) => Promise<PermissionAnswer>;
  readonly #question: (request: QuestionRequest, signal: AbortSignal) => Promise<QuestionAnswer>;

  constructor(
    answers: {
      permission?: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;
      question?: (request: QuestionRequest, signal: AbortSignal) => Promise<QuestionAnswer>;
    } = {},
  ) {
    this.#permission = answers.permission ?? (async () => ({ allow: true }));
    this.#question =
      answers.question ?? (async () => ({ answered: false, message: "The owner skipped it." }));
  }

  permission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    this.permissions.push(request);
    this.signals.push(signal);
    return this.#permission(request, signal);
  }

  question(request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> {
    this.questions.push(request);
    this.signals.push(signal);
    return this.#question(request, signal);
  }
}

/** The text the events carry: deltas and whole texts joined, each text as many times as it came. */
function written(events: readonly SessionEvent[]): string {
  return events
    .map((event) => (event.type === "text_delta" || event.type === "text" ? event.text : ""))
    .join("");
}

function ended(events: readonly SessionEvent[]): Extract<SessionEvent, { type: "turn_ended" }> {
  const last = events.at(-1);
  assert.equal(last?.type, "turn_ended");
  return last as Extract<SessionEvent, { type: "turn_ended" }>;
}

/** The order the seam documents for a turn's events, and the shapes it asks of each. */
function assertWellFormed(events: readonly SessionEvent[]): void {
  const open = new Set<string | null>();
  const started = new Set<string>();
  const finished = new Set<string>();
  let textOpen = false;
  for (const event of events) {
    switch (event.type) {
      case "message_started":
        open.add(event.parentCallId);
        textOpen = false;
        break;
      case "text_started":
        assert.ok(open.has(null), "text_started inside a message");
        textOpen = true;
        break;
      case "text_delta":
        assert.notEqual(event.text, "", "a delta is never empty");
        assert.ok(textOpen, "a delta follows text_started");
        break;
      case "message_ended":
        assert.ok(open.has(event.parentCallId), "message_ended closes a message_started");
        open.delete(event.parentCallId);
        textOpen = false;
        break;
      case "text":
        assert.notEqual(event.text, "", "a whole text is never empty");
        assert.equal(event.text, event.text.trim(), "a whole text is trimmed");
        break;
      case "call_started":
        assert.ok(event.toolName !== "" && event.callId !== "");
        assert.ok(!started.has(event.callId), "a call starts once");
        started.add(event.callId);
        break;
      case "call_ended":
        assert.ok(started.has(event.callId), "a call ends after it started");
        assert.ok(!finished.has(event.callId), "a call ends once");
        finished.add(event.callId);
        break;
      default:
    }
  }
  assert.equal(
    events.filter((event) => event.type === "turn_ended").length,
    1,
    "one turn_ended per turn",
  );
}

/** No event of a feature the back end does not declare. */
function assertDeclared(events: readonly SessionEvent[], caps: Capabilities): void {
  for (const event of events) {
    if (!caps.subagents && "parentCallId" in event) {
      assert.equal(event.parentCallId, null, `${event.type} under a call, without subagents`);
    }
    if (!caps.subagents && !caps.backgroundTasks) {
      assert.ok(!event.type.startsWith("task_"), `${event.type} without tasks`);
    }
    if (!caps.backgroundTasks) assert.notEqual(event.type, "report_started");
    if (!caps.compaction) {
      assert.ok(!event.type.startsWith("compaction_") && event.type !== "compacted");
    }
    if (!caps.usageLimits) assert.notEqual(event.type, "limits_changed");
    if (!caps.declaredState) assert.notEqual(event.type, "state_changed");
    if (event.type === "effort_observed" && event.level !== null) {
      assert.ok(caps.effortLevels.includes(event.level), "an effort the back end declares");
    }
  }
}

/** A session started for a test, closed when it ends. */
async function open(
  t: TestContext,
  world: AgentWorld,
  requests: RequestHandler = new Requests(),
  override: Partial<StartOptions> = {},
): Promise<{ session: AgentSession; events: Recorder }> {
  const session = await world.backend.start(startOptions(world, override), requests);
  t.after(() => session.close());
  return { session, events: new Recorder(session) };
}

function sessionIdOf(events: readonly SessionEvent[]): string {
  const id = events
    .map((event) =>
      event.type === "turn_ended" || event.type === "session_started" ? event.sessionId : null,
    )
    .findLast((sessionId) => sessionId !== null);
  assert.ok(id !== undefined && id !== null, "the session named itself");
  return id;
}

/** Registers the conformance tests of `name` against the back end `harness` builds. */
export function agentConformance(name: string, harness: AgentHarness): void {
  const caps = harness.capabilities;
  const lacks = (has: boolean, capability: string) => ({
    ...LIMIT,
    skip: has ? false : `${name} does not declare ${capability}`,
  });

  /** One test over a fresh world, removed when the test ends. */
  function check(
    title: string,
    options: TestOptions,
    body: (world: AgentWorld, t: TestContext) => Promise<void>,
  ): void {
    test(title, options, async (t) => {
      const world = await harness.create(t);
      t.after(() => world.dispose());
      await body(world, t);
    });
  }

  describe(`agent seam: ${name}`, () => {
    // Declaration.

    check("declares a name, words and the capabilities the harness lists", LIMIT, async (world) => {
      const { backend } = world;
      assert.ok(backend.name.trim() !== "");
      assert.ok(backend.words.author.trim() !== "" && backend.words.command.trim() !== "");
      assert.ok(backend.words.examples.trim() !== "");
      assert.ok(backend.words.terminal.includes("{directory}"));
      assert.ok(backend.words.terminal.includes("{session}"));
      // A command name is written after `!` in the chat and `/` in the agent: no slash, no space.
      const { newSession, login, logout } = backend.words;
      assert.ok(Array.isArray(newSession), "newSession is a list, empty when there is none");
      for (const name of [...newSession, ...[login, logout].filter((one) => one !== null)]) {
        assert.ok(/^[^\s/]+$/.test(name), `a command name carries no slash and no space: ${name}`);
      }
      for (const one of [login, logout]) assert.ok(one === null || typeof one === "string");
      assert.deepEqual(backend.capabilities, caps);
      const { effortLevels, permissionModes } = backend.capabilities;
      assert.ok(effortLevels.length > 0 && effortLevels.every((level) => level.trim() !== ""));
      assert.equal(new Set(effortLevels).size, effortLevels.length);
      assert.ok(permissionModes.default.trim() !== "");
      for (const mode of [permissionModes.auto, permissionModes.bypass]) {
        assert.ok(mode === null || mode.trim() !== "", "a role the back end lacks is null");
      }
    });

    check("usageLimits is a member exactly when it is declared", LIMIT, async (world) => {
      assert.equal(typeof world.backend.usageLimits === "function", caps.usageLimits);
    });

    check(
      "usageLimits answers with percentages from 0 to 100",
      lacks(caps.usageLimits, "usageLimits"),
      async (world) => {
        assert.ok(world.arrangeUsage, "the harness arranges a usage answer");
        world.arrangeUsage();
        const limits = await world.backend.usageLimits?.();
        assert.ok(limits !== undefined);
        assert.ok(
          limits.session !== null || limits.week !== null,
          "the harness's answer holds a limit",
        );
        for (const limit of [limits.session, limits.week]) {
          if (limit === null) continue;
          assert.ok(limit.percent >= 0 && limit.percent <= 100);
          assert.ok(limit.resetsAt === null || Number.isFinite(limit.resetsAt));
        }
      },
    );

    check("the back end closes twice without failing", LIMIT, async (world) => {
      await world.backend.close();
      await world.backend.close();
    });

    // Info and the commands of a live session.

    check("info agrees with the capabilities", LIMIT, async (world, t) => {
      const { session } = await open(t, world);
      const info = await session.info();
      if (caps.models) {
        assert.ok(info.models.length > 0, "models are listed when declared");
        for (const model of info.models) assert.ok(model.value !== "");
      } else {
        assert.deepEqual(info.models, [], "no model is listed without models");
      }
      if (caps.commands) {
        assert.ok(info.commands.length > 0, "commands are listed when declared");
        const names = info.commands.map((command) => command.name);
        assert.ok(names.every((word) => word !== ""));
        assert.equal(new Set(names).size, names.length);
      } else {
        assert.deepEqual(info.commands, [], "no command is listed without commands");
      }
      const modes = Object.values(caps.permissionModes);
      assert.ok(info.permissionMode === null || modes.includes(info.permissionMode));
    });

    check(
      "the context usage is a model and a share between 0 and 100, or nulls",
      LIMIT,
      async (world, t) => {
        const { session } = await open(t, world);
        const usage = await session.contextUsage();
        assert.ok(usage.model === null || usage.model !== "");
        assert.ok(usage.percentage === null || (usage.percentage >= 0 && usage.percentage <= 100));
      },
    );

    // Start, events and close.

    check(
      "a start resolves, and the events end after close with no process lost",
      LIMIT,
      async (world) => {
        const session = await world.backend.start(startOptions(world), new Requests());
        const events = new Recorder(session);
        await session.close();
        await events.finished;
        assert.equal(
          events.seen.some((event) => event.type === "process_lost"),
          false,
        );
        assert.equal(
          events.seen.some((event) => event.type === "turn_ended"),
          false,
        );
        assert.equal(world.running(), 0, "close leaves no process");
      },
    );

    check("close is safe to call twice, and at once", LIMIT, async (world) => {
      const session = await world.backend.start(startOptions(world), new Requests());
      await Promise.all([session.close(), session.close()]);
      await session.close();
    });

    check("a prompt sent after close is refused", LIMIT, async (world) => {
      const session = await world.backend.start(startOptions(world), new Requests());
      await session.close();
      await assert.rejects(session.send(prompt()));
    });

    // A turn.

    check(
      "a text arrives once, as deltas or whole, and the turn ends as an event",
      LIMIT,
      async (world, t) => {
        world.say("Hello there, friend.");
        const { session, events } = await open(t, world);
        const sent = prompt("Say hello");
        await session.send(sent);
        const turn = await events.turn();
        assert.equal(written(turn).trim(), "Hello there, friend.");
        assertWellFormed(turn);
        assertDeclared(turn, caps);
        const end = ended(turn);
        assert.equal(end.startedBy, "owner");
        assert.equal(end.ending, "done");
        assert.ok(end.steps === null || end.steps >= 1, "a turn that wrote a text did something");
        assert.ok(end.finalText === null || end.finalText.trim() === "Hello there, friend.");
        assert.ok(end.sessionId === null || end.sessionId !== "");
        await session.close();
        await events.finished;
        assert.deepEqual(
          events.seen.slice(turn.length),
          [],
          "nothing follows the end of the turn but the close",
        );
      },
    );

    check("turns follow one another, each with its own end", LIMIT, async (world, t) => {
      world.say("One.");
      world.say("Two.");
      const { session, events } = await open(t, world);
      await session.send(prompt("first"));
      assert.equal(written(await events.turn()).trim(), "One.");
      await session.send(prompt("second"));
      assert.equal(written(await events.turn()).trim(), "Two.");
    });

    check("send resolves while the turn is still running", LIMIT, async (world, t) => {
      world.callTool("allow", "Finished.");
      let release: (answer: PermissionAnswer) => void = () => undefined;
      let notify: (request: PermissionRequest) => void = () => undefined;
      const asked = new Promise<PermissionRequest>((resolve) => {
        notify = resolve;
      });
      const requests = new Requests({
        permission: (request) => {
          notify(request);
          return new Promise<PermissionAnswer>((resolve) => {
            release = resolve;
          });
        },
      });
      const { session, events } = await open(t, world, requests);
      await session.send(prompt());
      await asked;
      assert.equal(events.turnPending, false, "the turn waits for the answer");
      release({ allow: true });
      assertWellFormed(await events.turn());
    });

    check(
      "a prompt taken is named by its id, before the turn's words",
      lacks(caps.promptDuringTurn, "promptDuringTurn"),
      async (world, t) => {
        world.say("Taken.");
        const { session, events } = await open(t, world);
        const sent = prompt("Say it");
        await session.send(sent);
        const turn = await events.turn();
        const types = turn.map((event) => event.type);
        const taken = turn.find((event) => event.type === "prompt_taken");
        assert.deepEqual(taken, { type: "prompt_taken", promptId: sent.id });
        const message = types.indexOf("message_started");
        assert.ok(message === -1 || types.indexOf("prompt_taken") < message);
      },
    );

    // Requests.

    check(
      "a permission request resolves once and an allowed call ends",
      LIMIT,
      async (world, t) => {
        const played = world.callTool("allow", "Ran it.");
        const requests = new Requests();
        const { session, events } = await open(t, world, requests);
        await session.send(prompt());
        const turn = await events.turn();
        assert.equal(requests.permissions.length, 1, "the owner is asked once");
        assert.equal(requests.signals.length, 1, "the request came with a signal");
        assert.equal(requests.signals[0]?.aborted, false, "an answered request is not given up");
        const [request] = requests.permissions;
        assert.ok(request !== undefined);
        assert.equal(request.toolName, played.toolName);
        assert.deepEqual(request.input, played.input);
        const started = turn.find((event) => event.type === "call_started");
        assert.ok(started?.type === "call_started");
        assert.equal(started.toolName, played.toolName);
        assert.deepEqual(started.input, played.input);
        assert.ok(request.callId === null || request.callId === started.callId);
        const finished = turn.find((event) => event.type === "call_ended");
        assert.ok(finished?.type === "call_ended" && finished.callId === started.callId);
        assert.equal(finished.isError, false);
        assert.equal(written(turn).trim(), "Ran it.");
        assert.equal(ended(turn).ending, "done");
        const [told, ...rest] = world.told();
        assert.deepEqual(rest, []);
        assert.equal(told?.allow, true);
        assert.deepEqual(told?.input, played.input);
        assertWellFormed(turn);
        assertDeclared(turn, caps);
      },
    );

    check(
      "a request the agent gives up aborts the signal it passed, and the turn goes on to its end",
      LIMIT,
      async (world, t) => {
        const played = world.giveUpTool("Went on.");
        const requests = new Requests({
          permission: (_request, signal) =>
            new Promise((resolve) => {
              const refuse = () => resolve({ allow: false, message: "The agent gave it up." });
              if (signal.aborted) refuse();
              else signal.addEventListener("abort", refuse, { once: true });
            }),
        });
        const { session, events } = await open(t, world, requests);
        await session.send(prompt());
        const turn = await events.turn();
        assert.equal(requests.permissions.length, 1);
        assert.equal(requests.permissions[0]?.toolName, played.toolName);
        assert.equal(requests.signals[0]?.aborted, true, "the signal was aborted");
        assert.equal(ended(turn).ending, "done");
        assert.equal(written(turn).trim(), "Went on.");
        assertWellFormed(turn);
      },
    );

    check("a denial stops the call and the agent is told why", LIMIT, async (world, t) => {
      const played = world.callTool("deny", "Stopped.");
      const requests = new Requests({
        permission: async () => ({ allow: false, message: "No: the owner refused." }),
      });
      const { session, events } = await open(t, world, requests);
      await session.send(prompt());
      const turn = await events.turn();
      assert.equal(requests.permissions.length, 1);
      assert.equal(requests.permissions[0]?.toolName, played.toolName);
      assert.deepEqual(world.told(), [
        { allow: false, message: "No: the owner refused.", input: null },
      ]);
      const finished = turn.filter((event) => event.type === "call_ended");
      assert.ok(
        finished.every((event) => event.type === "call_ended" && event.isError),
        "a denied call never ends as a success",
      );
      assert.equal(ended(turn).ending, "done");
      assertWellFormed(turn);
    });

    check(
      "a question reaches the owner with its options, and the answers go back",
      lacks(caps.questions, "questions"),
      async (world, t) => {
        const played = world.askQuestion();
        const answers = Object.fromEntries(
          played.map((asked) => [
            asked.text,
            asked.multiSelect ? [asked.options[0] ?? ""] : (asked.options[0] ?? ""),
          ]),
        );
        const requests = new Requests({ question: async () => ({ answered: true, answers }) });
        const { session, events } = await open(t, world, requests);
        await session.send(prompt());
        const turn = await events.turn();
        assert.equal(requests.questions.length, 1);
        const [request] = requests.questions;
        assert.ok(request !== undefined && request.toolName !== "");
        assert.deepEqual(
          request.questions.map((asked) => ({
            text: asked.text,
            options: asked.options.map((option) => option.label),
            multiSelect: asked.multiSelect,
          })),
          played,
        );
        const started = turn.find((event) => event.type === "call_started");
        assert.ok(
          request.callId === null ||
            (started?.type === "call_started" && started.callId === request.callId),
        );
        const [told, ...rest] = world.told();
        assert.deepEqual(rest, []);
        assert.equal(told?.allow, true);
        assert.deepEqual(told?.input?.answers, answers);
        assert.equal(ended(turn).ending, "done");
        assertWellFormed(turn);
      },
    );

    check(
      "a question the owner skips is not answered, and the agent is told",
      lacks(caps.questions, "questions"),
      async (world, t) => {
        world.askQuestion();
        const requests = new Requests({
          question: async () => ({ answered: false, message: "The owner skipped it." }),
        });
        const { session, events } = await open(t, world, requests);
        await session.send(prompt());
        assert.equal(ended(await events.turn()).ending, "done");
        assert.deepEqual(world.told(), [
          { allow: false, message: "The owner skipped it.", input: null },
        ]);
      },
    );

    check(
      "a command's output arrives whole, once, and uses no model",
      lacks(caps.commands, "commands"),
      async (world, t) => {
        const { prompt: text, includes } = world.command();
        const { session, events } = await open(t, world);
        const listed = (await session.info()).commands;
        const word = text.slice(1).split(/\s/)[0] ?? "";
        assert.ok(
          text.startsWith("/") &&
            listed.some((entry) => entry.name === word || entry.aliases.includes(word)),
          "the prompt runs a command that info lists",
        );
        await session.send(prompt(text));
        const turn = await events.turn();
        assert.equal(written(turn).split(includes).length - 1, 1, "the output arrives once");
        const end = ended(turn);
        assert.equal(end.ending, "done");
        assert.deepEqual(end.tokens, {}, "a command the agent runs itself uses no model");
        // The seam calls a turn with no text 0 steps; a command writes one and still goes to no model.
        assert.ok(
          end.steps === null || end.steps === 0,
          "a command turn is not a step of the model",
        );
        assertWellFormed(turn);
        assertDeclared(turn, caps);
      },
    );

    check(
      "a request that fails ends the turn as an error with the agent's words",
      LIMIT,
      async (world, t) => {
        const includes = world.failTurn();
        const { session, events } = await open(t, world);
        await session.send(prompt());
        const turn = await events.turn();
        const errors = turn.filter((event) => event.type === "agent_error");
        assert.equal(errors.length, 1);
        const [error] = errors;
        assert.ok(error?.type === "agent_error" && error.category !== "");
        assert.ok(error.text.includes(includes));
        assert.equal(ended(turn).ending, "error");
        assertWellFormed(turn);
      },
    );

    // Interrupt and loss.

    check(
      "interrupt ends the turn as interrupted, and the session goes on",
      LIMIT,
      async (world, t) => {
        world.hangTurn("Working on it.");
        world.say("Back again.");
        const { session, events } = await open(t, world);
        await session.send(prompt());
        await events.through(
          (event) => event.type === "text_delta" || event.type === "text",
          "a text",
        );
        await session.interrupt();
        const turn = await events.turn();
        assert.equal(ended(turn).ending, "interrupted");
        assertDeclared(turn, caps);
        await session.send(prompt("again"));
        const next = await events.turn();
        assert.equal(written(next).trim(), "Back again.");
        assert.equal(ended(next).ending, "done");
      },
    );

    check(
      "an interrupt with no turn running resolves and ends nothing",
      LIMIT,
      async (world, t) => {
        const { session, events } = await open(t, world);
        await session.interrupt();
        await session.close();
        await events.finished;
        assert.equal(
          events.seen.some((event) => event.type === "turn_ended"),
          false,
        );
      },
    );

    check(
      "closing in the middle of a turn ends the events with no process lost",
      LIMIT,
      async (world, t) => {
        world.hangTurn("Still going.");
        const { session, events } = await open(t, world);
        await session.send(prompt());
        await events.through(
          (event) => event.type === "text_delta" || event.type === "text",
          "a text",
        );
        await session.close();
        await events.finished;
        assert.equal(
          events.seen.some((event) => event.type === "process_lost"),
          false,
        );
        assert.equal(world.running(), 0);
      },
    );

    check("a lost process gives process_lost as the last event, once", LIMIT, async (world, t) => {
      world.hangTurn("About to fall.");
      const { session, events } = await open(t, world);
      await session.send(prompt());
      await events.through(
        (event) => event.type === "text_delta" || event.type === "text",
        "a text",
      );
      world.die();
      await events.finished;
      const last = events.seen.at(-1);
      assert.ok(last?.type === "process_lost" && last.reason !== "");
      assert.equal(events.seen.filter((event) => event.type === "process_lost").length, 1);
      assert.equal(
        events.seen.some((event) => event.type === "turn_ended"),
        false,
      );
      await assert.rejects(session.send(prompt()), "a prompt sent after the loss is refused");
      await session.close();
      await session.close();
      assert.equal(world.running(), 0);
    });

    // Starts that fail.

    check(
      "a resume the agent refuses rejects with ResumeRefused and leaves no process",
      LIMIT,
      async (world) => {
        world.refuseResume();
        await assert.rejects(
          world.backend.start(startOptions(world, { resume: "no-such-session" }), new Requests()),
          ResumeRefused,
        );
        assert.equal(world.running(), 0);
      },
    );

    check(
      "any other failure of a start rejects with itself and leaves no process",
      LIMIT,
      async (world) => {
        const failure = new Error("the agent could not start");
        world.failStart(failure);
        await assert.rejects(
          world.backend.start(startOptions(world), new Requests()),
          (error) => error === failure,
        );
        assert.equal(world.running(), 0);
        const session = await world.backend.start(startOptions(world), new Requests());
        await session.close();
      },
    );

    // What a live session changes.

    check(
      "an effort level the back end declares is taken at the start",
      LIMIT,
      async (world, t) => {
        const level = caps.effortLevels[0] ?? "";
        await open(t, world, new Requests(), { effort: level });
      },
    );

    check(
      "setEffort takes a declared level or null, and refuses another",
      lacks(caps.liveEffort, "liveEffort"),
      async (world, t) => {
        const { session } = await open(t, world);
        await session.setEffort(caps.effortLevels[0] ?? "");
        await session.setEffort(null);
        await assert.rejects(session.setEffort("no-such-level"));
      },
    );

    check(
      "setEffort without liveEffort rejects (seam silent)",
      { ...LIMIT, skip: caps.liveEffort ? `${name} declares liveEffort` : false },
      async (world, t) => {
        const { session } = await open(t, world);
        await assert.rejects(session.setEffort(caps.effortLevels[0] ?? ""));
      },
    );

    check(
      "a permission mode the back end names is taken, another is refused",
      LIMIT,
      async (world, t) => {
        const { session } = await open(t, world);
        for (const mode of Object.values(caps.permissionModes)) {
          if (mode !== null) await session.setPermissionMode(mode);
        }
        await assert.rejects(session.setPermissionMode("no-such-mode"));
      },
    );

    check(
      "setModel takes a listed model or null",
      lacks(caps.models, "models"),
      async (world, t) => {
        const { session } = await open(t, world);
        const [first] = (await session.info()).models;
        assert.ok(first !== undefined);
        await session.setModel(first.value);
        await session.setModel(null);
      },
    );

    check(
      "setModel without models takes null and rejects a name (seam silent)",
      { ...LIMIT, skip: caps.models ? `${name} declares models` : false },
      async (world, t) => {
        const { session } = await open(t, world);
        await session.setModel(null);
        await assert.rejects(session.setModel("some-model"));
      },
    );

    // Sessions on disk.

    check(
      "an id that session_started names can be resumed at once",
      {
        ...LIMIT,
        skip: harness.refusesUnrecordedResume
          ? false
          : `${name}'s world accepts any resume, so it cannot refuse a named id`,
      },
      async (world, t) => {
        // The core stores the id as the event arrives, and a setup's Start may then start a
        // fresh client that resumes it before any prompt was sent. An agent that names its
        // session at start, or with the first prompt, must hold a record by then.
        world.say("Named.");
        const first = await open(t, world);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!first.events.seen.some((event) => event.type === "session_started")) {
          await first.session.send(prompt("name it"));
        }
        const named = await first.events.through(
          (event) => event.type === "session_started",
          "the session was named",
        );
        const id = sessionIdOf(named);
        await first.session.close();
        try {
          const again = await world.backend.start(
            startOptions(world, { resume: id }),
            new Requests(),
          );
          await again.close();
        } catch (error) {
          if (error instanceof ResumeRefused) {
            assert.fail(`session_started named ${id}, which a start refuses to resume`);
          }
          throw error;
        }
      },
    );

    check("a session that ran can be resumed after a restart", LIMIT, async (world, t) => {
      world.say("First.");
      const first = await open(t, world);
      await first.session.send(prompt("start it"));
      const id = sessionIdOf(await first.events.turn());
      await first.session.close();
      await world.persist(world.folder, id, Date.now());
      world.restart();
      world.say("Second.");
      const again = await open(t, world, new Requests(), { resume: id });
      await again.session.send(prompt("go on"));
      assert.equal(written(await again.events.turn()).trim(), "Second.");
    });

    check(
      "listSessions lists the sessions of a folder, newest first, and no other",
      lacks(caps.sessionListing, "sessionListing"),
      async (world, t) => {
        const ids: string[] = [];
        for (const [word, at] of [
          ["Older.", Date.UTC(2026, 9, 1, 10)],
          ["Newer.", Date.UTC(2026, 9, 2, 10)],
        ] as const) {
          world.say(word);
          const { session, events } = await open(t, world);
          await session.send(prompt(`say ${word}`));
          const id = sessionIdOf(await events.turn());
          await session.close();
          await world.persist(world.folder, id, at);
          ids.push(id);
        }
        assert.notEqual(ids[0], ids[1]);
        world.restart();
        const listed = await world.backend.listSessions(world.folder);
        assert.deepEqual(
          listed.map((session) => session.id),
          [ids[1], ids[0]],
        );
        for (const session of listed) {
          assert.ok(session.title !== "" && Number.isFinite(session.lastModified));
        }
        assert.deepEqual(await world.backend.listSessions(world.otherFolder), []);
        const alive = await world.backend.aliveSessions(world.folder);
        assert.ok(alive !== null && ids.every((id) => alive.has(id)));
        const dated: ListedSession[] = await world.backend.datedSessions(world.folder, listed);
        assert.deepEqual(
          dated.map((session) => session.id),
          [ids[1], ids[0]],
        );
      },
    );

    // Trust.

    check(
      "a folder is trusted as the agent's record says",
      {
        ...LIMIT,
        skip: caps.folderTrust ? GIT_LAYOUT.skip : `${name} does not declare folderTrust`,
      },
      async (world) => {
        assert.ok(world.trust, "the harness records trust");
        await world.trust(world.folder);
        assert.equal(await world.backend.folderTrusted(world.folder), true);
        assert.equal(await world.backend.folderTrusted(world.otherFolder), false);
        assert.equal(await world.backend.trustedRepository(world.folder), null);
      },
    );
  });
}
