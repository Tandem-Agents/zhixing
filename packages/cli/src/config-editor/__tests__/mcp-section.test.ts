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
import {
  handleMcpAddInputPanelKey,
  handleMcpAddPanelKey,
  handleMcpServerPanelKey,
} from "../panels/mcp.js";
import { presetToCandidate, type McpSetupCandidate } from "../mcp-setup.js";
import { findMcpPreset } from "../../registries/index.js";
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

  it("空配置 → 无 server 条目（只列预设 + 自定义接入入口）", () => {
    const entries = mcpSection.entries(createInitialState({}, {}));
    expect(serverEntries(entries)).toEqual([]);
    // 全是接入入口：预设候选（mcp-add）+ 统一输入（mcp-add-input）
    expect(
      entries.every(
        (e) => e.enterTarget?.kind === "mcp-add" || e.enterTarget?.kind === "mcp-add-input",
      ),
    ).toBe(true);
    expect(entries.some((e) => e.enterTarget?.kind === "mcp-add-input")).toBe(true);
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
    const target = entries.find((e) => e.label === "添加 Notion")?.enterTarget;
    expect(target).toMatchObject({ kind: "mcp-add", label: "Notion", fieldIndex: 0 });
    if (target?.kind === "mcp-add") {
      // 预设作为"预填候选"进入同一接入面板
      expect(target.candidate.serverId).toBe("notion");
      expect(target.inputs).toEqual({});
    }
  });
});

describe("handleMcpAddPanelKey — 接入向导", () => {
  const desc = {
    kind: "mcp-add" as const,
    candidate: presetToCandidate(findMcpPreset("github")!),
    inputs: {} as Record<string, string>,
    fieldIndex: 0,
  };
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
      expect(result.panel).toMatchObject({ kind: "mcp-add", error: "401 bad token" });
      if (result.panel.kind === "mcp-add") {
        expect(result.panel.candidate.serverId).toBe("github");
      }
      expect(result.state.inputBuffer).toBe("ghp_bad"); // 保留供修改重试
      expect(result.state.config.mcp?.servers?.github).toBeUndefined(); // 失败不写盘
    }
  });

  it("未注入 probe → 防御性 replace 报错", () => {
    const s0 = setInputBuffer(createInitialState({}, {}), "x");
    const action = handleMcpAddPanelKey(ctxWith(undefined), s0, desc, { type: "enter" });
    expect(action.type).toBe("replace");
  });

  it("多字段：非末字段 Enter 推进到下一字段并累积，末字段才验证", async () => {
    const candidate: McpSetupCandidate = {
      serverId: "two-key",
      entry: { type: "stdio", command: "npx", args: ["-y", "x"] },
      secretFields: [
        { key: "A", label: "A", hint: "", example: "" },
        { key: "B", label: "B", hint: "", example: "" },
      ],
      source: "inferred",
    };
    const d0 = { kind: "mcp-add" as const, candidate, inputs: {} as Record<string, string>, fieldIndex: 0 };

    // 字段 0 输入 av → Enter：推进到字段 1、累积 A、清输入，不验证
    const s0 = setInputBuffer(createInitialState({}, {}), "av");
    const step = handleMcpAddPanelKey(ctxWith(okProbe), s0, d0, { type: "enter" });
    expect(step.type).toBe("replace");
    if (step.type !== "replace" || step.panel.kind !== "mcp-add") return;
    expect(step.panel.fieldIndex).toBe(1);
    expect(step.panel.inputs).toEqual({ A: "av" });
    expect(step.state.inputBuffer).toBe("");

    // 字段 1（末）输入 bv → Enter：带 {A,B} 走验证 loading
    const s1 = setInputBuffer(createInitialState({}, {}), "bv");
    const last = handleMcpAddPanelKey(ctxWith(okProbe), s1, step.panel, { type: "enter" });
    expect(last.type).toBe("loading");
    if (last.type !== "loading") return;
    const result = await last.run(new AbortController().signal);
    expect(result.type).toBe("pop");
    if (result.type === "pop") {
      expect(result.state.credentials.mcp?.["two-key"]).toEqual({ A: "av", B: "bv" });
    }
  });
});

describe("handleMcpAddInputPanelKey — 统一输入接入", () => {
  const inputDesc = { kind: "mcp-add-input" as const };
  const okCandidate: McpSetupCandidate = {
    serverId: "linear",
    entry: { type: "stdio", command: "npx", args: ["-y", "linear-mcp"] },
    secretFields: [{ key: "LINEAR_KEY", label: "Linear Key", hint: "", example: "" }],
    source: "inferred",
  };
  const ctxResolve = (
    resolve: ConfigEditorRuntime["mcpResolve"],
  ): ConfigEditorContext =>
    ({ runtime: { mcpResolve: resolve } }) as unknown as ConfigEditorContext;
  const ctxFail = ctxResolve(async () => ({ ok: false, error: "x" }));

  it("字符累积；空 Enter 不前进；Esc 取消", () => {
    const s0 = createInitialState({}, {});
    const typed = handleMcpAddInputPanelKey(ctxFail, s0, inputDesc, { type: "char", ch: "a" });
    expect(typed.type).toBe("stay");
    if (typed.type === "stay") expect(typed.state.inputBuffer).toBe("a");
    expect(handleMcpAddInputPanelKey(ctxFail, s0, inputDesc, { type: "enter" }).type).toBe("stay");
    expect(handleMcpAddInputPanelKey(ctxFail, s0, inputDesc, { type: "escape" }).type).toBe("pop");
  });

  it("Enter → loading；解析成功 → navigate 到 mcp-add 候选面板", async () => {
    const s0 = setInputBuffer(createInitialState({}, {}), "linear-mcp");
    const ctx = ctxResolve(async () => ({ ok: true, candidate: okCandidate }));
    const action = handleMcpAddInputPanelKey(ctx, s0, inputDesc, { type: "enter" });
    expect(action.type).toBe("loading");
    if (action.type !== "loading") return;
    const result = await action.run(new AbortController().signal);
    expect(result.type).toBe("navigate");
    if (result.type === "navigate" && result.panel.kind === "mcp-add") {
      expect(result.panel.candidate.serverId).toBe("linear");
      expect(result.panel.fieldIndex).toBe(0);
      expect(result.panel.inputs).toEqual({});
    }
  });

  it("解析失败 → replace 回带 error，保留输入供修改", async () => {
    const s0 = setInputBuffer(createInitialState({}, {}), "??");
    const ctx = ctxResolve(async () => ({ ok: false, error: "推断失败" }));
    const action = handleMcpAddInputPanelKey(ctx, s0, inputDesc, { type: "enter" });
    if (action.type !== "loading") return;
    const result = await action.run(new AbortController().signal);
    expect(result.type).toBe("replace");
    if (result.type === "replace") {
      expect(result.panel).toMatchObject({ kind: "mcp-add-input", error: "推断失败" });
      expect(result.state.inputBuffer).toBe("??");
    }
  });

  it("撞名 → replace 提示已存在、不导航（不静默覆盖）", async () => {
    const s0 = setInputBuffer(stateWith({ linear: { type: "stdio", command: "c" } }), "linear-mcp");
    const ctx = ctxResolve(async () => ({ ok: true, candidate: okCandidate }));
    const action = handleMcpAddInputPanelKey(ctx, s0, inputDesc, { type: "enter" });
    if (action.type !== "loading") return;
    const result = await action.run(new AbortController().signal);
    expect(result.type).toBe("replace");
    if (result.type === "replace" && result.panel.kind === "mcp-add-input") {
      expect(result.panel.error).toContain("已存在");
    }
  });

  it("未注入 mcpResolve → 防御性 replace 报错", () => {
    const s0 = setInputBuffer(createInitialState({}, {}), "x");
    const ctx = { runtime: {} } as unknown as ConfigEditorContext;
    const action = handleMcpAddInputPanelKey(ctx, s0, inputDesc, { type: "enter" });
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
