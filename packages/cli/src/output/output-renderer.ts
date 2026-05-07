/**
 * AI 输出区主 dispatcher——AgentYield 流派发到各模块。
 *
 * 接口与 cli 既有渲染契约同形（startThinking / handleEvent / stop），调用方
 * 只需把 createRenderer 替换为 createOutputRenderer，类型自动兼容。
 *
 * 写屏统一经 CliWriter 注入：
 *   - cli REPL 模式：caller 注入 ScreenWriter（背后是 ScreenController frame buffer）
 *   - runOnce / 单次模式：caller 注入 StdoutWriter
 *
 * 接续 vs 独立段：流式 chunk 用 writer.appendInline（不补 \n，多次调用同行接续）；
 * 工具卡片 / 错误消息等用 writer.line（独立段，自动补 \n）。这是 frame buffer 模式
 * 下的接续合约——line 强制补 \n 会让 chunk 间被分行（视觉退化）。
 *
 * 当前覆盖：text_delta（◆ 锚 + 列 2 + hanging 4）/ thinking_delta dim / 工具卡片
 * `⟡ name args ✓ Xms`——后续模块（markdown / 代码块 / 工具行 / 闪烁）以同一文件
 * 为接入点逐步替换。
 */

import chalk from "chalk";
import type { AgentYield } from "@zhixing/core";
import { getToolRenderStrategy } from "../tool-render-strategy.js";
import type { CliWriter } from "../screen/index.js";
import { TextStream } from "./text-stream.js";

export interface OutputRenderer {
  startThinking: () => void;
  handleEvent: (event: AgentYield) => void;
  stop: () => void;
}

export interface CreateOutputRendererOptions {
  /**
   * 写屏 sink——所有 AI 输出（text / thinking / tool 卡片）经此协调。
   *
   * REPL 模式注入 createScreenWriter（chrome 协调）；runOnce 模式注入 createStdoutWriter
   * （直写 stdout）；测试模式可注入 mock writer 验证渲染序列。
   */
  readonly writer: CliWriter;
  /**
   * 终端列宽——TextStream 用于 wrap hanging 续行计算。默认从 process.stdout.columns
   * 读取，无 TTY 时回退到 80。
   */
  readonly columns?: number;
}

export function createOutputRenderer(
  options: CreateOutputRendererOptions,
): OutputRenderer {
  const { writer } = options;
  const getColumns = (): number =>
    options.columns ?? process.stdout.columns ?? 80;
  let textStream: TextStream | null = null;

  const flushTextStream = (): void => {
    if (textStream) {
      textStream.end();
      textStream = null;
    }
  };

  const renderEvent = (event: AgentYield): void => {
    switch (event.type) {
      case "text_delta": {
        // 过滤 LLM 在工具调用前的纯空白前导——避免起手就写一个 ◆ 锚但什么都没说
        if (!textStream && event.text.trim() === "") break;
        if (!textStream) {
          // 流式 text chunk 用 appendInline——不补 \n，多次调用在 frame buffer
          // tailBuffer 末尾行内接续；text-stream end 时写一个 \n 让 chunk 段独立落地
          textStream = new TextStream({
            write: (chunk) => writer.appendInline(chunk),
            columns: getColumns(),
          });
        }
        textStream.feed(event.text);
        break;
      }

      case "thinking_delta": {
        // thinking 流式 chunk 同样用 appendInline 接续——避免每个 chunk 独占一行
        if (event.thinking.length === 0) break;
        writer.appendInline(chalk.dim(event.thinking));
        break;
      }

      case "assistant_message":
        break;

      case "tool_start": {
        flushTextStream();
        if (getToolRenderStrategy(event.name) !== "default") break;
        // 工具卡片头部独占一段——尾部 ✓/✗ 由 tool_end 单独写入对齐缩进的下一行
        writer.line(
          `  ${chalk.cyan("⟡")} ${chalk.cyan(event.name)} ${chalk.dim(getToolSummary(event.name, event.input))}`,
        );
        break;
      }

      case "tool_end": {
        if (getToolRenderStrategy(event.name) !== "default") break;
        const status = event.result.isError ? chalk.red("✗") : chalk.green("✓");
        // 缩进对齐到 ⟡ 列（列 2）——视觉上 ✓ 与 ⟡ 同列形成"工具调用 → 完成"对应
        writer.line(`  ${status} ${chalk.dim(`${event.duration}ms`)}`);
        break;
      }

      case "turn_complete":
        flushTextStream();
        break;
    }
  };

  return {
    startThinking() {
      // status-bar 接管"思考中 / 回复中"等动态状态条；本接口仍保留以兼容
      // 调用方契约（OutputRenderer = startThinking / handleEvent / stop），但
      // 不再启动 spinner——避免与状态条双动画
      flushTextStream();
    },

    handleEvent(event: AgentYield) {
      renderEvent(event);
    },

    stop() {
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
