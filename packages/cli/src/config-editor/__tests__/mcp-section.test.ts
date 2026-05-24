/**
 * mcp section + mcp-server 详情面板 handler 测试（纯逻辑，无 UI / 无异步）。
 *
 * 关键不变量：
 *   - 列表来自 config（含已停用 server），运行态按 serverId 叠加
 *   - 连接中的 server 归 ready（靠 statusText 区分），绝不 blocked——不阻塞编辑器"完成"
 *   - 启停 / 删除是 WorkingState 事务变更
 */

import { describe, expect, it } from "vitest";
import type { McpServerStatus, ProbeResult } from "@zhixing/mcp";
import { createInitialState, setInputBuffer } from "../state.js";
import { mcpSection } from "../sections/mcp.js";
import { handleMcpAddPanelKey, handleMcpServerPanelKey } from "../panels/mcp.js";
import type {
  ConfigEditorContext,
  ConfigEditorRuntime,
  WorkingState,
} from "../types.js";

function stateWith(servers: Record<string, unknown>): WorkingState {
  return createInitialState({ mcp: { servers } } as never, {});
}

function runtimeOf(statuses: McpServerStatus[]): ConfigEditorRuntime {
  return { mcpServerStatuses: () => statuses };
}

describe("mcpSection.entries", () => {
  // 过滤出"已接入 server"条目（排除"添加预设"入口）
  const serverEntries = (entries: ReturnType<typeof mcpSection.entries>) =>
    entries.filter((e) => e.enterTarget?.kind === "mcp-server");

  it("空配置 → 无 server 条目（只列可添加的预设入口）", () => {
    const entries = mcpSection.entries(createInitialState({}, {}));
    expect(serverEntries(entries)).toEqual([]);
    expect(entries.every((e) => e.enterTarget?.kind === "mcp-add")).toBe(true);
  });

  it("列出 config 中全部 server（含已停用），enterTarget 指向 mcp-server", () => {
    const state = stateWith({
      github: { type: "http", url: "https://x" },
      old: { type: "stdio", command: "c", enabled: false },
    });
    const servers = serverEntries(mcpSection.entries(state));
    expect(servers.map((e) => e.label)).toEqual(["github", "old"]);
    expect(servers[0]!.enterTarget).toEqual({ kind: "mcp-server", serverId: "github" });
    // 已停用 → disabled
    expect(servers[1]!.state).toEqual({ kind: "disabled", statusText: "已停用" });
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
    const servers = serverEntries(mcpSection.entries(state, runtimeOf([])));
    expect(servers.map((e) => e.label)).toEqual(["off"]);
  });

  it("未接入的预设列为'添加 X'入口；已接入的不重复列", () => {
    // 已装 github，未装 notion
    const state = stateWith({ github: { type: "http", url: "https://x" } });
    const entries = mcpSection.entries(state);
    const labels = entries.map((e) => e.label);
    expect(labels).toContain("github"); // 已接入 server
    expect(labels).toContain("添加 Notion"); // 未接入预设
    expect(labels).not.toContain("添加 GitHub"); // github 已接入、不重复
    const addNotion = entries.find((e) => e.label === "添加 Notion");
    expect(addNotion?.enterTarget).toEqual({ kind: "mcp-add", presetId: "notion" });
  });
});

describe("handleMcpAddPanelKey — 接入向导", () => {
  const desc = { kind: "mcp-add", presetId: "github" } as const;
  const okProbe = async (): Promise<ProbeResult> => ({
    ok: true,
    tools: [{ name: "x", inputSchema: {} }],
  });
  const failProbe = async (): Promise<ProbeResult> => ({
    ok: false,
    error: "401 bad token",
  });
  function ctxWith(
    mcpProbe?: ConfigEditorRuntime["mcpProbe"],
  ): ConfigEditorContext {
    return { runtime: mcpProbe ? { mcpProbe } : {} } as unknown as ConfigEditorContext;
  }

  it("字符累积；空 Enter 不前进；Esc 取消", () => {
    const s0 = createInitialState({}, {});
    const typed = handleMcpAddPanelKey(ctxWith(okProbe), s0, desc, {
      type: "char",
      ch: "g",
    });
    expect(typed.type).toBe("stay");
    if (typed.type === "stay") expect(typed.state.inputBuffer).toBe("g");
    expect(
      handleMcpAddPanelKey(ctxWith(okProbe), s0, desc, { type: "enter" }).type,
    ).toBe("stay");
    expect(
      handleMcpAddPanelKey(ctxWith(okProbe), s0, desc, { type: "escape" }).type,
    ).toBe("pop");
  });

  it("Enter（有输入）→ loading；run 验证成功 → 写盘 + pop", async () => {
    const s0 = setInputBuffer(createInitialState({}, {}), "ghp_abc");
    const action = handleMcpAddPanelKey(ctxWith(okProbe), s0, desc, { type: "enter" });
    expect(action.type).toBe("loading");
    if (action.type !== "loading") return;
    const result = await action.run(new AbortController().signal);
    expect(result.type).toBe("pop");
    if (result.type === "pop") {
      expect(result.state.config.mcp?.servers?.github?.url).toBe(
        "https://api.githubcopilot.com/mcp/",
      );
      expect(result.state.credentials.mcp?.github?.Authorization).toBe("Bearer ghp_abc");
      expect(result.state.inputBuffer).toBe("");
    }
  });

  it("run 验证失败 → replace 回带 error 的 mcp-add、保留输入、不写盘", async () => {
    const s0 = setInputBuffer(createInitialState({}, {}), "ghp_bad");
    const action = handleMcpAddPanelKey(ctxWith(failProbe), s0, desc, { type: "enter" });
    expect(action.type).toBe("loading");
    if (action.type !== "loading") return;
    const result = await action.run(new AbortController().signal);
    expect(result.type).toBe("replace");
    if (result.type === "replace") {
      expect(result.panel).toMatchObject({
        kind: "mcp-add",
        presetId: "github",
        error: "401 bad token",
      });
      expect(result.state.inputBuffer).toBe("ghp_bad"); // 保留供修改重试
      expect(result.state.config.mcp?.servers?.github).toBeUndefined(); // 失败不写盘
    }
  });

  it("未注入 probe → 防御性 replace 报错", () => {
    const s0 = setInputBuffer(createInitialState({}, {}), "x");
    const action = handleMcpAddPanelKey(ctxWith(undefined), s0, desc, { type: "enter" });
    expect(action.type).toBe("replace");
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
