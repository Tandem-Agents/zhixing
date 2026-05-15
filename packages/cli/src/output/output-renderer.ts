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
import type { CliWriter, ReplaceableSegmentHandle } from "../screen/index.js";
import { stringWidth, wrapToWidth } from "../tui/line-width.js";
import { MarkdownStream, type MarkdownMode } from "./markdown/index.js";
import { createToolBatchCoordinator } from "./tool-batch-coordinator.js";

// ─── Thinking rolling tail 显示参数 ───
//
// 设计契约(产品决策,详见 cli/src/output/output-renderer.ts thinking_block_*
// 案例处理):
//   - 无 thinking: 完全不占空间
//   - thinking ≤ 2 行: 自然 1 / 2 行
//   - thinking > 2 行: 恒定 2 行 rolling tail (最旧的滚走)
//   - 曾滚出过内容时, 显示第一行前缀加 ELLIPSIS 标记
//   - thinking 流结束: segment.close() 固化进 scrollback,内容不变(显式不擦)
//
// 前缀符号: ┊ (U+250A 虚线竖线) + 空格 = 2 列;chalk.dim 灰色不抢戏。
// 与 tool batch 视觉元素 (⟡ / ⋮ / etc) 风格一致 —— 信息分级清楚但不刺眼。
const THINKING_PREFIX = "┊ ";
const THINKING_ELLIPSIS = "...";
// flush 节流毫秒数 —— thinking_delta 高频(~30ms/chunk)时频繁 replace segment 会
// 视觉闪烁。60ms 是 16fps 帧率粒度,人眼无感却足够 batch 多个 chunk 一次重绘。
const THINKING_FLUSH_MS = 60;

interface ThinkingDisplayState {
  segment: ReplaceableSegmentHandle;
  /** 累积全文 buffer (含原始 \n) —— flush 时按 \n + 显示宽度 wrap 切行 */
  buffer: string;
  /** 是否曾滚出过内容 —— 一旦 wrapped lines > 2 即标记 true,后续显示永远加 ELLIPSIS */
  scrolledOut: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 渲染 thinking buffer 为最终 segment 文本 (最多 2 行 + 前缀 + dim + 可选 ELLIPSIS)。
 *
 * 步骤:
 *   1. 按 \n 硬切成段 (LLM thinking 输出可能含换行)
 *   2. 每段按 columns - prefixWidth 软换行 (wrapToWidth 处理 CJK 双宽)
 *   3. 取最后 2 行
 *   4. 第一行如果曾/此刻有滚出,加 ELLIPSIS 前缀标记
 *   5. 整体加 ┊ 前缀 + chalk.dim
 *
 * @returns text 与是否曾有内容滚出(累积语义:本次或之前任何一次滚出过都为 true)
 */
function renderThinkingTail(
  buffer: string,
  columns: number,
  scrolledOutBefore: boolean,
): { text: string; scrolledOut: boolean } {
  const prefixWidth = stringWidth(THINKING_PREFIX);
  const wrapWidth = Math.max(1, columns - prefixWidth);

  // 按 \n 硬切 + wrapToWidth 软换行
  const paragraphs = buffer.split("\n");
  const allLines: string[] = [];
  for (const para of paragraphs) {
    if (para === "") {
      // 空段(连续 \n / 末尾 \n) 作为空行加入 — 保留 thinking 视觉结构
      allLines.push("");
      continue;
    }
    const wrapped = wrapToWidth(para, wrapWidth);
    allLines.push(...wrapped);
  }

  const scrolledOutNow = allLines.length > 2;
  const scrolledOut = scrolledOutBefore || scrolledOutNow;
  const visibleLines = allLines.slice(-2);

  const formattedLines = visibleLines.map((line, idx) => {
    const isFirst = idx === 0;
    const body = scrolledOut && isFirst ? THINKING_ELLIPSIS + line : line;
    return chalk.dim(THINKING_PREFIX + body);
  });

  return { text: formattedLines.join("\n"), scrolledOut };
}

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

  // Thinking rolling tail 状态 —— 仅在 thinking_block_start ~ thinking_block_end
  // 之间非空,thinking 流外恒为 null。详见顶部 THINKING_* 常量注释与
  // renderThinkingTail 函数实现。
  let thinkingState: ThinkingDisplayState | null = null;

  const flushTextStream = (): void => {
    if (mdStream) {
      mdStream.end();
      mdStream = null;
    }
  };

  const flushThinkingNow = (): void => {
    if (!thinkingState) return;
    if (thinkingState.flushTimer !== null) {
      clearTimeout(thinkingState.flushTimer);
      thinkingState.flushTimer = null;
    }
    const { text, scrolledOut } = renderThinkingTail(
      thinkingState.buffer,
      getColumns(),
      thinkingState.scrolledOut,
    );
    thinkingState.segment.replace(text);
    thinkingState.scrolledOut = scrolledOut;
  };

  const scheduleThinkingFlush = (): void => {
    if (!thinkingState || thinkingState.flushTimer !== null) return;
    thinkingState.flushTimer = setTimeout(() => {
      flushThinkingNow();
    }, THINKING_FLUSH_MS);
  };

  /**
   * 关闭 thinking segment 并落定显示。
   *
   * 调用时机:
   *   - thinking_block_end (正常路径,显式边界)
   *   - 其他事件入口防御性 cleanup (异常路径:adapter 漏 emit end / error / abort)
   *   - stop() / dispose
   *
   * 行为: flushThinkingNow 把 pending buffer 写完 + segment.close() 固化进
   * scrollback (内容不变,符合"结束后不变"产品契约)。thinkingState 清 null。
   */
  const closeThinkingSegment = (): void => {
    if (!thinkingState) return;
    flushThinkingNow();
    thinkingState.segment.close();
    thinkingState = null;
  };

  const renderEvent = (event: AgentYield): void => {
    switch (event.type) {
      case "text_delta": {
        // 过滤 LLM 在工具调用前的纯空白前导——避免起手就写一个 ◆ 锚但什么都没说
        if (!mdStream && event.text.trim() === "") break;
        // 防御性 cleanup —— 正常路径 thinking_block_end 应已 emit;但 adapter
        // 异常 / 协议漂移时 thinking segment 可能悬挂,这里在 text 段 begin 之前
        // 兜底关闭(单一活跃 segment 约束:thinking segment 与 markdown segment
        // 不可同时活跃)
        closeThinkingSegment();
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

      case "thinking_block_start": {
        // Thinking 流开始 —— 释放上一段 (markdown / batch),独占 segment
        // 活跃位 (单一活跃 segment 约束)。防御:若上一个 thinking segment 还
        // 在 (异常路径) 先 close,正常路径下 closeThinkingSegment no-op。
        flushTextStream();
        batchCoordinator.closeBatch();
        closeThinkingSegment();

        const segFactory = writer.beginReplaceableSegment;
        if (!segFactory) {
          // StdoutWriter (runOnce 模式) 不实现 segment —— 降级为不显示 thinking。
          // thinking 内容仍由 llm-call 累积成 ThinkingBlock 并持久化进 transcript,
          // 仅缺 cli UI 渲染。这是合理取舍:runOnce 是 batch 模式,无动态 segment 能力。
          break;
        }

        // 段间空行 —— 与既有 markdown segment / tool batch 的进入模式一致
        writer.ensureSegmentBreak();

        thinkingState = {
          segment: segFactory.call(writer),
          buffer: "",
          scrolledOut: false,
          flushTimer: null,
        };
        // 首次 replace 写入空内容 —— begin 默认会有空段,首个 thinking_delta
        // 到来时再节流 flush。
        break;
      }

      case "thinking_delta": {
        if (event.thinking.length === 0) break;
        if (thinkingState) {
          thinkingState.buffer += event.thinking;
          scheduleThinkingFlush();
        } else {
          // 异常路径降级 —— 未收到 thinking_block_start 就直接来 thinking_delta
          // (adapter 协议漂移 / 跨 provider 兜底等)。退化为旧的 appendInline 灰色
          // 全量显示,保证内容不丢失;不进 rolling tail (无 segment 不能 replace)。
          writer.appendInline(chalk.dim(event.thinking));
        }
        break;
      }

      case "thinking_block_end": {
        closeThinkingSegment();
        break;
      }

      case "assistant_message":
        break;

      case "tool_start": {
        // 防御性 cleanup —— 与 text_delta 同理:tool 段开始前若有悬挂 thinking
        // segment 先 close (与 ensureSegmentBreak / batch 段管理逻辑一致)
        closeThinkingSegment();
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
        closeThinkingSegment();
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
      // 防御性 cleanup —— 异常退出 / abort / dispose 路径若 thinking segment
      // 还在,这里关闭 (与 markdown segment / batch segment 同模式)
      closeThinkingSegment();
      flushTextStream();
      batchCoordinator.dispose();
      pendingToolInputs.clear();
    },
  };
}
