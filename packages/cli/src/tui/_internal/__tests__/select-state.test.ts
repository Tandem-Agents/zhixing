import { describe, expect, it } from "vitest";
import type { SelectOption } from "../../select-types.js";
import {
  makeInitialSelectState,
  reduceSelect,
  type SelectAction,
} from "../select-state.js";

const simpleOpt = (value: string, hotkey?: string): SelectOption => ({
  type: "simple",
  value,
  label: value,
  hotkey,
});

const inputOpt = (
  value: string,
  opts: { hotkey?: string; allowEmptySubmit?: boolean } = {},
): SelectOption => ({
  type: "input",
  value,
  label: value,
  placeholder: `请输入 ${value}`,
  hotkey: opts.hotkey,
  allowEmptySubmit: opts.allowEmptySubmit,
});

describe("makeInitialSelectState", () => {
  it("默认 selected=0 + inputMode=false + 空 buffer", () => {
    const state = makeInitialSelectState([simpleOpt("a"), simpleOpt("b")]);
    expect(state).toEqual({ selected: 0, inputMode: false, inputBuffer: "" });
  });

  it("initialSelected 在合法范围内透传", () => {
    const state = makeInitialSelectState(
      [simpleOpt("a"), simpleOpt("b"), simpleOpt("c")],
      1,
    );
    expect(state.selected).toBe(1);
  });

  it("initialSelected 越界 clamp 到范围内", () => {
    expect(
      makeInitialSelectState([simpleOpt("a")], 5).selected,
    ).toBe(0);
    expect(
      makeInitialSelectState([simpleOpt("a"), simpleOpt("b")], -1).selected,
    ).toBe(0);
  });
});

describe("reduceSelect — select 模式", () => {
  const options = [simpleOpt("a", "1"), simpleOpt("b", "2"), simpleOpt("c")];

  it("up 减小 selected，到顶部 clamp 不变", () => {
    let { state } = reduceSelect(
      makeInitialSelectState(options, 1),
      { kind: "up" },
      options,
    );
    expect(state.selected).toBe(0);
    ({ state } = reduceSelect(state, { kind: "up" }, options));
    expect(state.selected).toBe(0); // 已在顶不变
  });

  it("down 增大 selected，到底部 clamp 不变", () => {
    let { state } = reduceSelect(
      makeInitialSelectState(options, 1),
      { kind: "down" },
      options,
    );
    expect(state.selected).toBe(2);
    ({ state } = reduceSelect(state, { kind: "down" }, options));
    expect(state.selected).toBe(2); // 已在底不变
  });

  it("enter on simple → result selected", () => {
    const { result } = reduceSelect(
      makeInitialSelectState(options),
      { kind: "enter" },
      options,
    );
    expect(result).toEqual({ kind: "selected", value: "a" });
  });

  it("enter on input → 切到 input 模式（不产 result）", () => {
    const opts = [simpleOpt("a"), inputOpt("note")];
    const { state, result } = reduceSelect(
      makeInitialSelectState(opts, 1),
      { kind: "enter" },
      opts,
    );
    expect(result).toBeUndefined();
    expect(state.inputMode).toBe(true);
    expect(state.inputBuffer).toBe("");
  });

  it("escape → cancelled escape", () => {
    const { result } = reduceSelect(
      makeInitialSelectState(options),
      { kind: "escape" },
      options,
    );
    expect(result).toEqual({ kind: "cancelled", cause: "escape" });
  });

  it("hotkey 匹配 simple → 选中并产 result", () => {
    const { state, result } = reduceSelect(
      makeInitialSelectState(options),
      { kind: "hotkey", key: "2" },
      options,
    );
    expect(state.selected).toBe(1);
    expect(result).toEqual({ kind: "selected", value: "b" });
  });

  it("hotkey 匹配 input → 切到 input 模式不产 result", () => {
    const opts = [simpleOpt("a"), inputOpt("note", { hotkey: "n" })];
    const { state, result } = reduceSelect(
      makeInitialSelectState(opts),
      { kind: "hotkey", key: "n" },
      opts,
    );
    expect(result).toBeUndefined();
    expect(state.selected).toBe(1);
    expect(state.inputMode).toBe(true);
  });

  it("hotkey 不匹配 → 状态不变", () => {
    const state0 = makeInitialSelectState(options);
    const { state, result } = reduceSelect(
      state0,
      { kind: "hotkey", key: "z" },
      options,
    );
    expect(state).toBe(state0);
    expect(result).toBeUndefined();
  });

  it("input 模式专属 action 在 select 模式无效（char / backspace）", () => {
    const state0 = makeInitialSelectState(options);
    expect(reduceSelect(state0, { kind: "char", ch: "x" }, options).state).toBe(
      state0,
    );
    expect(reduceSelect(state0, { kind: "backspace" }, options).state).toBe(
      state0,
    );
  });
});

describe("reduceSelect — input 模式", () => {
  const options: SelectOption[] = [
    simpleOpt("a"),
    inputOpt("note"),
  ];
  function inInputMode(): ReturnType<typeof makeInitialSelectState> {
    return { selected: 1, inputMode: true, inputBuffer: "" };
  }

  it("char append 到 buffer", () => {
    let { state } = reduceSelect(
      inInputMode(),
      { kind: "char", ch: "h" },
      options,
    );
    expect(state.inputBuffer).toBe("h");
    ({ state } = reduceSelect(state, { kind: "char", ch: "i" }, options));
    expect(state.inputBuffer).toBe("hi");
  });

  it("backspace 删 buffer 末尾，空 buffer no-op", () => {
    const state0 = { ...inInputMode(), inputBuffer: "hi" };
    let { state } = reduceSelect(state0, { kind: "backspace" }, options);
    expect(state.inputBuffer).toBe("h");
    ({ state } = reduceSelect(state, { kind: "backspace" }, options));
    expect(state.inputBuffer).toBe("");
    // 空 buffer 再 backspace —— no-op
    ({ state } = reduceSelect(state, { kind: "backspace" }, options));
    expect(state.inputBuffer).toBe("");
  });

  it("backspace 按 code point 删（代理对安全）", () => {
    // U+1F600 GRINNING FACE 是 surrogate pair —— pop 应删整个 emoji
    const state0 = { ...inInputMode(), inputBuffer: "a\u{1F600}" };
    const { state } = reduceSelect(state0, { kind: "backspace" }, options);
    expect(state.inputBuffer).toBe("a");
  });

  it("enter 非空 buffer → result selected with note", () => {
    const state0 = { ...inInputMode(), inputBuffer: "hello" };
    const { result } = reduceSelect(state0, { kind: "enter" }, options);
    expect(result).toEqual({
      kind: "selected",
      value: "note",
      note: "hello",
    });
  });

  it("enter 空 buffer 且 !allowEmptySubmit → no-op（吃掉按键，保持 input 模式）", () => {
    const state0 = inInputMode();
    const { state, result } = reduceSelect(state0, { kind: "enter" }, options);
    expect(result).toBeUndefined();
    expect(state).toBe(state0);
  });

  it("enter 空 buffer + allowEmptySubmit → result selected（无 note）", () => {
    const opts: SelectOption[] = [
      simpleOpt("a"),
      inputOpt("note", { allowEmptySubmit: true }),
    ];
    const { result } = reduceSelect(
      inInputMode(),
      { kind: "enter" },
      opts,
    );
    expect(result).toEqual({ kind: "selected", value: "note" });
    if (result?.kind === "selected") {
      expect(result.note).toBeUndefined();
    }
  });

  it("escape → 退回 select 模式（不取消整个面板）", () => {
    const state0 = { ...inInputMode(), inputBuffer: "abc" };
    const { state, result } = reduceSelect(
      state0,
      { kind: "escape" },
      options,
    );
    expect(result).toBeUndefined();
    expect(state.inputMode).toBe(false);
    expect(state.inputBuffer).toBe("");
  });

  it("select 模式专属 action 在 input 模式无效（up / down / hotkey）", () => {
    const state0 = inInputMode();
    expect(reduceSelect(state0, { kind: "up" }, options).state).toBe(state0);
    expect(reduceSelect(state0, { kind: "down" }, options).state).toBe(state0);
    expect(
      reduceSelect(state0, { kind: "hotkey", key: "a" }, options).state,
    ).toBe(state0);
  });

  it("异常态防御——inputMode=true 但 current 非 input 类型，回到 select 模式", () => {
    // 构造异常 state：inputMode=true 但 selected 指向 simple 选项
    const badState = { selected: 0, inputMode: true, inputBuffer: "x" };
    const { state } = reduceSelect(badState, { kind: "char", ch: "y" }, options);
    expect(state.inputMode).toBe(false);
    expect(state.inputBuffer).toBe("");
  });
});

describe("reduceSelect — immutability", () => {
  it("reducer 不修改入参 state", () => {
    const options = [simpleOpt("a"), simpleOpt("b")];
    const state0 = makeInitialSelectState(options);
    const original = { ...state0 };
    reduceSelect(state0, { kind: "down" }, options);
    expect(state0).toEqual(original);
  });

  it("返回新对象（reference 不等）", () => {
    const options = [simpleOpt("a"), simpleOpt("b")];
    const state0 = makeInitialSelectState(options);
    const { state } = reduceSelect(state0, { kind: "down" }, options);
    expect(state).not.toBe(state0);
  });

  it("无状态变化时返回同一引用（reducer 微优化）", () => {
    const options = [simpleOpt("a")];
    const state0 = makeInitialSelectState(options);
    // up 在 selected=0 时无变化
    const { state } = reduceSelect(state0, { kind: "up" }, options);
    expect(state).toBe(state0);
  });
});
