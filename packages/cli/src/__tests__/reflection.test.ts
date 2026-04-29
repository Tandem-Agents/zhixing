import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ToolDefinition } from "@zhixing/core";

// ─── 工具 mock ───

function mockTools(includeMemory: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "read",
      description: "Read files",
      inputSchema: { type: "object", properties: {} },
      async call() { return { content: "" }; },
    },
  ];

  if (includeMemory) {
    tools.push({
      name: "memory",
      description: "Manage memories",
      inputSchema: { type: "object", properties: {} },
      async call() { return { content: "" }; },
    });
  }

  return tools;
}

// ─── system-prompt 技能进化段 ───

describe("buildSystemPrompt — Skill Evolution segment", () => {
  it("包含技能进化指导（当 memory 工具注册时）", () => {
    const prompt = buildSystemPrompt({
      tools: mockTools(true),
      cwd: "/test",
    });

    expect(prompt).toContain("## Skill Evolution");
    expect(prompt).toContain("reusable methodology");
    expect(prompt).toContain("Never silently create or update skills");
    expect(prompt).toContain("At most one skill proposal per conversation");
  });

  it("不包含技能进化指导（当 memory 工具未注册时）", () => {
    const prompt = buildSystemPrompt({
      tools: mockTools(false),
      cwd: "/test",
    });

    expect(prompt).not.toContain("## Skill Evolution");
  });

  it("进化指导在缓存分界标记之前（属于静态区）", () => {
    const prompt = buildSystemPrompt({
      tools: mockTools(true),
      cwd: "/test",
    });

    const boundaryIndex = prompt.indexOf("__ZHIXING_CACHE_BOUNDARY__");
    const evolutionIndex = prompt.indexOf("## Skill Evolution");

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(evolutionIndex).toBeGreaterThan(-1);
    expect(evolutionIndex).toBeLessThan(boundaryIndex);
  });
});

// ─── project-context 反思逻辑 ───

// 使用 enrichContext 的导入需要 mock 文件系统，这里测试 buildReflectionHint 的逻辑
// 通过 enrichContext 的公开行为间接验证

import { enrichContext, REFLECTION_THRESHOLD, loadProjectContext } from "@zhixing/orchestrator/runtime";
import type { Message } from "@zhixing/core";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("enrichContext — reflection hint", () => {
  // 这些测试不依赖文件系统（不触发 skill 匹配，仅测反思逻辑）
  // MemoryRetriever 在无 skills 目录时返回空

  it("toolEndCount >= threshold 时注入反思提示", async () => {
    const baseContext = await loadProjectContext("/nonexistent-for-test");
    const result = await enrichContext(
      baseContext,
      [userMsg("hello")],
      { lastToolEndCount: REFLECTION_THRESHOLD },
    );

    expect(result.reflectionHint).not.toBeNull();
    expect(result.reflectionHint).toContain("Reflection Hint");
    expect(result.reflectionHint).toContain(String(REFLECTION_THRESHOLD));
  });

  it("toolEndCount < threshold 时不注入", async () => {
    const baseContext = await loadProjectContext("/nonexistent-for-test");
    const result = await enrichContext(
      baseContext,
      [userMsg("hello")],
      { lastToolEndCount: REFLECTION_THRESHOLD - 1 },
    );

    expect(result.reflectionHint).toBeNull();
  });

  it("已提议过技能时不再注入", async () => {
    const baseContext = await loadProjectContext("/nonexistent-for-test");
    const result = await enrichContext(
      baseContext,
      [userMsg("hello")],
      { lastToolEndCount: 20, hasProposedSkill: true },
    );

    expect(result.reflectionHint).toBeNull();
  });

  it("默认 options 不触发反思", async () => {
    const baseContext = await loadProjectContext("/nonexistent-for-test");
    const result = await enrichContext(baseContext, [userMsg("hello")]);

    expect(result.reflectionHint).toBeNull();
  });

  it("REFLECTION_THRESHOLD 的值为 8", () => {
    expect(REFLECTION_THRESHOLD).toBe(8);
  });
});
