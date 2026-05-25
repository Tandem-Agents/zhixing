/**
 * 主面板 handler 测试 —— 全局快捷键（Esc / Ctrl+C 退出、Ctrl+S 完成）。
 *
 * 不渲染、纯逻辑：buildOptions 只用 ctx.sections（+ 可选 runtime），故 ctx 可最小构造。
 * 用 mcp section（全可选、无完成门槛）测"直接完成"，用 model section（主模型必填）测"被拦"。
 */

import { describe, expect, it } from "vitest";
import { handleMainPanelKey, initialMainCursor } from "../panels/main.js";
import { createInitialState } from "../state.js";
import type { ConfigEditorContext, SectionId, WorkingState } from "../types.js";

function ctxWith(sections: SectionId[]): ConfigEditorContext {
  return { sections } as unknown as ConfigEditorContext;
}

const state: WorkingState = createInitialState({} as never, {} as never);

describe("handleMainPanelKey — 全局快捷键", () => {
  it("Esc → 退出（cancelled），与 Ctrl+C 等价（主面板是顶层）", () => {
    const esc = handleMainPanelKey(ctxWith(["mcp"]), state, initialMainCursor(), {
      type: "escape",
    });
    expect(esc.action.type).toBe("exit");
    if (esc.action.type === "exit") expect(esc.action.result.kind).toBe("cancelled");

    const cc = handleMainPanelKey(ctxWith(["mcp"]), state, initialMainCursor(), {
      type: "ctrl-c",
    });
    expect(cc.action).toEqual(esc.action);
  });

  it("Ctrl+S → 完成；mcp 全可选无门槛 → completed", () => {
    const r = handleMainPanelKey(ctxWith(["mcp"]), state, initialMainCursor(), {
      type: "ctrl-s",
    });
    expect(r.action.type).toBe("exit");
    if (r.action.type === "exit") expect(r.action.result.kind).toBe("completed");
  });

  it("Ctrl+S → 有必填缺失（主模型未配）则不完成、原地回显错误", () => {
    const r = handleMainPanelKey(ctxWith(["model"]), state, initialMainCursor(), {
      type: "ctrl-s",
    });
    expect(r.action.type).toBe("stay");
    expect(r.errorMessage).toBeTruthy();
  });
});
