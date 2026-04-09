/**
 * 摘要质量校验
 *
 * 设计决策：
 * - 必需章节标题检查（继承 OpenClaw 的 audit 思路）
 * - 不做 identifier 逐一校验（过于严格，成本不匹配）
 * - 单次重试（2 次不过就降级）
 */

// ─── 主会话必需章节 ───

export const REQUIRED_MAIN_SECTIONS = [
  "## 核心目标",
  "## 技术上下文",
  "## 文件与变更",
  "## 已解决与未解决",
  "## 待办清单",
  "## 当前进度",
  "## 关键标识符",
] as const;

// ─── Sub-agent 必需章节 ───

export const REQUIRED_SUB_SECTIONS = [
  "## 任务概述",
  "## 当前状态",
  "## 关键发现",
  "## 下一步",
  "## 保留上下文",
] as const;

// ─── 校验结果 ───

export interface ValidationResult {
  valid: boolean;
  missing: string[];
}

// ─── 校验函数 ───

/**
 * 检查摘要是否包含所有必需章节标题。
 *
 * 匹配规则：按行 trim 后精确匹配标题文本。
 * 对比 OpenClaw：它还检查 identifier 保留和 user ask 重叠度，
 * 我们选择在 prompt 中强调这些要求，但不做逐一校验。
 */
export function validateSummary(
  summary: string,
  template: "main-session" | "sub-agent" = "main-session",
): ValidationResult {
  const sections =
    template === "main-session"
      ? REQUIRED_MAIN_SECTIONS
      : REQUIRED_SUB_SECTIONS;

  const lines = new Set(summary.split("\n").map((l) => l.trim()));

  const missing = sections.filter((section) => !lines.has(section));

  return {
    valid: missing.length === 0,
    missing: [...missing],
  };
}
