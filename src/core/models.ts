import type { ModelInfo } from "../agent/seam.ts";
import { DEFAULT } from "./setup.ts";

/**
 * How the agent's own model list names the model with this full id: its display name, or the id
 * itself when the list does not hold it. The `default` entry is skipped, since it stands for
 * whichever model the agent picks and not for one of its own.
 */
export function modelName(models: readonly ModelInfo[], id: string): string {
  const listed = models.find((m) => m.value !== DEFAULT && m.resolvedModel === id);
  return listed === undefined ? id : listed.displayName;
}
