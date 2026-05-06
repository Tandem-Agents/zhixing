/**
 * 角色锚字符 + 颜色映射。
 *
 * 单字符锚家族（角色起首）：
 *   用户 ❯ / AI ◆◇ / 工具 ⟡ / 子 agent ⌬ / 章节 ▎
 *
 * AI 锚状态化：
 *   ◆ 实心 = 完成态（白默认 / 绿成功 / 红失败）
 *   ◇ 空心 = 进行中态（白色亮暗震荡，仅工具/操作类）
 *
 * AI 普通文字回复无"进行中"状态——边到边 chunk 输出每段即完成；
 * 闪烁仅工具/操作类专属。形态与颜色独立编码：形态承载"是否完成"，
 * 颜色承载"成败"，色弱用户仍能识别完成态。
 */

import chalk from "chalk";

export const ANCHOR_AI_DONE = "◆";
export const ANCHOR_AI_RUNNING = "◇";
export const ANCHOR_TOOL = "⟡";
export const ANCHOR_SUB_AGENT = "⌬";

/** AI 文字回复起首锚——白色实心。 */
export function aiTextAnchor(): string {
  return chalk.white(ANCHOR_AI_DONE);
}

/** 工具进行中锚——空心，颜色由 caller 在 bright/dim 间切换驱动闪烁。 */
export function toolRunningAnchor(brightness: "bright" | "dim"): string {
  return brightness === "bright"
    ? chalk.white(ANCHOR_AI_RUNNING)
    : chalk.dim.white(ANCHOR_AI_RUNNING);
}

/** 工具完成锚——实心绿（成功）/ 红（失败）。 */
export function toolDoneAnchor(success: boolean): string {
  return success ? chalk.green(ANCHOR_AI_DONE) : chalk.red(ANCHOR_AI_DONE);
}
