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
 *   zhixing --log                              # 启用 dump（默认关闭）
 *   ```
 *   启用后日志写到 `~/.zhixing/logs/llm-raw-{pid}-{ts}.log`，路径在第一次记录时
 *   通过 stderr 短提示一次（chrome 启动前打印，不破坏 chrome）。
 *
 *   历史：早期通过 ENV `ZHIXING_RAW_DUMP=1` 启用，但 PowerShell 的 `$env:VAR="1"; cmd`
 *   语法会把 VAR 持久化到 session（与 bash `VAR=1 cmd` 单次性不同），用户曾因此
 *   反馈"dump 状态拔不掉"。改为 CLI flag 后启用状态由 argv 显式标记，每次启动
 *   都明确，避免任何 shell ENV 语法陷阱。
 *
 * **设计契约**:
 *   - **默认禁用**: caller 不传 `enabled` 或传 false 时全 noop，零运行成本
 *   - **完全旁路**: dump 失败 swallow，不影响 LLM 流处理与渲染路径
 *   - **process-level singleton**: 一个 cli 进程一个日志文件，跨多个 turn / 多次
 *     LLM 请求累积
 *   - **不依赖 chrome**: 直接 fs 同步写入，与 ScreenController / cliWriter 完全
 *     解耦——chrome 出问题时仍能记录
 *   - **接入点单一**: 在 createRenderSubscribers (per-run-bus 订阅装载点) attach，
 *     不在 output-renderer 重复接入避免双轨道
 *   - **caller 决定 enabled**: caller 在首次调 `getLlmChunkDump()` 之前调
 *     `configureLlmChunkDump(enabled)` 显式传入；缺省 = 禁用，与 setStatusBar /
 *     ContextIndicator 等"由 caller 显式注入开关"的模式一致
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  AgentEventMap,
  ContentBlock,
  IEventBus,
  Message,
  StreamEvent,
  ToolSpec,
} from "@zhixing/core";

/** 一次 LLM 请求的完整入参——dump 用于人类阅读 + 可机器还原 */
export interface LlmRequestPayload {
  readonly model: string;
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
}

export interface LlmChunkDump {
  /**
   * 记录一次 LLM 请求的完整入参——LLM 调用前记录,可对照后续接收的 stream event
   * 排查"输入端是否符合预期"类 bug（如 system prompt 与配置不符 / 历史 message
   * 漏 / tools schema 错乱等）
   */
  recordRequestPayload(payload: LlmRequestPayload): void;
  /** 记录 stream event —— 按 type 分发 (delta 类输出 raw + codepoint, 结构事件简短描述) */
  recordStreamEvent(event: StreamEvent): void;
  /** 标记 turn 边界 —— 在日志中插入分隔符 + 重置 turn 起点时间 */
  recordTurnBoundary(): void;
  /** 关闭日志文件流 —— process exit 自动调,caller 也可显式调 */
  dispose(): void;
}

/**
 * 模块级 lazy singleton + caller 注入 enabled。
 *
 * ─── 协议 ───
 *
 *   caller 启动时调一次 `configureLlmChunkDump(enabled)` 显式设置启用状态，
 *   之后任何 module 通过 `getLlmChunkDump()` 复用单例。
 *
 *   未 configure 直接调 `getLlmChunkDump()` → 默认禁用（零运行成本 noop）。
 *
 *   typical usage（cli REPL / runOnce 入口）：
 *   ```
 *   configureLlmChunkDump(options.log === true);
 *   getLlmChunkDump();  // 预热 singleton（详见 attachChunkDumpToBus docstring）
 *   ```
 *
 *   未来加新启用条件（如配置文件 / 多 dump 实例）扩展 configure 签名即可，
 *   getLlmChunkDump 的 caller 零感知（singleton 单点协议稳定）。
 *
 * ─── 不暴露失败 ───
 *
 *   任何 IO 错误 swallow 并退化为 noop —— 诊断模块自身不应影响 cli 主流程。
 */
let cachedHandle: LlmChunkDump | null = null;
let pendingEnabled = false;

/**
 * 配置 chunk dump 启用状态 —— caller 在首次调 `getLlmChunkDump()` 之前调一次。
 *
 * 重复调用 / cached 之后调用 = 不生效（singleton 一旦创建状态固定，再 configure
 * 不会替换 handle）。caller 应在启动入口一次性传 final 决定，不要中途切换。
 */
export function configureLlmChunkDump(enabled: boolean): void {
  pendingEnabled = enabled;
}

export function getLlmChunkDump(): LlmChunkDump {
  if (cachedHandle !== null) return cachedHandle;
  cachedHandle = pendingEnabled ? createDump() : NOOP;
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
    bus.on("llm:request_start", (event) => {
      dump.recordRequestPayload({
        model: event.model,
        systemPrompt: event.systemPrompt,
        messages: event.messages,
        tools: event.tools,
      });
    }),
  );
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
  // 启用状态由 configureLlmChunkDump 决定 —— 此函数只在 pendingEnabled=true 时被
  // getLlmChunkDump 调用，自身无需再 check enabled flag。

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
    `# LLM raw dump (pid ${process.pid})\n` +
    `# Started at ${new Date().toISOString()}\n` +
    `# Records both LLM REQUEST PAYLOAD (system + messages + tools) and stream\n` +
    `# events (text/thinking/tool_call_delta with codepoint hex; structural\n` +
    `# message/tool_call start/end summaries). Use this to diagnose UI vs LLM\n` +
    `# mismatches, "token climbing but screen frozen" cases, and "system prompt\n` +
    `# / context not as expected" cases.\n\n`;
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
    recordRequestPayload(payload) {
      if (fd === null) return;
      ensureTurnHeader();
      const elapsed = Date.now() - turnStart;
      writeSync(fd, formatRequestPayload(payload, elapsed));
    },
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
  recordRequestPayload: () => {},
  recordStreamEvent: () => {},
  recordTurnBoundary: () => {},
  dispose: () => {},
};

/**
 * 格式化一次 LLM 请求的完整入参——人类可读摘要 + 完整 JSON 还原。
 *
 * 摘要部分让快速跳读时能看到 system 长度 / messages 角色与 ContentBlock 类型 /
 * tools 名单；完整 JSON 在分隔符块内便于人类折叠 + 机器还原（粘到 LLM 调试工具
 * 即可重放该请求）。
 */
function formatRequestPayload(
  payload: LlmRequestPayload,
  elapsedMs: number,
): string {
  const head = `[+${elapsedMs}ms]`;
  const lines: string[] = [];
  lines.push(`${head} >>> LLM REQUEST PAYLOAD <<<`);
  lines.push(`  model:    ${payload.model}`);
  const sysLen = payload.systemPrompt?.length ?? 0;
  lines.push(`  system:   ${sysLen} chars`);
  lines.push(`  messages: ${payload.messages.length} entries`);
  for (let i = 0; i < payload.messages.length; i++) {
    lines.push(`    [${i}] ${formatMessageSummary(payload.messages[i]!)}`);
  }
  const toolNames = payload.tools.map((t) => t.name).join(", ");
  lines.push(
    `  tools:    ${payload.tools.length}${
      payload.tools.length > 0 ? ` (${toolNames})` : ""
    }`,
  );

  // 完整 JSON 还原——messages 内 ToolResultBlock.content 可能含图像 base64 / 大字
  // 段，dump 不裁剪让排查时拥有完整信息（用户主动启用诊断、本机文件无外泄风险）
  const fullJson = JSON.stringify(
    {
      model: payload.model,
      systemPrompt: payload.systemPrompt,
      messages: payload.messages,
      tools: payload.tools,
    },
    null,
    2,
  );

  lines.push("--- full payload (JSON) ---");
  lines.push(fullJson);
  lines.push("--- end payload ---");
  lines.push("");
  return lines.join("\n");
}

/** 单条 message 的人类可读摘要：role + ContentBlock kind + 大致长度 */
function formatMessageSummary(msg: Message): string {
  const blocks = msg.content.map(formatBlockSummary).join(" ");
  return `${msg.role.padEnd(9)} ${blocks}`;
}

function formatBlockSummary(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text(${block.text.length}c)`;
    case "thinking":
      return `thinking(${block.thinking.length}c)`;
    case "tool_use":
      return `tool_use(${block.name}#${block.id})`;
    case "tool_result": {
      // ToolResultBlock.content 可能是 string 或 ContentBlock[]
      const content = block.content;
      if (typeof content === "string") return `tool_result(${content.length}c)`;
      const inner = (content as readonly ContentBlock[])
        .map(formatBlockSummary)
        .join(",");
      return `tool_result[${inner}]`;
    }
    case "image":
      return `image(${
        block.source.type === "base64" ? block.source.mediaType : "url"
      })`;
    default: {
      const exhaustive: never = block;
      void exhaustive;
      return "unknown_block";
    }
  }
}

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
      // usage 完整 dump —— 含 inputTokens / outputTokens 真值 + 可选 cacheReadTokens
      // / cacheWriteTokens（provider 解析后的 TokenUsage）。诊断"cache 命中显示
      // 不出来"等场景必看：JSON 里没出现 cacheReadTokens 字段 = 上游 API 没返回
      // 或 vendor 方言未匹配；出现但 cli 不显示 = ContextIndicator / 渲染层问题。
      return (
        `${head} message_end (stopReason=${event.stopReason ?? "<none>"})\n` +
        `  usage: ${JSON.stringify(event.usage)}\n\n`
      );
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
  pendingEnabled = false;
}
