import {
  createMaterialTokenPattern,
  MATERIAL_TOKEN_PATTERN,
} from "./input-material-registry.js";
import {
  createPasteTokenPattern,
  PASTE_TOKEN_PATTERN,
} from "./paste-registry.js";

export const INPUT_HANDLE_TOKEN_PATTERNS: readonly RegExp[] = [
  PASTE_TOKEN_PATTERN,
  MATERIAL_TOKEN_PATTERN,
];

export function createInputHandleTokenPatterns(): readonly RegExp[] {
  return [createPasteTokenPattern(), createMaterialTokenPattern()];
}
