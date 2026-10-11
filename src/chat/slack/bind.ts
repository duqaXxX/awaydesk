/**
 * `!bind` alone, as Slack shows it: one row per folder `src/core/folders.ts` found, a Bind button
 * each.
 */

import { relative, sep } from "node:path";
import { FOLDER_ROWS, fill, type Names, named, texts } from "../../core/port.ts";
import { compareCodePoints } from "../../text.ts";
import { type ContextBlock, contextBlock } from "./reply/blocks.ts";
import { shownAsWritten } from "./reply/escape.ts";

export const BIND_ACTION = "folder_bind";

/** One folder: its relative path as code, and a Bind button unless it is the channel's own. */
export interface FolderRow {
  type: "section";
  block_id: string;
  text: { type: "mrkdwn"; text: string };
  accessory?: {
    type: "button";
    action_id: string;
    value: string;
    text: { type: "plain_text"; text: string };
  };
}

export type BindBlock = ContextBlock | FolderRow;

/** A path's components as `PurePosixPath` compares them: no empty or `.` part. */
function parts(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

function samePath(a: string, b: string): boolean {
  const left = parts(a);
  const right = parts(b);
  return left.length === right.length && left.every((part, i) => part === right[i]);
}

/** Paths sort by components as Python sorts a `Path`, so `a/b` comes before `a-b`. */
function comparePaths(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const order = compareCodePoints(left[i] as string, right[i] as string);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function row(root: string, index: number, folder: string, current: boolean): FolderRow {
  const shown = relative(root, folder).split(sep).join("/") || ".";
  const block: FolderRow = {
    type: "section",
    // An index, not the path: a block_id is capped at 255 characters.
    block_id: `folder-${index}`,
    text: {
      type: "mrkdwn",
      text: `\`${shownAsWritten(shown)}\`${current ? texts.BIND_CURRENT : ""}`,
    },
  };
  if (!current) {
    block.accessory = {
      type: "button",
      action_id: BIND_ACTION,
      value: shown,
      text: { type: "plain_text", text: texts.BIND_BUTTON },
    };
  }
  return block;
}

/** The list: the first FOLDER_ROWS folders in path order, the channel's own marked. */
export function bindBlocks(
  root: string,
  folders: string[],
  current: string | null,
  names: Names,
): BindBlock[] {
  const shown = folders.slice(0, FOLDER_ROWS).toSorted(comparePaths);
  // The list's own lines are the daemon's notices, small and grey; the rows keep their button.
  if (folders.length === 0) {
    return [contextBlock(fill(named(texts.BIND_EMPTY, names), { root: shownAsWritten(root) }))];
  }
  return [
    contextBlock(fill(named(texts.BIND_LIST, names), { root: shownAsWritten(root) })),
    ...shown.map((folder, i) =>
      row(root, i, folder, current !== null && samePath(folder, current)),
    ),
    ...(folders.length > FOLDER_ROWS
      ? [contextBlock(fill(texts.BIND_MORE, { rows: FOLDER_ROWS }))]
      : []),
  ];
}
