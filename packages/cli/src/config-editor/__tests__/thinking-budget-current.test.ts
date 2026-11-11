/**
 * 预算形态的当前值：现有预设没有 budget 形态的模型，用定向的替身目录元数据覆盖。
 * 只证明编辑器对 budget 形态的标记与保留，不代表任何真实服务已接通预算参数。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@zhixing-ai/providers/configuration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhixing-ai/providers/configuration")>();
  const fixture = {
    name: "Budget fixture",
    baseUrl: "https://fixture.invalid",
    protocol: "openai-compatible",
    knownModels: [{
      id: "budget-model", name: "Budget model", contextWindow: 8192, maxOutputTokens: 1024,
      supportsTools: true, supportsThinking: true, thinkingControl: { type: "budget", range: [1024, 8192] },
    }],
  };
  return { ...actual, getPreset: (id: string) => (id === "budget-fixture" ? fixture : actual.getPreset(id)) };
});

const { createInitialState } = await import("../state.js");
const { buildThinkingConfigMeta, handleListPanelKey } = await import("../model/list.js");

describe("budget 形态的当前值", () => {
  it("在当前模型上回车后标出“自定义预算…”，Esc 返回仍保留预算", () => {
    const state = createInitialState(
      { llm: { main: { provider: "budget-fixture", model: "budget-model", thinking: { mode: "budget", budget: 4096 } } } },
      {},
    );
    const modelList = { kind: "model-list", role: "main", providerId: "budget-fixture" } as const;
    const selected = handleListPanelKey(state, modelList, { index: 0 }, { type: "enter" }).action;
    expect(selected.type).toBe("navigate");
    if (selected.type !== "navigate") throw Error("model selection did not open thinking");
    const thinking = { kind: "thinking-config", role: "main", providerId: "budget-fixture", model: "budget-model" } as const;
    expect(buildThinkingConfigMeta(selected.state, thinking).items.filter((item) => item.current).map((item) => item.label))
      .toEqual(["自定义预算…"]);
    const back = handleListPanelKey(selected.state, thinking, { index: 0 }, { type: "escape" }).action;
    expect(back.type === "pop" && back.state.config.llm?.main?.thinking).toEqual({ mode: "budget", budget: 4096 });
  });
});
