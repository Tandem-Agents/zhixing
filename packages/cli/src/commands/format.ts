/**
 * 命令输出的共享展示格式化 —— 跨命令模块（info 的 /tasks、session 的 /resume）与
 * repl 的对话选择器都要把时间戳渲染成"x 分钟前"，收在中立 util 里单点定义，避免
 * 各处各写一份、也避免命令模块反向依赖 repl。
 */

/** 把绝对时间渲染成相对人读时间（"刚刚" / "3 分钟前" / "昨天" / "5 天前"）。 */
export function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  return `${days} 天前`;
}
