/**
 * A `state.json` that cannot be written (the folder is read-only here; a full disk throws the
 * same way from `StateStore.write`). The root's status is crash-repair bookkeeping like the
 * request and open-reply fields: a failed write is logged by the error's name and the session
 * goes on, whatever it was doing.
 */
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { test } from "node:test";
import { APPROVE } from "../../../src/core/requests.ts";
import { setWriter } from "../../../src/log.ts";
import { CHANNEL, THREAD } from "../../support/fake-slack.ts";
import { canUseToolCall, harnessFor, sdkMessages } from "../../support/sessions.ts";
import { pending } from "./helpers.ts";

const NEEDS_PERMISSIONS = { skip: process.platform === "win32" || process.getuid?.() === 0 };
const PROMPT = "SECRET-PROMPT-CONTENT";
const COMMAND = "SECRET-COMMAND-CONTENT";
const STATUS_LINE = "could not record the root's status in state.json";

/** The log lines written from now on, and the way to stop collecting them. */
function collect(t: Parameters<typeof harnessFor>[0]): string[] {
  const lines: string[] = [];
  const before = setWriter((line) => lines.push(line));
  t.after(() => void setWriter(before));
  return lines;
}

/** `work` with the folder of `state.json` read-only, writable again once it returns. */
async function unwritable<T>(folder: string, work: () => Promise<T>): Promise<T> {
  chmodSync(folder, 0o500);
  try {
    return await work();
  } finally {
    chmodSync(folder, 0o700);
  }
}

/** The lines that name a failed status write, and only they. */
function statusLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes(STATUS_LINE));
}

test(
  "a prompt is sent when the status write fails, in a session with no worker",
  NEEDS_PERMISSIONS,
  async (t) => {
    const maker = harnessFor(t);
    const h = maker({ turns: [sdkMessages("tools")] }, { turns: [sdkMessages("tools")] });
    await (await h.session().submit("first")).done.wait();
    await h.idle();
    // What a restart or an idle close leaves: the next message rebuilds the session.
    await h.restart();
    const session = h.manager.get(CHANNEL, THREAD);
    assert.ok(session !== null);
    const lines = collect(t);

    const turn = await unwritable(maker.tmpPath, () => session.submit(PROMPT));
    await turn.done.wait();

    assert.deepEqual(h.clients.at(-1)?.queries, [PROMPT]);
    const failed = statusLines(lines);
    assert.equal(failed.length, 1);
    assert.match(failed[0] ?? "", /EACCES$/);
    assert.ok(!lines.join("\n").includes(PROMPT));
  },
);

test(
  "a permission request is posted and answered when the status write fails",
  NEEDS_PERMISSIONS,
  async (t) => {
    const maker = harnessFor(t);
    const ask = canUseToolCall("Bash", { command: COMMAND });
    const h = maker({ turns: [[ask, ...sdkMessages("tools")]] });
    const lines = collect(t);
    const session = h.session();

    const turn = await unwritable(maker.tmpPath, async () => {
      const submitted = await session.submit("go");
      await h.until(() => h.slack.callsTo("chat.postMessage").some((args) => "blocks" in args));
      return submitted;
    });
    const [approvalId] = pending(h.approvals);
    assert.ok(approvalId !== undefined);
    assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
    await turn.done.wait();

    assert.deepEqual(h.clients[0]?.permissionResults[0], { allow: true });
    assert.ok(statusLines(lines).length >= 2); // ⏳ at the submit, ✋ at the request
    assert.ok(statusLines(lines).every((line) => line.endsWith("EACCES")));
    assert.ok(!lines.join("\n").includes(COMMAND));
  },
);

test(
  "a close that cuts a turn short completes when the status write fails",
  NEEDS_PERMISSIONS,
  async (t) => {
    const maker = harnessFor(t);
    const ask = canUseToolCall("Bash", { command: COMMAND });
    const h = maker({ turns: [[ask, ...sdkMessages("tools")]] });
    const session = h.session();
    await session.submit(PROMPT);
    await h.until(() => pending(h.approvals).length > 0);
    const lines = collect(t);

    await unwritable(maker.tmpPath, () => session.close());

    assert.equal(session.closed, true);
    const failed = statusLines(lines);
    assert.ok(failed.length >= 1);
    assert.ok(failed.every((line) => line.endsWith("EACCES")));
    assert.ok(!lines.join("\n").includes(PROMPT));
    assert.ok(!lines.join("\n").includes(COMMAND));
  },
);
