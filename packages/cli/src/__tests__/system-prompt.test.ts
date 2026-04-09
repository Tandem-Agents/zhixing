import { describe, it, expect } from "vitest";
import { buildSystemPrompt, CACHE_BOUNDARY } from "../system-prompt.js";
import type { ToolDefinition } from "@zhixing/core";

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
  });

  it("静态区在不同 cwd 间保持一致", () => {
    const prompt1 = buildSystemPrompt({ ...ctx, cwd: "/project/a" });
    const prompt2 = buildSystemPrompt({ ...ctx, cwd: "/project/b" });

    const static1 = prompt1.split(CACHE_BOUNDARY)[0];
    const static2 = prompt2.split(CACHE_BOUNDARY)[0];

    expect(static1).toBe(static2);
  });
});
