import { describe, expect, it, vi } from "vitest";
import type {
  SkillCatalogAdmissionApplication,
  SkillCatalogAdmissionOutcome,
} from "@zhixing/core/skills/catalog";
import { createAdmitSkillTool } from "../skill.js";

const CTX = { workingDirectory: "/tmp", toolCallId: "tool-admit" } as never;

describe("admit_skill Skill Catalog binding", () => {
  it("preserves schema, permission argument and safety boundaries", () => {
    const tool = createAdmitSkillTool(application({ kind: "missing-input" }), "main");
    expect(tool.inputSchema.properties).toHaveProperty("path");
    expect(tool.inputSchema.properties).toHaveProperty("admissionToken");
    expect(tool.permissionArgumentKey).toBe("path");
    expect(tool.boundaries).toEqual([
      { boundaryType: "filesystem", access: "read", dynamic: false },
      { boundaryType: "app-state", access: "write", dynamic: false },
    ]);
    expect(tool.isParallelSafe).toBe(false);
  });

  it("only normalizes input and delegates first-call state to the domain application", async () => {
    const admit = vi.fn(async () => ({
      kind: "admitted" as const,
      id: "deploy",
      name: "Deploy",
    }));
    const tool = createAdmitSkillTool({ admit }, "work");

    await expect(tool.call({ path: " /candidate " }, CTX)).resolves.toEqual({
      content: "已记录接入技能「Deploy」(id: deploy)；本轮成功完成后入库。",
      isError: false,
    });
    expect(admit).toHaveBeenCalledWith({
      source: { kind: "local-path", path: "/candidate" },
      mode: "work",
      operationId: "tool-admit",
    });
  });

  it("maps needs-confirm and escalate reports without owning token state", async () => {
    const needs = createAdmitSkillTool(application({
      kind: "needs-confirm",
      admissionToken: "token-1",
      reason: "可疑措辞",
      threats: [{ category: "prompt-injection", rule: "ignore", excerpt: "ignore" }],
    }), "main");
    const report = await needs.call({ path: "/candidate" }, CTX);
    expect(report).toMatchObject({ isError: false });
    expect(report.content).toContain("可疑措辞");
    expect(report.content).toContain("admissionToken");
    expect(report.content).toContain("token-1");

    const blocked = createAdmitSkillTool(application({
      kind: "escalated",
      reason: "确凿注入",
      threats: [],
    }), "main");
    const denial = await blocked.call({ path: "/candidate" }, CTX);
    expect(denial).toMatchObject({ isError: true });
    expect(denial.content).toContain("不可绕过");
    expect(denial.content).not.toContain("admissionToken");
  });

  it("delegates confirmation token and preserves expiration/tamper copy", async () => {
    const admit = vi.fn(async () => ({ kind: "confirmation-expired" as const }));
    const expired = createAdmitSkillTool({ admit }, "main");
    const first = await expired.call({ admissionToken: " token-1 " }, CTX);
    expect(first).toMatchObject({ isError: true });
    expect(first.content).toContain("重新审查");
    expect(admit).toHaveBeenCalledWith({
      admissionToken: "token-1",
      mode: "main",
      operationId: "tool-admit",
    });

    const changed = createAdmitSkillTool(application({ kind: "candidate-changed" }), "main");
    const second = await changed.call({ admissionToken: "token-2" }, CTX);
    expect(second).toMatchObject({ isError: true });
    expect(second.content).toContain("不一致");
  });

  it("preserves missing-input, missing-name and phase-specific failure copy", async () => {
    const missing = createAdmitSkillTool(application({ kind: "missing-input" }), "main");
    expect(await missing.call({}, CTX)).toMatchObject({
      isError: true,
      content: expect.stringContaining("首调需要 path"),
    });

    const unnamed = createAdmitSkillTool(application({ kind: "missing-name" }), "main");
    expect(await unnamed.call({ path: "/candidate" }, CTX)).toMatchObject({
      isError: true,
      content: expect.stringContaining("缺少 name"),
    });

    const failure: SkillCatalogAdmissionApplication = {
      async admit() {
        throw new Error("stage failed");
      },
    };
    const failed = createAdmitSkillTool(failure, "main");
    expect(await failed.call({ path: "/candidate" }, CTX)).toEqual({
      content: "接入失败:stage failed",
      isError: true,
    });
    expect(await failed.call({ admissionToken: "token" }, CTX)).toEqual({
      content: "接入失败:stage failed(已丢弃,需重新审查)",
      isError: true,
    });
  });
});

function application(
  outcome: SkillCatalogAdmissionOutcome,
): SkillCatalogAdmissionApplication {
  return { async admit() { return outcome; } };
}
