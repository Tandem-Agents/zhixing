/**
 * PR4 思考控制 panel 行为测试。
 *
 * 用真实 deepseek preset 数据（deepseek-v4-pro 有 effort 形态、
 * deepseek-v4-flash 无 thinkingControl），不造伪元数据：
 *   - model 选定后：有可配形态 → navigate 到 thinking-config；none → pop
 *   - thinking-config 按 ThinkingControl 渲染正确选项并写 config.llm.<role>.thinking
 *   - thinking-budget 输入：合法数值写 budget；非法取消不写
 */

import { describe, expect, it } from "vitest";
import { createInitialState, writeModelRole } from "../state.js";
import { handleListPanelKey } from "../panels/list.js";
import { handleThinkingBudgetPanelKey } from "../panels/input.js";
import type { PanelDescriptor, WorkingState } from "../types.js";

const modelListDesc = {
  kind: "model-list",
  role: "main",
  providerId: "deepseek",
} as Extract<PanelDescriptor, { kind: "model-list" }>;

function enterAt(
  state: WorkingState,
  descriptor: PanelDescriptor,
  index: number,
) {
  return handleListPanelKey(state, descriptor, { index }, { type: "enter" });
}

describe("model-list 选定后导航", () => {
  it("选有 thinkingControl 的 model（deepseek-v4-pro）→ navigate 到 thinking-config", () => {
    const state = createInitialState({}, {});
    // items: [deepseek-v4-pro(0, main 推荐), deepseek-v4-flash(1), + 添加自定义(2)]
    const { action } = enterAt(state, modelListDesc, 0);

    expect(action.type).toBe("navigate");
    if (action.type === "navigate") {
      expect(action.panel).toEqual({
        kind: "thinking-config",
        role: "main",
        providerId: "deepseek",
        model: "deepseek-v4-pro",
      });
      expect(action.state.config.llm?.main).toEqual({
        provider: "deepseek",
        model: "deepseek-v4-pro",
      });
    }
  });

  it("选无 thinkingControl 的 model（deepseek-v4-flash）→ 直接 pop，不进思考步骤", () => {
    const state = createInitialState({}, {});
    const { action } = enterAt(state, modelListDesc, 1);

    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.config.llm?.main?.model).toBe("deepseek-v4-flash");
      expect(action.state.config.llm?.main?.thinking).toBeUndefined();
    }
  });
});

describe("model-list 选定 · provider 取 descriptor 权威上下文（回归）", () => {
  it("角色已配旧 provider，在另一 provider 列表选 model → 切换到 descriptor.providerId", () => {
    // 复现：模板默认 main=deepseek；用户改选 siliconflow 后进 siliconflow
    // 列表选 model。旧实现 `currentRole?.provider ?? descriptor.providerId`
    // 会把 model 错写到陈旧的 deepseek 下，导致 siliconflow 侧永远「待选」。
    // 这里反向布置（已配 siliconflow，进 deepseek 列表选）等价验证同一根因。
    const stale = writeModelRole(
      createInitialState({}, {}),
      "main",
      "siliconflow",
      "deepseek-ai/DeepSeek-V4-Flash",
    );
    const { action } = enterAt(stale, modelListDesc, 0); // modelListDesc.providerId = deepseek

    const main =
      action.type === "navigate"
        ? action.state.config.llm?.main
        : action.type === "pop"
          ? action.state.config.llm?.main
          : undefined;
    // provider 必须切到用户当前浏览的 deepseek（descriptor.providerId），
    // 不得停留在陈旧的 siliconflow；model 为所选项。
    expect(main).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });
});

describe("thinking-config 渲染与写入（deepseek-v4-pro = effort 形态）", () => {
  const thinkingDesc = {
    kind: "thinking-config",
    role: "main",
    providerId: "deepseek",
    model: "deepseek-v4-pro",
  } as Extract<PanelDescriptor, { kind: "thinking-config" }>;

  // effort 形态选项序：关闭思考(0) / 开启默认强度(1) / 强度 high(2) / 强度 max(3)
  it("选『关闭思考』→ pop 并写 {mode:off}", () => {
    const state = createInitialState({}, {});
    const { action } = enterAt(state, thinkingDesc, 0);
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.config.llm?.main?.thinking).toEqual({ mode: "off" });
    }
  });

  it("选『开启（服务端默认强度）』→ 写 {mode:on}", () => {
    const state = createInitialState({}, {});
    const { action } = enterAt(state, thinkingDesc, 1);
    if (action.type === "pop") {
      expect(action.state.config.llm?.main?.thinking).toEqual({ mode: "on" });
    }
  });

  it("选官方档『强度 max』→ 写 {mode:effort,effort:max}（原值不映射）", () => {
    const state = createInitialState({}, {});
    const { action } = enterAt(state, thinkingDesc, 3);
    if (action.type === "pop") {
      expect(action.state.config.llm?.main?.thinking).toEqual({
        mode: "effort",
        effort: "max",
      });
    }
  });
});

describe("handleThinkingBudgetPanelKey", () => {
  const budgetDesc = {
    kind: "thinking-budget",
    role: "main",
    providerId: "qwen",
    model: "qwen-max",
  } as Extract<PanelDescriptor, { kind: "thinking-budget" }>;

  it("合法整数 → pop 并写 {mode:budget,budget:N}", () => {
    let state = createInitialState({}, {});
    state = { ...state, inputBuffer: "8000" };
    const action = handleThinkingBudgetPanelKey(state, budgetDesc, {
      type: "enter",
    });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.config.llm?.main?.thinking).toEqual({
        mode: "budget",
        budget: 8000,
      });
      expect(action.state.inputBuffer).toBe("");
    }
  });

  it("非数字 → 取消不写", () => {
    let state = createInitialState({}, {});
    state = { ...state, inputBuffer: "abc" };
    const action = handleThinkingBudgetPanelKey(state, budgetDesc, {
      type: "enter",
    });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.config.llm?.main?.thinking).toBeUndefined();
    }
  });

  it("Esc → 丢弃 buffer 并 pop", () => {
    let state = createInitialState({}, {});
    state = { ...state, inputBuffer: "123" };
    const action = handleThinkingBudgetPanelKey(state, budgetDesc, {
      type: "escape",
    });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.inputBuffer).toBe("");
    }
  });
});
