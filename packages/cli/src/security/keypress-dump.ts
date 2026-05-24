/**
 * Keypress 路径诊断 dump —— SelectOperationRegion 字符输入路径观测通道 +
 * confirm 面板前后 REPL stdin 生命周期观测。
 *
 * **背景**：
 *   - confirmation panel input mode 字符输入 bug（postmortem 2026-05-14）
 *   - confirm 面板退出后输入冻结 bug（postmortem 2026-05-20，ConPTY raw-mode
 *     翻转死锁）—— 涵盖 panel 之外的 typeahead.suspend/resume /
 *     keyboard.attach/detach / 在 turn 边界释放 stdin ownership 等 REPL 生命周期节点。
 *   本通道记录字符路径与 stdin 生命周期每个节点，让真实数据告知字符在哪一步
 *   丢失/分流，以及 stdin/raw mode/listener 状态何时被错误重置。
 *
 * **生产路径零开销**：所有 record 函数顶部 `pendingEnabled` 早返 + `--log` 默认
 * 关闭。Sync I/O 与 2000ms 周期轮询仅在 dump 启用时生效。
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

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getZhixingHome } from "@zhixing/core";

let pendingEnabled = false;
let logPath: string | null = null;
let initStarted = false;
let pollIntervalStarted = false;
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
  // dump 启用 → 同时启周期性 stdin 状态轮询。这是 2026-05-20 postmortem(confirm
  // 面板退出后输入冻结 / ConPTY raw-mode 翻转死锁)的关键诊断工具:Node Readable
  // 自报健康但底层不 emit 事件时,需要轮询佐证"指标全绿但事件不来"。
  //
  // 频率 2000ms:每分钟 30 条,既能在几秒内捕捉到状态转移,又不至于在长会话里灌
  // 满日志。timer.unref() 让它不阻塞进程退出。pollIntervalStarted 防 caller
  // 反复 configureKeypressDump(true) 触发多个 setInterval 并行 —— first call wins
  // 的 initStarted 守卫只在首次 record 后才生效,configureKeypressDump 本身
  // 不被它覆盖。
  if (
    enabled &&
    !pollIntervalStarted &&
    typeof process.stdin !== "undefined"
  ) {
    pollIntervalStarted = true;
    const timer = setInterval(() => {
      recordStdinSnapshot("stdin.periodic-poll", process.stdin);
    }, 2000);
    if (typeof timer.unref === "function") timer.unref();
  }
}

/** 是否启用 —— SelectOperationRegion 早期 short-circuit 用 */
export function isKeypressDumpEnabled(): boolean {
  return pendingEnabled;
}

/**
 * 懒初始化 dump 文件路径 —— 首次 record 时确定。enabled=false 或失败时返回 null。
 *
 * 采用同步 appendFileSync 而非 WriteStream:WriteStream 内部缓冲在进程被硬关
 * (用户 force-close terminal、SIGKILL)时丢失末尾几条;诊断要求"哪怕最后一刻
 * 也要落盘"。每条 record 同步 I/O,代价是 dump 期间会序列化阻塞当前事件循环
 * (acceptable —— dump 仅诊断模式启用)。
 */
function ensurePath(): string | null {
  if (!pendingEnabled) return null;
  if (logPath) return logPath;
  if (initStarted) return null;
  initStarted = true;

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    // 走 getZhixingHome（含 ZHIXING_HOME 解析）而非直拼 homedir——否则 ZHIXING_HOME
    // 覆盖时其余数据进自定义目录、唯独这份调试日志漏到真实家目录，位置不一致。
    const dir = join(getZhixingHome(), "logs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `keypress-${process.pid}-${ts}.log`);

    startTime = Date.now();
    logPath = path;
    const header =
      `# zhixing keypress dump (pid ${process.pid})\n` +
      `# Started at ${new Date().toISOString()}\n` +
      `# Records SelectOperationRegion keypress path + REPL lifecycle nodes:\n` +
      `#   stdin.keypress-raw, batcher.onSingle, batcher.onPaste,\n` +
      `#   handleKeypress.*, translateKey.result, reduceSelect.result,\n` +
      `#   repaint.triggered, finish, typeahead.suspend/resume,\n` +
      `#   keyboard.attach/detach 等\n` +
      `# 用 sync appendFileSync 写入,force-close terminal 也能保证已记录的全部到盘.\n\n`;
    appendFileSync(path, header);
    // allow-direct-stdout
    process.stderr.write(
      `[zhixing] keypress dump enabled → ${path}\n`,
    );
    return logPath;
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
  const path = ensurePath();
  if (!path) return;
  const dt = Date.now() - startTime;
  let chunk = `[+${dt}ms] ${stage}\n`;
  for (const [k, v] of Object.entries(data)) {
    const valStr =
      typeof v === "string" ? formatString(v) : JSON.stringify(v);
    chunk += `  ${k}: ${valStr}\n`;
  }
  chunk += "\n";
  try {
    appendFileSync(path, chunk);
  } catch {
    // 写盘失败 swallow,不影响主流程
  }
}

/**
 * 记录 stdin 生命周期快照 —— 给定 stdin 引用，dump 当前 stdin.isRaw 与
 * keypress listener 数量。caller 传 stage 与 extra data 便于日志阅读。
 *
 * 用于 typeahead.suspend/resume / keyboard.attach/detach / 切换 confirm 面板
 * 前后等关键节点，对比"应该有几个 listener、应该 raw=true 还是 false"。
 */
export function recordStdinSnapshot(
  stage: string,
  stdin: NodeJS.ReadStream | undefined | null,
  extra?: Record<string, unknown>,
): void {
  if (!pendingEnabled) return;
  // 探 stdin 的内部 flowing 状态 —— 关键诊断字段:即使 listener 都在,如果
  // stdin paused / 非 flowing,keypress 事件就不会被 emit。Node 把这个状态藏
  // 在 _readableState.flowing(undefined=未开始流 / false=暂停 / true=流中)。
  const state = stdin
    ? ((stdin as unknown as { _readableState?: { flowing?: unknown } })
        ._readableState ?? null)
    : null;
  const data: Record<string, unknown> = {
    isRaw:
      stdin && typeof (stdin as unknown as { isRaw?: boolean }).isRaw === "boolean"
        ? (stdin as unknown as { isRaw: boolean }).isRaw
        : null,
    keypressListenerCount:
      stdin && typeof stdin.listenerCount === "function"
        ? stdin.listenerCount("keypress")
        : null,
    dataListenerCount:
      stdin && typeof stdin.listenerCount === "function"
        ? stdin.listenerCount("data")
        : null,
    flowing: state ? (state as { flowing?: unknown }).flowing ?? null : null,
    isPaused:
      stdin && typeof stdin.isPaused === "function" ? stdin.isPaused() : null,
    ...(extra ?? {}),
  };
  recordKeypressEvent(stage, data);
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
