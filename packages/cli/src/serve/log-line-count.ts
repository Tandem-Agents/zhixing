export const DEFAULT_LOG_LINES = 50;
export const MAX_LOG_LINES = 5000;

export function normalizeLogLineCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOG_LINES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LOG_LINES) {
    throw new Error(`--lines 必须是 1 到 ${MAX_LOG_LINES} 的整数`);
  }
  return value;
}
