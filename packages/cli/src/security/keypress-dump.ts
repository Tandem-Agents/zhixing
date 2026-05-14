/**
 * Keypress 路径诊断 dump —— SelectOperationRegion 字符输入路径观测通道。
 *
 * **背景**：confirmation panel input mode 字符输入 bug 调查中，readline 在 raw
 * mode + ScreenController 任务队列调度的微妙交互下，可能把单字符 keypress 分
 * 流到 paste-detector 的 onPaste 路径而非 onSingle（postmortem 2026-05-14）。
 * 本通道记录字符路径每个节点，让真实数据告知字符在哪一步丢失/分流。
 *
 * **使用**：
 *   ```
 *   zhixing --log                              # 同时启用 LLM chunk dump + keypress dump
 *   ```
 *   启用后日志写到 `~/.zhixing/logs/keypress-{pid}-{ts}.log`，路径在第一次记录
 *   时通过 stderr 短提示一次（chrome 启动前打印）。
 *
 *   与 LLM chunk dump 共享 `--log` flag —— 单一开关启用所有诊断 channel，避免
 *   多 flag 心智负担。原 ENV `ZHIXING_KEYPRESS_DUMP` 模式因 PowerShell 持久化
 *   到 session（与 bash 单次性不同）已被淘汰——argv 显式标记每次启动明确。
 *
 * **设计契约**（与 llm-chunk-dump 同模式）：
 *   - **默认禁用**：caller 不传 `enabled` 或传 false 时全 noop，零运行成本
 *   - **完全旁路**：dump 失败 swallow，不影响 keypress / chrome / 状态机
 *   - **process-level singleton**：一个 cli 进程一个日志文件，跨多次 confirmation
 *   - **caller 决定 enabled**：caller 在首次 record 之前调
 *     `configureKeypressDump(enabled)` 显式传入；缺省 = 禁用
 */

import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let pendingEnabled = false;
let stream: WriteStream | null = null;
let initStarted = false;
let startTime = 0;

/**
 * caller 在 cli 入口 action 内调一次（首次 record 之前）—— 与
 * `configureLlmChunkDump` 同模式，由 `--log` argv flag 控制。
 *
 * 反复调用：first call wins —— 后续调用静默忽略避免 race（与 LLM dump 同语义）。
 */
export function configureKeypressDump(enabled: boolean): void {
  if (initStarted) return; // first call wins
  pendingEnabled = enabled;
}

/** 是否启用 —— SelectOperationRegion 早期 short-circuit 用 */
export function isKeypressDumpEnabled(): boolean {
  return pendingEnabled;
}

/**
 * 懒初始化 dump 流 —— 首次 record 时创建文件。enabled=false 或多次初始化失败时
 * 返回 null 让 caller 早返不做 I/O。
 */
function ensureStream(): WriteStream | null {
  if (!pendingEnabled) return null;
  if (stream) return stream;
  if (initStarted) return null;
  initStarted = true;

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(homedir(), ".zhixing", "logs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `keypress-${process.pid}-${ts}.log`);

    startTime = Date.now();
    stream = createWriteStream(path, { flags: "a" });
    stream.write(`# zhixing keypress dump (pid ${process.pid})\n`);
    stream.write(`# Started at ${new Date().toISOString()}\n`);
    stream.write(`# Records SelectOperationRegion keypress path nodes:\n`);
    stream.write(`#   stdin.keypress-raw, batcher.onSingle, batcher.onPaste,\n`);
    stream.write(`#   handleKeypress.*, translateKey.result, reduceSelect.result,\n`);
    stream.write(`#   repaint.triggered, finish.\n`);
    stream.write(`# Use this to diagnose "字符输入不显示" / 按键路径异常 类 bug.\n\n`);
    // allow-direct-stdout
    process.stderr.write(
      `[zhixing] keypress dump enabled → ${path}\n`,
    );
    return stream;
  } catch {
    // IO 失败退化为 noop；不抛错让 cli 主流程不受影响
    return null;
  }
}

/**
 * 记录一个 keypress 路径节点 —— stage 标识节点名，data 提供上下文。
 *
 * data 内 `str` / `content` 等字符串字段自动展开 codepoint hex 让不可见字符
 * （控制字符 / IME 中文 / surrogate pair 等）也可识别——这是 postmortems
 * 2026-05-07 案例的关键观测手段（U+007F DEL 字符通过 codepoint hex 被识别）。
 */
export function recordKeypressEvent(
  stage: string,
  data: Record<string, unknown>,
): void {
  const s = ensureStream();
  if (!s) return;
  const dt = Date.now() - startTime;
  s.write(`[+${dt}ms] ${stage}\n`);
  for (const [k, v] of Object.entries(data)) {
    const valStr =
      typeof v === "string" ? formatString(v) : JSON.stringify(v);
    s.write(`  ${k}: ${valStr}\n`);
  }
  s.write("\n");
}

/**
 * 字符串展开：raw + codepoint hex 列表。
 *
 * 示例：
 *   "s" → `"s" [U+0073]`
 *   "中" → `"中" [U+4E2D]`
 *   "\x1b[B" (ANSI down) → `"[B" [U+001B U+005B U+0042]`
 *   "" → `"" []`
 */
function formatString(s: string): string {
  const codepoints = Array.from(s)
    .map(
      (ch) =>
        `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    )
    .join(" ");
  return `${JSON.stringify(s)} [${codepoints}]`;
}
