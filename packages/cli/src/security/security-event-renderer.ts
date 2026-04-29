/**
 * 安全事件 → 终端横幅渲染
 *
 * 把 secure-executor 通过 onBlocked / onUserDenied 回调上报的事件渲染为
 * 人类可读的彩色横幅。两个函数都是单向输出(无 UI 交互):
 *   - block 横幅:策略 / 权限规则拦截(pipeline 对 agent 说"不行")
 *   - user-denied 横幅:用户在 confirmation 面板选"拒绝并说明原因"
 *     (用户对 agent 说"不做",含 reason 反馈)
 *
 * 交互式确认对话框(broker.attach)归 terminal-renderer.ts;
 * 子 agent 路径不传这两个回调 → 自动静默,失败信息由 tool_result 回流给父 LLM。
 */

import chalk from "chalk";
import type { SecurityMiddlewareResult } from "@zhixing/core";

/**
 * 把"工具 + 入参"渲染为人类可读的一行,bash / 文件路径 / 通用 JSON 三种形态。
 */
function formatOperation(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "bash" || toolName === "shell") {
    const cmd = typeof input["command"] === "string" ? input["command"] : "";
    return `${chalk.gray("$")} ${chalk.cyan(cmd)}`;
  }
  const pathArg =
    (typeof input["path"] === "string" && input["path"]) ||
    (typeof input["file_path"] === "string" && input["file_path"]) ||
    (typeof input["target"] === "string" && input["target"]) ||
    "";
  if (pathArg) {
    return `${chalk.gray(toolName + " →")} ${chalk.cyan(pathArg)}`;
  }
  const summary = JSON.stringify(input);
  const brief = summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
  return `${chalk.gray(toolName)} ${chalk.dim(brief)}`;
}

/** 渲染"被策略 / 权限规则阻止"的拒绝消息 —— 无需用户交互 */
export function renderBlockedMessage(
  toolName: string,
  toolInput: Record<string, unknown>,
  result: SecurityMiddlewareResult,
): void {
  console.log();
  console.log(chalk.red("╭─ 操作被阻止 ────────────────────────"));
  console.log(`${chalk.red("│")} ${formatOperation(toolName, toolInput)}`);
  console.log(chalk.red("│"));
  console.log(
    `${chalk.red("│")} ${chalk.dim("原因:")} ${result.reason ?? "未知"}`,
  );
  const rules = result.decision?.matchedRules ?? [];
  if (rules.length > 0) {
    console.log(
      `${chalk.red("│")} ${chalk.dim("匹配规则:")} ${rules
        .map((r) => r.id)
        .join(", ")}`,
    );
  }
  console.log(chalk.red("╰────────────────────────────────────────"));
}

/**
 * 渲染"用户主动拒绝"的消息 —— 与策略阻止语义不同。
 *
 * 策略阻止是 pipeline 对 agent 说"不行"(规则拦截);
 * 用户拒绝是用户对 agent 说"不做"(意志表达)。
 * 两者应有不同的视觉和文案,否则会显示成"原因: 无匹配规则,默认放行"这种
 * 把审批触发原因当作拒绝原因的滑稽输出。
 */
export function renderUserDeniedMessage(
  toolName: string,
  toolInput: Record<string, unknown>,
  userReason?: string,
): void {
  console.log();
  console.log(chalk.yellow("╭─ 已拒绝 ────────────────────────────"));
  console.log(`${chalk.yellow("│")} ${formatOperation(toolName, toolInput)}`);
  console.log(chalk.yellow("│"));
  if (userReason && userReason.trim()) {
    console.log(
      `${chalk.yellow("│")} ${chalk.dim("用户反馈:")} ${userReason}`,
    );
  } else {
    console.log(
      `${chalk.yellow("│")} ${chalk.dim("用户未提供具体原因")}`,
    );
  }
  console.log(chalk.yellow("╰────────────────────────────────────────"));
}
