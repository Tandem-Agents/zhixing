/**
 * mcp section + mcp-server 详情面板 handler 测试（纯逻辑，无 UI / 无异步）。
 *
 * 关键不变量：
 *   - 列表来自 config（含已停用 server），运行态按 serverId 叠加
 *   - 连接中的 server 归 ready（靠 statusText 区分），绝不 blocked——不阻塞编辑器"完成"
 *   - 启停 / 删除是 WorkingState 事务变更
 */

import { describe, expect, it } from "vitest";
import type { McpServerStatus } from "@zhixing/mcp";
import { createInitialState } from "../state.js";
import { mcpSection } from "../sections/mcp.js";
import { handleMcpServerPanelKey } from "../panels/mcp.js";
import type { ConfigEditorRuntime, WorkingState } from "../types.js";

function stateWith(servers: Record<string, unknown>): WorkingState {
  return createInitialState({ mcp: { servers } } as never, {});
}

function runtimeOf(statuses: McpServerStatus[]): ConfigEditorRuntime {
  return { mcpServerStatuses: () => statuses };
}

describe("mcpSection.entries", () => {
  it("空配置 → 无条目", () => {
    expect(mcpSection.entries(createInitialState({}, {}))).toEqual([]);
  });

  it("列出 config 中全部 server（含已停用），enterTarget 指向 mcp-server", () => {
    const state = stateWith({
      github: { type: "http", url: "https://x" },
      old: { type: "stdio", command: "c", enabled: false },
    });
    const entries = mcpSection.entries(state);
    expect(entries.map((e) => e.label)).toEqual(["github", "old"]);
    expect(entries[0]!.enterTarget).toEqual({ kind: "mcp-server", serverId: "github" });
    // 已停用 → disabled
    expect(entries[1]!.state).toEqual({ kind: "disabled", statusText: "已停用" });
  });

  it("叠加运行态：connected 显示工具数、connecting 显示原因，均为 ready（不 blocked）", () => {
    const state = stateWith({
      a: { type: "stdio", command: "c" },
      b: { type: "stdio", command: "c" },
      c: { type: "stdio", command: "c" },
    });
    const runtime = runtimeOf([
      { serverId: "a", transport: "stdio", status: "connected", toolCount: 14 },
      { serverId: "b", transport: "stdio", status: "connecting", toolCount: 0, error: "spawn failed" },
      // c 无运行态
    ]);
    const entries = mcpSection.entries(state, runtime);
    expect(entries[0]!.state).toEqual({ kind: "ready", statusText: "已连接 · 14 工具" });
    expect(entries[1]!.state).toEqual({ kind: "ready", statusText: "连接中 · spawn failed" });
    expect(entries[2]!.state).toEqual({ kind: "ready", statusText: "已启用" });
    // 没有任何 blocked（连接中不阻塞完成）
    expect(entries.every((e) => e.state.kind !== "blocked")).toBe(true);
  });

  it("列表来源是 config——已停用 server 不在 serverStatuses 也仍出现", () => {
    const state = stateWith({ off: { type: "stdio", command: "c", enabled: false } });
    // runtime 不含 off（停用 server 不受管），列表仍要列出它供重新启用
    const entries = mcpSection.entries(state, runtimeOf([]));
    expect(entries.map((e) => e.label)).toEqual(["off"]);
  });
});

describe("handleMcpServerPanelKey", () => {
  const desc = { kind: "mcp-server", serverId: "x" } as const;
  const base = stateWith({ x: { type: "stdio", command: "c" } });

  it("启停（cursor 0 + Enter）翻转 enabled、stay", () => {
    const r = handleMcpServerPanelKey(base, desc, { index: 0 }, { type: "enter" });
    expect(r.action.type).toBe("stay");
    if (r.action.type === "stay") {
      expect(r.action.state.config.mcp?.servers?.x?.enabled).toBe(false);
    }
  });

  it("删除（cursor 1 + Enter）移除 server、pop", () => {
    const r = handleMcpServerPanelKey(base, desc, { index: 1 }, { type: "enter" });
    expect(r.action.type).toBe("pop");
    if (r.action.type === "pop") {
      expect(r.action.state.config.mcp?.servers?.x).toBeUndefined();
    }
  });

  it("方向键在两个动作间环绕", () => {
    expect(
      handleMcpServerPanelKey(base, desc, { index: 0 }, { type: "arrow-up" }).cursor,
    ).toEqual({ index: 1 });
    expect(
      handleMcpServerPanelKey(base, desc, { index: 1 }, { type: "arrow-down" }).cursor,
    ).toEqual({ index: 0 });
  });

  it("Esc → pop（不改 state）；Ctrl+C → exit cancelled", () => {
    expect(handleMcpServerPanelKey(base, desc, { index: 0 }, { type: "escape" }).action.type).toBe("pop");
    const c = handleMcpServerPanelKey(base, desc, { index: 0 }, { type: "ctrl-c" }).action;
    expect(c.type).toBe("exit");
    if (c.type === "exit") expect(c.result.kind).toBe("cancelled");
  });
});
