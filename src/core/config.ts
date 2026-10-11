/** Load the daemon's configuration from ~/.config/awaydesk/.env. */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { errorCode } from "../values.ts";
import { expandUser, resolvePath } from "./paths.ts";

export const CONFIG_DIR = join(homedir(), ".config", "awaydesk");

/** The variables that select the agent and the chat; absent, the registry's defaults hold. */
export const SELECTORS = ["AWAYDESK_AGENT", "AWAYDESK_CHAT"] as const;
const [AGENT_VARIABLE, CHAT_VARIABLE] = SELECTORS;

/** The variables the core itself requires; each module names its own. */
export const REQUIRED = ["ALLOWED_ROOT"] as const;

/** The configuration is missing, unsafe or invalid; the message says what to fix. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A module's variables: a lookup gives the value, and printing, spreading or `JSON.stringify` show nothing. */
export type Variables = Readonly<Record<string, string>>;

/** The variables one module reads. */
export interface ModuleVariables {
  /** The daemon does not start without these. */
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/**
 * What `loadConfig` needs of the registry: the names a variable may select, their defaults, and the
 * variables each module reads. `Registry` satisfies it; the core does not import the registry.
 */
export interface Modules {
  readonly agents: Readonly<Record<string, ModuleVariables>>;
  readonly chats: Readonly<Record<string, ModuleVariables>>;
  readonly defaults: { readonly agent: string; readonly chat: string };
}

/**
 * The two modules' variables are non-enumerable, so `util.inspect`, `JSON.stringify` and a log
 * line that prints the object never show them (they hold the tokens). A spread copy of a `Config`
 * drops them.
 */
export interface Config {
  /** The name of the selected agent: a key of `Modules.agents`. */
  readonly agent: string;
  /** The name of the selected chat: a key of `Modules.chats`. */
  readonly chat: string;
  readonly allowedRoot: string;
  readonly configDir: string;
  /** The values of the agent's `required` and `optional` variables the file sets. */
  readonly agentVariables: Variables;
  /** The values of the chat's `required` and `optional` variables the file sets. */
  readonly chatVariables: Variables;
}

/** The variables a `${NAME}` may name besides the file's own; the process environment by default. */
export type Env = Readonly<Record<string, string | undefined>>;

// python-dotenv's own pattern (`dotenv/variables.py`, 1.2.4): `${NAME}` and `${NAME:-default}`.
// `$NAME` without braces, a lone `$` and `${NAME:other}` stay as they are.
const VARIABLE = /\$\{([^}:]*)(?::-([^}]*))?\}/g;

/**
 * The key names of `text` in the order the file defines them. `util.parseEnv` returns its keys
 * sorted, which loses the order python-dotenv resolves in: a name defined later in the file does
 * not exist yet for the values before it. A key `parseEnv` read that no line start names (should
 * a syntax differ) goes last, so no key is dropped.
 */
function fileOrder(text: string, keys: readonly string[]): string[] {
  const wanted = new Set(keys);
  const ordered = new Set<string>();
  for (const [, key] of text.matchAll(/^[ \t]*(?:export[ \t]+)?([^\s=#]+)[ \t]*=/gm)) {
    if (key !== undefined && wanted.has(key)) ordered.add(key);
  }
  return [...ordered, ...keys.filter((key) => !ordered.has(key))];
}

/**
 * The values of a `.env` text with `${NAME}` and `${NAME:-default}` expanded as python-dotenv does
 * by default (`interpolate=True`), which is how the Python daemon read this file. A name
 * resolves from the values the file defined above it, else from `env`, else to its default, else
 * to nothing; an `env` entry that is empty counts as set. The expanded value is final: nothing in
 * it is expanded again. Quotes were dropped by `parseEnv` and python-dotenv expands inside single
 * quotes too, so every value is expanded alike. Differences from python-dotenv: a key repeated in
 * the file (the last value is used and expanded once, where python-dotenv expands each
 * occurrence) and a bare `NAME` line with no `=` (python-dotenv records it as unset and
 * `${NAME:-d}` then gives nothing; here `d`).
 */
export function expandEnv(text: string, env: Env = process.env): Record<string, string> {
  const raw = new Map(Object.entries(parseEnv(text)));
  const resolved = new Map<string, string>();
  for (const key of fileOrder(text, [...raw.keys()])) {
    const value = raw.get(key);
    if (value === undefined) continue;
    resolved.set(
      key,
      value.replace(VARIABLE, (_match, name: string, fallback: string | undefined) => {
        const defined = resolved.get(name);
        if (defined !== undefined) return defined;
        const inherited = Object.hasOwn(env, name) ? env[name] : undefined;
        return inherited ?? fallback ?? "";
      }),
    );
  }
  return Object.fromEntries(resolved);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** The values of `names` that `values` holds, readable by lookup and shown by nothing. */
function hiddenVariables(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
): Variables {
  const hidden: Record<string, string> = Object.create(null);
  for (const name of names) {
    const value = values[name];
    if (Object.hasOwn(values, name) && value !== undefined) {
      Object.defineProperty(hidden, name, { value, enumerable: false });
    }
  }
  return hidden;
}

/** The module `variable` selects (its default when the file does not set it), or a `ConfigError`. */
function selected(
  variable: string,
  chosen: string | undefined,
  fallback: string,
  held: Readonly<Record<string, ModuleVariables>>,
): readonly [name: string, module: ModuleVariables] {
  const name = chosen ?? fallback;
  const module = Object.hasOwn(held, name) ? held[name] : undefined;
  if (module === undefined) {
    throw new ConfigError(
      `${variable} is "${name}", which this daemon does not hold; the valid names are: ` +
        Object.keys(held).sort().join(", "),
    );
  }
  return [name, module];
}

/**
 * Read and validate `.env` for the modules it selects; throws ConfigError, never touches
 * `process.env`. The values a module's own checks refuse (the shape of a token) are its to
 * judge when it is built.
 */
export function loadConfig(
  modules: Modules,
  configDir: string = CONFIG_DIR,
  env: Env = process.env,
): Config {
  const envPath = join(configDir, ".env");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(envPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ConfigError(`${envPath} does not exist; see docs/setup.md, Part 2`);
    }
    throw error;
  }
  if (!st.isFile()) {
    throw new ConfigError(`${envPath} must be a regular file, not a link`);
  }
  // Ownership and mode are POSIX facts; the daemon is not supported on Windows yet.
  if (process.platform !== "win32") {
    if (st.uid !== process.getuid?.()) {
      throw new ConfigError(`${envPath} must belong to the user running awaydesk`);
    }
    // The tokens drive a shell on this machine: nobody but the owner may read them.
    if (st.mode & 0o077) {
      throw new ConfigError(`${envPath} is readable by others; run: chmod 600 ${envPath}`);
    }
  }

  const values: Record<string, string> = {};
  // A byte order mark would become part of the first variable's name.
  const text = readFileSync(envPath, "utf8").replace(/^\ufeff/, "");
  for (const [key, raw] of Object.entries(expandEnv(text, env))) {
    const value = raw?.trim();
    if (value) values[key] = value;
  }
  const [agent, agentModule] = selected(
    AGENT_VARIABLE,
    values[AGENT_VARIABLE],
    modules.defaults.agent,
    modules.agents,
  );
  const [chat, chatModule] = selected(
    CHAT_VARIABLE,
    values[CHAT_VARIABLE],
    modules.defaults.chat,
    modules.chats,
  );
  // The chat's, then the agent's, then the core's own.
  const missing = [...chatModule.required, ...agentModule.required, ...REQUIRED].filter(
    (key) => !Object.hasOwn(values, key),
  );
  if (missing.length > 0) {
    throw new ConfigError(`missing in ${envPath}: ${missing.join(", ")}`);
  }
  const written = values.ALLOWED_ROOT as string;
  const expanded = expandUser(written);
  // A relative path would read from the working directory: the terminal's folder at Checkpoint 2,
  // `/` under launchd.
  if (!isAbsolute(expanded)) {
    throw new ConfigError(
      `ALLOWED_ROOT must be an absolute path, or one starting with ~/; it is "${written}"`,
    );
  }
  const root = resolvePath(expanded);
  if (!isDirectory(root)) {
    throw new ConfigError(`ALLOWED_ROOT is not a directory: ${root}`);
  }
  return Object.defineProperties(
    { agent, chat, allowedRoot: root, configDir },
    {
      agentVariables: {
        value: hiddenVariables([...agentModule.required, ...agentModule.optional], values),
        enumerable: false,
      },
      chatVariables: {
        value: hiddenVariables([...chatModule.required, ...chatModule.optional], values),
        enumerable: false,
      },
    },
  ) as Config;
}
