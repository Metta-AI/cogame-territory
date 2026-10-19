import { createHash } from "node:crypto";
import { selectionMetadata, type PromptSelection } from "./prompt-selection.js";

export function promptMetadata(selection: PromptSelection, system: string, user: string) {
  return {
    ...selectionMetadata(selection),
    system_sha256: createHash("sha256").update(system).digest("hex"),
    user_sha256: createHash("sha256").update(user).digest("hex"),
  };
}
