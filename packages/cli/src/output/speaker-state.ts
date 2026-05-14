/**
 * 角色锚字符 + 颜色映射。
 *
 * 单字符锚家族（角色起首）：
 *   用户 ❯ / AI ◆◇ / 工具批次 ⟡ / 副作用 ✎ / 子 agent ⌬ / 章节 ▎
 *
 * AI 锚状态化：
 *   ◆ 实心 = 完成态（白默认 / 绿成功 / 红失败）
 *   ◇ 空心 = 进行中态（白色亮暗震荡，仅工具/操作类）
 *
 * AI 普通文字回复无"进行中"状态——边到边 chunk 输出每段即完成；
 * 闪烁仅工具/操作类专属。形态与颜色独立编码：形态承载"是否完成"，
 * 颜色承载"成败"，色弱用户仍能识别完成态。
 *
 * **工具锚的双形态**（产品决策——按 LLM 行为相位分流）：
 *   - ⟡ 探索批次锚：read / glob / grep / bash 等 default 工具走 batch coordinator
 *     折叠展示。次级 dim 视觉。
 *   - ✎ 副作用锚：write / edit / schedule 等 side-effect 工具改变持久状态。
 *     永不折叠，独立成行 dim 但形态突出。让用户随时知道「AI 改了我什么」是
 *     agent 与用户建立信任的产品基石。
 */

import chalk from "chalk";

export const ANCHOR_AI_DONE = "◆";
export const ANCHOR_AI_RUNNING = "◇";
export const ANCHOR_TOOL = "⟡";
/**
 * 副作用工具锚——铅笔字符 U+270E，语义即时（编辑）。
 * 与 ⟡（菱形线框）形态差异大，扫读时一眼跳出；用户无需学习成本即可识别
 * 「这是一条改变持久状态的工具调用」。
 */
export const ANCHOR_SIDE_EFFECT = "✎";
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

/**
 * 副作用工具锚——dim ✎，单行独立成段使用。
 *
 * 与 batch 头部 ⟡ 同样走 dim 色阶——不抢 ◆ AI 决策行的视觉主轴；但 ✎ 形态独立
 * + 永不折叠 + 独立成段三重视觉信号让副作用扫读时天然跳出。
 */
export function sideEffectAnchor(): string {
  return chalk.dim(ANCHOR_SIDE_EFFECT);
}
