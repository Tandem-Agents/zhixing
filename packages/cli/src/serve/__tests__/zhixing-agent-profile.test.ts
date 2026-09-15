import { describe, expect, it } from "vitest";
import { mainProfile, subAgentProfile } from "@zhixing/orchestrator/profile";
import { buildSystemPrompt, SUB_AGENT_SEGMENTS } from "@zhixing/orchestrator/runtime";
import { zhixingProfile, ZHIXING_IDENTITY, ZHIXING_VALUES } from "../zhixing-agent-profile.js";
import { createWebFetchTool } from "@zhixing/tools-builtin";

describe("知行产品身份投影", () => {
  it("逐字承接封版身份稿，职责不冒充角色的自述", () => {
    expect(ZHIXING_IDENTITY).toBe(`你是知行，用户的行动伙伴。你认真对待托付，胜过表现自己。守法向善，不为达成目标而不择手段或伤害他人。

你喜欢琢磨新办法，偏爱简单而巧妙的解法。面对陌生问题，主动探索、求证，不把寻找办法推给用户；确实做不到就坦诚说明。

你有自己的判断，不靠附和讨好。交流直接自然，幽默不刻意；一起讨论时耐心推敲，受托办事时主动推进。`);
    const profile = zhixingProfile();
    expect(profile.instructions.startsWith(ZHIXING_IDENTITY)).toBe(true);
    expect(profile.instructions).toContain("核实结果再交付");
    expect(profile.instructions).toContain("经同意再通过技能工具保存或修改");
    expect(profile.instructions).toContain("不直接修改内部配置或读取秘密");
    expect(profile.instructions).not.toMatch(/OpenClaw|OpenCloud|折纸|3D|我是/);
    expect(mainProfile().instructions).not.toContain("你是知行");
  });

  it("子任务只取共同价值，保留自身职责和只读工具边界", () => {
    const parent = zhixingProfile();
    const child = subAgentProfile({ subAgentId: "a", delegationInstructions: parent.delegationInstructions });
    const prompt = buildSystemPrompt({ profile: child, segments: SUB_AGENT_SEGMENTS, tools: [], cwd: "/unused", workspace: null });
    expect(prompt).toContain(ZHIXING_VALUES);
    expect(prompt).toContain("只负责当前子任务");
    expect(prompt).toContain("不发起用户对话或对外发消息");
    expect(prompt).not.toContain("你是知行");
    expect(prompt).not.toContain("## 协作职责");
    expect(child.enabledTools).toEqual(["read", "glob", "grep", "web_fetch"]);
    expect(child.delegationInstructions).toBeUndefined();
  });

  it("身份不扩充实际能力，找来源指引不再把可自主处理的问题推给用户", () => {
    expect(zhixingProfile({ hasWorkspace: false }).enabledTools)
      .toEqual(mainProfile({ hasWorkspace: false }).enabledTools);
    const tool = createWebFetchTool();
    const prompt = buildSystemPrompt({ profile: zhixingProfile(), tools: [tool], cwd: "/unused", workspace: null });
    expect(prompt).toContain("先用其他可用能力查找来源");
    expect(prompt).toContain("使用用户提供、可靠已知或已读取材料中出现的地址");
    expect(prompt).toContain("does not search the web");
    expect(prompt).not.toContain("ask for the URL or suggest a search engine");
    expect(prompt).not.toContain("never list capabilities");
    expect(prompt).not.toContain("answer what was asked");
  });
});
