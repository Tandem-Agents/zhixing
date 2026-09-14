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
  it("instructions 持历史身份段 verbatim 文本(byte-equal 锚点)", () => {
    expect(MAIN_IDENTITY_INSTRUCTIONS).toBe(
      [
        "You are Zhixing (知行), a personal intelligent assistant.",
        'Your name means "unity of knowledge and action" — you understand problems and take action to solve them.',
      ].join("\n"),
    );
    expect(mainProfile().instructions).toBe(MAIN_IDENTITY_INSTRUCTIONS);
  });

  it("renderIdentity(mainProfile()) 等于历史身份段(无前缀头、无 constraints)", () => {
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
    expect(p.instructions).toContain("# Your Role");
    expect(p.instructions).toContain("You are a sub-agent dispatched by the main agent.");
    expect(p.instructions).not.toContain("do thing");
  });

  it("constraints 含 4 条标准子 agent 约束", () => {
    const p = subAgentProfile({ subAgentId: "x" });
    expect(p.constraints).toHaveLength(4);
    expect(p.constraints.join("\n")).toContain("the user does not see it");
    expect(p.constraints.join("\n")).toContain("Task tool");
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
