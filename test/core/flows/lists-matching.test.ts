/**
 * Which session a typed `!resume` target means, and what the answer to a bind says: the two
 * decisions of words and numbers the lists flows own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListedSession } from "../../../src/agent/seam.ts";
import { boundText } from "../../../src/core/flows/bind.ts";
import { ID_PREFIX_MIN, matching } from "../../../src/core/flows/resume.ts";
import { DirectoryMissing } from "../../../src/core/sessions/errors.ts";
import * as texts from "../../../src/core/texts.ts";

/** Session metadata as the seam lists it. */
function info(id: string, title: string, fields: Partial<ListedSession> = {}): ListedSession {
  return { id, title, customTitle: null, branch: null, size: null, lastModified: 1, ...fields };
}

test("a session is found by id or by its name", () => {
  const named = info("68da9311-0000-4000-8000-000000000001", "trust", { customTitle: "trust" });
  const other = info("68da9311-0000-4000-8000-000000000002", "Other");
  const twin = info("68da9311-0000-4000-8000-000000000003", "twin", { customTitle: "twin" });
  const twin2 = info("68da9311-0000-4000-8000-000000000004", "twin", { customTitle: "twin" });
  const sessions = [named, other, twin, twin2];
  assert.deepEqual(matching(sessions, other.id), [other]);
  assert.deepEqual(matching(sessions, "trust"), [named]);
  assert.deepEqual(matching(sessions, "Other"), []); // a summary with no title (a first prompt) is no name
  assert.deepEqual(matching(sessions, "twin"), [twin, twin2]);
});

test("a session is found by the start of its id the list shows", () => {
  const first = info("1b4b42a0-0000-4000-8000-000000000001", "first");
  const second = info("1b4b42a1-0000-4000-8000-000000000002", "second");
  const added = info("add00000-0000-4000-8000-000000000003", "add", { customTitle: "add" });
  const sessions = [first, second, added];
  assert.equal(ID_PREFIX_MIN, 8);
  assert.deepEqual(matching(sessions, "1b4b42a0"), [first]);
  assert.deepEqual(matching(sessions, "1b4b42a"), []); // shorter than the list shows: not read as an id
  assert.deepEqual(matching(sessions, "add"), [added]); // a short title that is also hex stays a title
  assert.deepEqual(matching(sessions, "1b4b42a0-0000"), [first]);
});

const upper = (text: string): string => text.toUpperCase();

test("a bind that no session can start in says why, before anything about old folders", () => {
  const missing = new DirectoryMissing("/work/app");
  assert.equal(
    boundText("/work/app", missing, ["/work/old"], upper),
    texts.fill(texts.BIND_UNAVAILABLE, { directory: "/WORK/APP", reason: missing.message }),
  );
});

test("a bind with no thread in another folder says only where the channel is bound", () => {
  assert.equal(
    boundText("/work/app", null, [], upper),
    texts.fill(texts.BIND_OK, { directory: "/WORK/APP" }),
  );
});

test("a bind names each old folder its threads keep working in, in code", () => {
  assert.equal(
    boundText("/work/app", null, ["/work/a", "/work/b"], upper),
    texts.fill(texts.BIND_OK_ELSEWHERE, {
      directory: "/WORK/APP",
      old: "`/WORK/A`, `/WORK/B`",
    }),
  );
});
