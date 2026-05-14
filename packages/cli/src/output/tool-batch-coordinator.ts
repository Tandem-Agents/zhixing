/**
 * Tool Batch Coordinator —— 工具批次折叠展示协调器。
 *
 * **产品定位**：连续多个工具调用（譬如 LLM 一个 turn 内的 11 次 Read/Glob/Bash）
 * 在原"每工具两行卡片"渲染下会占满屏幕，把用户真正关心的 AI 决策/答案推到屏外。
 * 本协调器把连续 success 的工具调用折叠为"5 行恒定上限"批次展示：
 *
 *     ⟡ 已使用 11 个工具（Glob×2 · Bash×1 · Read×8）· 14s     ← 头部摘要（dim ⟡）
 *          ⋮ +8                                                ← 折叠提示
 *          Read .zhixing/config.json · 4 lines                 ← 近邻详情 × 3
 *          Read getting-started.md · 16 lines
 *          Bash dir /b D:\Workspace · 8 lines · 47ms
 *
 * **信息层级**：◆ AI 决策（主级，白）→ ⟡ 工具批次（次级，整组 dim）。视觉重量
 * 自然让位给 AI 文字内容；用户回顾 AI 中间做了什么时仍有近邻 3 条工具 + 总数 +
 * 分类计数可供扫读。
 *
 * **动态更新**：每个 success tool_end 触发一次 segment.replace 整段重渲——复用
 * markdown code block / list 双态渲染的 ReplaceableSegment 机制（流式期 replace、
 * 闭合期 commit）。用户实时看到"已使用 N 个工具 · Ks"的递增反馈。
 *
 * **失败破窗**：失败工具不入 batch——recordFailure 立即先 commit 当前 batch
 * （保前序工具历史），再 emit 红色独立 ◆ 行让错误突出可见，下次 success 起新
 * batch。错误信号永不被批次淹没。
 *
 * ─── 关键架构约束 ───
 *
 * **单一活跃 segment 约束（ScreenController 强制）**：
 *   markdown stream 的 code block / list 段渲染期间也持有 segment。批次 segment
 *   与之**不可同时活跃**。caller（output-renderer）必须保证：
 *     - text_delta 起手前调 closeBatch（mdStream 创建 → markdown 内部按需 begin）
 *     - tool_start (sub-agent-status) 起手前调 closeBatch（让 status-bar 接管）
 *     - turn_complete / stop 时调 closeBatch / dispose
 *   markdown stream 仅在 paragraph 起手后才可能 begin segment，与 batch 路径
 *   天然顺序互斥。
 *
 * **StdoutWriter 退化路径**：
 *   StdoutWriter 不实现 beginReplaceableSegment（pipe / CI 场景关心 stream 稳定
 *   性 + 无 chrome）。退化为"events 累积 + closeBatch 一次性 line emit 多行"：
 *   pipe 消费者看到的是最终态 5 行摘要 + 详情，比原 22 行单工具卡片更结构化。
 *
 * **不与 status-bar 冲突**：
 *   status-bar 走 EventBus tool:call_start/end 路径在 chrome 动态区显示"调用
 *   Read · 3s · 等待结果"；coordinator 走 AgentYield tool_end 路径在 scrollback
 *   写批次摘要。两路径独立、消费不同事件源——一个是"现在在做什么"动态，一个是
 *   "做过什么"历史。
 */

import type { CliWriter } from "../screen/index.js";
import type { ReplaceableSegmentHandle } from "../screen/screen-controller.js";
import {
  type BatchEventSnapshot,
  formatBatchDetailLine,
  formatBatchSummary,
  formatToolHeader,
  formatToolResult,
} from "../tool-card-format.js";
import { tone, layout } from "../tui/style.js";
import {
  ANCHOR_TOOL,
  sideEffectAnchor,
  toolDoneAnchor,
} from "./speaker-state.js";

/**
 * 详情窗口大小——近邻 N 条工具详情入展示，更早的折成 `⋮ +K`。
 *
 * 3 是工程上的"近邻感最小值"——再少（1/2）失去回顾价值，再多（5+）反而把屏占
 * 推回原问题。固定常量；如需用户级配置项未来再开放。
 */
const RECENT_DETAIL_WINDOW = 3;

/**
 * 详情行 / ⋮ 折叠行的起首前缀 = layout.contentPrefix (2) + 5 空格 = 7 空格。
 *
 * 视觉契约：
 *   - 头部 ⟡ 起首在列 3（contentPrefix 之后），AI ◆ 行同列——但 dim 不抢戏
 *   - 详情起首在列 8——比头部缩进 5 列，强烈的"附属下挂"视觉感
 *   - 与 ◆ 行的列对齐失去——故意为之，让批次组在视觉上自成独立块
 */
const DETAIL_LINE_PREFIX = `${layout.contentPrefix}     `;

export interface ToolBatchCoordinator {
  /**
   * 记录一个 success tool_end（探索类工具，default 策略）—— 累入当前 batch；若无
   * batch 则开新 batch + 段间空行。每次调用触发一次 segment.replace 重渲（chrome
   * 模式）或纯累积（StdoutWriter）。
   *
   * 调用方 caller 应保证 event.result.isError === false（失败走 recordFailure）+
   * tool 走 default 策略（副作用走 recordSideEffect）。
   */
  recordSuccess(event: BatchEventSnapshot): void;

  /**
   * 记录一个 success 副作用工具 tool_end（side-effect 策略：write / edit /
   * schedule）—— **永不折叠**渲染：commit 当前 batch（保历史）+ 段间空行 + 单行
   * `✎ <Action> <target> · <result>` 展示。
   *
   * 副作用 = AI 改变持久状态 = 用户事后必须能精确回看「改了我什么」。视觉上 dim
   * 不抢戏（不与 ◆ AI 决策行竞争主轴），但单行独立 + 异形 ✎ 锚 + 永不折叠三重
   * 信号让其在 scrollback 扫读中天然跳出。
   *
   * 失败副作用工具仍走 recordFailure 红色破窗——错误统一处理，不论策略。
   */
  recordSideEffect(event: BatchEventSnapshot): void;

  /**
   * 记录一个 failure tool_end —— 破窗渲染：commit 当前 batch（保历史）+ 段间空行 +
   * 红色独立 ◆ 行展示失败工具，让错误最大化醒目，下次 success 重开新 batch。
   *
   * 调用方 caller 应保证 event.result.isError === true。失败统一走此路径不论
   * 工具策略（default / side-effect 均如此）——错误信号需要统一最高优先级展示。
   */
  recordFailure(event: BatchEventSnapshot): void;

  /**
   * 封口当前 batch —— commit segment（chrome 模式）或一次 line emit 多行（退化）。
   * 调用时机：text_delta 起手前、tool_start (sub-agent-status) 起手前、turn_complete。
   * 无活跃 batch 时 no-op，可幂等多次调用。
   */
  closeBatch(): void;

  /**
   * 释放协调器 —— renderer.stop 调用。等价 closeBatch 行为（封口当前 batch），命名
   * 单独表达"renderer 即将销毁"语义；caller 在 dispose 后不应再调任何 API。
   */
  dispose(): void;
}

interface CreateToolBatchCoordinatorOptions {
  readonly writer: CliWriter;
}

interface BatchState {
  events: BatchEventSnapshot[];
  /**
   * chrome 模式（ScreenWriter）持有的 ReplaceableSegment handle —— 用于流式期反复
   * replace 整段重渲；StdoutWriter 退化时为 null，closeBatch 走一次性 line emit。
   */
  segment: ReplaceableSegmentHandle | null;
}

export function createToolBatchCoordinator(
  options: CreateToolBatchCoordinatorOptions,
): ToolBatchCoordinator {
  const { writer } = options;
  let state: BatchState | null = null;

  /**
   * 把当前 events 渲染为多行字符串—— segment.replace / commit 传入；StdoutWriter 退
   * 化路径 split("\n") 后逐行 writer.line。整组 dim、⟡ 锚作为次级视觉。
   */
  const renderBatchText = (events: readonly BatchEventSnapshot[]): string => {
    const lines: string[] = [];
    lines.push(
      `${layout.contentPrefix}${tone.dim(ANCHOR_TOOL)} ${tone.dim(formatBatchSummary(events))}`,
    );
    const recent = events.slice(-RECENT_DETAIL_WINDOW);
    const omitted = events.length - recent.length;
    if (omitted > 0) {
      lines.push(`${DETAIL_LINE_PREFIX}${tone.dim(`⋮ +${omitted}`)}`);
    }
    for (const e of recent) {
      lines.push(`${DETAIL_LINE_PREFIX}${tone.dim(formatBatchDetailLine(e))}`);
    }
    return lines.join("\n");
  };

  const beginBatch = (): BatchState => {
    // 段间空行保证：与上一段（AI paragraph / 失败行 / 用户消息 echo）拉开 1 空行
    writer.ensureSegmentBreak();
    // 退化检测：StdoutWriter 不实现 beginReplaceableSegment → factory undefined
    const factory = writer.beginReplaceableSegment;
    const segment = factory ? factory.call(writer) : null;
    return { events: [], segment };
  };

  const closeBatchInternal = (): void => {
    if (state === null) return;
    const finalText = renderBatchText(state.events);
    if (state.segment !== null) {
      // chrome 模式：commit 替换 segment 为 finalText 并冻结（不再 replace）
      state.segment.commit(finalText);
    } else {
      // StdoutWriter 退化：一次性 emit 最终多行——pipe / CI 看到结构化 5 行而非原 22 行
      for (const line of finalText.split("\n")) writer.line(line);
    }
    state = null;
  };

  return {
    recordSuccess(event) {
      if (state === null) state = beginBatch();
      state.events.push(event);
      if (state.segment !== null) {
        // chrome 模式：每次工具完成实时重渲，用户看到"已使用 N 个 · Ks"递增反馈
        state.segment.replace(renderBatchText(state.events));
      }
      // 退化路径：events 持续累积，closeBatch 时一次性 emit
    },

    recordSideEffect(event) {
      // 副作用「破窗」（与失败破窗同结构，但视觉上 dim 不喧宾夺主）：先封口当前
      // batch 让 segment 释放 + 段间空行 + emit 单行 ✎ 展示
      closeBatchInternal();
      writer.ensureSegmentBreak();
      // 复用 batch detail 行格式：`Action target · result` —— 与 batch 详情行的
      // 排版完全一致，让用户在视觉上感知「同一信息密度的工具行」，差异仅在 ✎ 锚
      // 和「永不折叠 + 独立成段」的语义
      const line = formatBatchDetailLine(event);
      writer.line(
        `${layout.contentPrefix}${sideEffectAnchor()} ${tone.dim(line)}`,
      );
    },

    recordFailure(event) {
      // 破窗：先封口当前 batch（保前序工具历史不丢），再 emit 独立失败行
      closeBatchInternal();
      writer.ensureSegmentBreak();
      const header = formatToolHeader(event.name, event.input);
      const result = formatToolResult(event.name, event.result, event.duration);
      // 失败行保留 ◆ 形态（红）—— 与 batch ⟡ / 副作用 ✎ 形态对比鲜明,
      // 错误信号最大化醒目
      writer.line(`${layout.contentPrefix}${toolDoneAnchor(false)} ${header}`);
      writer.line(
        `${layout.contentPrefix}  ${tone.dim("⎿")} ${tone.error(result)}`,
      );
    },

    closeBatch: closeBatchInternal,

    dispose() {
      // 与 closeBatch 行为一致——separately 命名让 caller 表达 renderer.stop 析构语义
      closeBatchInternal();
    },
  };
}
