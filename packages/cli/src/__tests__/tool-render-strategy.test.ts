import { describe, expect, it } from "vitest";
import {
  TOOL_RENDER_STRATEGY,
  getToolRenderStrategy,
  type ToolRenderStrategy,
} from "../tool-render-strategy.js";

describe("tool-render-strategy · 单一事实源契约", () => {
  it("Task 工具策略 = 'sub-agent-status'(主路径不渲染,状态条接管)", () => {
    expect(getToolRenderStrategy("Task")).toBe<ToolRenderStrategy>(
      "sub-agent-status",
    );
  });

  it("副作用白名单工具(write / edit / schedule) = 'side-effect'", () => {
    for (const name of ["write", "edit", "schedule"]) {
      expect(getToolRenderStrategy(name)).toBe<ToolRenderStrategy>(
        "side-effect",
      );
    }
  });

  it("二义性工具(bash / memory / web_fetch) 不入副作用白名单——归 default", () => {
    // bash:    `ls` 读 vs `npm install` 写
    // memory:  `search / list` 读 vs `save / update / delete` 写
    //          (LLM 高频 list/search 调用,整体归 side-effect 会稀释真正 save 的信号)
    // web_fetch: stateless 网络请求,归探索
    for (const name of ["bash", "memory", "web_fetch"]) {
      expect(getToolRenderStrategy(name)).toBe<ToolRenderStrategy>("default");
    }
  });

  it("探索类工具(read / grep / glob) 兜底 = 'default'", () => {
    for (const name of ["read", "grep", "glob"]) {
      expect(getToolRenderStrategy(name)).toBe<ToolRenderStrategy>("default");
    }
  });

  it("空字符串 / 未知工具名也兜底 default(防御性)", () => {
    expect(getToolRenderStrategy("")).toBe<ToolRenderStrategy>("default");
    expect(getToolRenderStrategy("unknown-future-tool")).toBe<ToolRenderStrategy>(
      "default",
    );
  });

  it("TOOL_RENDER_STRATEGY 表当前内容 byte-equal 锚点(防误改/误删)", () => {
    // 锚定本表当前显式注册的工具集合 —— 任何加表 / 改表 / 删表都必须更新本断言,
    // 强迫开发者意识到自己改了"哪些工具走非默认渲染"的全局事实源
    expect(TOOL_RENDER_STRATEGY).toStrictEqual({
      Task: "sub-agent-status",
      write: "side-effect",
      edit: "side-effect",
      schedule: "side-effect",
      save_skill: "side-effect",
      admit_skill: "side-effect",
    });
  });

  it("Object.freeze 运行期不变量:isFrozen=true + 任意 mutate 在 strict 模式抛 TypeError", () => {
    // 编译期 Readonly 类型 + 运行期 freeze 双层防御 —— 本表是"哪个工具走非默认
    // 渲染"的全局事实源,任何运行期 mutate 都会破坏多侧消费方(renderer / coordinator /
    // status-bar)的渲染契约(回归 P0 双重渲染问题)
    expect(Object.isFrozen(TOOL_RENDER_STRATEGY)).toBe(true);

    // strict mode 下改已存在 key、加新 key、删 key 都应抛 TypeError
    // (vitest 跑 ESM 自动 strict mode,无需显式声明)
    const mutable = TOOL_RENDER_STRATEGY as Record<string, ToolRenderStrategy>;
    expect(() => {
      mutable["Task"] = "default";
    }).toThrow(TypeError);
    expect(() => {
      mutable["NewTool"] = "default";
    }).toThrow(TypeError);
    expect(() => {
      delete mutable["Task"];
    }).toThrow(TypeError);
  });
});
