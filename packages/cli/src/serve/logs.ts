/**
 * `zhixing serve logs` — 查看后台宿主日志
 *
 * 两个模式：
 *   默认：读 ~/.zhixing/logs/server/server.log → 打印最后 N 行（默认 50）
 *   --tail：持续跟踪模式（每 500ms poll，文件增长则增量输出新内容）
 *
 * 为什么用轮询而非 fs.watch：
 * - Windows 上 fs.watch 每次写入触发多次事件、需自行去重
 * - 跨平台行为不一致，跨文件系统（samba/nfs）经常不工作
 * - 轮询 ~30 行实现，行为可预测
 *
 * 所有外部依赖通过 deps 注入，便于测试不真的读写磁盘或阻塞 stdin。
 */

import chalk from "chalk";
import { stat as fsStat, readFile, open as fsOpen } from "node:fs/promises";
import { getDefaultLogPath } from "@zhixing/server";

export const DEFAULT_LOG_LINES = 50;
export const MAX_LOG_LINES = 5000;

export interface LogsOptions {
  /** 默认模式显示的行数，默认 50 */
  lines?: number;
  /** 跟踪模式 */
  tail?: boolean;
  /** 跟踪模式轮询间隔，默认 500ms */
  pollMs?: number;
  /** 日志路径覆盖（测试用）*/
  logPath?: string;
  /** 跟踪停止条件（测试用；返回 true 则 stop）。生产使用 AbortSignal 或 Ctrl+C */
  stopCondition?: () => boolean;
  /** 依赖注入 */
  deps?: LogsDeps;
}

export interface LogsDeps {
  statFn?: (path: string) => Promise<{ size: number }>;
  readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>;
  /** 从 offset 开始读到 EOF，返回新增字节数据 */
  readRangeFn?: (path: string, from: number, to: number) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  console?: Pick<Console, "log" | "error">;
}

export async function runLogsCommand(opts: LogsOptions = {}): Promise<void> {
  const deps = opts.deps ?? {};
  const logPath = opts.logPath ?? getDefaultLogPath();
  const lines = normalizeLogLineCount(opts.lines);
  const con = deps.console ?? console;

  if (opts.tail) {
    await tailLog({ logPath, lines, pollMs: opts.pollMs ?? 500, stopCondition: opts.stopCondition, deps });
  } else {
    await printLastLines({ logPath, lines, deps, console: con });
  }
}

export function normalizeLogLineCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOG_LINES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LOG_LINES) {
    throw new Error(`--lines 必须是 1 到 ${MAX_LOG_LINES} 的整数`);
  }
  return value;
}

// ─── 默认模式 ───

interface PrintLastOpts {
  logPath: string;
  lines: number;
  deps: LogsDeps;
  console: Pick<Console, "log" | "error">;
}

async function printLastLines(opts: PrintLastOpts): Promise<void> {
  const readFileFn = opts.deps.readFileFn ?? ((p, e) => readFile(p, e));
  let content: string;
  try {
    content = await readFileFn(opts.logPath, "utf-8");
  } catch (err) {
    opts.console.error(chalk.red(`Failed to read ${opts.logPath}: ${errMsg(err)}`));
    return;
  }
  const allLines = content.split("\n");
  // split 后末尾通常是 ""（如果以 \n 结尾），剔除以免空行污染 tail
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const tail = allLines.slice(-opts.lines);
  for (const line of tail) opts.console.log(line);
}

// ─── 跟踪模式 ───

interface TailOpts {
  logPath: string;
  lines: number;
  pollMs: number;
  stopCondition?: () => boolean;
  deps: LogsDeps;
}

async function tailLog(opts: TailOpts): Promise<void> {
  const stat = opts.deps.statFn ?? defaultStat;
  const readRange = opts.deps.readRangeFn ?? defaultReadRange;
  const sleep = opts.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const con = opts.deps.console ?? console;

  // 1. 首次：打印最后 N 行 + 记录当前 size
  let lastSize = 0;
  try {
    const first = await stat(opts.logPath);
    lastSize = first.size;
  } catch {
    con.error(chalk.dim(`(waiting for ${opts.logPath} to appear...)`));
  }
  await printLastLines({ logPath: opts.logPath, lines: opts.lines, deps: opts.deps, console: con });

  // 2. 轮询
  const shouldStop = opts.stopCondition ?? (() => false);
  while (!shouldStop()) {
    await sleep(opts.pollMs);
    let currentSize: number;
    try {
      currentSize = (await stat(opts.logPath)).size;
    } catch {
      // 文件被删/换 → 重置 size（下次 append 时增量读）
      lastSize = 0;
      continue;
    }

    if (currentSize < lastSize) {
      // 文件被截断（truncate）→ 从头开始
      lastSize = 0;
    }

    if (currentSize > lastSize) {
      try {
        const delta = await readRange(opts.logPath, lastSize, currentSize);
        con.log(delta.replace(/\n$/, ""));
      } catch (err) {
        con.error(chalk.red(`tail read error: ${errMsg(err)}`));
      }
      lastSize = currentSize;
    }
  }
}

// ─── 默认实现 ───

async function defaultStat(path: string): Promise<{ size: number }> {
  const s = await fsStat(path);
  return { size: s.size };
}

async function defaultReadRange(path: string, from: number, to: number): Promise<string> {
  const length = to - from;
  if (length <= 0) return "";
  const handle = await fsOpen(path, "r");
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, from);
    return buf.toString("utf-8");
  } finally {
    await handle.close();
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
