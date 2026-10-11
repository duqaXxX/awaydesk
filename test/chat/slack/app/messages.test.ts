/** How a message's composer blocks are read into the text a word is read in (`unformatted`). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { unformatted } from "../../../../src/chat/slack/app/messages.ts";

// A composer message's blocks, as Slack stores them. Read back on 2026-10-07: a section with a
// `text` element in inline code, and a `rich_text_preformatted` part. The `bold` style and the
// `rich_text_quote` and `rich_text_list` part types are named by the Block Kit reference and were
// not read from a real message.
type Part = Record<string, unknown>;

function richText(...parts: Part[]): Part[] {
  return [{ type: "rich_text", block_id: "Rd58H", elements: parts }];
}

function part(leaves: Part[], kind = "rich_text_section"): Part {
  return { type: kind, elements: leaves };
}

function leaf(text: string, style: Record<string, boolean> = {}): Part {
  return { type: "text", text, ...(Object.keys(style).length > 0 ? { style } : {}) };
}

const CODE_BLOCK = { ...part([leaf("!goal tick")], "rich_text_preformatted"), border: 0 };

const unformattedCases: [string, unknown, string][] = [
  // The two shapes read back from Slack: inline code, and a code block.
  ["`!goal tick`", richText(part([leaf("!goal tick", { code: true })])), "!goal tick"],
  ["```!goal tick```\n", richText(CODE_BLOCK), "!goal tick"],
  // Only the first run is read in the blocks: what follows it comes from the text, with its own
  // formatting and its links as the owner sent them.
  [
    "`!goal` what is it?",
    richText(part([leaf("!goal", { code: true }), leaf(" what is it?")])),
    "!goal what is it?",
  ],
  [
    "*!goal* run `make test` see https://example.com/1",
    richText(
      part([leaf("!goal", { bold: true }), leaf(" run "), leaf("make test", { code: true })]),
    ),
    "!goal run `make test` see https://example.com/1",
  ],
  [
    "`!compact`\n```notes```",
    richText(
      part([leaf("!compact", { code: true })]),
      part([leaf("notes")], "rich_text_preformatted"),
    ),
    "!compact\n```notes```",
  ],
  // Anything before the `!` keeps the message a prompt, formatted or not.
  ["`\\!stop`", richText(part([leaf("\\!stop", { code: true })])), ""],
  ["say `!stop`", richText(part([leaf("say "), leaf("!stop", { code: true })])), ""],
  ["!stop", richText(part([leaf("!stop")])), ""], // no marks: `parseBang` reads the text
  // A quote and a list are not read through.
  ["> !stop", richText(part([leaf("!stop")], "rich_text_quote")), ""],
  ["• !stop", richText(part([part([leaf("!stop")])], "rich_text_list")), ""],
  // A text that does not read as marks, the run, the marks again: left alone.
  ["`!stop`", richText(part([leaf("!status", { code: true })])), ""],
  ["`!stop", richText(part([leaf("!stop", { code: true })])), ""],
  ["x`!stop`", richText(part([leaf("!stop", { code: true })])), ""],
  // No composer block: nothing tells a mark from a character the owner typed.
  ["`!stop`", [{ type: "section", text: { type: "mrkdwn", text: "`!stop`" } }], ""],
  ["`!stop`", [], ""],
  ["`!stop`", null, ""],
];

unformattedCases.forEach(([text, blocks, expected], index) => {
  test(`unformatted [${index + 1}: ${JSON.stringify(text)}]`, () => {
    assert.equal(unformatted(text, blocks), expected);
  });
});
