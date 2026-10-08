/** Pure Host audit notices; no input or terminal ownership. */
import chalk from "chalk";
import type { PermissionContextId, SecurityEventMap } from "@zhixing/core/security";
import { tone } from "../tui/style.js";
import { wrapAnsiLine } from "../tui/line-width.js";

export function renderAuditEvent(event:
  | { type: "steward_review"; payload: SecurityEventMap["security:steward_review"] }
  | { type: "rule_sedimented"; payload: SecurityEventMap["security:rule_sedimented"] },
): string | null {
  // 输出含 2 空格 indent，与 user / assistant / 工具卡片首列对齐。长内容（含外部
  // 自由文本 reason / pattern）超 columns 时按 wrapAnsiLine 软换行，续行通过
  // continuationPrefix 自动维持 indent —— ANSI 序列与 CJK 全角宽度均原生支持。
  // 段间空行不在此处理：caller 应调 `writer.ensureSegmentBreak()` 表达段间语义。
  const indent = "  ";
  const cols = process.stdout.columns ?? 80;
  const wrapWidth = Math.max(1, cols - indent.length);

  if (event.type === "steward_review") {
    if (event.payload.decision !== "safe") return null;
    const raw = tone.dim(
      `🛡 安全助理放行 ${event.payload.tool} ${event.payload.operation}（理由：${event.payload.reason}）`,
    );
    const { output } = wrapAnsiLine(raw, wrapWidth, {
      continuationPrefix: indent,
    });
    return `${indent}${output}`;
  }

  // rule_sedimented：按 contextId.kind switch exhaustive 拼接作用范围
  // （未来加新 kind 时 TypeScript 强制 highlight 此处，不靠 substring 反推）
  const scope = chalk.bold(formatAuditContextScope(event.payload.contextId));
  const count = event.payload.contributors.length;
  const raw = tone.dim(
    `🛡 已在 ${scope} 记住 ${count} 次同类操作，自动建立放行规则：${event.payload.pattern.argument}（进 /trust 可查看/撤销）`,
  );
  const { output } = wrapAnsiLine(raw, wrapWidth, {
    continuationPrefix: indent,
  });
  return `${indent}${output}`;
}

/**
 * 沉淀作用范围标签 —— 按 contextId.kind switch exhaustive。
 *
 * 主模式标为「主模式」、workspace / scene 都属于"工作场景"对用户呈现统一术语。
 * 未来要 UX 区分 workspace 与 scene 仅需在此处分两支，type system 强制把所有
 * caller 同步 highlight。
 */
function formatAuditContextScope(contextId: PermissionContextId): string {
  switch (contextId.kind) {
    case "main":
      return "主模式";
    case "workspace":
    case "scene":
      return "当前工作场景";
  }
}
