/**
 * LLM 原始 chunk 诊断 dump —— 把 LLM 流的每个 chunk **完全原样** 写到日志文件,
 * 用于排查"屏幕渲染与实际 LLM 输出不符"类视觉 bug。
 *
 * **关键定位**:
 *   - cli REPL 渲染层（markdown-stream / TextStream / ScreenController）会对 LLM
 *     原始 chunk 做大量加工（trim 起首不可见、wrap、hanging、segment 切分等）
 *   - 出现"屏幕显示与预期不符"时, 必须能看到 LLM 真实发出的原始字节才能定位
 *     bug 在 LLM 端 / 解析端 / 渲染端 哪一层
 *   - 本模块在 output-renderer 处旁路记录, 不影响现有任何渲染路径
 *
 * **使用方式**:
 *   ```
 *   ZHIXING_RAW_DUMP=1 zhixing
 *   ```
 *   启用后日志写到 `~/.zhixing/logs/llm-raw-{pid}-{ts}.log`。日志路径在第一次
 *   record 时通过 stderr 短提示一次（chrome 启动前打印,不破坏 chrome）。复现
 *   bug 后查看该文件即可看到每个 chunk 的精确字节序列、codepoint、时间戳、
 *   turn 边界。
 *
 * **设计契约**:
 *   - **默认禁用**: 不违反"cli 工具默认不写日志"原则; 仅排错时手动启用
 *   - **完全旁路**: dump 失败不影响 LLM 流处理（catch 不向上抛）
 *   - **零运行成本（默认态）**: env var 未启用时全 noop
 *   - **process-level singleton**: 一个 cli 进程一个日志文件,跨多个 turn 累积
 *   - **不依赖 chrome**: 直接 fs.createWriteStream,与 ScreenController / cliWriter
 *     完全解耦——chrome 出问题时仍能记录
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENABLE_ENV = "ZHIXING_RAW_DUMP";

export type ChunkKind = "text_delta" | "thinking_delta";

export interface LlmChunkDump {
  /** 记录单个 chunk —— 含原始字符串 / codepoint / 与 turn 起点的相对时间戳 */
  recordChunk(kind: ChunkKind, text: string): void;
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
    `# Each chunk shows: kind, +Nms from turn start, raw JSON-escaped, codepoint hex\n` +
    `# Compare these chunks against what cli rendered to diagnose UI vs LLM mismatches\n\n`;
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

  return {
    recordChunk(kind, text) {
      if (fd === null) return;
      if (firstChunkOfTurn) {
        writeSync(
          fd,
          `=== TURN ${turnIndex + 1} (started ${new Date(turnStart).toISOString()}) ===\n\n`,
        );
        firstChunkOfTurn = false;
      }
      const elapsed = Date.now() - turnStart;
      const codepoints = formatCodepoints(text);
      writeSync(
        fd,
        `[+${elapsed}ms] ${kind} (len=${text.length})\n` +
          `  raw: ${JSON.stringify(text)}\n` +
          `  codepoints: ${codepoints}\n\n`,
      );
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

/** 同步写入 —— swallow IO 错误避免诊断模块影响 cli 主流程。 */
function writeSync(fd: number, data: string): void {
  try {
    fs.writeSync(fd, data);
  } catch {
    /* swallow */
  }
}

const NOOP: LlmChunkDump = {
  recordChunk: () => {},
  recordTurnBoundary: () => {},
  dispose: () => {},
};

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
