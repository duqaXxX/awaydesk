/**
 * The instance: which of the daemons on one machine this is. It is a name, or none for the default
 * instance, and what is the instance's own derives from it here: its configuration folder and its
 * scratch folder. The same rule holds on every system, and a function takes the home and the
 * temporary folder as arguments so that a test passes its own.
 */
import { join } from "node:path";

/** The variable that selects an instance when `--instance` is absent; only the command line reads it. */
export const INSTANCE_VARIABLE = "AWAYDESK_INSTANCE";

/** `name` is null for the default instance, which keeps the folders of a single-instance install. */
export interface Instance {
  readonly name: string | null;
}

export const DEFAULT_INSTANCE: Instance = { name: null };

// 32 characters at most: the lock of a Linux instance is a socket, whose path has 104 bytes.
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A name that follows the rule, or the sentence that says why `text` is refused. */
export function parseInstanceName(text: string): { name: string } | { refusal: string } {
  if (text === "default") {
    return {
      refusal: `the instance name "default" would read as the default instance, which has no name: leave the instance out to use it`,
    };
  }
  if (!NAME.test(text)) {
    return {
      refusal: `${JSON.stringify(text)} is not an instance name: a name is 1 to 32 characters of a-z, 0-9 and "-", and starts with a letter or a digit`,
    };
  }
  return { name: text };
}

function suffix(instance: Instance): string {
  return instance.name === null ? "" : `-${instance.name}`;
}

/** `~/.config/awaydesk` for the default instance, `~/.config/awaydesk-<name>` for a named one. */
export function configDirOf(instance: Instance, home: string): string {
  return join(home, ".config", `awaydesk${suffix(instance)}`);
}

/** The folder under `tmp` that holds the files a chat saves for the instance: `awaydesk[-<name>]`. */
export function scratchDirOf(instance: Instance, tmp: string): string {
  return join(tmp, `awaydesk${suffix(instance)}`);
}
