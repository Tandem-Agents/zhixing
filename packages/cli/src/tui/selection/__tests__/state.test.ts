import { describe, expect, it } from "vitest";

import {
  makeInitialSelectionState,
  reduceSelection,
  type SelectionState,
} from "../state.js";
import { validateSelectionRequest } from "../types.js";

function makeRequest() {
  return validateSelectionRequest({
    title: "选择操作",
    options: [
      { value: "allow", label: "允许", hotkey: "a" },
      { value: "disabled", label: "不可用", disabled: true },
      {
        value: "name",
        label: "输入名称",
        hotkey: "n",
        input: { placeholder: "名称" },
      },
      {
        value: "delete",
        label: "删除",
        hotkey: "d",
        confirm: { title: "确认删除" },
      },
    ],
  });
}

describe("selection state reducer", () => {
  it("starts at the validated initial option and skips disabled rows", () => {
    const request = makeRequest();
    const initial = makeInitialSelectionState(request);
    expect(initial).toEqual({
      selectedIndex: 0,
      layer: "select",
      inputBuffer: "",
    });

    const down = reduceSelection(initial, { kind: "down" }, request).state;
    expect(down.selectedIndex).toBe(2);

    const up = reduceSelection(down, { kind: "up" }, request).state;
    expect(up.selectedIndex).toBe(0);
  });

  it("selects plain options and cancels with escape", () => {
    const request = makeRequest();
    const state = makeInitialSelectionState(request);

    expect(
      reduceSelection(state, { kind: "enter" }, request).result,
    ).toEqual({ kind: "selected", value: "allow" });

    expect(
      reduceSelection(state, { kind: "escape" }, request).result,
    ).toEqual({ kind: "cancelled", cause: "escape" });
  });

  it("hotkeys activate input and confirm layers instead of bypassing them", () => {
    const request = makeRequest();
    const state = makeInitialSelectionState(request);

    const input = reduceSelection(state, { kind: "hotkey", key: "N" }, request);
    expect(input.result).toBeUndefined();
    expect(input.state).toMatchObject({ selectedIndex: 2, layer: "input" });

    const confirm = reduceSelection(state, { kind: "hotkey", key: "d" }, request);
    expect(confirm.result).toBeUndefined();
    expect(confirm.state).toMatchObject({ selectedIndex: 3, layer: "confirm" });
  });

  it("input layer submits text, blocks empty submit by default, and deletes by code point", () => {
    const request = makeRequest();
    let state = reduceSelection(
      makeInitialSelectionState(request),
      { kind: "hotkey", key: "n" },
      request,
    ).state;

    expect(
      reduceSelection(state, { kind: "enter" }, request).result,
    ).toBeUndefined();

    state = reduceSelection(state, { kind: "char", ch: "你" }, request).state;
    state = reduceSelection(state, { kind: "char", ch: "好" }, request).state;
    state = reduceSelection(state, { kind: "backspace" }, request).state;

    expect(state.inputBuffer).toBe("你");
    expect(
      reduceSelection(state, { kind: "enter" }, request).result,
    ).toEqual({ kind: "selected", value: "name", input: "你" });
  });

  it("input layer can explicitly allow empty submit", () => {
    const request = validateSelectionRequest({
      title: "选择",
      options: [
        {
          value: "note",
          label: "备注",
          input: { placeholder: "可留空", allowEmpty: true },
        },
      ],
    });
    const inputState = reduceSelection(
      makeInitialSelectionState(request),
      { kind: "enter" },
      request,
    ).state;

    expect(
      reduceSelection(inputState, { kind: "enter" }, request).result,
    ).toEqual({ kind: "selected", value: "note", input: "" });
  });

  it("confirm layer requires enter and returns to select on escape", () => {
    const request = makeRequest();
    const confirmState = reduceSelection(
      makeInitialSelectionState(request),
      { kind: "hotkey", key: "d" },
      request,
    ).state;

    expect(
      reduceSelection(confirmState, { kind: "enter" }, request).result,
    ).toEqual({ kind: "selected", value: "delete" });

    const returned = reduceSelection(
      confirmState,
      { kind: "escape" },
      request,
    ).state;
    expect(returned).toMatchObject<Partial<SelectionState>>({
      selectedIndex: 3,
      layer: "select",
      inputBuffer: "",
    });
  });
});
