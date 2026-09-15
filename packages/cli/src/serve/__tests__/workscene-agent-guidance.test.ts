import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { subAgentProfile } from "@zhixing/orchestrator/profile";
import { zhixingProfile as mainProfile, ZHIXING_IDENTITY as MAIN_IDENTITY_INSTRUCTIONS, ZHIXING_VALUES } from "../zhixing-agent-profile.js";
import { buildSystemPrompt, CACHE_BOUNDARY, SUB_AGENT_SEGMENTS } from "@zhixing/orchestrator/runtime";
import type { ToolDefinition } from "@zhixing/core/types";
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
  it("有已解析 workspace → 主工具全集（含文件工具）", () => {
    const p = powerProfile({ ...makeScene(), hasWorkspace: true });
    expect(p.enabledTools).toEqual([
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "bash",
      "web_fetch",
      "load_skill",
      "save_skill",
      "admit_skill",
      "Task",
    ]);
  });

  it("无 workspace → 剔除全部本地文件类工具（by-construction 隔离）", () => {
    const p = powerProfile({ ...makeScene(), hasWorkspace: false });
    // load_skill / save_skill 读写 app-state(~/.zhixing/skills)、非 workdir
    // 本地文件,故保留。
    expect(p.enabledTools).toEqual([
      "web_fetch",
      "load_skill",
      "save_skill",
      "Task",
    ]);
    for (const fileTool of ["read", "write", "edit", "glob", "grep", "bash"]) {
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
  const entry = () => createWorkmodeEnterTool({ get: async () => null });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");

  it("保持无关工具指引不变，同一产品身份在不同场景使用同源前缀", () => {
    expect(hash(WORKING_MODE_TEXT)).toBe("73413a99baffdba62f0eaf804a5b5741c4bd2d678d84c900eb7ed6ee16991ff9");
    for (const profile of [mainProfile(), powerProfile(makeScene())]) {
      const input = { profile, tools: [stubTool("Task"), entry()], cwd: "/unused" };
      const prefix = buildSystemPrompt(input).split(CACHE_BOUNDARY)[0]!;
      expect(prefix).toContain(MAIN_IDENTITY_INSTRUCTIONS);
      expect(prefix.split(MAIN_IDENTITY_INSTRUCTIONS)).toHaveLength(2);
      expect(buildSystemPrompt(input)).toBe(buildSystemPrompt(input));
    }
    const child = subAgentProfile({ subAgentId: "a", delegationInstructions: mainProfile().delegationInstructions });
    const prompt = buildSystemPrompt({ profile: child, segments: SUB_AGENT_SEGMENTS, tools: [], cwd: "/unused" });
    expect(prompt).toContain(ZHIXING_VALUES);
    expect(prompt).not.toContain(MAIN_IDENTITY_INSTRUCTIONS);
  });

  it("keeps scene choice, confirmation, workspace and turn-boundary decisions", () => {
    const prompt = buildSystemPrompt({ tools: [entry()], cwd: "/test/project" });
    expect(prompt).toContain(WORKING_MODE_TEXT);
    for (const content of ["workscene_list", "set_workdir", "clear_workdir", "optional device workspace", "ask the user before switching", "with confirmation", "finish the current turn normally", "Never request or transmit a remote filesystem path"]) {
      expect(prompt).toContain(content);
    }
    expect(prompt).not.toContain("workscene_memory_query");
  });

  it("follows the actual tool contribution, not a magic tool name", () => {
    const build = (tools: ToolDefinition[]) => buildSystemPrompt({ tools, cwd: "/test/project" });
    expect(build([stubTool("workmode_enter")])).not.toContain(WORKING_MODE_TEXT);
    expect(build([{ ...entry(), name: "renamed-entry" }])).toContain(WORKING_MODE_TEXT);
    expect(build([createWorkmodeExitTool()])).not.toContain(WORKING_MODE_TEXT);
    expect(build([])).not.toContain(WORKING_MODE_TEXT);
  });

  it("removes guidance when a job filters its contributing tool", () => {
    const select = (tools?: string[]) => selectJobRuntimeTools({
      instruction: { ...(tools ? { tools } : {}) } as never,
      baseProfile: mainProfile(), extraTools: [entry()], executionMcpServers: [],
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
