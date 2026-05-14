/**
 * 安全事件 → 终端横幅渲染
 *
 * 把 secure-executor 通过 onSecurityBlocked 回调上报的策略阻止事件渲染为
 * 人类可读的横幅（pipeline 对 agent 说"不行"——规则拦截）。
 *
 * **user-denied 路径已移除**：用户拒绝场景由 `tool-card-format.formatToolResult`
 * 内的 user-denied 文案翻译（◆ 红色破窗显示 `已拒绝 · <reason>`）承担——避免
 * 与同事件的 ◆ 工具失败破窗视觉重复。secure-executor 的 onUserDenied 回调字段
 * 在 cli 已不再注入，runtime 默认 no-op。
 *
 * 写屏经 CliWriter 协调——blocked 触发时 chrome 在屏幕（turn 进行中），
 * 直接 console.log 会推走 chrome；走 writer.line 让屏幕协调器擦+写+重画。
 *
 * createXxxRenderer factory 模式：caller 在初始化时绑 cliWriter，返回符合
 * createAgentRuntime 公共回调签名的函数，无侵入注入到 onSecurityBlocked。
 *
 * 交互式确认对话框(broker.attach)归 terminal-renderer.ts;
 * 子 agent 路径不传此回调 → 自动静默,失败信息由 tool_result 回流给父 LLM。
 */

import chalk from "chalk";
import type { SecurityMiddlewareResult } from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";
import { stripAnsi } from "../tui/ansi.js";
import { stringWidth } from "../tui/line-width.js";
import { tone } from "../tui/style.js";

/**
 * 渲染全框 banner —— `╭─ title ─...─╮` + `│ content │` × N + `╰─...─╯`。
 *
 * 视觉契约：
 *   - 整体框：上/下/左/右四边封口，banner 是独立成块的视觉单元
 *   - 宽度满屏自适应：frameWidth = max(40, columns - 1)，与 chrome lineBudget
 *     (columns - 1) 同基线；最低 40 列保 robust，宽屏自然延伸
 *   - 边框 dim 染色（去多彩，P5 单 brand cyan；错误信号由文字承担）
 *   - 内容行右 padding 到 innerWidth-1 + 右 │ —— 边框对齐
 *
 * **字符算法（顶边 / 内容行 / 底边总宽度一致 = frameWidth）**：
 *   顶边 `╭─{title}{dashes}╮`:
 *     2 (╭─) + titleVisible + topDashes + 1 (╮) = frameWidth
 *     ⟹ topDashes = frameWidth - 3 - titleVisible
 *   内容行 `│ {content}{pad} │`:
 *     1 (│) + 1 ( ) + content + pad + 1 (│) = frameWidth
 *     ⟹ content + pad = frameWidth - 3
 *     ⟹ pad = frameWidth - 3 - lineVisible
 *   底边 `╰{dashes}╯`:
 *     1 (╰) + (frameWidth - 2) + 1 (╯) = frameWidth
 *
 * 行宽合约：每行可见宽度 = frameWidth ≤ columns - 1，避免终端隐式 wrap。
 */
function renderBoxedBanner(
  writer: CliWriter,
  title: string,
  contentLines: readonly string[],
): void {
  const cols = process.stdout.columns ?? 80;
  const frameWidth = Math.max(40, cols - 1);

  // 顶边：╭─{title}{dashes}╮  总长 = frameWidth
  const titleSegment = ` ${title} `;
  const titleVisible = stringWidth(stripAnsi(titleSegment));
  const topDashes = Math.max(0, frameWidth - 3 - titleVisible);
  writer.line(
    tone.dim(`╭─${titleSegment}${"─".repeat(topDashes)}╮`),
  );

  // 内容行：│ {content}{pad} │  总长 = frameWidth
  for (const line of contentLines) {
    const lineVisible = stringWidth(stripAnsi(line));
    const pad = " ".repeat(Math.max(0, frameWidth - 3 - lineVisible));
    writer.line(`${tone.dim("│")} ${line}${pad}${tone.dim("│")}`);
  }

  // 底边：╰{dashes}╯  总长 = frameWidth
  writer.line(tone.dim(`╰${"─".repeat(frameWidth - 2)}╯`));
}

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
    const lines: string[] = [
      formatOperation(toolName, toolInput),
      "",
      `${chalk.dim("原因:")} ${result.reason ?? "未知"}`,
    ];
    const rules = result.decision?.matchedRules ?? [];
    if (rules.length > 0) {
      lines.push(
        `${chalk.dim("匹配规则:")} ${rules.map((r) => r.id).join(", ")}`,
      );
    }
    writer.line("");
    renderBoxedBanner(writer, "操作被阻止", lines);
  };
}

