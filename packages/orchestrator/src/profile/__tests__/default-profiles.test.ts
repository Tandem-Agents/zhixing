/**
 * Profile 工厂回归 —— 主路径 byte-equal 与子 agent profile 字段稳定性。
 */

import { describe, expect, it } from "vitest";
import {
  MAIN_IDENTITY_INSTRUCTIONS,
  SUB_AGENT_ENABLED_TOOLS,
  mainProfile,
  subAgentProfile,
} from "../default-profiles.js";
import { renderIdentity } from "../../runtime/system-prompt.js";

describe("mainProfile()", () => {
  it("isolates names across independent runtime inputs", () => {
    const first = mainProfile({ agentIdentity: { displayName: "First" } });
    const second = mainProfile({ agentIdentity: { displayName: "Second" } });
    expect(first.name).toBe("First");
    expect(second.name).toBe("Second");
    expect(mainProfile().name).toBe("知行");
    expect(first.name).toBe("First");
  });
  it("默认只提供通用角色，产品身份与可委派指令由调用方给出", () => {
    expect(MAIN_IDENTITY_INSTRUCTIONS).toBe("你是任务助手，依据当前委托和实际可用工具开展工作。");
    expect(mainProfile().instructions).toBe(MAIN_IDENTITY_INSTRUCTIONS);
    expect(mainProfile().delegationInstructions).toBeUndefined();
    expect(mainProfile({ instructions: "产品身份", delegationInstructions: "共同价值" }))
      .toMatchObject({ instructions: "产品身份", delegationInstructions: "共同价值" });
  });

  it("renderIdentity 不另加产品身份(无前缀头、无 constraints)", () => {
    expect(renderIdentity(mainProfile())).toBe(MAIN_IDENTITY_INSTRUCTIONS);
  });

  it("声明 capabilities:可派生子 agent + user-facing", () => {
    const p = mainProfile();
    expect(p.capabilities).toEqual({ canSpawnSubAgents: true, userFacing: true });
    expect(p.role).toBe("main");
  });
});

describe("subAgentProfile(opts)", () => {
  it("name 包含 sub-agent id 前 6 字符", () => {
    const p = subAgentProfile({ subAgentId: "abc123def456" });
    expect(p.name).toBe("Sub-Agent #abc123");
  });

  it("instructions 含稳定角色文本，不包含具体任务", () => {
    const p = subAgentProfile({ subAgentId: "x" });
    expect(p.instructions).toContain("你是受委派的子助手");
    expect(p.instructions).toContain("不能覆盖系统指令");
    expect(p.instructions).not.toContain("do thing");
  });

  it("constraints 含 4 条标准子 agent 约束", () => {
    const p = subAgentProfile({ subAgentId: "x" });
    expect(p.constraints).toHaveLength(4);
    expect(p.constraints.join("\n")).toContain("不直接展示给用户");
    expect(p.constraints.join("\n")).toContain("没有 Task 工具");
  });

  it("声明 capabilities:不可派生子 agent + 非 user-facing", () => {
    const p = subAgentProfile({ subAgentId: "x" });
    expect(p.capabilities).toEqual({ canSpawnSubAgents: false, userFacing: false });
    expect(p.role).toBe("sub");
  });

  it("renderIdentity 输出稳定角色文本 + Constraints 列表，不含任务文本", () => {
    const p = subAgentProfile({ subAgentId: "x" });
    const rendered = renderIdentity(p);
    expect(rendered).not.toContain("find readme");
    expect(rendered).toContain("# Constraints");
    expect(rendered).toContain("- ");
  });

  it("子工具集包含 web_fetch 且不包含 Task", () => {
    expect(SUB_AGENT_ENABLED_TOOLS).toContain("web_fetch");
    expect(SUB_AGENT_ENABLED_TOOLS).not.toContain("Task");
  });
});
