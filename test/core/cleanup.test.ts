import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { aliveSessions } from "../../src/agent/claude/listing.ts";
import type { ThreadRef } from "../../src/chat/seam.ts";
import {
  type ChannelAnswer,
  type ChannelLookup,
  clean,
  forgetGoneChannels,
} from "../../src/core/cleanup.ts";
import { StateStore } from "../../src/core/state.ts";
import type { Logger } from "../../src/log.ts";

const CHANNEL = "C000CHAN";
const GONE_CHANNEL = "C000GONE";
const OTHER_GONE = "C000GON2";
const THREAD = "1789000000.000100";
const GONE_THREAD = "1789000500.000100";
const SESSION = "68da9311-0000-4000-8000-00000000000a";
const NOBODY: readonly ThreadRef[] = [];
const NEEDS_PERMISSIONS = { skip: process.platform === "win32" || process.getuid?.() === 0 };

/** A thread's name read as its opening time in epoch seconds, as a chat whose names are times does. */
const opened = (ref: ThreadRef): number | null => Number(ref.thread);

function nothingLive(): readonly ThreadRef[] {
  return NOBODY;
}

const made: string[] = [];

after(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

/** The lines a pass logs, by level. */
interface Logged extends Pick<Logger, "info" | "warning"> {
  readonly lines: string[];
}

function logged(): Logged {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`INFO ${message}`),
    warning: (message) => lines.push(`WARNING ${message}`),
  };
}

let directory: string;
let state: StateStore;
let log: Logged;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "awd-cleanup-"));
  made.push(directory);
  state = new StateStore(join(directory, "state.json"), { warn: () => undefined });
  state.bind(CHANNEL, join(directory, "project"));
  state.bind(GONE_CHANNEL, join(directory, "old"));
  state.openThread(CHANNEL, THREAD, SESSION);
  state.openThread(GONE_CHANNEL, GONE_THREAD, SESSION);
  log = logged();
});

/** What `conversations.info` can answer: the recorded channel, or an error code or exception. */
type Reply = "channel" | string | Error;

/**
 * The lookup the Slack provider supplies, over a fake `conversations.info`: it answers per channel
 * id with the recorded channel when the id is not named, else the failure given. Slack's
 * `channel_not_found` is `gone`, a channel read is `there`, and every other error code or
 * exception is `no answer`, which is what the provider will make of them.
 */
function channelsInSlack(
  replies: Record<string, Reply>,
  otherwise: Reply = "channel",
): ChannelLookup {
  return async (channelId) => {
    const reply = replies[channelId] ?? otherwise;
    if (reply === "channel") return "there";
    if (reply instanceof Error) return "no answer";
    return reply === "channel_not_found" ? "gone" : "no answer";
  };
}

test("a channel slack no longer has is forgotten with its threads", async () => {
  // conversations.info reference, read 2026-10-01: `channel_not_found`, also what a private
  // channel the bot is not in answers (measured the same day on deleted channels).
  const lookup = channelsInSlack({ [GONE_CHANNEL]: "channel_not_found" });
  assert.deepEqual(await forgetGoneChannels(lookup, state, nothingLive, "Slack", log), [
    GONE_CHANNEL,
  ]);
  assert.deepEqual(state.channels(), [CHANNEL]);
  assert.equal(state.thread(GONE_CHANNEL, GONE_THREAD), null);
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
  const text = log.lines.join("\n");
  assert.ok(text.includes(GONE_CHANNEL) && text.includes("1 thread"));
});

const failures: [string, Reply][] = [
  ["internal_error", "internal_error"],
  ["ratelimited", "ratelimited"],
  ["missing_scope", "missing_scope"],
  ["network down", new Error("network down")],
];

for (const [label, failure] of failures) {
  test(`anything but not found forgets nothing [${label}]`, async () => {
    // Not an answer about the channel: it cannot be told gone.
    const lookup = channelsInSlack({ [GONE_CHANNEL]: failure });
    assert.deepEqual(await forgetGoneChannels(lookup, state, nothingLive, "Slack", log), []);
    assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
  });
}

test("no channel slack can see forgets nothing and says so", async () => {
  // Every bound channel not found: the token of another workspace, or the app removed from
  // them all. Wiping every binding on that would be the wrong repair.
  const lookup = channelsInSlack({}, "channel_not_found");
  assert.deepEqual(await forgetGoneChannels(lookup, state, nothingLive, "Slack", log), []);
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
  assert.ok(log.lines.join("\n").includes("none of the 2 bound channels"));
});

for (const [label, failure] of [
  ["network down", new Error("network down")],
  ["ratelimited", "ratelimited"],
] as [string, Reply][]) {
  test(`a pass in which slack found no channel forgets nothing [${label}]`, async () => {
    // The token of another workspace, and one call that failed for a reason of its own: a
    // channel Slack did not answer about is not a channel it found.
    state.bind(OTHER_GONE, "/srv/elsewhere");
    const gone = "channel_not_found";
    const lookup = channelsInSlack({
      [CHANNEL]: failure,
      [GONE_CHANNEL]: gone,
      [OTHER_GONE]: gone,
    });
    assert.deepEqual(await forgetGoneChannels(lookup, state, nothingLive, "Slack", log), []);
    assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL, OTHER_GONE]);
    assert.ok(log.lines.join("\n").includes("none of the 3 bound channels"));
  });
}

test("a channel with a live session is left for the next pass", async () => {
  const lookup = channelsInSlack({ [GONE_CHANNEL]: "channel_not_found" });
  const live: ThreadRef[] = [{ channel: GONE_CHANNEL, thread: GONE_THREAD }];
  assert.deepEqual(await forgetGoneChannels(lookup, state, () => live, "Slack", log), []);
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
});

test("several gone channels go in one pass", async () => {
  state.bind(OTHER_GONE, "/srv/elsewhere");
  const gone = "channel_not_found";
  const lookup = channelsInSlack({ [GONE_CHANNEL]: gone, [OTHER_GONE]: gone });
  assert.deepEqual(await forgetGoneChannels(lookup, state, nothingLive, "Slack", log), [
    GONE_CHANNEL,
    OTHER_GONE,
  ]);
  assert.deepEqual(state.channels(), [CHANNEL]);
});

test("clean forgets gone channels then prunes what is left", async () => {
  const lookup = channelsInSlack({ [GONE_CHANNEL]: "channel_not_found" });
  const asked: string[] = [];

  function alive(folder: string): Set<string> {
    asked.push(folder);
    return new Set(); // the session is gone from the folder
  }

  await clean(lookup, state, {
    alive,
    live: nothingLive,
    chat: "Slack",
    openedAt: opened,
    logger: log,
  });
  assert.deepEqual(state.channels(), [CHANNEL]);
  assert.equal(state.thread(CHANNEL, THREAD), null); // pruned: its session no longer exists
  // the forgotten channel's folder is not read
  assert.deepEqual(asked, [state.channel(CHANNEL)?.directory]);
  assert.ok(log.lines.join("\n").includes("pruned 1 stale thread"));
});

test("clean keeps a thread with a live session", async () => {
  const live: ThreadRef[] = [{ channel: CHANNEL, thread: THREAD }];
  await clean(channelsInSlack({}), state, {
    alive: () => new Set(),
    live: () => live,
    chat: "Slack",
    openedAt: opened,
    logger: log,
  });
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
});

test("a thread opened while the folders are read is kept", async () => {
  // The sessions are listed off the event loop: what is opened meanwhile, in a folder the
  // listing did not cover, cannot be told gone.
  const late = "1789000900.000100";

  async function alive(): Promise<Set<string>> {
    state.bind("C000LATE", join(directory, "late"));
    state.openThread("C000LATE", late, "a-session-no-listing-saw");
    await Promise.resolve();
    return new Set([SESSION]);
  }

  await clean(channelsInSlack({}), state, {
    alive,
    live: nothingLive,
    chat: "Slack",
    openedAt: opened,
    logger: log,
  });
  assert.notEqual(state.thread("C000LATE", late), null);
});

test("clean goes on to prune when the channel check itself fails", async () => {
  // The check fails the way it can: `live`, read once the channel is found gone, raises on that
  // first read.
  const lookup = channelsInSlack({ [GONE_CHANNEL]: "channel_not_found" });
  let reads = 0;

  function live(): readonly ThreadRef[] {
    reads += 1;
    if (reads === 1) throw new Error("unexpected");
    return NOBODY;
  }

  await clean(lookup, state, {
    alive: () => new Set(),
    live,
    chat: "Slack",
    openedAt: opened,
    logger: log,
  });
  assert.ok(log.lines.join("\n").includes("could not check the bound channels"));
  assert.equal(state.thread(CHANNEL, THREAD), null); // the prune still ran
});

test("clean survives a folder that cannot be read and a slack that fails", async () => {
  const lookup = channelsInSlack({}, new Error("network down"));

  function broken(): never {
    throw Object.assign(new Error("transcripts unreadable"), { code: "EACCES" });
  }

  await clean(lookup, state, {
    alive: broken,
    live: nothingLive,
    chat: "Slack",
    openedAt: opened,
    logger: log,
  }); // never throws
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
  assert.ok(log.lines.join("\n").includes("could not prune stale threads"));
});

test("a lookup that throws is no answer", async () => {
  const answers: Record<string, ChannelAnswer> = { [CHANNEL]: "there", [GONE_CHANNEL]: "gone" };
  const lookup: ChannelLookup = async (channelId) => {
    if (channelId === OTHER_GONE) throw new Error("boom");
    return answers[channelId] ?? "no answer";
  };
  state.bind(OTHER_GONE, "/srv/elsewhere");
  assert.deepEqual(await forgetGoneChannels(lookup, state, nothingLive, "Slack", log), [
    GONE_CHANNEL,
  ]);
  assert.deepEqual(state.channels(), [CHANNEL, OTHER_GONE]);
  assert.ok(log.lines.join("\n").includes(`could not read channel ${OTHER_GONE}`));
});

test("a thread with no session is dropped for its age only when the chat dates it", async () => {
  // The chat's names mean nothing to the core: a thread it cannot date is never dropped for age.
  const undated = "not-a-time";
  state.openThread(CHANNEL, undated);
  state.openThread(CHANNEL, GONE_THREAD);
  const later = Number(GONE_THREAD) + 2 * 24 * 60 * 60;
  const dated = (ref: ThreadRef): number | null => (ref.thread === undated ? null : opened(ref));

  await clean(channelsInSlack({}), state, {
    alive: () => new Set([SESSION]),
    live: nothingLive,
    chat: "Slack",
    openedAt: dated,
    now: () => later,
    logger: log,
  });
  assert.equal(state.thread(CHANNEL, GONE_THREAD), null); // dated and older than a day
  assert.notEqual(state.thread(CHANNEL, undated), null);
  assert.notEqual(state.thread(CHANNEL, THREAD), null); // its session is alive
  assert.ok(log.lines.join("\n").includes("pruned 1 stale thread"));
});

test(
  "a pass over transcripts that cannot be searched prunes nothing",
  NEEDS_PERMISSIONS,
  async (t) => {
    // The real `aliveSessions` over a config folder of the test: with the projects folder closed
    // (EACCES) its listing is empty, and the thread's session is on disk all the same.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "awd-cleanup-")));
    made.push(root);
    const config = join(root, "config");
    const project = join(root, "project");
    mkdirSync(project);
    const transcripts = join(config, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, `${SESSION}.jsonl`), "");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    t.after(() => {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      chmodSync(join(config, "projects"), 0o755);
    });
    const closed = new StateStore(join(root, "state.json"), { warn: () => undefined });
    closed.bind(CHANNEL, project);
    closed.openThread(CHANNEL, THREAD, SESSION);

    chmodSync(join(config, "projects"), 0o000);
    await clean(channelsInSlack({}), closed, {
      alive: (folder) => aliveSessions(folder),
      live: nothingLive,
      chat: "Slack",
      openedAt: opened,
      logger: log,
    });
    assert.notEqual(closed.thread(CHANNEL, THREAD), null);
    assert.deepEqual(log.lines, []);
  },
);
