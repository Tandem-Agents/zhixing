/**
 * AI 输出区主 dispatcher——AgentYield 流派发到各模块。
 *
 * 接口与 repl 既有渲染契约同形（startThinking / handleEvent / stop），调用方
 * 只需把 createRenderer 替换为 createOutputRenderer，类型自动兼容。
 *
 * 当前覆盖：
 *   text_delta → TextStream（◆ 锚 + 列 2 + hanging 4）
 *   thinking_delta、tool_start/end、turn_complete、spinner → 沿用既有视觉
 *
 * 后续模块（markdown 流式 / 代码块 / 工具行 / 闪烁）以同一文件为接入点逐步替换。
 */

import chalk from "chalk";
import type { AgentYield } from "@zhixing/core";
import { getToolRenderStrategy } from "../tool-render-strategy.js";
import { TextStream } from "./text-stream.js";

export interface OutputRenderer {
  startThinking: () => void;
  handleEvent: (event: AgentYield) => void;
  stop: () => void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const SPINNER_TEXT = "思考中...";
const SPINNER_HINT = "esc 中断";
/** 覆盖 spinner 行最长形态的清行宽度——CJK 全宽计入 2 列，留余量 */
const SPINNER_CLEAR_WIDTH = 50;

export function createOutputRenderer(): OutputRenderer {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let atLineStart = true;
  let textStream: TextStream | null = null;

  const startSpinner = (): void => {
    stopSpinner();
    frame = 0;
    timer = setInterval(() => {
      const ch = SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]!;
      process.stdout.write(
        `\r  ${chalk.cyan(ch)} ${chalk.dim(SPINNER_TEXT)} ${chalk.dim("·")} ${chalk.dim(SPINNER_HINT)}`,
      );
    }, SPINNER_INTERVAL_MS);
  };

  const stopSpinner = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      process.stdout.write(`\r${" ".repeat(SPINNER_CLEAR_WIDTH)}\r`);
    }
  };

  const flushTextStream = (): void => {
    if (textStream) {
      textStream.end();
      textStream = null;
      atLineStart = true;
    }
  };

  const renderEvent = (event: AgentYield): void => {
    switch (event.type) {
      case "text_delta": {
        // 过滤 LLM 在工具调用前的纯空白前导——避免起手就写一个 ◆ 锚但什么都没说
        if (!textStream && event.text.trim() === "") break;
        if (!textStream) textStream = new TextStream();
        textStream.feed(event.text);
        atLineStart = false;
        break;
      }

      case "thinking_delta":
        process.stdout.write(chalk.dim(event.thinking));
        atLineStart = event.thinking.endsWith("\n");
        break;

      case "assistant_message":
        break;

      case "tool_start": {
        flushTextStream();
        if (getToolRenderStrategy(event.name) !== "default") break;
        if (!atLineStart) process.stdout.write("\n");
        process.stdout.write(
          `  ${chalk.cyan("⟡")} ${chalk.cyan(event.name)} ${chalk.dim(getToolSummary(event.name, event.input))} `,
        );
        atLineStart = false;
        break;
      }

      case "tool_end": {
        if (getToolRenderStrategy(event.name) !== "default") break;
        const status = event.result.isError ? chalk.red("✗") : chalk.green("✓");
        process.stdout.write(`${status} ${chalk.dim(`${event.duration}ms`)}\n`);
        atLineStart = true;
        break;
      }

      case "turn_complete":
        flushTextStream();
        break;
    }
  };

  return {
    startThinking() {
      flushTextStream();
      atLineStart = true;
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
        startSpinner();
      }
      renderEvent(event);
    },

    stop() {
      stopSpinner();
      flushTextStream();
    },
  };
}

function getToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read":
    case "write":
      return typeof input["path"] === "string" ? input["path"] : "";
    case "bash": {
      const cmd = typeof input["command"] === "string" ? input["command"] : "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    default:
      return "";
  }
}
