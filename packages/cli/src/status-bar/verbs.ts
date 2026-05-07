/**
 * 状态条文案——中文动词 + 时间 / token 格式化。
 *
 * 知行调性：低饱和、不卡通、不堆叠英文活泼词；中文动词 + 括号弱化数据。
 * 状态条形态：
 *   主行   `<spinner> <动词>`
 *   括号  `(<时间> · <↑↓ token> · <可选状态描述>)`
 */

import type { AbortReason } from "@zhixing/core";

/**
 * 「印鉴流转」spinner——知行的视觉签名，4 个图形 ◈ ▣ ■ ◆ 在双轴矩阵上环绕滚动。
 *
 * 设计理念：
 *   AI 思考过程是印章在 2×2 矩阵上沿外周滚动一圈：
 *
 *                  形状轴
 *              菱形(0°)   方形(45°)
 *            ┌──────────┬──────────┐
 *      带核  │    ◈ ─────▶  ▣     │   ← 中心空心（虚）
 *            │    ▲          │     │
 *            │    │          ▼     │
 *      实心  │    ◆ ◀─────  ■     │   ← 中心填实
 *            └──────────┴──────────┘
 *                  密度轴
 *
 *   帧序列 ◈ → ▣ → ■ → ◆ → ◈ 沿矩阵外周顺时针滚动——**每步只变一个属性**，
 *   相邻帧视觉相似度高，产生"连续滚动"而非"对角跳跃"的体感：
 *
 *     步 1: ◈→▣  形状变（菱→方），密度保持带核    "旋转 45°"
 *     步 2: ▣→■  密度变（带核→实心），形状保持方  "填实"
 *     步 3: ■→◆  形状变（方→菱），密度保持实心    "旋转回"
 *     步 4: ◆→◈  密度变（实心→带核），形状保持菱  "变虚"
 *
 * 完成态：dim 暗色的 ◆ —— 形态守恒（◆ 在 spinner 帧 3），颜色弱化（活跃→静默）。
 * ◆ 同时也是 AI 文字段起首锚 (◆ 你好...)，三场景同字符 = 知行的核心视觉签名。
 *
 * 4 帧 × 250ms = 1000ms 一周期——节奏与 status-bar.ts 的 TICK_INTERVAL_MS 严格
 * 同步：每次 ticker repaint 都精确推进一个 spinner 帧，否则 floor(now/FRAME_MS)
 * 与 250ms 采样不整除时会跳帧（如 180/250 不整除时 ◆ 帧从不显示）。
 */
const SPINNER_FRAMES = ["◈", "▣", "■", "◆"];

/**
 * 帧时长（ms）—— **必须与 status-bar.ts 的 TICK_INTERVAL_MS 一致**，否则 spinner
 * 在 ticker 采样点上的取值会跳帧，部分帧字符永远不被显示（视觉上会变成 3 帧循环
 * 而不是 4 帧）。改动其一时，另一处也要同步。
 */
const FRAME_MS = 250;

/** 「印鉴流转」spinner 字符——按时间戳推算帧 */
export function spinnerFrame(now: number): string {
  const frame = Math.floor(now / FRAME_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame]!;
}

/**
 * 完成态字符——◆ 实心菱（与 AI 文字锚同字符）。spinner 帧 3 也是 ◆，从流转到完成
 * 是"形状不变，颜色由 brand 亮色变为 dim 弱化色"——动→静且强→弱的双轴过渡。
 *
 * caller（renderDonePhase）负责用 tone.dim 包裹此字符渲染弱化色。
 */
export const COMPLETED_GLYPH = "◆";

/**
 * 把毫秒数渲染为人类可读时长——最小单位秒，更高单位嵌套展示更细的下级。
 *
 *   < 60s   → `Ns`         (e.g. `0s` / `8s` / `59s`)
 *   < 1h    → `Nm Ms`      (e.g. `1m 0s` / `9m 27s` / `59m 59s`)
 *   ≥ 1h    → `Hh Mm Ss`   (e.g. `1h 0m 0s` / `1h 3m 3s`)
 *
 * 设计意图：
 *   - 不显示比秒更细的精度——状态条数字粗粒度足够，毫秒级波动在 ticker 250ms
 *     节流下也无法稳定展示
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

/** 截断 description，超过 maxLen 用省略号收尾——CJK 全宽按字符数计简化处理。 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
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
