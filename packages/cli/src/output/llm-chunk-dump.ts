/**
 * LLM 原始 chunk 诊断 dump —— 把 LLM 流的每个事件 **完全原样** 写到日志文件,
 * 用于排查"屏幕渲染与实际 LLM 输出不符"类视觉 bug 与"token 涨但屏幕不动"类
 * 卡住 bug。
 *
 * **关键定位**:
 *   - cli REPL 渲染层（markdown-stream / TextStream / ScreenController）会对 LLM
 *     原始 chunk 做大量加工（trim 起首不可见、wrap、hanging、segment 切分等）
 *   - 出现"屏幕显示与预期不符"或"token 涨但 cli 不动"时, 必须能看到 LLM 真实
 *     发出的所有事件才能定位 bug 在 LLM 端 / 解析端 / 渲染端 哪一层
 *   - 本模块订阅 EventBus `llm:stream_event` 旁路记录, 不影响任何渲染路径
 *
 * **覆盖的事件类型**:
 *   - text_delta / thinking_delta / tool_call_delta —— 内容增量, 输出 raw + codepoint
 *   - message_start / message_end / tool_call_start / tool_call_end / error ——
 *     结构性事件, 输出单行简短描述
 *   - agent:run_end —— 用作 turn 边界标记
 *
 *   覆盖完整 StreamEvent 类型让任何"内容到底了哪一种事件"的疑问都有答案。
 *
 * **使用方式**:
 *   ```
 *   ZHIXING_RAW_DUMP=1 zhixing                # bash
 *   $env:ZHIXING_RAW_DUMP="1"; zhixing        # PowerShell
 *   ```
 *   启用后日志写到 `~/.zhixing/logs/llm-raw-{pid}-{ts}.log`，路径在第一次记录时
 *   通过 stderr 短提示一次（chrome 启动前打印,不破坏 chrome）。
 *
 * **设计契约**:
 *   - **默认禁用**: env var 未启用时全 noop,零运行成本
 *   - **完全旁路**: dump 失败 swallow,不影响 LLM 流处理与渲染路径
 *   - **process-level singleton**: 一个 cli 进程一个日志文件,跨多个 turn / 多次
 *     LLM 请求累积
 *   - **不依赖 chrome**: 直接 fs 同步写入,与 ScreenController / cliWriter 完全
 *     解耦——chrome 出问题时仍能记录
 *   - **接入点单一**: 在 createRenderSubscribers (per-run-bus 订阅装载点) attach,
 *     不在 output-renderer 重复接入避免双轨道
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  AgentEventMap,
  IEventBus,
  StreamEvent,
} from "@zhixing/core";

const ENABLE_ENV = "ZHIXING_RAW_DUMP";

export interface LlmChunkDump {
  /** 记录 stream event —— 按 type 分发 (delta 类输出 raw + codepoint, 结构事件简短描述) */
  recordStreamEvent(event: StreamEvent): void;
  /** 标记 turn 边界 —— 在日志中插入分隔符 + 重置 turn 起点时间 */
  recordTurnBoundary(): void;
  /** 关闭日志文件流 —— process exit 自动调,caller 也可显式调 */
  dispose(): void;
}

/**
 * 模块级 lazy singleton —— 第一次调用返回固定 handle，后续调用复用同一文件。
 * env var 未启用时返回 noop handle（零开销）。
 *
 * 不暴露"初始化失败"——任何 IO 错误 swallow 并退化为 noop，避免诊断模块本身
 * 影响 cli 主流程。
 */
let cachedHandle: LlmChunkDump | null = null;

export function getLlmChunkDump(): LlmChunkDump {
  if (cachedHandle !== null) return cachedHandle;
  cachedHandle = createDump();
  return cachedHandle;
}

/**
 * 把 chunk-dump 挂到 RuntimeSession 的 EventBus —— 订阅 llm:stream_event 与
 * agent:run_end，分别对应 chunk 记录与 turn 边界。返回 unsubscribe 用于装饰器
 * cleanup（与 createRenderSubscribers 的 lifecycle 对齐）。
 *
 * env var 未启用时仍订阅 EventBus（成本极低——就是 noop record），但保持代码
 * 路径一致避免分支膨胀。
 *
 * **重要契约（cli REPL 模式）**：
 *   caller **必须**在 ScreenController 创建之前先调用一次 `getLlmChunkDump()`
 *   预热 singleton——否则本函数内的首次 `getLlmChunkDump()` 会触发 dump 创建,
 *   `process.stderr.write` 写启用提示。chrome 已接管 stdout 时 stderr 写入会
 *   推 cursor 破坏 frame model，让 welcome 顶部行被错误推入 scrollback（视觉
 *   表现为"欢迎块顶部多一行重复"）。
 *
 *   预热位置：cli REPL 入口（`startRepl` 函数最开头）。预热后 cached handle
 *   保留，本函数内复用，零 stderr 副作用。
 *
 *   serve daemon 模式无 chrome（stdio 重定向到 daemon 日志文件），不受此约束——
 *   stderr 写入直接落到日志文件，与渲染无关。
 */
export function attachChunkDumpToBus(
  bus: IEventBus<AgentEventMap>,
): () => void {
  const dump = getLlmChunkDump();
  const unsubs: Array<() => void> = [];
  unsubs.push(
    bus.on("llm:stream_event", (event) => {
      dump.recordStreamEvent(event);
    }),
  );
  unsubs.push(
    bus.on("agent:run_end", () => {
      dump.recordTurnBoundary();
    }),
  );
  return () => {
    for (const u of unsubs) u();
  };
}

function createDump(): LlmChunkDump {
  if (process.env[ENABLE_ENV] !== "1") return NOOP;

  let fd: number | null = null;
  let logPath = "";
  try {
    const logDir = path.join(os.homedir(), ".zhixing", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    logPath = path.join(logDir, `llm-raw-${process.pid}-${ts}.log`);
    fd = fs.openSync(logPath, "a");
  } catch {
    // IO 失败退化为 noop；不抛错让 cli 主流程不受影响
    return NOOP;
  }

  // 启动横幅 + 路径提示到 stderr——cli REPL chrome 接管 stdout 之前 stderr 仍可见
  const banner =
    `# LLM raw chunk dump (pid ${process.pid})\n` +
    `# Started at ${new Date().toISOString()}\n` +
    `# Records all StreamEvent types: delta events (text/thinking/tool_call_delta)\n` +
    `# show raw + codepoint hex; structural events (message/tool_call start/end)\n` +
    `# show one-line summary. Use this to diagnose UI vs LLM mismatches and\n` +
    `# "token climbing but screen frozen" cases.\n\n`;
  writeSync(fd, banner);
  // allow-direct-stdout
  process.stderr.write(`[zhixing] LLM raw chunk dump enabled → ${logPath}\n`);

  let turnStart = Date.now();
  let turnIndex = 0;
  let firstChunkOfTurn = true;

  // process exit 兜底关闭——避免 abrupt exit 时 fd 泄漏
  const onExit = (): void => {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* swallow */
      }
      fd = null;
    }
  };
  process.once("exit", onExit);

  const ensureTurnHeader = (): void => {
    if (!firstChunkOfTurn || fd === null) return;
    writeSync(
      fd,
      `=== TURN ${turnIndex + 1} (started ${new Date(turnStart).toISOString()}) ===\n\n`,
    );
    firstChunkOfTurn = false;
  };

  return {
    recordStreamEvent(event) {
      if (fd === null) return;
      ensureTurnHeader();
      const elapsed = Date.now() - turnStart;
      writeSync(fd, formatStreamEvent(event, elapsed));
    },
    recordTurnBoundary() {
      if (fd === null) return;
      if (!firstChunkOfTurn) {
        // 仅在该 turn 内有 chunk 时才写 turn 结束标记 + 重置——避免空 turn 噪音
        writeSync(fd, `--- end of TURN ${turnIndex + 1} ---\n\n`);
      }
      turnIndex += 1;
      turnStart = Date.now();
      firstChunkOfTurn = true;
    },
    dispose() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* swallow */
        }
        fd = null;
      }
      try {
        process.off("exit", onExit);
      } catch {
        /* swallow */
      }
    },
  };
}

const NOOP: LlmChunkDump = {
  recordStreamEvent: () => {},
  recordTurnBoundary: () => {},
  dispose: () => {},
};

/**
 * 把 StreamEvent 格式化为日志条目——delta 类输出 raw + codepoint，结构事件单行
 * 简短描述。所有条目末尾留 1 空行让人类阅读时分块清晰。
 */
function formatStreamEvent(event: StreamEvent, elapsedMs: number): string {
  const head = `[+${elapsedMs}ms]`;
  switch (event.type) {
    case "text_delta":
      return formatDeltaEvent(head, "text_delta", event.text);
    case "thinking_delta":
      return formatDeltaEvent(head, "thinking_delta", event.thinking);
    case "tool_call_delta":
      return (
        `${head} tool_call_delta (id=${event.id}, args.len=${event.argsFragment.length})\n` +
        `  args: ${JSON.stringify(event.argsFragment)}\n` +
        `  codepoints: ${formatCodepoints(event.argsFragment)}\n\n`
      );
    case "message_start":
      return `${head} message_start (id=${event.messageId ?? "<none>"})\n\n`;
    case "tool_call_start":
      return `${head} tool_call_start (id=${event.id}, name=${event.name})\n\n`;
    case "tool_call_end":
      return `${head} tool_call_end (id=${event.id})\n\n`;
    case "message_end":
      return `${head} message_end (stopReason=${event.stopReason ?? "<none>"})\n\n`;
    case "error":
      return `${head} error: ${event.error.message ?? String(event.error)}\n\n`;
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return `${head} unknown_event: ${JSON.stringify(event)}\n\n`;
    }
  }
}

function formatDeltaEvent(
  head: string,
  kind: string,
  text: string,
): string {
  return (
    `${head} ${kind} (len=${text.length})\n` +
    `  raw: ${JSON.stringify(text)}\n` +
    `  codepoints: ${formatCodepoints(text)}\n\n`
  );
}

/** 同步写入 —— swallow IO 错误避免诊断模块影响 cli 主流程。 */
function writeSync(fd: number, data: string): void {
  try {
    fs.writeSync(fd, data);
  } catch {
    /* swallow */
  }
}

/**
 * 把字符串按 code point 转成 "U+XXXX U+XXXX ..." 形式——便于查看
 * 不可见字符（BOM / LRM / RLM / VS16 等）的精确 Unicode 标识。
 */
function formatCodepoints(text: string): string {
  return [...text]
    .map((c) => {
      const cp = c.codePointAt(0);
      if (cp === undefined) return "?";
      return "U+" + cp.toString(16).padStart(4, "0").toUpperCase();
    })
    .join(" ");
}

/**
 * 测试用：重置模块级 singleton 状态。生产代码不应调用。
 */
export function __resetForTesting(): void {
  cachedHandle?.dispose();
  cachedHandle = null;
}
