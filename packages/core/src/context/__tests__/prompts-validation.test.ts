import { describe, expect, it } from "vitest";
import {
  MAIN_SESSION_PROMPT,
  SUB_AGENT_PROMPT,
  MERGE_SUMMARIES_PROMPT,
  buildContinuationMessage,
  buildManualCompactMessage,
  buildRetryPrompt,
  getSummarizationPrompt,
  wrapCustomInstructions,
} from "../prompts.js";
import {
  REQUIRED_MAIN_SECTIONS,
  REQUIRED_SUB_SECTIONS,
  validateSummary,
} from "../validation.js";

// ─── Prompt 模板 ───

describe("MAIN_SESSION_PROMPT", () => {
  it("包含全部 7 个必需章节标题", () => {
    for (const section of REQUIRED_MAIN_SECTIONS) {
      expect(MAIN_SESSION_PROMPT).toContain(section);
    }
  });

  it("包含关键指令", () => {
    expect(MAIN_SESSION_PROMPT).toContain("不要调用任何工具");
    expect(MAIN_SESSION_PROMPT).toContain("用对话的主要语言");
    expect(MAIN_SESSION_PROMPT).toContain("原样保留");
  });
});

describe("SUB_AGENT_PROMPT", () => {
  it("包含全部 5 个必需章节标题", () => {
    for (const section of REQUIRED_SUB_SECTIONS) {
      expect(SUB_AGENT_PROMPT).toContain(section);
    }
  });

  it("强调任务恢复导向", () => {
    expect(SUB_AGENT_PROMPT).toContain("可立即恢复任务");
  });
});

describe("MERGE_SUMMARIES_PROMPT", () => {
  it("包含合并要求关键词", () => {
    expect(MERGE_SUMMARIES_PROMPT).toContain("保留所有活跃任务");
    expect(MERGE_SUMMARIES_PROMPT).toContain("标识符原样保留");
  });
});

// ─── getSummarizationPrompt ───

describe("getSummarizationPrompt", () => {
  it("main-session 返回 7 段模板", () => {
    const prompt = getSummarizationPrompt("main-session");
    expect(prompt).toContain("## 核心目标");
    expect(prompt).toContain("## 关键标识符");
  });

  it("sub-agent 返回 5 段模板", () => {
    const prompt = getSummarizationPrompt("sub-agent");
    expect(prompt).toContain("## 任务概述");
    expect(prompt).toContain("## 保留上下文");
    expect(prompt).not.toContain("## 核心目标");
  });

  it("追加自定义指令", () => {
    const prompt = getSummarizationPrompt(
      "main-session",
      "特别关注数据库迁移",
    );
    expect(prompt).toContain("特别关注数据库迁移");
    expect(prompt).toContain("请在摘要中特别关注");
  });

  it("自定义指令截断到 800 字符", () => {
    const long = "x".repeat(1000);
    const prompt = getSummarizationPrompt("main-session", long);
    const customPart = prompt.slice(MAIN_SESSION_PROMPT.length);
    expect(customPart.length).toBeLessThan(1000);
  });
});

// ─── 续写消息 ───

describe("buildContinuationMessage", () => {
  it("包含摘要内容和续航指令", () => {
    const msg = buildContinuationMessage("## 核心目标\n测试摘要");
    expect(msg).toContain("对话已压缩");
    expect(msg).toContain("## 核心目标");
    expect(msg).toContain("测试摘要");
    expect(msg).toContain("继续工作");
  });
});

describe("buildManualCompactMessage", () => {
  it("包含摘要内容和等待指令", () => {
    const msg = buildManualCompactMessage("## 核心目标\n测试摘要");
    expect(msg).toContain("对话已压缩");
    expect(msg).toContain("等待用户");
  });
});

// ─── 重试 prompt ───

describe("buildRetryPrompt", () => {
  it("列出缺失的章节", () => {
    const prompt = buildRetryPrompt(["## 核心目标", "## 当前进度"]);
    expect(prompt).toContain("## 核心目标");
    expect(prompt).toContain("## 当前进度");
    expect(prompt).toContain("缺少");
  });
});

// ─── wrapCustomInstructions ───

describe("wrapCustomInstructions", () => {
  it("空字符串返回空", () => {
    expect(wrapCustomInstructions("")).toBe("");
    expect(wrapCustomInstructions("   ")).toBe("");
  });

  it("包装格式正确", () => {
    const result = wrapCustomInstructions("关注性能优化");
    expect(result).toContain("[用户的额外聚焦指令]");
    expect(result).toContain("关注性能优化");
  });
});

// ─── validateSummary ───

describe("validateSummary", () => {
  const validMainSummary = REQUIRED_MAIN_SECTIONS.map(
    (s) => `${s}\n一些内容`,
  ).join("\n\n");

  const validSubSummary = REQUIRED_SUB_SECTIONS.map(
    (s) => `${s}\n一些内容`,
  ).join("\n\n");

  it("完整的主会话摘要通过校验", () => {
    const result = validateSummary(validMainSummary, "main-session");
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("完整的 sub-agent 摘要通过校验", () => {
    const result = validateSummary(validSubSummary, "sub-agent");
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("缺少章节时返回 missing 列表", () => {
    const incomplete = "## 核心目标\n内容\n\n## 技术上下文\n内容";
    const result = validateSummary(incomplete, "main-session");
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("## 文件与变更");
    expect(result.missing).toContain("## 当前进度");
    expect(result.missing).toContain("## 关键标识符");
  });

  it("空摘要检测所有章节缺失", () => {
    const result = validateSummary("", "main-session");
    expect(result.valid).toBe(false);
    expect(result.missing).toHaveLength(7);
  });

  it("默认使用 main-session 模板", () => {
    const result = validateSummary(validMainSummary);
    expect(result.valid).toBe(true);
  });

  it("章节标题前后有空格也能匹配", () => {
    const withSpaces = REQUIRED_MAIN_SECTIONS.map(
      (s) => `  ${s}  \n内容`,
    ).join("\n\n");
    const result = validateSummary(withSpaces, "main-session");
    expect(result.valid).toBe(true);
  });
});
