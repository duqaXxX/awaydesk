/** `!guide`: the guide assembled from the parts of `texts.ts` that the agent and the chat can serve. */
import * as texts from "./texts.ts";
import { fill, type Named, type Names, named } from "./texts.ts";

/** What the agent and the chat have, each read from a capability: a part appears when its flag is on. */
export interface GuideOffer {
  /** The agent keeps a record of trust (`folderTrust`). */
  readonly folderTrust: boolean;
  /** The agent lists models (`models`). */
  readonly models: boolean;
  /** The agent has effort levels (`effortLevels` is not empty). */
  readonly efforts: boolean;
  /** The agent has a bypass mode (`permissionModes.bypass` is not null). */
  readonly bypass: boolean;
  /** The agent has commands of its own (`commands`). */
  readonly commands: boolean;
  /** The agent asks questions (`questions`). */
  readonly questions: boolean;
  /** The agent runs background tasks (`backgroundTasks`). */
  readonly backgroundTasks: boolean;
  /** The agent lists its sessions (`sessionListing`). */
  readonly sessionListing: boolean;
  /** The chat shows a file (`fileUpload`). */
  readonly fileUpload: boolean;
}

/** `a`, `a and b`, `a, b and c`. */
function joined(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The guide for these names, with only the parts `offered` says the pair can serve. */
export function guideText(names: Names, offered: GuideOffer): string {
  const say = (text: string | Named): string =>
    typeof text === "string" ? text : named(text, names);

  const choices = [
    offered.models ? texts.GUIDE_SETUP_MODEL : null,
    offered.efforts ? texts.GUIDE_SETUP_EFFORT : null,
    offered.bypass ? texts.GUIDE_SETUP_BYPASS : null,
  ].flatMap((item) => (item === null ? [] : [say(item)]));
  const start = [
    texts.GUIDE_START,
    say(offered.folderTrust ? texts.GUIDE_BIND_TRUSTED : texts.GUIDE_BIND_ANY),
    say(texts.GUIDE_FIRST_MESSAGE),
    ...(choices.length > 0 ? [fill(texts.GUIDE_SETUP, { choices: joined(choices) })] : []),
  ];

  const approvals = [
    say(texts.GUIDE_PERMISSION),
    ...(offered.questions ? [say(texts.GUIDE_QUESTION)] : []),
  ];

  const sessions =
    texts.GUIDE_SESSIONS_STATUS +
    (offered.backgroundTasks ? texts.GUIDE_SESSIONS_TASKS : "") +
    texts.GUIDE_SESSIONS_STOP +
    (offered.sessionListing ? ` ${texts.GUIDE_SESSIONS_RESUME}` : "") +
    ` ${texts.GUIDE_SESSIONS_TERMINAL}`;

  const [first, ...others] = names.newSession.map((name) => `\`!${name}\``);
  const newSession =
    first === undefined
      ? ""
      : ` ${fill(texts.GUIDE_NEW_SESSION, { names: others.length > 0 ? `${first} (${others.join(", ")})` : first })}`;
  const commands = say(texts.GUIDE_COMMANDS) + newSession;

  const sections = [
    say(texts.GUIDE_INTRO),
    start.join("\n"),
    ...(offered.commands ? [commands] : []),
    `${offered.questions ? texts.GUIDE_APPROVALS_AND_QUESTIONS : texts.GUIDE_APPROVALS}\n${approvals.join(" ")}`,
    sessions,
    ...(offered.fileUpload ? [say(texts.GUIDE_FILES)] : []),
    ...(offered.bypass ? [say(texts.GUIDE_BYPASS)] : []),
    texts.GUIDE_END,
  ];
  return sections.join("\n\n");
}
