import path from "node:path";
import { getZhixingHome, toSafePathSegment } from "../paths.js";

export const ADVANCEMENT_LOG_FILE = "advancement.jsonl";

export function getAdvancementRoot(): string {
  return path.join(getZhixingHome(), "advancement");
}

export function advancementConversationDir(
  root: string,
  conversationId: string,
): string {
  return path.join(root, toSafePathSegment(conversationId));
}

export function advancementLogPath(root: string, conversationId: string): string {
  return path.join(
    advancementConversationDir(root, conversationId),
    ADVANCEMENT_LOG_FILE,
  );
}
