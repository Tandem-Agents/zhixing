/**
 * 安全事件 → 终端横幅渲染
 *
 * 把 secure-executor 通过 onBlocked / onUserDenied 回调上报的事件渲染为
 * 人类可读的彩色横幅。两个函数都是单向输出(无 UI 交互):
 *   - block 横幅:策略 / 权限规则拦截(pipeline 对 agent 说"不行")
 *   - user-denied 横幅:用户在 confirmation 面板选"拒绝并说明原因"
 *     (用户对 agent 说"不做",含 reason 反馈)
 *
 * 写屏经 CliWriter 协调——blocked / userDenied 触发时 chrome 在屏幕（turn 进行中），
 * 直接 console.log 会推走 chrome；走 writer.line 让屏幕协调器擦+写+重画。
 *
 * createXxxRenderer factory 模式：caller 在初始化时绑 cliWriter，返回符合
 * createAgentRuntime 公共回调签名的函数，无侵入注入到 onSecurityBlocked / onUserDenied。
 *
 * 交互式确认对话框(broker.attach)归 terminal-renderer.ts;
 * 子 agent 路径不传这两个回调 → 自动静默,失败信息由 tool_result 回流给父 LLM。
 */

import chalk from "chalk";
import type { SecurityMiddlewareResult } from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";

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

/**
 * 创建 onSecurityBlocked 渲染器——绑定 cliWriter，返回符合 createAgentRuntime 回调
 * 签名的函数。caller 在 cli 入口创建一次，传给 createAgentRuntime.onSecurityBlocked。
 */
export function createBlockedRenderer(writer: CliWriter) {
  return (
    toolName: string,
    toolInput: Record<string, unknown>,
    result: SecurityMiddlewareResult,
  ): void => {
    writer.line("");
    writer.line(chalk.red("╭─ 操作被阻止 ────────────────────────"));
    writer.line(`${chalk.red("│")} ${formatOperation(toolName, toolInput)}`);
    writer.line(chalk.red("│"));
    writer.line(
      `${chalk.red("│")} ${chalk.dim("原因:")} ${result.reason ?? "未知"}`,
    );
    const rules = result.decision?.matchedRules ?? [];
    if (rules.length > 0) {
      writer.line(
        `${chalk.red("│")} ${chalk.dim("匹配规则:")} ${rules
          .map((r) => r.id)
          .join(", ")}`,
      );
    }
    writer.line(chalk.red("╰────────────────────────────────────────"));
  };
}

/**
 * 创建 onUserDenied 渲染器——同 createBlockedRenderer 模式。
 *
 * 策略阻止是 pipeline 对 agent 说"不行"(规则拦截);
 * 用户拒绝是用户对 agent 说"不做"(意志表达)。
 * 两者应有不同的视觉和文案。
 */
export function createUserDeniedRenderer(writer: CliWriter) {
  return (
    toolName: string,
    toolInput: Record<string, unknown>,
    userReason?: string,
  ): void => {
    writer.line("");
    writer.line(chalk.yellow("╭─ 已拒绝 ────────────────────────────"));
    writer.line(`${chalk.yellow("│")} ${formatOperation(toolName, toolInput)}`);
    writer.line(chalk.yellow("│"));
    if (userReason && userReason.trim()) {
      writer.line(
        `${chalk.yellow("│")} ${chalk.dim("用户反馈:")} ${userReason}`,
      );
    } else {
      writer.line(
        `${chalk.yellow("│")} ${chalk.dim("用户未提供具体原因")}`,
      );
    }
    writer.line(chalk.yellow("╰────────────────────────────────────────"));
  };
}
