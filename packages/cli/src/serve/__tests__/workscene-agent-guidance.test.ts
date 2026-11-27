import { createWorksceneRunToolApplication } from "../workscene-application-adapter.js";
import { describe, expect, it } from "vitest";
import { subAgentProfile } from "@zhixing-ai/orchestrator/profile";
import { zhixingProfile as mainProfile, ZHIXING_IDENTITY as MAIN_IDENTITY_INSTRUCTIONS, ZHIXING_VALUES } from "../zhixing-agent-profile.js";
import { buildSystemPrompt, buildSystemPromptParts, SUB_AGENT_SEGMENTS } from "@zhixing-ai/orchestrator/runtime";
import type { ToolDefinition } from "@zhixing-ai/core/types";
import { powerProfile, WORKING_MODE_TEXT } from "../workscene-agent-guidance.js";
import { createWorkmodeEnterTool, createWorkmodeExitTool } from "../workmode-tools.js";
import { selectJobRuntimeTools } from "../job-runtime-tool-selection.js";

type WorksceneProfileInput = Parameters<typeof powerProfile>[0];

function makeScene(overrides: Partial<WorksceneProfileInput> = {}): WorksceneProfileInput {
  return {
    id: "scene-x",
    name: "知行 CLI 开发",
    hasSceneControlTools: true,
    ...overrides,
  };
}

describe("powerProfile(scene)", () => {
  it("retains isolated explicit identity inputs", () => {
    const first = powerProfile(makeScene(), { agentIdentity: { displayName: "First" } });
    const second = powerProfile(makeScene(), { agentIdentity: { displayName: "Second" } });
    expect(first.name).toBe("First");
    expect(second.name).toBe("Second");
    expect(mainProfile().name).toBe("知行");
    expect(powerProfile(makeScene()).name).toBe("知行");
    expect(first.name).toBe("First");
  });
  it("有已解析 workspace → 主工具全集（含文件工具与 v2 技能工具）", () => {
    const p = powerProfile({ ...makeScene(), hasWorkspace: true });
    expect(p.enabledTools).toEqual([
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "bash",
      "web_fetch",
      "skill_read",
      "skill_save",
      "skill_admit",
      "skill_materialize",
      "Task",
    ]);
  });

  it("无 workspace → 剔除全部本地文件与工作区落盘类工具（by-construction 隔离）", () => {
    const p = powerProfile({ ...makeScene(), hasWorkspace: false });
    // skill_read / skill_save 仅访问 app-state 技能库，不触碰工作区文件系统，故保留。
    expect(p.enabledTools).toEqual([
      "web_fetch",
      "skill_read",
      "skill_save",
      "Task",
    ]);
    for (const fileTool of ["read", "write", "edit", "glob", "grep", "bash", "skill_admit", "skill_materialize"]) {
      expect(p.enabledTools).not.toContain(fileTool);
    }
  });

  it("instructions 含基础身份、场景内属性管理与退出自判；capabilities 同 main", () => {
    const p = powerProfile(makeScene({ name: "写作场景" }));
    expect(p.instructions).toContain(MAIN_IDENTITY_INSTRUCTIONS);
    expect(p.instructions).toContain("写作场景");
    expect(p.instructions).toContain("重命名");
    expect(p.instructions).toContain("更换设备工作区");
    expect(p.instructions).toContain("解除绑定");
    expect(p.instructions).not.toContain("memory");
    // 退出自判：显式指向 workmode_exit 工具，而非仅"叙述完成"
    expect(p.instructions).toContain("workmode_exit");
    expect(p.capabilities).toEqual({
      canSpawnSubAgents: true,
      userFacing: true,
    });
    expect(p.role).toBe("main");
  });

  it("同一 scene 多次调用 instructions byte-equal（静态前缀缓存可复用）", () => {
    const scene = { ...makeScene(), hasWorkspace: true };
    expect(powerProfile(scene).instructions).toBe(
      powerProfile(scene).instructions,
    );
  });
});

function stubTool(name: string): ToolDefinition {
  return { name, description: `stub ${name}`, inputSchema: { type: "object" }, call: async () => ({ content: "" }) };
}

describe("Workscene model guidance", () => {
  const entry = () => createWorkmodeEnterTool({ get: async () => null }, createWorksceneRunToolApplication());

  it("任务交接指引保持中文与边界清晰，同一产品身份在不同场景使用同源前缀", () => {
    expect(WORKING_MODE_TEXT).toContain("单纯切换时省略 handoff，不启动旧任务");
    for (const profile of [mainProfile(), powerProfile(makeScene())]) {
      const input = { profile, tools: [stubTool("Task"), entry()], cwd: "/unused" };
      const prefix = buildSystemPromptParts(input).staticPrefix;
      expect(prefix).toContain(MAIN_IDENTITY_INSTRUCTIONS);
      expect(prefix.split(MAIN_IDENTITY_INSTRUCTIONS)).toHaveLength(2);
      expect(buildSystemPrompt(input)).toBe(buildSystemPrompt(input));
    }
    const child = subAgentProfile({ subAgentId: "a", delegationInstructions: mainProfile().delegationInstructions });
    const prompt = buildSystemPrompt({ profile: child, segments: SUB_AGENT_SEGMENTS, tools: [], cwd: "/unused" });
    expect(prompt).toContain(ZHIXING_VALUES);
    expect(prompt).not.toContain(MAIN_IDENTITY_INSTRUCTIONS);
  });

  it("folds entry choice, handoff, no-host-path and turn-boundary rules into workmode_enter tool contract without polluting systemPrompt", () => {
    const tool = entry();
    expect(tool.systemPromptGuidance).toBeUndefined();
    for (const content of [
      "workscene_list",
      "授权工作区",
      "禁止索要或编造宿主机物理路径",
      "handoff 四元组（goal/constraints/completed/remaining）",
      "只切换视图时省略 handoff",
      "调用后结束本轮，不提前宣称已切换",
    ]) {
      expect(tool.description).toContain(content);
    }
    const withoutList = createWorkmodeEnterTool(
      { get: async () => null },
      createWorksceneRunToolApplication(),
      { hasWorksceneList: false },
    );
    expect(withoutList.description).not.toContain("workscene_list");
    const prompt = buildSystemPrompt({ tools: [tool], cwd: "/test/project" });
    expect(prompt).not.toContain(WORKING_MODE_TEXT);
    expect(prompt).not.toContain("workscene_memory_query");
  });

  it("tool-guidance segment follows actual systemPromptGuidance contribution, not a magic tool name", () => {
    const guidedTool: ToolDefinition = { ...entry(), systemPromptGuidance: WORKING_MODE_TEXT };
    const build = (tools: ToolDefinition[]) => buildSystemPrompt({ tools, cwd: "/test/project" });
    expect(build([stubTool("workmode_enter")])).not.toContain(WORKING_MODE_TEXT);
    expect(build([{ ...guidedTool, name: "renamed-entry" }])).toContain(WORKING_MODE_TEXT);
    expect(build([createWorkmodeExitTool(createWorksceneRunToolApplication())])).not.toContain(WORKING_MODE_TEXT);
    expect(build([])).not.toContain(WORKING_MODE_TEXT);
  });

  it("removes guidance when a job filters its contributing tool", () => {
    const guidedTool: ToolDefinition = { ...entry(), systemPromptGuidance: WORKING_MODE_TEXT };
    const select = (tools?: string[]) => selectJobRuntimeTools({
      instruction: { ...(tools ? { tools } : {}) } as never,
      capabilities: { tools: tools ?? [...mainProfile().enabledTools, "workmode_enter"], mcpServers: [] },
      baseProfile: mainProfile(), extraTools: [guidedTool], executionMcpServers: [],
      implementation: Object.freeze({ create: () => { throw new Error("not used"); } }),
    });
    const build = (selection: ReturnType<typeof select>) => buildSystemPrompt({
      profile: selection.profile, tools: [...selection.runtimeTools.extraTools], cwd: "/test/project",
    });
    expect(build(select())).toContain(WORKING_MODE_TEXT);
    expect(build(select(["workmode_enter"]))).toContain(WORKING_MODE_TEXT);
    expect(build(select(["read"]))).not.toContain(WORKING_MODE_TEXT);
  });
});
