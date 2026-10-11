/** What `!guide` is told when the agent and the chat declare every capability, as Claude and Slack do. */
import type { GuideOffer } from "../../src/core/guide.ts";

export const EVERYTHING_OFFERED: GuideOffer = {
  folderTrust: true,
  models: true,
  efforts: true,
  bypass: true,
  commands: true,
  questions: true,
  backgroundTasks: true,
  sessionListing: true,
  fileUpload: true,
};
