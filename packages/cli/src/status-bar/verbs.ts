/**
 * 状态条文案——中文动词 + 时间 / token 格式化。
 *
 * 知行调性：低饱和、不卡通、不堆叠英文活泼词；中文动词 + 括号弱化数据。
 * 状态条形态：
 *   主行   `<spinner> <动词>`
 *   括号  `(<时间> · <↑↓ token> · <可选状态描述>)`
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 旋转 spinner 字符——按时间戳推算帧（80ms / frame） */
export function spinnerFrame(now: number): string {
  const frame = Math.floor(now / 80) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame]!;
}

/** 完成态静态字符（六瓣花，与 spinner 形态成对呼应） */
export const COMPLETED_GLYPH = "✻";

/** 把毫秒数渲染为人类可读时长——`450ms` / `7.3s` / `3m 45s` / `1h 2m` */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remainSec = Math.floor(totalSec % 60);
  if (totalMin < 60) return `${totalMin}m ${remainSec}s`;
  const totalHour = Math.floor(totalMin / 60);
  const remainMin = totalMin % 60;
  return `${totalHour}h ${remainMin}m`;
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

/** 状态动词词库——单一中文短语，不带括号 / 标点。 */
export const VERBS = {
  thinking: "思考中",
  streaming: "回复中",
  compacting: "整理上下文",
  retrying: "重试中",
  toolCalling: (name: string): string => `调用 ${name}`,
  task: (n: number, desc: string): string =>
    `子任务 #${n}: ${truncate(desc, 20)}`,
  done: (ms: number): string => `完成于 ${formatDuration(ms)}`,
} as const;
