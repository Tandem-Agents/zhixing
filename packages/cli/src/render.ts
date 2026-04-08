/**
 * 终端渲染模块
 *
 * 职责：将 AgentYield 事件转为终端可视输出。
 * MVP 方案：chalk 直接着色 + process.stdout.write 流式输出。
 * 不引入 Ink/React/ora 等终端 UI 框架。
 *
 * Spinner 实现：自研 Braille dots 动画，零依赖。
 * 时序规则：
 *   start  → 用户回车后立即启动
 *   stop   → 收到首个 text_delta / thinking_delta / tool_start 时自动停止
 *   resume → turn_complete 后自动恢复（等待下一轮 LLM 响应）
 */

import chalk from "chalk";
import type { AgentResult, AgentYield, TokenUsage } from "@zhixing/core";

// ─── Spinner 常量 ───

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const SPINNER_TEXT = "思考中...";
// 清除宽度足够覆盖 spinner 行（CJK 字符占 2 列，需要比 .length 更大的值）
const SPINNER_CLEAR_WIDTH = 30;

// ─── 有状态渲染器 ───

export interface Renderer {
  /** 启动思考动画（用户输入后立即调用） */
  startThinking: () => void;
  /** 处理 AgentYield 事件（自动管理 spinner 生命周期） */
  handleEvent: (event: AgentYield) => void;
  /** 强制停止 spinner（异常路径兜底） */
  stop: () => void;
}

export function createRenderer(): Renderer {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  // 追踪光标是否在行首，避免 tool_start 产生多余空行
  let atLineStart = true;
  // 追踪本轮是否已输出可见内容，过滤 LLM 在工具调用前输出的前导空白
  let hasVisibleContent = false;

  function startSpinner(): void {
    stopSpinner();
    frame = 0;
    timer = setInterval(() => {
      const char = SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]!;
      process.stdout.write(
        `\r  ${chalk.cyan(char)} ${chalk.dim(SPINNER_TEXT)}`,
      );
    }, SPINNER_INTERVAL_MS);
  }

  function stopSpinner(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      process.stdout.write(`\r${" ".repeat(SPINNER_CLEAR_WIDTH)}\r`);
    }
  }

  function renderEvent(event: AgentYield): void {
    switch (event.type) {
      case "text_delta":
        // 过滤每轮开头的纯空白（LLM 在工具调用前常输出多余换行）
        if (!hasVisibleContent) {
          if (event.text.trim() === "") break;
          hasVisibleContent = true;
        }
        process.stdout.write(event.text);
        atLineStart = event.text.endsWith("\n");
        break;

      case "thinking_delta":
        hasVisibleContent = true;
        process.stdout.write(chalk.dim(event.thinking));
        atLineStart = event.thinking.endsWith("\n");
        break;

      case "assistant_message":
        break;

      case "tool_start":
        if (!atLineStart) process.stdout.write("\n");
        process.stdout.write(
          `  ${chalk.cyan("⟡")} ${chalk.cyan(event.name)} ${chalk.dim(getToolSummary(event.name, event.input))} `,
        );
        atLineStart = false;
        break;

      case "tool_end": {
        const status = event.result.isError
          ? chalk.red("✗")
          : chalk.green("✓");
        process.stdout.write(`${status} ${chalk.dim(`${event.duration}ms`)}\n`);
        atLineStart = true;
        break;
      }

      case "turn_complete":
        break;
    }
  }

  return {
    startThinking() {
      atLineStart = true;
      hasVisibleContent = false;
      startSpinner();
    },

    handleEvent(event: AgentYield) {
      if (
        timer !== null &&
        (event.type === "text_delta" ||
          event.type === "thinking_delta" ||
          event.type === "tool_start")
      ) {
        stopSpinner();
      }

      if (event.type === "turn_complete") {
        hasVisibleContent = false;
        startSpinner();
      }

      renderEvent(event);
    },

    stop() {
      stopSpinner();
    },
  };
}

// ─── 运行结果摘要 ───

export function renderSummary(result: AgentResult, durationMs: number): void {
  const duration = (durationMs / 1000).toFixed(1);
  const tokens = formatUsage(result.usage);

  console.log(
    `\n${chalk.dim("─")} ${tokens} ${chalk.dim("·")} ${chalk.dim(`${duration}s`)}`,
  );
}

function formatUsage(usage: TokenUsage): string {
  const parts = [
    chalk.dim(`${usage.inputTokens.toLocaleString()} →`),
    chalk.dim(`${usage.outputTokens.toLocaleString()} tokens`),
  ];
  if (usage.cacheReadTokens) {
    parts.push(chalk.dim(`(cache: ${usage.cacheReadTokens.toLocaleString()})`));
  }
  return parts.join(" ");
}

// ─── 错误渲染 ───

export function renderError(error: unknown): void {
  if (error instanceof Error && error.name === "ProviderConfigError") {
    console.error(
      `\n${chalk.red("✗")} ${chalk.red.bold("配置错误")}: ${error.message}`,
    );
    console.error(chalk.dim("\n  运行 zhixing config 查看当前配置\n"));
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${chalk.red("✗")} ${message}`);
}

// ─── 欢迎动画 ───

/**
 * 欢迎页面：打字动画 + 极简信息。
 *
 * 视觉序列（TTY 模式，~400ms）：
 *   1. "✦" 出现（80ms 预等待）
 *   2. "知行" 逐字打出（每字 70ms）
 *   3. 模型名淡入
 *   4. 短暂停顿后进入 prompt
 *
 * 非 TTY 环境（管道/CI）降级为静态单行输出。
 */
export async function renderWelcome(options: { model: string }): Promise<void> {
  const { model } = options;

  if (!process.stdout.isTTY) {
    console.log(`知行 · ${model}`);
    return;
  }

  console.log();

  // Phase 1: 标志出现
  process.stdout.write("  ");
  await sleep(80);
  process.stdout.write(chalk.cyan.bold("✦"));
  await sleep(120);

  // Phase 2: 名称逐字打出
  process.stdout.write(" ");
  for (const char of "知行") {
    process.stdout.write(chalk.bold(char));
    await sleep(70);
  }
  console.log();

  // Phase 3: 模型名静默出现
  await sleep(60);
  console.log(`    ${chalk.dim(model)}`);
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 内部辅助 ───

function getToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read":
    case "write":
      return typeof input["path"] === "string" ? input["path"] : "";
    case "bash": {
      const cmd =
        typeof input["command"] === "string" ? input["command"] : "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    default:
      return "";
  }
}
