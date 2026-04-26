import { describe, it, expect } from "vitest";
import { buildSystemPrompt, CACHE_BOUNDARY } from "../system-prompt.js";
import type { ToolDefinition } from "@zhixing/core";
import { createWebFetchTool } from "@zhixing/tools-builtin";

// ─── 工具工厂 ───

function stubTool(name: string, overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object" },
    call: async () => ({ content: "" }),
    ...overrides,
  };
}

const defaultTools = [
  stubTool("read"),
  stubTool("write"),
  stubTool("edit"),
  stubTool("glob"),
  stubTool("grep"),
  stubTool("bash"),
];

// ─── 测试 ───

describe("buildSystemPrompt", () => {
  const ctx = { tools: defaultTools, cwd: "/test/project" };

  it("包含身份定义", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Zhixing");
    expect(prompt).toContain("知行");
  });

  it("包含工作原则", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Principles");
    expect(prompt).toContain("Read before edit");
  });

  it("包含动态生成的工具使用段", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Tool Usage");
    expect(prompt).toContain("`read`");
    expect(prompt).toContain("`grep`");
    expect(prompt).toContain("`glob`");
    expect(prompt).toContain("`edit`");
    expect(prompt).toContain("`write`");
    expect(prompt).toContain("`bash`");
  });

  it("含 Commitment 信号抑制叙述原则（ADR-007 Phase 2）", async () => {
    const { COMMITMENT_SIGNAL } = await import("@zhixing/core");
    const prompt = buildSystemPrompt(ctx);
    // 直接引用 core 常量——保证系统提示里的信号字面与 tool-executor 附加到 content 的逐字一致
    expect(prompt).toContain(COMMITMENT_SIGNAL);
    expect(prompt).toMatch(/Do NOT restate|not restate/i);
  });

  it("包含风格段", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Style");
    expect(prompt).toContain("concise");
  });

  it("包含安全段", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("destructive");
  });

  it("包含缓存分界标记", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("__ZHIXING_CACHE_BOUNDARY__");
  });

  it("分界标记将静态区和动态区分隔", () => {
    const prompt = buildSystemPrompt(ctx);
    const [before, after] = prompt.split(CACHE_BOUNDARY);

    // 静态区包含身份和原则
    expect(before).toContain("Zhixing");
    expect(before).toContain("## Principles");

    // 动态区包含环境信息
    expect(after).toContain("## Environment");
    expect(after).toContain("/test/project");
  });

  it("包含环境信息", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Working directory: /test/project");
    expect(prompt).toContain("Platform:");
    expect(prompt).toContain("Node.js:");
  });

  it("shell 参数会出现在环境段", () => {
    const prompt = buildSystemPrompt({ ...ctx, shell: "zsh" });
    expect(prompt).toContain("Shell: zsh");
  });

  it("不传 shell 时环境段不含 Shell 行", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("Shell:");
  });

  describe("工具段动态适应", () => {
    it("仅有 read 工具时，工具段只包含 read", () => {
      const prompt = buildSystemPrompt({ ...ctx, tools: [stubTool("read")] });
      expect(prompt).toContain("`read`");
      expect(prompt).not.toContain("`grep`");
      expect(prompt).not.toContain("`bash`");
    });

    it("无工具时，工具段只有标题", () => {
      const prompt = buildSystemPrompt({ ...ctx, tools: [] });
      expect(prompt).toContain("## Tool Usage");
      expect(prompt).not.toContain("`read`");
    });

    it("添加自定义工具时不影响已有段落", () => {
      const tools = [...defaultTools, stubTool("custom_tool")];
      const prompt = buildSystemPrompt({ ...ctx, tools });
      expect(prompt).toContain("`read`");
    });

    it("包含 parallelSafe 工具时提示并行", () => {
      const tools = [stubTool("read", { isParallelSafe: true })];
      const prompt = buildSystemPrompt({ ...ctx, tools });
      expect(prompt).toContain("parallel");
    });

    it("含 web_fetch(真实工具)时输出 distill / preapproved hosts / not-search 引导", () => {
      const prompt = buildSystemPrompt({
        ...ctx,
        tools: [createWebFetchTool()],
      });
      expect(prompt).toContain("`web_fetch`");
      expect(prompt).toMatch(/does not search the web/i);
      expect(prompt).toMatch(/with `prompt`/i);
      expect(prompt).toMatch(/without `prompt`/i);
      expect(prompt).toContain("github.com");
      expect(prompt).toContain("docs.anthropic.com");
      expect(prompt).toMatch(/Do not invent URLs/i);
    });

    it("不含 web_fetch 时无 web_fetch 引导段", () => {
      const prompt = buildSystemPrompt({ ...ctx, tools: [stubTool("read")] });
      expect(prompt).not.toContain("`web_fetch`");
      expect(prompt).not.toContain("Pre-approved hosts");
    });

    it("自描述 systemPromptHints 通用透传(任意工具自带 hints 都生效)", () => {
      const customHints = [
        "- Use `custom_tool` for X",
        "- Custom hint line 2",
      ];
      const tool = stubTool("custom_tool", { systemPromptHints: customHints });
      const prompt = buildSystemPrompt({ ...ctx, tools: [tool] });
      expect(prompt).toContain("Use `custom_tool` for X");
      expect(prompt).toContain("Custom hint line 2");
    });

    it("无 systemPromptHints 字段的工具不影响其他工具的 hints", () => {
      const toolWithHints = stubTool("custom_a", {
        systemPromptHints: ["- Hint A"],
      });
      const toolWithout = stubTool("custom_b");
      const prompt = buildSystemPrompt({ ...ctx, tools: [toolWithHints, toolWithout] });
      expect(prompt).toContain("Hint A");
    });
  });

  it("静态区在不同 cwd 间保持一致", () => {
    const prompt1 = buildSystemPrompt({ ...ctx, cwd: "/project/a" });
    const prompt2 = buildSystemPrompt({ ...ctx, cwd: "/project/b" });

    const static1 = prompt1.split(CACHE_BOUNDARY)[0];
    const static2 = prompt2.split(CACHE_BOUNDARY)[0];

    expect(static1).toBe(static2);
  });
});
