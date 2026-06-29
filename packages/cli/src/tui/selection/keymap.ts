import type * as readline from "node:readline";

import type {
  SelectionAction,
  SelectionState,
} from "./state.js";

export function translateSelectionKeypress(
  str: string,
  key: readline.Key | undefined,
  state: SelectionState,
): SelectionAction | null {
  if (state.layer === "input") {
    if (key?.name === "return") return { kind: "enter" };
    if (key?.name === "escape") return { kind: "escape" };
    if (key?.name === "backspace") return { kind: "backspace" };
    if (isTextKeypress(str, key)) return { kind: "char", ch: str };
    return null;
  }
  if (state.layer === "details") {
    if (key?.name === "up") return { kind: "up" };
    if (key?.name === "down") return { kind: "down" };
    if (key?.name === "left") return { kind: "left" };
    if (key?.name === "return") return { kind: "enter" };
    if (key?.name === "escape") return { kind: "escape" };
    return null;
  }

  if (key?.name === "up") return { kind: "up" };
  if (key?.name === "down") return { kind: "down" };
  if (key?.name === "right") return { kind: "details" };
  if (key?.name === "return") return { kind: "enter" };
  if (key?.name === "escape") return { kind: "escape" };
  if (isTextKeypress(str, key)) return { kind: "hotkey", key: str };
  return null;
}

function isTextKeypress(
  str: string,
  key: readline.Key | undefined,
): boolean {
  return Boolean(
    str &&
      !key?.ctrl &&
      !key?.meta &&
      str !== "\r" &&
      str !== "\n" &&
      !str.startsWith("\x1b"),
  );
}
