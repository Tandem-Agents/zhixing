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
 * 工具调用职责切分（三方协作）：
 *   - **状态条（动态区）**：显示 "调用 Read (3s · 等待结果)" 进行中视觉，由 spinner
 *     驱动。走 EventBus tool:call_start/end 路径，独立于本文件。
 *   - **批次协调器（永久区）**：连续 success tool_end 折叠为 5 行恒定上限批次
 *     摘要——头部 `⟡ 已使用 N 个工具（分类）· duration` + ⋮ + 近邻 3 详情。
 *     用 ReplaceableSegment 实时重渲。详见 tool-batch-coordinator.ts。
 *   - **失败破窗（永久区）**：failure tool_end 由 coordinator.recordFailure 触发
 *     红色独立 ◆ 行 emit，错误信号永不被批次淹没。
 *   - tool_start 不直接写 scrollback——进行中视觉由状态条接管，避免双显
 *
 * **关键约束（单一活跃 segment）**：
 *   ScreenController.beginReplaceableSegment 不支持嵌套——markdown stream 的
 *   code block / list segment 与 batch segment 不可同时活跃。本 dispatcher 在
 *   每个"换段"边界（text_delta 起手 / sub-agent-status 工具 start / turn_complete）
 *   调 coordinator.closeBatch 释放，让后续 markdown stream 可安全 begin。
 */

import chalk from "chalk";
import type { AgentYield } from "@zhixing/core";
import { getToolRenderStrategy } from "../tool-render-strategy.js";
import type { CliWriter } from "../screen/index.js";
import { MarkdownStream, type MarkdownMode } from "./markdown/index.js";
import { createToolBatchCoordinator } from "./tool-batch-coordinator.js";

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
   * 终端列宽——MarkdownStream / TextStream 用于 wrap hanging 续行计算。默认从
   * process.stdout.columns 读取，无 TTY 时回退到 80。
   */
  readonly columns?: number;
  /**
   * Markdown 渲染模式——render（默认 TTY 完整渲染）/ strip（CI / pipe / 日志，
   * 仅缩进结构，不染色）/ raw（调试，输出原始 markdown 字符）。
   */
  readonly markdownMode?: MarkdownMode;
}

export function createOutputRenderer(
  options: CreateOutputRendererOptions,
): OutputRenderer {
  const { writer } = options;
  const getColumns = (): number =>
    options.columns ?? process.stdout.columns ?? 80;
  const markdownMode: MarkdownMode = options.markdownMode ?? "render";
  let mdStream: MarkdownStream | null = null;
  const batchCoordinator = createToolBatchCoordinator({ writer });

  /**
   * 已开始但未完成的工具调用 input 缓存——AgentYield.tool_end 不携带 input，
   * 卡片 header / batch 详情行需要 tool_start 时的 input 重建。turn 内 tool 调用
   * 配对严格（每个 tool_start 都有对应 tool_end），end 时取出并清理，结束 turn
   * 自然清空。
   */
  const pendingToolInputs = new Map<string, Record<string, unknown>>();

  const flushTextStream = (): void => {
    if (mdStream) {
      mdStream.end();
      mdStream = null;
    }
  };

  const renderEvent = (event: AgentYield): void => {
    switch (event.type) {
      case "text_delta": {
        // 过滤 LLM 在工具调用前的纯空白前导——避免起手就写一个 ◆ 锚但什么都没说
        if (!mdStream && event.text.trim() === "") break;
        if (!mdStream) {
          // 关键顺序：先 closeBatch 释放 segment（hasActiveSegment=false），再
          // ensureSegmentBreak 写段间空行，最后 mdStream 创建时再按需 begin 新
          // segment——保证不触发"single-segment only"约束抛错。
          batchCoordinator.closeBatch();
          writer.ensureSegmentBreak();

          // MarkdownStream 协调 paragraph 字符流式（appendInline）+ 闭合 block 独立段
          // （line）+ fenced code block 双态渲染（流式期 dim 占位、闭合时 highlight 替换，
          // 仅 ScreenWriter 提供 segment factory 时启用；StdoutWriter 自动退化为 hold）
          const segFactory = writer.beginReplaceableSegment;
          mdStream = new MarkdownStream({
            appendInline: (chunk) => writer.appendInline(chunk),
            line: (text) => writer.line(text),
            columns: getColumns(),
            mode: markdownMode,
            beginReplaceableSegment: segFactory
              ? () => segFactory.call(writer)
              : undefined,
          });
        }
        mdStream.feed(event.text);
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
        const strategy = getToolRenderStrategy(event.name);
        if (strategy === "sub-agent-status") {
          // Task —— status-bar 接管「父任务 + 子 agent」层次化进度展示。先关闭
          // 当前 batch 让 Task 视觉独立呈现，避免与前序工具批次粘连。
          batchCoordinator.closeBatch();
          break;
        }
        // default + side-effect 都需要缓存 input 给 tool_end 用（构建 batch 详情
        // 行 / 副作用单行）。进行中视觉由状态条接管，scrollback 在 tool_end 时
        // 由 coordinator 按策略分流（折叠 vs 独立成行）。
        //   - default 的 batch close 由 coordinator 在新 batch 开始 / text_delta /
        //     turn_complete / Task start 等边界触发
        //   - side-effect 的 batch close 由 coordinator.recordSideEffect 内部触发
        pendingToolInputs.set(event.id, event.input);
        break;
      }

      case "tool_end": {
        const strategy = getToolRenderStrategy(event.name);
        // sub-agent-status（Task）走 status-bar 接管的层次化进度展示——主路径静默
        if (strategy === "sub-agent-status") break;

        const input = pendingToolInputs.get(event.id) ?? {};
        pendingToolInputs.delete(event.id);

        const snapshot = {
          name: event.name,
          input,
          result: event.result,
          duration: event.duration,
        };
        // 失败统一走 recordFailure 红色破窗——不论 default / side-effect 策略,
        // 错误信号统一最高优先级展示，让用户绝不可能漏看
        if (event.result.isError === true) {
          batchCoordinator.recordFailure(snapshot);
        } else if (strategy === "side-effect") {
          // 副作用工具（write/edit/schedule）—— 独立成行 ✎ 锚，永不折叠
          batchCoordinator.recordSideEffect(snapshot);
        } else {
          // 探索类工具（default）—— 入 batch 折叠展示
          batchCoordinator.recordSuccess(snapshot);
        }
        break;
      }

      case "turn_complete":
        flushTextStream();
        batchCoordinator.closeBatch();
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
      batchCoordinator.dispose();
      pendingToolInputs.clear();
    },
  };
}
