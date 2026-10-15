/**
 * Where a report goes when the reply of the task it reports is not the last thing in the thread
 * (2026-10-15): into the thread's last reply when that one is at rest, so that fewer
 * messages and pushes come of one prompt; only with no such reply, a reply of its own at the
 * bottom. The measured case: a background subagent in a first prompt, a background command in a
 * second one, then the subagent's report and the command's report. Replayed from `subagent` and
 * `background`, the second with its ids changed so both run side by side.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Status } from "../../../src/chat/slack/reply/status.ts";
import { harnessFor, sdkMessages } from "../../support/sessions.ts";
import { isReport, renamedBackground, splitBackground } from "./helpers.ts";

const AGENT_REPORT = /^✓ Agent "/m;
const COMMAND_REPORT = /^✓ Background command "/m;

test("two reports for tasks of earlier replies render into the last reply, at rest", async (t) => {
  const [agentStart, agentEnd, agentReport] = splitBackground(sdkMessages("subagent"));
  const [commandStart, commandEnd, commandReport] = renamedBackground();
  const h = harnessFor(t)({ turns: [agentStart, commandStart] });
  const session = h.session();
  await (await session.submit("start the agent")).done.wait();
  await (await session.submit("start the command")).done.wait();
  h.clients[0]?.inject([...agentEnd, ...agentReport]);
  await h.until(() => h.bodies().some((body) => AGENT_REPORT.test(body)));
  h.clients[0]?.inject([...commandEnd, ...commandReport]);
  await h.until(() => h.bodies().some((body) => COMMAND_REPORT.test(body)));
  await h.idle();
  const bodies = h.bodies();
  // Two replies and the ending of the second, which the last report posts below its body.
  assert.equal(bodies.length, 3, bodies.join("\n---\n"));
  assert.ok(!isReport(bodies[0] ?? ""), "the first reply holds no report");
  // The agent's report first, the command's after it, both in the second reply.
  const second = bodies[1] ?? "";
  assert.ok(AGENT_REPORT.test(second) && COMMAND_REPORT.test(second), second);
  assert.ok(second.search(AGENT_REPORT) < second.search(COMMAND_REPORT), second);
  assert.equal(h.slack.callsTo("chat.startStream").length, 2);
  assert.equal(h.slack.callsTo("chat.postMessage").length, 1);
});

test("with a message of the owner's below the last reply, the report opens a reply of its own", async (t) => {
  const [agentStart, agentEnd, agentReport] = splitBackground(sdkMessages("subagent"));
  const [commandStart] = renamedBackground();
  const h = harnessFor(t)({ turns: [agentStart, commandStart] });
  const session = h.session();
  await (await session.submit("start the agent")).done.wait();
  await (await session.submit("start the command")).done.wait();
  // The owner's `!status` sits below both replies: neither is last.
  await session.status();
  h.clients[0]?.inject([...agentEnd, ...agentReport]);
  await h.until(() => h.replies().some(isReport));
  await h.idle();
  const texts = h.replies();
  assert.equal(texts.findIndex(isReport), texts.length - 1, texts.join("\n---\n"));
  assert.equal(h.slack.callsTo("chat.startStream").length, 3);
});

test("the last reply keeps resting for a task of an earlier reply that ends after its own", async (t) => {
  // X from reply A, the owner's next prompt, Y from reply B; Y ends first and is reported in B.
  // B owes nothing of its own then, but X still waits and its reply is no longer last: B stays
  // open to take X's report, so the prompt costs two replies and one footer, not three.
  const [commandX, endX, reportX] = splitBackground();
  const [commandY, endY, reportY] = renamedBackground();
  const h = harnessFor(t)({ turns: [commandX, commandY] });
  const session = h.session();
  await (await session.submit("start X")).done.wait();
  await (await session.submit("start Y")).done.wait();
  h.clients[0]?.inject([...endY, ...reportY]);
  await h.until(() => h.bodies().some((body) => isReport(body)));
  await h.idle();
  h.clients[0]?.inject([...endX, ...reportX]);
  await h.until(() => session.idle);
  await h.idle();
  await h.sleep(3);
  const bodies = h.bodies();
  assert.equal(h.slack.callsTo("chat.startStream").length, 2, bodies.join("\n---\n"));
  assert.ok(!isReport(bodies[0] ?? ""), "the first reply holds no report");
  const second = bodies[1] ?? "";
  assert.equal(second.match(/^✓ Background command "/gm)?.length, 2, second);
  // One footer, under the last message of the thread.
  const shown = h.slack.createdTs.map(
    (ts) => h.slack.messages.get(ts)?.blocks.some((block) => block.type === "divider") ?? false,
  );
  assert.deepEqual(
    shown,
    shown.map((_, index) => index === shown.length - 1),
    JSON.stringify(shown),
  );
  assert.equal(h.reactions().at(-1), Status.DONE);
});
