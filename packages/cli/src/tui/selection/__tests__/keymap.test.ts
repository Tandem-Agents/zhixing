import type * as readline from "node:readline";

import { describe, expect, it } from "vitest";

import { translateSelectionKeypress } from "../keymap.js";
import {
  makeInitialSelectionState,
  reduceSelection,
} from "../state.js";
import { validateSelectionRequest } from "../types.js";

function key(name: string, extra: Partial<readline.Key> = {}): readline.Key {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: extra.sequence ?? name,
    ...extra,
  };
}

describe("translateSelectionKeypress", () => {
  it("maps selection layer navigation, disclosure, submit, cancel, and hotkeys", () => {
    const request = validateSelectionRequest({
      title: "选择",
      details: { title: "完整说明", body: ["一"] },
      options: [{ value: "continue", label: "继续", hotkey: "c" }],
    });
    const state = makeInitialSelectionState(request);

    expect(translateSelectionKeypress("", key("up"), state)).toEqual({
      kind: "up",
    });
    expect(translateSelectionKeypress("", key("down"), state)).toEqual({
      kind: "down",
    });
    expect(translateSelectionKeypress("", key("right"), state)).toEqual({
      kind: "details",
    });
    expect(translateSelectionKeypress("", key("return"), state)).toEqual({
      kind: "enter",
    });
    expect(translateSelectionKeypress("", key("escape"), state)).toEqual({
      kind: "escape",
    });
    expect(translateSelectionKeypress("c", key("c"), state)).toEqual({
      kind: "hotkey",
      key: "c",
    });
  });

  it("keeps terminal escape sequences out of text and hotkey input", () => {
    const request = validateSelectionRequest({
      title: "选择",
      options: [
        {
          value: "name",
          label: "输入名称",
          input: { placeholder: "名称" },
        },
      ],
    });
    const selectState = makeInitialSelectionState(request);
    const inputState = reduceSelection(
      selectState,
      { kind: "enter" },
      request,
    ).state;

    expect(
      translateSelectionKeypress("\x1b[A", undefined, selectState),
    ).toBeNull();
    expect(
      translateSelectionKeypress(
        "\x1b[A",
        key("up", { sequence: "\x1b[A" }),
        inputState,
      ),
    ).toBeNull();
    expect(translateSelectionKeypress("你", key("你"), inputState)).toEqual({
      kind: "char",
      ch: "你",
    });
  });

  it("maps details layer scrolling and return controls only", () => {
    const request = validateSelectionRequest({
      title: "选择",
      details: { title: "完整说明", body: ["一", "二"] },
      options: [{ value: "continue", label: "继续" }],
    });
    const detailsState = reduceSelection(
      makeInitialSelectionState(request),
      { kind: "details" },
      request,
    ).state;

    expect(translateSelectionKeypress("", key("up"), detailsState)).toEqual({
      kind: "up",
    });
    expect(translateSelectionKeypress("", key("down"), detailsState)).toEqual({
      kind: "down",
    });
    expect(translateSelectionKeypress("", key("left"), detailsState)).toEqual({
      kind: "left",
    });
    expect(translateSelectionKeypress("", key("return"), detailsState)).toEqual({
      kind: "enter",
    });
    expect(translateSelectionKeypress("", key("escape"), detailsState)).toEqual({
      kind: "escape",
    });
    expect(translateSelectionKeypress("c", key("c"), detailsState)).toBeNull();
  });
});
