/**
 * The conformance suite of the chat seam: `chatConformance` registers `node:test` tests that hold
 * any provider to what `src/chat/seam.ts` promises, member by member. A provider is reached
 * through a small adapter (`ChatRig`): it builds the provider, plays the owner and somebody else
 * in the chat, and reads back what a thread and a channel show as plain facts (a message with
 * this text, a control that can still be pressed). Nothing here knows a chat library.
 *
 * Words the checks write are plain (no mark any chat reads as markup), since what a provider
 * shows is read back as text.
 *
 * A check that only makes sense with a capability is skipped by name for a provider without it.
 * A check a provider does not pass yet is `todo` with the reason given in the options, so that
 * removing the option is the only edit to make once it does.
 */
import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import type { PromptContent, Question } from "../../src/agent/seam.ts";
import {
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type FooterFields,
  type InboundMessage,
  type ListPick,
  type MessageId,
  type OwnerAnswer,
  type OwnerList,
  type OwnerRequest,
  type TaskUpdate,
  type ThreadRef,
} from "../../src/chat/seam.ts";

// ---- the adapter

/** Where a read looks: a thread, or with no `thread` the channel's main view. */
export interface Scope {
  readonly channel: string;
  readonly thread?: string;
}

/** One message of a chat as it shows now. */
export interface Shown {
  /** Null for a line the chat does not keep as a message (one only the owner sees). */
  readonly id: MessageId | null;
  /** All the words it shows, a task line's and a footer's among them. */
  readonly text: string;
  /** It has a control that can still be pressed. */
  readonly pressable: boolean;
  /** Only the owner sees it. */
  readonly ownerOnly: boolean;
}

/** A message a person wrote. */
export interface Said {
  readonly id: MessageId;
  readonly ref: ThreadRef;
}

/** A request the daemon put to the owner, as `ThreadChat.ask` showed it. */
export interface Asked {
  readonly ref: ThreadRef;
  readonly requestId: string;
  readonly request: OwnerRequest;
  readonly message: MessageId;
}

/** A list the daemon offered, as `ChannelChat.offer` showed it. */
export interface Listed {
  readonly channel: string;
  readonly list: OwnerList;
  readonly message: MessageId;
}

/**
 * Somebody in the chat. What a person does reaches the provider the way it would in the chat:
 * the provider alone decides whether it reaches the daemon.
 */
export interface Person {
  says(channel: string, text: string, options?: { readonly thread?: string }): Promise<Said>;
  /** Uses the control of the request that gives `answer`: a click, or a form's submission. */
  answers(asked: Asked, answer: OwnerAnswer): Promise<void>;
  /** Uses the control of the row `row` (a folder's path, a session's id) of a list. */
  picks(listed: Listed, row: string): Promise<void>;
}

/** A provider under test, not started, with the chat around it. */
export interface ChatRig {
  readonly provider: ChatProvider;
  /** A channel the chat has. */
  readonly channel: string;
  /** A thread of it that was there before the provider started. */
  readonly thread: ThreadRef;
  readonly owner: Person;
  readonly other: Person;
  /**
   * The chat can show a line to the owner alone. Where it can not, a line asked for the owner
   * is a message of the thread.
   */
  readonly ownerOnlyNotices: boolean;
  /** What `scope` shows now, in the order the messages were written. */
  read(scope: Scope): readonly Shown[];
  /** Lets the provider write what it holds back (a chat that streams writes a text after a pause). */
  settle(): Promise<void>;
  /** From now on the chat refuses what is written in it. */
  refuseWrites(): void;
  /** `channel` is no longer there for the chat. */
  removeChannel(channel: string): void;
  /** `thread` is no longer there for the chat: its first message is gone. */
  removeThread(thread: ThreadRef): void;
  /** From now on the chat can not say whether a channel or a thread is there. */
  failLookups(): void;
}

export type MakeRig = (t: TestContext) => Promise<ChatRig>;

export interface ChatConformanceOptions {
  /**
   * The reasons a family of checks is `todo`. The checks run and may fail without failing the
   * run; a check that passes while its `todo` stands is reported as passing.
   */
  readonly todo?: {
    /** The owner check and every check of what reaches `ChatInbound`. */
    readonly inbound?: string;
  };
}

// ---- what the checks write

const OWN_WORDS = "please build the module";
const FOLDER = "/work/notes";

function permission(): OwnerRequest {
  return {
    type: "permission",
    callId: "call-1",
    toolName: "Bash",
    input: { command: "ls" },
    title: "Run the listing",
    description: null,
  };
}

const QUESTION: Question = {
  header: "Colour",
  text: "Which colour",
  multiSelect: false,
  options: [
    { label: "red", description: null, preview: null },
    { label: "blue", description: null, preview: null },
  ],
};

function question(): OwnerRequest {
  return {
    type: "question",
    callId: "call-2",
    toolName: "AskUserQuestion",
    title: null,
    questions: [QUESTION],
  };
}

function hold(requestId: string, channel: string): OwnerRequest {
  return {
    type: "hold",
    requestId,
    other: { channel, thread: "elsewhere" },
    link: "the other thread",
  };
}

function setup(requestId: string): OwnerRequest {
  return {
    type: "setup",
    requestId,
    models: [
      {
        value: "model-a",
        displayName: "Model A",
        description: null,
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ],
    efforts: [],
    bypassOffered: true,
    selection: { model: "model-a", effort: "low", bypass: false },
  };
}

/** A request of each type, and the answer its control gives. */
const REQUESTS: ReadonlyArray<{
  readonly name: string;
  /** A click, or a form the owner fills. */
  readonly control: "click" | "form";
  readonly request: (requestId: string, channel: string) => OwnerRequest;
  readonly answer: OwnerAnswer;
}> = [
  {
    name: "permission",
    control: "click",
    request: permission,
    answer: { type: "permission", allow: true },
  },
  {
    name: "question",
    control: "form",
    request: question,
    answer: { type: "question", answers: { [QUESTION.text]: "red" } },
  },
  { name: "hold", control: "click", request: hold, answer: { type: "hold", send: true } },
  {
    name: "setup",
    control: "form",
    request: setup,
    answer: {
      type: "setup",
      selection: { model: "model-a", effort: "high", bypass: true },
    },
  },
];

const FOOTER: FooterFields = {
  bypass: false,
  model: "model-a",
  effort: null,
  folder: FOLDER,
  branch: null,
  changes: null,
  sessionTokens: null,
  contextPercent: null,
  sessionLimit: null,
  weekLimit: null,
};

function line(id: string, title: string, status: TaskUpdate["status"]): TaskUpdate {
  return {
    id,
    title,
    status,
    details: null,
    output: null,
    name: "Read",
    task: false,
    calls: 0,
    preview: null,
    folded: null,
  };
}

const FOLDERS: OwnerList = {
  type: "folders",
  root: "/work",
  folders: ["/work/notes", "/work/tools"],
  bound: null,
};

function sessions(thread: ThreadRef): OwnerList {
  return {
    type: "sessions",
    folder: FOLDER,
    sessions: [
      {
        id: "session-1",
        title: "an earlier session",
        customTitle: null,
        branch: null,
        size: null,
        lastModified: 1_780_000_000_000,
      },
    ],
    held: 0,
    thread,
  };
}

// ---- the inbound the checks record

class Recorder implements ChatInbound {
  readonly messages: InboundMessage[] = [];
  readonly answers: Array<{
    readonly ref: ThreadRef;
    readonly requestId: string;
    readonly answer: OwnerAnswer;
    readonly message: MessageId | null;
  }> = [];
  readonly picks: ListPick[] = [];
  readonly unboundChannels: string[] = [];

  async message(message: InboundMessage): Promise<void> {
    this.messages.push(message);
  }

  async answer(
    ref: ThreadRef,
    requestId: string,
    answer: OwnerAnswer,
    message: MessageId | null,
  ): Promise<boolean> {
    this.answers.push({ ref, requestId, answer, message });
    return true;
  }

  async picked(pick: ListPick): Promise<void> {
    this.picks.push(pick);
  }

  async unbound(channel: string): Promise<void> {
    this.unboundChannels.push(channel);
  }

  get empty(): boolean {
    return (
      this.messages.length +
        this.answers.length +
        this.picks.length +
        this.unboundChannels.length ===
      0
    );
  }
}

/** The words of a prompt. */
function promptText(content: PromptContent | null): string {
  assert.ok(content !== null, "the prompt was taken");
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

// ---- the suite

/** A provider started over a recorder, stopped once at the end of the test. */
interface Started {
  readonly rig: ChatRig;
  readonly provider: ChatProvider;
  readonly inbound: Recorder;
  /** The thread the checks write in. */
  readonly ref: ThreadRef;
  /** Stops the provider, once. */
  stop(): Promise<void>;
  /** Closes the provider, once. */
  close(): Promise<void>;
}

/** Builds a rig and starts its provider over a recorder; both ends are done once at the test's end. */
async function start(t: TestContext, make: MakeRig, running = true): Promise<Started> {
  const rig = await make(t);
  const inbound = new Recorder();
  let live = false;
  let closed = false;
  const stop = async (): Promise<void> => {
    if (!live) return;
    live = false;
    await rig.provider.stop();
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await rig.provider.close();
  };
  if (running) {
    await rig.provider.start(inbound);
    live = true;
  }
  t.after(async () => {
    await stop();
    await close();
  });
  return { rig, provider: rig.provider, inbound, ref: rig.thread, stop, close };
}

/** The checks of `name`'s provider, made by `make`, as one `describe`. */
export function chatConformance(
  name: string,
  make: MakeRig,
  options: ChatConformanceOptions = {},
): void {
  const todo = options.todo ?? {};

  /** A check that runs against a started provider. */
  const check = (
    title: string,
    body: (started: Started, t: TestContext) => Promise<void>,
    marks: { readonly todo?: string | undefined } = {},
  ): void => {
    test(title, { todo: marks.todo }, async (t) => {
      await body(await start(t, make), t);
    });
  };

  /** A check that needs the capability `needed` and is skipped by name without it. */
  const gated = (
    title: string,
    needed: keyof ChatProvider["capabilities"],
    body: (started: Started, t: TestContext) => Promise<void>,
  ): void => {
    test(title, async (t) => {
      const started = await start(t, make);
      if (!started.provider.capabilities[needed]) {
        t.skip(`${name} lacks the capability ${needed}`);
        return;
      }
      await body(started, t);
    });
  };

  const inbound = (title: string, body: Parameters<typeof check>[1]): void =>
    check(title, body, { todo: todo.inbound });

  describe(`the chat seam: ${name}`, () => {
    describe("the provider", () => {
      check("names itself and declares its capabilities", async ({ provider }) => {
        assert.equal(typeof provider.name, "string");
        assert.notEqual(provider.name, "");
        const flags = Object.entries(provider.capabilities);
        assert.deepEqual(flags.map(([flag]) => flag).sort(), [
          "activityLine",
          "fileUpload",
          "nativeStreaming",
          "reactions",
        ]);
        for (const [flag, value] of flags) assert.equal(typeof value, "boolean", flag);
      });

      check("has openFile exactly when it declares fileUpload", async ({ provider }) => {
        assert.equal(typeof provider.openFile === "function", provider.capabilities.fileUpload);
      });

      check("leaves a plain word alone when it escapes it", async ({ provider }) => {
        assert.equal(provider.escape("plainword", "notice"), "plainword");
        assert.equal(provider.escape("plainword", "reference"), "plainword");
      });

      check("writes a channel for each markup, never empty and never rejecting", async (s) => {
        for (const markup of ["notice", "reference"] as const) {
          const written = s.provider.channelName(s.ref.channel, markup);
          assert.equal(typeof written, "string");
          assert.ok(written.trim() !== "", markup);
        }
      });

      check("dates a thread by a number or by nothing, and by the same on every ask", async (s) => {
        const first = s.provider.openedAt(s.ref);
        assert.ok(first === null || (typeof first === "number" && Number.isFinite(first)));
        assert.equal(s.provider.openedAt(s.ref), first);
        assert.equal(s.provider.openedAt({ channel: s.ref.channel, thread: "never-opened" }), null);
      });

      check("says a channel it has is there", async ({ rig, provider }) => {
        assert.equal(await provider.channelState(rig.channel), "there");
      });

      check("says a channel that went is gone", async ({ rig, provider }) => {
        rig.removeChannel(rig.channel);
        assert.equal(await provider.channelState(rig.channel), "gone");
      });

      check(
        "says `no answer`, or rejects with a named ChatError, when it can not say",
        async ({ rig, provider }) => {
          rig.failLookups();
          const answer = await provider.channelState(rig.channel).catch((error: unknown) => error);
          if (answer instanceof ChatError) assert.notEqual(answer.name, "");
          else assert.equal(answer, "no answer");
        },
      );
    });

    describe("a thread: whether the chat still has it", () => {
      check("says a thread it has is there", async ({ provider, ref }) => {
        assert.equal(await provider.threadState(ref), "there");
      });

      check("says a thread whose first message went is gone", async ({ rig, provider, ref }) => {
        rig.removeThread(ref);
        assert.equal(await provider.threadState(ref), "gone");
      });

      check(
        "says `no answer`, or rejects with a named ChatError, when it can not say",
        async ({ rig, provider, ref }) => {
          rig.failLookups();
          const answer = await provider.threadState(ref).catch((error: unknown) => error);
          if (answer instanceof ChatError) assert.notEqual(answer.name, "");
          else assert.equal(answer, "no answer");
        },
      );
    });

    describe("a thread: what the daemon writes", () => {
      check("tell writes a line the owner reads", async ({ rig, provider, ref }) => {
        const thread = provider.thread(ref);
        await thread.tell("That word needs a folder");
        const shown = rig.read(ref).filter((m) => m.text.includes("That word needs a folder"));
        assert.equal(shown.length, 1);
        assert.equal(
          shown[0]?.ownerOnly,
          rig.ownerOnlyNotices,
          "only the owner sees it where the chat can, and it is a message of the thread where it can not",
        );
        await thread.tell("This one stays", { stays: true });
        const stays = rig.read(ref).filter((m) => m.text.includes("This one stays"));
        assert.equal(stays.length, 1);
        assert.equal(stays[0]?.ownerOnly, false, "a line that stays is a message of the thread");
      });

      check(
        "tell and the other members that never reject do not",
        async ({ rig, provider, ref }) => {
          rig.refuseWrites();
          const thread = provider.thread(ref);
          await thread.tell("Nobody is told");
          await thread.tell("Nobody is told", { stays: true });
          await thread.notice("Nobody is told");
          await thread.acknowledge("no-such-message");
          await thread.link("the thread", "notice");
          await thread.endReply("no-such-message", "stopped");
        },
      );

      check("notice writes a message of the thread", async ({ rig, provider, ref }) => {
        await provider.thread(ref).notice("Resumed after a restart");
        const shown = rig.read(ref).filter((m) => m.text.includes("Resumed after a restart"));
        assert.equal(shown.length, 1);
        assert.equal(shown[0]?.ownerOnly, false);
      });

      check("say writes a reference at full size", async ({ rig, provider, ref }) => {
        const thread = provider.thread(ref);
        await thread.say("Status of the session is idle");
        await thread.say("Status for the owner is idle", { ownerOnly: true });
        const open = rig.read(ref).filter((m) => m.text.includes("Status of the session"));
        assert.equal(open.length, 1);
        assert.equal(open[0]?.ownerOnly, false);
        const owned = rig.read(ref).filter((m) => m.text.includes("Status for the owner"));
        assert.equal(owned.length, 1);
        assert.equal(owned[0]?.ownerOnly, rig.ownerOnlyNotices);
      });

      check(
        "say rejects with ChatError when it could not write",
        async ({ rig, provider, ref }) => {
          rig.refuseWrites();
          await assert.rejects(provider.thread(ref).say("Nobody reads this"), ChatError);
        },
      );

      check("link is a string or nothing", async ({ provider, ref }) => {
        const thread = provider.thread(ref);
        for (const markup of ["notice", "reference"] as const) {
          const link = await thread.link("the session", markup);
          assert.ok(link === null || (typeof link === "string" && link !== ""));
        }
      });

      check("close ends the session's part of the chat", async ({ provider, ref }) => {
        await provider.thread(ref).close();
      });
    });

    describe("a request: ask, withdraw, and what is left of an answered one", () => {
      for (const { name: type, request } of REQUESTS) {
        check(`ask shows a ${type} request with a control, and withdraw removes it`, async (s) => {
          const thread = s.provider.thread(s.ref);
          const id = await thread.ask(
            `request-${type}`,
            request(`request-${type}`, s.ref.channel),
            `A ${type} request`,
          );
          assert.equal(typeof id, "string");
          assert.notEqual(id, "");
          const shown = s.rig.read(s.ref).find((m) => m.id === id);
          assert.ok(shown, "the request is shown in the thread");
          assert.ok(shown.pressable, "and has a control to press");
          assert.equal(await thread.withdraw(id), true);
          assert.equal(
            s.rig.read(s.ref).some((m) => m.id === id),
            false,
            "the request is no longer shown",
          );
          assert.equal(await thread.withdraw(id), true); // one already gone counts as removed
        });
      }

      check("ask rejects with ChatError when it could not show the request", async (s) => {
        s.rig.refuseWrites();
        await assert.rejects(
          s.provider.thread(s.ref).ask("request-refused", permission(), "A request"),
          ChatError,
        );
      });

      check("keepAnswers leaves the record of the answers and nothing to press", async (s) => {
        const thread = s.provider.thread(s.ref);
        const id = await thread.ask("request-answered", question(), "A question");
        await thread.keepAnswers(id, [QUESTION], { [QUESTION.text]: "blue" });
        const shown = s.rig.read(s.ref).find((m) => m.id === id);
        assert.ok(shown, "the record stays in the thread");
        assert.equal(shown.pressable, false);
        assert.match(shown.text, /blue/);
      });

      check("rewrite turns a message into a notice with nothing to press", async (s) => {
        const thread = s.provider.thread(s.ref);
        const id = await thread.ask("request-setup", setup("request-setup"), "A setup");
        await thread.rewrite(id, "Started with model-a");
        const shown = s.rig.read(s.ref).find((m) => m.id === id);
        assert.ok(shown, "the notice stays in the thread");
        assert.equal(shown.pressable, false);
        assert.match(shown.text, /Started with model-a/);
      });
    });

    describe("a reply", () => {
      check("writes nothing until it is given something to show", async (s) => {
        const before = s.rig.read(s.ref).length;
        const reply = s.provider.thread(s.ref).openReply(() => {});
        await reply.settle();
        assert.equal(s.rig.read(s.ref).length, before);
        assert.equal(reply.footerShown, false);
      });

      check("carries text, a task line and a footer to its end", async (s) => {
        const opened: Array<[MessageId | null, MessageId | null]> = [];
        const reply = s.provider.thread(s.ref).openReply((old, fresh) => opened.push([old, fresh]));
        await reply.text("The build is finished\n\n");
        await reply.task(line("call-1", "Read notes.txt", "in_progress"));
        await reply.task(line("call-1", "Read notes.txt", "complete"));
        await reply.settle();
        await s.rig.settle();
        assert.ok(
          s.rig.read(s.ref).some((m) => m.text.includes("Read notes.txt")),
          "the task line is shown while the reply runs",
        );
        await reply.finish([], FOOTER);
        assert.equal(reply.footerShown, false, "the footer is not there before the end");
        assert.equal(await reply.closeOut(), true, "the end landed");
        assert.equal(reply.footerShown, true);
        assert.equal(await reply.waitLanded(), true);
        assert.equal(await reply.settle(), true);
        const shown = s.rig.read(s.ref).filter((m) => m.text.includes("The build is finished"));
        assert.equal(shown.length, 1, "the reply is one message");
        assert.match(shown[0]?.text ?? "", /model-a/, "and carries the footer");
        assert.equal(opened.length, 2, "told of the message a crash would leave unfinished");
        const [added, dropped] = opened;
        assert.equal(added?.[0], null);
        assert.equal(typeof added?.[1], "string");
        assert.equal(dropped?.[0], added?.[1]);
        assert.equal(dropped?.[1], null);
      });

      check("a reply at rest shows the footer before it ends", async (s) => {
        const reply = s.provider.thread(s.ref).openReply(() => {});
        await reply.text("Started a command");
        await reply.finish([], FOOTER);
        reply.rest();
        await reply.settle();
        await s.rig.settle();
        const shown = () => s.rig.read(s.ref).filter((m) => m.text.includes("Started a command"));
        assert.equal(shown().length, 1);
        assert.match(shown()[0]?.text ?? "", /model-a/, "the footer shows under the waiting reply");
        assert.equal(reply.footerShown, false, "and the reply has not ended");
        await reply.text("\n\nThe command ended");
        await reply.finish([], FOOTER);
        await reply.settle();
        await s.rig.settle();
        assert.match(shown()[0]?.text ?? "", /The command ended/, "its report grows it");
        assert.equal(await reply.closeOut(), true);
        assert.equal(reply.footerShown, true);
        // A provider may post the ending as a message of its own: the footer shows once.
        const all = s.rig.read(s.ref).filter((m) => /model-a/.test(m.text));
        assert.equal(all.length, 1, "the thread says the footer once");
      });

      check("closes out with no footer", async (s) => {
        const reply = s.provider.thread(s.ref).openReply(() => {});
        await reply.text("An answer with no footer");
        await reply.finish([], null);
        assert.equal(await reply.closeOut(), true);
        assert.equal(reply.footerShown, true);
      });

      check("shows what still runs after the footer, of the latest reply alone", async (s) => {
        const reply = s.provider.thread(s.ref).openReply(() => {});
        await reply.text("Started a command");
        await reply.finish([], FOOTER);
        await reply.closeOut();
        const showing = () => s.rig.read(s.ref).some((m) => m.text.includes("1 shell"));
        reply.setRunning("1 shell");
        await reply.settle();
        await s.rig.settle();
        assert.equal(showing(), true);
        reply.setLatest(false);
        await reply.settle();
        await s.rig.settle();
        assert.equal(showing(), false, "an older reply keeps its footer and drops the counts");
        reply.setLatest(true);
        reply.setRunning("");
        await reply.settle();
        await s.rig.settle();
        assert.equal(showing(), false);
      });

      check("knows when the owner or another reply wrote below it", async (s) => {
        const first = s.provider.thread(s.ref).openReply(() => {});
        assert.equal(first.last, false, "a reply with no message is not the last");
        assert.equal(first.overtaken, false);
        await first.text("The first answer");
        await first.settle();
        await s.rig.settle();
        assert.equal(first.last, true, "nothing is below it");
        assert.equal(first.overtaken, false);
        await s.rig.owner.says(s.ref.channel, "and one more thing", { thread: s.ref.thread });
        assert.equal(first.last, false, "the owner wrote below it");
        assert.equal(first.overtaken, false, "which is not another reply");
        const second = s.provider.thread(s.ref).openReply(() => {});
        await second.text("The second answer");
        await second.settle();
        await s.rig.settle();
        assert.equal(first.overtaken, true, "another reply has a message below it");
        assert.equal(second.overtaken, false);
        assert.equal(second.last, true, "written after the owner's message: nothing is below it");
      });

      check("an ended reply with the owner below it is not last", async (s) => {
        const reply = s.provider.thread(s.ref).openReply(() => {});
        await reply.text("The answer");
        await reply.finish([], FOOTER);
        assert.equal(await reply.closeOut(), true);
        await reply.settle();
        await s.rig.settle();
        assert.equal(reply.last, true);
        await s.rig.owner.says(s.ref.channel, "thanks", { thread: s.ref.thread });
        assert.equal(reply.last, false, "the owner wrote below it");
        assert.equal(reply.overtaken, false);
      });

      check("a reply with another reply below it ends where it is", async (s) => {
        const first = s.provider.thread(s.ref).openReply(() => {});
        await first.text("The first answer");
        await first.settle();
        const second = s.provider.thread(s.ref).openReply(() => {});
        await second.text("The second answer");
        await second.settle();
        await s.rig.settle();
        assert.equal(first.overtaken, true);
        const messages = s.rig.read(s.ref).length;
        await first.finish([], FOOTER);
        assert.equal(await first.closeOut(), true, "the end landed");
        await s.rig.settle();
        const shown = s.rig.read(s.ref).filter((m) => m.text.includes("The first answer"));
        assert.equal(shown.length, 1);
        assert.match(shown[0]?.text ?? "", /model-a/, "the footer is under it");
        assert.equal(s.rig.read(s.ref).length, messages, "nothing was posted for the end");
      });

      /** Texts of the thread's messages that show the footer. */
      const footers = (s: Started) =>
        s.rig
          .read(s.ref)
          .map((m, index) => ({ index, text: m.text }))
          .filter((m) => m.text.includes("model-a"));
      const where = (s: Started, words: string) =>
        s.rig.read(s.ref).findIndex((m) => m.text.includes(words));

      check("between two owner messages one footer shows, under the last reply", async (s) => {
        const first = s.provider.thread(s.ref).openReply(() => {});
        await first.text("The first answer");
        await first.settle();
        const second = s.provider.thread(s.ref).openReply(() => {});
        await second.text("The second answer");
        await second.settle();
        await first.finish([], FOOTER);
        assert.equal(await first.closeOut(), true);
        await second.finish([], FOOTER);
        assert.equal(await second.closeOut(), true);
        await first.settle();
        await second.settle();
        await s.rig.settle();
        const shown = footers(s);
        assert.equal(shown.length, 1, "one footer in the stretch");
        assert.ok((shown[0]?.index ?? -1) >= where(s, "The second answer"), "under the last reply");
        assert.equal(
          s.rig.read(s.ref)[where(s, "The first answer")]?.text.includes("model-a"),
          false,
          "the reply above shows none",
        );
      });

      check("an owner message keeps the footer above it", async (s) => {
        const first = s.provider.thread(s.ref).openReply(() => {});
        await first.text("The first answer");
        await first.finish([], FOOTER);
        assert.equal(await first.closeOut(), true);
        await first.settle();
        await s.rig.owner.says(s.ref.channel, "and one more thing", { thread: s.ref.thread });
        const second = s.provider.thread(s.ref).openReply(() => {});
        await second.text("The second answer");
        await second.finish([], FOOTER);
        assert.equal(await second.closeOut(), true);
        await second.settle();
        await s.rig.settle();
        assert.equal(footers(s).length, 2, "each stretch keeps its footer");
        assert.ok(
          footers(s).some(
            (m) =>
              m.index >= where(s, "The first answer") && m.index < where(s, "The second answer"),
          ),
          "the footer above the owner's message stays above it",
        );
      });

      check("a reply that ends with no footer of its own takes the one above it", async (s) => {
        const first = s.provider.thread(s.ref).openReply(() => {});
        await first.text("The first answer");
        await first.settle();
        const second = s.provider.thread(s.ref).openReply(() => {});
        await second.text("The second answer");
        await second.settle();
        await first.finish([], FOOTER);
        assert.equal(await first.closeOut(), true);
        await second.finish([], null);
        assert.equal(await second.closeOut(), true);
        await first.settle();
        await second.settle();
        await s.rig.settle();
        const shown = footers(s);
        assert.equal(shown.length, 1, "the footer is shown once");
        assert.ok((shown[0]?.index ?? -1) >= where(s, "The second answer"), "under the last reply");
      });

      check("reports an end that did not land", async (s) => {
        const reply = s.provider.thread(s.ref).openReply(() => {});
        await reply.text("This one is refused");
        await reply.settle();
        s.rig.refuseWrites();
        await reply.finish([], FOOTER);
        assert.equal(await reply.closeOut(), false);
        assert.equal(reply.footerShown, false);
      });

      check("lets endReply end one a stop left unfinished", async (s) => {
        let open: MessageId | null = null;
        const reply = s.provider.thread(s.ref).openReply((_old, fresh) => {
          open = fresh ?? open;
        });
        await reply.text("The turn was running");
        await reply.settle();
        await s.rig.settle();
        assert.ok(open, "told of the message");
        assert.equal(await s.provider.thread(s.ref).endReply(open, "Stopped before the end"), true);
        const shown = s.rig.read(s.ref).filter((m) => m.id === open);
        assert.equal(shown.length, 1);
        assert.match(shown[0]?.text ?? "", /Stopped before the end/);
        await s.provider.thread(s.ref).endReply(open, "Stopped before the end"); // twice is fine
        // One already gone counts as ended.
        assert.equal(await s.provider.thread(s.ref).endReply("no-such-message", "Stopped"), true);
      });

      check("keeps what the reply showed when endReply ends it", async (s) => {
        let open: MessageId | null = null;
        const reply = s.provider.thread(s.ref).openReply((_old, fresh) => {
          open = fresh ?? open;
        });
        await reply.text("The turn was running");
        await reply.settle();
        await s.rig.settle();
        assert.ok(open, "told of the message");
        await s.provider.thread(s.ref).endReply(open, "Stopped before the end");
        const shown = s.rig.read(s.ref).filter((m) => m.id === open);
        assert.match(shown[0]?.text ?? "", /The turn was running/);
      });

      gated("shows a text as it is written", "nativeStreaming", async (s) => {
        const reply = s.provider.thread(s.ref).openReply(() => {});
        await reply.text("Half of the answer");
        await s.rig.settle();
        assert.ok(s.rig.read(s.ref).some((m) => m.text.includes("Half of the answer")));
        await reply.finish([], null);
        await reply.closeOut();
      });
    });

    describe("what a capability adds", () => {
      gated("shows a status and takes it away", "reactions", async ({ provider, ref }) => {
        const thread = provider.thread(ref);
        assert.equal(await thread.showStatus("working"), true);
        assert.equal(await thread.showStatus("done"), true);
        await thread.settleStatus();
        await thread.clearStatus();
      });

      gated("takes an activity line without waiting", "activityLine", async ({ provider, ref }) => {
        const thread = provider.thread(ref);
        assert.equal(typeof thread.activityRefused, "boolean");
        thread.showActivity("Reading the module", "is reading the module");
        thread.showActivity("", "");
      });
    });

    describe("a channel", () => {
      check("notice and say write in the channel, outside any thread", async (s) => {
        const channel = s.provider.channel(s.rig.channel);
        await channel.notice("This folder is bound");
        await channel.say("Folders under the root");
        const texts = s.rig.read({ channel: s.rig.channel }).map((m) => m.text);
        assert.ok(texts.some((text) => text.includes("This folder is bound")));
        assert.ok(texts.some((text) => text.includes("Folders under the root")));
      });

      check("notice and say reject with ChatError when the chat refused", async (s) => {
        s.rig.refuseWrites();
        const channel = s.provider.channel(s.rig.channel);
        await assert.rejects(channel.notice("Nobody reads this"), ChatError);
        await assert.rejects(channel.say("Nobody reads this"), ChatError);
      });

      check("offers a list with a control, withdraws it and rewrites it", async (s) => {
        const channel = s.provider.channel(s.rig.channel);
        await channel.offer(FOLDERS, "Pick a folder to bind");
        const offered = s.rig
          .read({ channel: s.rig.channel })
          .filter((m) => m.text.includes("Pick a folder to bind"));
        assert.equal(offered.length, 1);
        const id = offered[0]?.id;
        assert.ok(id, "the list is a message of the channel");
        assert.ok(offered[0]?.pressable);
        assert.equal(await channel.withdraw(id), true);
        assert.equal(
          s.rig.read({ channel: s.rig.channel }).some((m) => m.id === id),
          false,
        );
        await channel.offer(sessions(s.ref), "Pick a session to resume");
        const again = s.rig
          .read({ channel: s.rig.channel })
          .find((m) => m.text.includes("Pick a session to resume"));
        assert.ok(again?.id && again.pressable);
        await channel.rewrite(again.id, "Resumed an earlier session");
        const done = s.rig.read({ channel: s.rig.channel }).find((m) => m.id === again.id);
        assert.ok(done, "the notice stays in the channel");
        assert.equal(done.pressable, false);
        assert.match(done.text, /Resumed an earlier session/);
      });
    });

    describe("what reaches the daemon", () => {
      inbound("a message of the owner arrives once, whole", async (s) => {
        const said = await s.rig.owner.says(s.rig.channel, OWN_WORDS);
        assert.equal(s.inbound.messages.length, 1);
        const [message] = s.inbound.messages;
        assert.deepEqual(message?.ref, said.ref);
        assert.equal(message?.ref.channel, s.rig.channel);
        assert.equal(message?.id, said.id);
        assert.equal(message?.topLevel, true, "written in the channel, not inside a thread");
        assert.equal(message?.text, OWN_WORDS);
        assert.equal(message?.plain, OWN_WORDS);
        assert.equal(message?.literal, false);
        assert.equal(promptText((await message?.content()) ?? null), OWN_WORDS);
      });

      inbound("a message inside a thread arrives with that thread's name", async (s) => {
        const first = await s.rig.owner.says(s.rig.channel, OWN_WORDS);
        const inside = await s.rig.owner.says(s.rig.channel, "and add a test", {
          thread: first.ref.thread,
        });
        assert.equal(s.inbound.messages.length, 2);
        const message = s.inbound.messages[1];
        assert.deepEqual(message?.ref, first.ref);
        assert.equal(message?.id, inside.id);
        assert.equal(message?.topLevel, false);
        assert.equal(message?.text, "and add a test");
      });

      for (const { name: type, request, answer } of REQUESTS) {
        inbound(
          `the owner's answer to a ${type} request arrives with its request id`,
          async (s) => {
            const requestId = `request-${type}`;
            const thread = s.provider.thread(s.ref);
            const message = await thread.ask(
              requestId,
              request(requestId, s.ref.channel),
              "A request",
            );
            const asked: Asked = {
              ref: s.ref,
              requestId,
              request: request(requestId, s.ref.channel),
              message,
            };
            await s.rig.owner.answers(asked, answer);
            assert.equal(s.inbound.answers.length, 1);
            const [arrived] = s.inbound.answers;
            assert.deepEqual(arrived?.ref, s.ref);
            assert.equal(arrived?.requestId, requestId);
            assert.deepEqual(arrived?.answer, answer);
            assert.ok(arrived?.message === null || arrived?.message === message);
          },
        );
      }

      inbound("the owner's skip of a question arrives as null answers", async (s) => {
        const thread = s.provider.thread(s.ref);
        const request = question();
        const message = await thread.ask("request-skipped", request, "A question");
        const skip: OwnerAnswer = { type: "question", answers: null };
        await s.rig.owner.answers(
          { ref: s.ref, requestId: "request-skipped", request, message },
          skip,
        );
        assert.deepEqual(
          s.inbound.answers.map((a) => a.answer),
          [skip],
        );
      });

      inbound("the owner's denial of a permission arrives as a denial", async (s) => {
        const thread = s.provider.thread(s.ref);
        const request = permission();
        const message = await thread.ask("request-denied", request, "A permission");
        const deny: OwnerAnswer = { type: "permission", allow: false };
        await s.rig.owner.answers(
          { ref: s.ref, requestId: "request-denied", request, message },
          deny,
        );
        assert.deepEqual(
          s.inbound.answers.map((a) => a.answer),
          [deny],
        );
      });

      inbound("a pick from a list of folders arrives with the list's message", async (s) => {
        const channel = s.provider.channel(s.rig.channel);
        await channel.offer(FOLDERS, "Pick a folder to bind");
        const shown = s.rig
          .read({ channel: s.rig.channel })
          .find((m) => m.text.includes("Pick a folder to bind"));
        assert.ok(shown?.id);
        await s.rig.owner.picks(
          { channel: s.rig.channel, list: FOLDERS, message: shown.id },
          "/work/tools",
        );
        assert.deepEqual(s.inbound.picks, [
          { type: "folder", channel: s.rig.channel, path: "/work/tools", list: shown.id },
        ]);
      });

      inbound(
        "a pick from a list of sessions arrives with the session and the thread",
        async (s) => {
          const channel = s.provider.channel(s.rig.channel);
          const list = sessions(s.ref);
          await channel.offer(list, "Pick a session to resume");
          const shown = s.rig
            .read({ channel: s.rig.channel })
            .find((m) => m.text.includes("Pick a session to resume"));
          assert.ok(shown?.id);
          await s.rig.owner.picks({ channel: s.rig.channel, list, message: shown.id }, "session-1");
          assert.equal(s.inbound.picks.length, 1);
          const [pick] = s.inbound.picks;
          assert.equal(pick?.type, "session");
          if (pick?.type !== "session") return;
          assert.equal(pick.channel, s.rig.channel);
          assert.equal(pick.sessionId, "session-1");
          assert.ok(pick.thread === null || JSON.stringify(pick.thread) === JSON.stringify(s.ref));
          assert.equal(pick.list, shown.id);
        },
      );

      test("nothing arrives before start", { todo: todo.inbound }, async (t) => {
        const early = await start(t, make, false);
        await early.rig.owner.says(early.rig.channel, OWN_WORDS);
        assert.ok(early.inbound.empty);
      });

      inbound("nothing arrives after stop", async (s) => {
        const thread = s.provider.thread(s.ref);
        const requestId = "request-late";
        const request = permission();
        const message = await thread.ask(requestId, request, "A permission");
        const channel = s.provider.channel(s.rig.channel);
        await channel.offer(FOLDERS, "Pick a folder to bind");
        const listed = s.rig
          .read({ channel: s.rig.channel })
          .find((m) => m.text.includes("Pick a folder to bind"));
        assert.ok(listed?.id);
        await s.stop();
        await s.rig.owner.says(s.rig.channel, OWN_WORDS);
        await s.rig.owner.says(s.rig.channel, "inside", { thread: s.ref.thread });
        await s.rig.owner.answers(
          { ref: s.ref, requestId, request, message },
          { type: "permission", allow: true },
        );
        await s.rig.owner.picks(
          { channel: s.rig.channel, list: FOLDERS, message: listed.id },
          "/work/notes",
        );
        assert.ok(s.inbound.empty);
      });
    });

    describe("the owner check: nobody else reaches the daemon", () => {
      inbound("a message from somebody else never arrives", async (s) => {
        await s.rig.other.says(s.rig.channel, "run something else");
        await s.rig.other.says(s.rig.channel, "inside the owner's thread", {
          thread: s.ref.thread,
        });
        assert.ok(s.inbound.empty);
        await s.rig.owner.says(s.rig.channel, OWN_WORDS);
        assert.equal(s.inbound.messages.length, 1, "the owner's does, on the same path");
      });

      for (const { name: type, control, request, answer } of REQUESTS) {
        inbound(`a ${control} on a ${type} request from somebody else never arrives`, async (s) => {
          const requestId = `request-${type}`;
          const asking = request(requestId, s.ref.channel);
          const message = await s.provider.thread(s.ref).ask(requestId, asking, "A request");
          const asked: Asked = { ref: s.ref, requestId, request: asking, message };
          await s.rig.other.answers(asked, answer);
          assert.ok(s.inbound.empty);
          await s.rig.owner.answers(asked, answer);
          assert.equal(s.inbound.answers.length, 1, "the owner's does, on the same control");
        });
      }

      inbound("a pick from a list from somebody else never arrives", async (s) => {
        const channel = s.provider.channel(s.rig.channel);
        for (const [title, list, row] of [
          ["Pick a folder to bind", FOLDERS, "/work/tools"],
          ["Pick a session to resume", sessions(s.ref), "session-1"],
        ] as const) {
          await channel.offer(list, title);
          const shown = s.rig.read({ channel: s.rig.channel }).find((m) => m.text.includes(title));
          assert.ok(shown?.id);
          const listed: Listed = { channel: s.rig.channel, list, message: shown.id };
          await s.rig.other.picks(listed, row);
          assert.ok(s.inbound.empty, title);
          await s.rig.owner.picks(listed, row);
          assert.equal(s.inbound.picks.length, 1, title);
          s.inbound.picks.length = 0;
        }
      });
    });
  });
}
