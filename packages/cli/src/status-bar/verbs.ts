/**
 * 状态条文案——中文动词 + 时间 / token 格式化。
 *
 * 知行调性：低饱和、不卡通、不堆叠英文活泼词；中文动词 + 括号弱化数据。
 * 状态条形态：
 *   主行   `<spinner> <动词>`
 *   括号  `(<时间> · <↑↓ token> · <可选状态描述>)`
 */

import type { AbortReason } from "@zhixing/core/interrupt";
import { shortVisibleLabel } from "../subtasks/presentation.js";

/** M1 交替滚：方菱逐帧交替，单列纹理，10 帧 × 300ms = 3 秒一轮。 */
const SPINNER_FRAMES = ["◇", "□", "◈", "▤", "◆", "▦", "◈", "▨", "◇", "▩"];

/** 帧时长同时用于状态条 ticker，避免帧序与刷新节奏分开维护。 */
export const SPINNER_FRAME_MS = 300;

/** 按时间推算帧；事件触发的额外重画不会推进动画。 */
export function spinnerFrame(now: number): string {
  const frame = Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame]!;
}

/** 正常结束立即显示单列实心菱形，由 renderDonePhase 渲染为弱化色。 */
export const COMPLETED_GLYPH = "◆";

/**
 * 把毫秒数渲染为人类可读时长——最小单位秒，更高单位嵌套展示更细的下级。
 *
 *   < 60s   → `Ns`         (e.g. `0s` / `8s` / `59s`)
 *   < 1h    → `Nm Ms`      (e.g. `1m 0s` / `9m 27s` / `59m 59s`)
 *   ≥ 1h    → `Hh Mm Ss`   (e.g. `1h 0m 0s` / `1h 3m 3s`)
 *
 * 设计意图：
 *   - 不显示比秒更细的精度——状态条数字粗粒度足够，无需随每帧展示毫秒级波动
 *   - 高位单位**保留所有低位**——`1h 2m 0s` 而非 `1h 2m`，让"小时级耗时也能精到秒"
 *     的细节稳定可读，避免 1h 0m 时显示 `1h` 与 1h 1m 时显示 `1h 1m` 的字段闪烁
 *   - `Math.round`（非 floor）：450ms → `0s`、500ms → `1s`，符合直觉的"四舍五入到秒"
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${sec}s`;
  const min = totalMin % 60;
  const hour = Math.floor(totalMin / 60);
  return `${hour}h ${min}m ${sec}s`;
}

/** 把 token 数渲染为紧凑形式——`123` / `1.2k` / `14.3k` / `1.5M` */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 截断 description，超过 maxLen 用省略号收尾。 */
export function truncate(s: string, maxLen: number): string {
  return shortVisibleLabel(s, maxLen);
}

/**
 * 把 AbortReason 渲染为状态条括号内的简短标签——空间有限，不展开完整诊断。
 *
 * 完整诊断由 render.ts 的 formatAbortReasonSummary 在终端摘要行展示（如 server / 日志
 * 路径）。此处仅给状态条的"已中断 (X)"括号内用，X 是最关键的来源标识。
 *
 *   user-cancel (esc)       → "esc"
 *   user-cancel (ctrl-c)    → "ctrl+c"
 *   user-cancel (sigint)    → "sigint"
 *   user-cancel (rpc)       → "rpc"
 *   idle-timeout            → "超时"
 *   parent-abort            → "上层中断"
 *   external (origin?)      → origin or "外部"
 *   null / undefined        → "未知"
 */
export function formatAbortReasonShort(
  reason: AbortReason | null | undefined,
): string {
  if (!reason) return "未知";
  switch (reason.kind) {
    case "user-cancel":
      return reason.source === "ctrl-c" ? "ctrl+c" : reason.source;
    case "idle-timeout":
      return "超时";
    case "parent-abort":
      return "上层中断";
    case "external":
      return reason.origin ?? "外部";
  }
}

/** 状态动词词库——单一中文短语，不带括号 / 标点。 */
export const VERBS = {
  thinking: "思考中",
  streaming: "回复中",
  compacting: "整理上下文",
  retrying: "重试中",
  interrupting: "流式静默",
  toolCalling: (name: string): string => `调用 ${name}`,
  task: (n: number, desc: string): string =>
    `子任务 #${n}: ${truncate(desc, 20)}`,
  done: (ms: number): string => `用时 ${formatDuration(ms)}`,
} as const;
