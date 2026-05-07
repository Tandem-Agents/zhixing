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
 * 工具调用职责切分：
 *   - 状态条（动态区）显示 "调用 Read (3s · 等待结果)" 进行中视觉，由 spinner 驱动
 *   - scrollback（永久区）仅在 tool_end 写完成卡片 `◆ Read(target) / ⎿ result`，
 *     成败编码于 ◆ 颜色（绿 / 红）
 *   - tool_start 不直接写 scrollback——避免与状态条职责重叠造成双重显示
 */

import chalk from "chalk";
import type { AgentYield } from "@zhixing/core";
import { getToolRenderStrategy } from "../tool-render-strategy.js";
import {
  formatToolHeader,
  formatToolResult,
} from "../tool-card-format.js";
import type { CliWriter } from "../screen/index.js";
import { layout } from "../tui/style.js";
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

  /**
   * 已开始但未完成的工具调用 input 缓存——AgentYield.tool_end 不携带 input，
   * 卡片 header 需要 tool_start 时的 input 重建。turn 内 tool 调用配对严格
   * （每个 tool_start 都有对应 tool_end），end 时取出并清理，结束 turn 自然清空。
   */
  const pendingToolInputs = new Map<string, Record<string, unknown>>();

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
        // 仅缓存 input 给 tool_end 用——进行中视觉由状态条接管，scrollback 在
        // 完成时一次性写卡片（避免双区双显）
        pendingToolInputs.set(event.id, event.input);
        break;
      }

      case "tool_end": {
        if (getToolRenderStrategy(event.name) !== "default") break;
        const input = pendingToolInputs.get(event.id) ?? {};
        pendingToolInputs.delete(event.id);

        const isError = event.result.isError ?? false;
        const colorAnchor = isError ? chalk.red : chalk.green;

        const header = formatToolHeader(event.name, input);
        const result = formatToolResult(
          event.name,
          event.result,
          event.duration,
        );

        // 卡片首行：`◆ Action(target)` 起首与 AI 行同列（layout.contentPrefix）
        writer.line(`${layout.contentPrefix}${colorAnchor("◆")} ${header}`);
        // 续行 ⎿ result：列 2 + 2 = 列 4，与 AI 文字续行 hanging 同基线
        writer.line(
          `${layout.contentPrefix}  ${chalk.dim(`⎿ ${result}`)}`,
        );
        break;
      }

      case "turn_complete":
        flushTextStream();
        // turn 结束兜底清理——正常路径每个 tool_start 都配对 tool_end，
        // 此处仅防御异常断开（如流被中断时未匹配的 tool_start）
        pendingToolInputs.clear();
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
      pendingToolInputs.clear();
    },
  };
}
