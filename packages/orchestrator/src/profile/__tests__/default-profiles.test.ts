/**
 * Profile 工厂回归 —— 主路径 byte-equal 与子 agent profile 字段稳定性。
 */

import { describe, expect, it } from "vitest";
import type { WorkScene } from "@zhixing/core";
import {
  MAIN_IDENTITY_INSTRUCTIONS,
  mainProfile,
  powerProfile,
  subAgentProfile,
} from "../default-profiles.js";
import { renderIdentity } from "../../runtime/system-prompt.js";

function makeScene(overrides: Partial<WorkScene> = {}): WorkScene {
  return {
    id: "scene-x",
    name: "知行 CLI 开发",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mainProfile()", () => {
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
    const p = subAgentProfile({ subAgentId: "abc123def456", task: "find files" });
    expect(p.name).toBe("Sub-Agent #abc123");
  });

  it("instructions 含任务文本与 markdown 头", () => {
    const p = subAgentProfile({ subAgentId: "x", task: "do thing" });
    expect(p.instructions).toContain("# Your Role");
    expect(p.instructions).toContain("do thing");
  });

  it("constraints 含 4 条标准子 agent 约束", () => {
    const p = subAgentProfile({ subAgentId: "x", task: "t" });
    expect(p.constraints).toHaveLength(4);
    expect(p.constraints.join("\n")).toContain("the user does not see it");
    expect(p.constraints.join("\n")).toContain("Task tool");
  });

  it("声明 capabilities:不可派生子 agent + 非 user-facing", () => {
    const p = subAgentProfile({ subAgentId: "x", task: "t" });
    expect(p.capabilities).toEqual({ canSpawnSubAgents: false, userFacing: false });
    expect(p.role).toBe("sub");
  });

  it("renderIdentity 输出含任务文本 + Constraints 列表", () => {
    const p = subAgentProfile({ subAgentId: "x", task: "find readme" });
    const rendered = renderIdentity(p);
    expect(rendered).toContain("find readme");
    expect(rendered).toContain("# Constraints");
    expect(rendered).toContain("- ");
  });
});

describe("powerProfile(scene)", () => {
  it("有 workdir → 主工具全集（含文件工具）", () => {
    const p = powerProfile(makeScene({ workdir: "/tmp/proj" }));
    expect(p.enabledTools).toEqual([
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "bash",
      "memory",
      "web_fetch",
      "Task",
    ]);
  });

  it("无 workdir → 剔除全部本地文件类工具（by-construction 隔离）", () => {
    const p = powerProfile(makeScene());
    expect(p.enabledTools).toEqual(["memory", "web_fetch", "Task"]);
    for (const fileTool of ["read", "write", "edit", "glob", "grep", "bash"]) {
      expect(p.enabledTools).not.toContain(fileTool);
    }
  });

  it("instructions 含基础身份 + 场景名定位 + 退出自判(指向 workmode_exit)；capabilities 同 main", () => {
    const p = powerProfile(makeScene({ name: "写作场景" }));
    expect(p.instructions).toContain(MAIN_IDENTITY_INSTRUCTIONS);
    expect(p.instructions).toContain("写作场景");
    // 退出自判：显式指向 workmode_exit 工具，而非仅"叙述完成"
    expect(p.instructions).toContain("workmode_exit");
    expect(p.capabilities).toEqual({
      canSpawnSubAgents: true,
      userFacing: true,
    });
    expect(p.role).toBe("main");
  });

  it("同一 scene 多次调用 instructions byte-equal（静态前缀缓存可复用）", () => {
    const scene = makeScene({ workdir: "/x" });
    expect(powerProfile(scene).instructions).toBe(
      powerProfile(scene).instructions,
    );
  });
});
