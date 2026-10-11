/**
 * `!bind`, typed or picked from the list of folders: which folder a channel's next thread
 * starts in. The core decides which folders the list holds and what the answer says; the chat
 * draws the list.
 */
import type { ListPick } from "../../chat/seam.ts";
import { compareCodePoints } from "../../text.ts";
import { resolveDirectory } from "../sessions/directory.ts";
import type { DirectoryUnavailable } from "../sessions/errors.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { BindFlow } from "./contract.ts";
import type { FlowDeps, Talk } from "./talk.ts";

/**
 * The answer to a bind: what keeps a session from starting in the folder, if anything
 * (`BIND_UNAVAILABLE` keeps priority: what would stop every session there matters more than
 * where an existing thread's session lives), else the old folders existing threads keep working
 * in, if any. `inNotice` makes a folder safe to stand inside the notice.
 */
export function boundText(
  directory: string,
  unavailable: DirectoryUnavailable | null,
  oldFolders: readonly string[],
  inNotice: (text: string) => string,
): string {
  if (unavailable !== null) {
    return fill(texts.BIND_UNAVAILABLE, {
      directory: inNotice(directory),
      reason: unavailable.message,
    });
  }
  if (oldFolders.length === 0) {
    return fill(texts.BIND_OK, { directory: inNotice(directory) });
  }
  const old = oldFolders.map((folder) => `\`${inNotice(folder)}\``).join(", ");
  return fill(texts.BIND_OK_ELSEWHERE, { directory: inNotice(directory), old });
}

/** A folder picked from the list, and what follows `!bind <folder>`. */
export interface Binding extends BindFlow {
  /** The pick of a folder from a list `list()` posted. */
  picked(pick: Extract<ListPick, { type: "folder" }>): Promise<void>;
}

export function binding(deps: FlowDeps, talk: Talk): Binding {
  const { agent, chat, sessions, state, names, allowedRoot } = deps;
  const inNotice = (text: string): string => chat.escape(text, "notice");

  /** The folder a typed path or a pick names, inside the allowed root; null, told, otherwise. */
  const folderNamed = async (channel: string, path: string): Promise<string | null> => {
    const directory = resolveDirectory(path, allowedRoot);
    if (directory === null) {
      await talk.inChannel(
        channel,
        fill(texts.BIND_OUTSIDE, { path: inNotice(path), root: inNotice(allowedRoot) }),
      );
    }
    return directory;
  };

  // Thread entries keep their own folder either side of the bind (`StateStore.bind`), so the
  // old folders can be read now: those of the channel's threads that differ from the new one.
  const announce = async (channel: string, directory: string): Promise<void> => {
    const unavailable = await sessions.unavailable(directory);
    const record = state.channel(channel);
    const threads = record === null ? [] : [...record.threads.values()];
    const oldFolders = [
      ...new Set(threads.map((thread) => thread.directory).filter((old) => old !== directory)),
    ].sort(compareCodePoints);
    await talk.inChannel(channel, boundText(directory, unavailable, oldFolders, inNotice));
  };

  return {
    async to(channel, path) {
      const directory = await folderNamed(channel, path);
      if (directory === null) return;
      if (!(await sessions.bind(channel, directory))) {
        await talk.inChannel(channel, texts.BIND_BUSY);
        return;
      }
      await announce(channel, directory);
    },

    async list(channel) {
      const record = state.channel(channel);
      const folders = await sessions.foldersIn(allowedRoot);
      // An agent with no record of trust is offered every folder: no title names its trust.
      const trusted =
        folders.length > 0 ? named(texts.BIND_LIST, names) : named(texts.BIND_EMPTY, names);
      const title = fill(agent.capabilities.folderTrust ? trusted : texts.BIND_LIST_ANY, {
        root: allowedRoot,
      });
      await chat.channel(channel).offer(
        {
          type: "folders",
          root: allowedRoot,
          folders,
          bound: record === null ? null : record.directory,
        },
        title,
      );
    },

    async picked(pick) {
      const { channel } = pick;
      // The pick is not trusted: its folder goes through the same check as a typed `!bind`.
      const directory = await folderNamed(channel, pick.path);
      if (directory === null) return;
      const record = state.channel(channel);
      if (record !== null && record.directory === directory) {
        await talk.inChannel(channel, fill(texts.BIND_ALREADY, { directory: inNotice(directory) }));
        return;
      }
      // A list can be old: unlike a typed `!bind`, a pick never ends work in flight either.
      if (!(await sessions.bind(channel, directory))) {
        await talk.inChannel(channel, texts.BIND_BUSY);
        return;
      }
      await announce(channel, directory);
      await talk.removeRequest({ channel, thread: pick.list }, pick.list);
    },
  };
}
