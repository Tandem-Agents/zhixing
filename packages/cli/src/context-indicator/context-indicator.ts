/**
 * ContextIndicator —— 状态条尾部"上下文 + cache"指示器。
 *
 * ─── 是什么 ───
 *
 * 在状态条第一行的 "context" 段渲染"下次 LLM 将携带多少 tokens"的快照，
 * 形如 `~ 14k` 或 `~ 14k (cache 9k)`。`~` 前缀强调估算语义，与 status-bar
 * 的 `↑↓ token`（本 run API 真值消耗）严格区分 —— 这是窗口占用快照，
 * 那是流量消耗累加。
 *
 * ─── 多源合成（核心架构） ───
 *
 * 本指示器消费两个独立信号合成单段展示：
 *
 *   1. `context:tokens_snapshot.totalTokens` —— turn-end 钩子 ③ 步 emit 的
 *      上下文占用，业界推测 Claude Code 同模式 = "已发送部分 API 真值锚定
 *      + 自 anchor 以来新增的 messages 后缀做字符估算"（见 core/loop/turn-end.ts）
 *
 *   2. `llm:request_end.usage.cacheReadTokens` —— 最近一次 LLM API 调用的
 *      cache 命中真值（数据源 = providers/src/adapters/*-usage.ts 解析）
 *
 * 为什么 CLI 端合成而不是 core 在 context:tokens_snapshot 增加 cache 字段：
 *
 *   - 估算 vs 真值语义边界：context:tokens_snapshot 是 estimator 出的估算
 *     快照，塞入 API 真值会让事件语义错位
 *   - turn-end 钩子是无状态副作用编排器，要它"记住最近一次 llm:request_end
 *     的 cache 值"等同强行加状态，本质违反钩子设计
 *   - 合成是展示层决策，归 CLI 自然 —— core emit 各种原子事件，CLI 决定如何合成展示
 *
 * 跨 run 失效语义：
 *
 *   本组件是 per-run 装配（render.ts 通过 decorateRunBus 在 runtime.run() 内
 *   创建，run 结束时 dispose）—— 新 run 总是全新实例 + state=null。本组件
 *   **不订阅** `agent:run_start`，避免引入永远不可达的 handler 分支（per-run
 *   装配下 run_start 触发时 state 必然为初始 null/null，清值分支永远 short-circuit）。
 *
 * Run 内多 LLM call 刷新语义：
 *
 *   - 每次 llm:request_end 覆盖 cacheReadTokens（值 > 0 时设值；否则清 null）
 *     —— "last-wins"，cache=0 / undefined 表示本次 call 无命中，老值过期
 *   - turn-end 触发 context:tokens_snapshot → totalTokens last-wins 覆盖
 *
 * ─── 装配与启用 ───
 *
 * 单一启用条件：调用方注入 `screen`。与 status-bar 同模式 —— render.ts 的
 * `if (screen)` 是唯一开关，无 chrome 的运行模式（serve 等）自然不
 * 装配本组件。无 ENV、无 CLI flag、无运行时配置字段；组件常态化
 * 存在于 REPL 模式。
 *
 * ─── 自然降级（按数据可用性） ───
 *
 * - totalTokens 永远没到达 → 段始终不渲染（等待 estimator + eventBus 装配完整后
 *   的首次 emit）
 * - cacheReadTokens 缺失 / 0 / 负 → 仅渲染 `~ Xk`，无 `(cache Yk)` 后缀；
 *   provider 不暴露 cache 字段时（如 SiliconFlow 中转）永远是这个状态
 * - dispose 时不撤段 —— 跨 run 之间保留最后一次有效快照（与 status-bar 的
 *   done 状态保留显示同模式），下一次 run 的 first emit 自然覆盖
 */

import type { AgentEventMap, IEventBus } from "@zhixing/core";
import { STATUS_TAIL_IDS, type ScreenController } from "../screen/index.js";
import { formatTokens } from "../status-bar/verbs.js";

/**
 * 本组件占用的 tail 段 id —— 引用注册表保证全 CLI 命名一致。
 *
 * 与 TaskTail (`STATUS_TAIL_IDS.task`) 等其他 tail source 通过 id 隔离；
 * 视觉顺序由 STATUS_TAIL_IDS 声明顺序唯一决定（task 在前、context 在后
 * → `[task] │ [context]`，"主任务进度在前、辅助诊断在后"），与运行时
 * 各 source 首次 emit 的时序无关。
 */
const CONTEXT_TAIL_ID = STATUS_TAIL_IDS.context;

export interface ContextIndicatorOptions {
  readonly screen: ScreenController;
  readonly eventBus: IEventBus<AgentEventMap>;
}

export interface ContextIndicatorHandle {
  dispose(): void;
}

export function createContextIndicator(
  options: ContextIndicatorOptions,
): ContextIndicatorHandle {
  const { screen, eventBus } = options;

  // ─── 多源 reactive state ───
  // null 表示"尚未收到对应数据" —— 与 0 严格区分（0 是真值，null 是缺值）。
  // totalTokens=null 时整段不渲染（等待首次 estimator 快照到达）。
  // cacheReadTokens=null 时只渲染 totalTokens 部分（无 cache 信息或 cache=0）。
  let totalTokens: number | null = null;
  let cacheReadTokens: number | null = null;

  const repaint = (): void => {
    if (totalTokens === null) return; // 未收到 totalTokens → 整段不渲染
    screen.setStatusTail(
      CONTEXT_TAIL_ID,
      formatContextTokens(totalTokens, cacheReadTokens),
    );
  };

  // ① 上下文占用快照 —— turn-end 钩子 ③ 步 emit（anchor + delta / fallback 字符估算）
  const offTokens = eventBus.on("context:tokens_snapshot", (payload) => {
    // 防御：totalTokens ≤ 0（异常 emit / 估算器返 0）→ 不刷段，避免出现 "~ 0" 噪声
    if (payload.totalTokens <= 0) return;
    totalTokens = payload.totalTokens;
    repaint();
  });

  // ② Cache 命中真值 —— provider 解析 API 返回的 cacheReadTokens
  //
  // 每次 LLM call 都覆盖（last-wins）：
  //   - cacheReadTokens > 0 → 设值，下一帧渲染 "(cache Xk)" 后缀
  //   - cacheReadTokens 缺失 / 0 / 负 → 清 null，下一帧不渲染 cache 部分
  //
  // "清掉 0 值"是必要的 —— 同一个 run 内多次 LLM call，第 N 次可能命中、
  // 第 N+1 次未命中。若不清，旧值"假显示"。
  //
  // 服务商不暴露 cache 字段时（如 SiliconFlow 中转，详见
  // providers/src/presets.ts siliconflow.quirks 注释），cacheReadTokens 永远是
  // undefined → 永远 null → 永远只显示 `~ Xk` 无 cache 后缀。这是自然降级，
  // 非 bug，非配置缺失。
  const offRequestEnd = eventBus.on("llm:request_end", (payload) => {
    const next = payload.usage.cacheReadTokens;
    cacheReadTokens = next !== undefined && next > 0 ? next : null;
    repaint();
  });

  return {
    dispose: (): void => {
      offTokens();
      offRequestEnd();
      // 不撤段 —— 跨 run 之间保留最后一次有效快照，与 status-bar 的 done 状态
      // 保留显示同模式（status-bar.ts:455 "done 状态保留显示——dispose 不该清掉它"）。
      //
      // ContextIndicator 是 per-run 装配，run 结束触发 dispose；若此时撤段，
      // 用户看到的状态条会在 turn 结束瞬间"丢失上下文指示"，体验断裂。保留快照让
      // 用户能持续看到"上次 turn 结束时的占用 / cache"，下一次 run 的 first emit
      // 自然覆盖；session 退出由 ScreenController.detachInput → statusTails.clear()
      // 单点清理，与 status-bar 的清理路径同模式。
    },
  };
}

/**
 * 合成展示文本 —— 按"总占用 + 可选 cache"两段拼。
 *
 * 格式契约：
 *   - 仅 totalTokens：`~ 14.0k`
 *   - 含 cache：`~ 14.0k (cache 9.0k)`
 *
 * 设计：
 *   - `~` 前缀强调估算语义（与 status-bar 的 `↑↓` 真值前缀字符级区分）
 *   - cache 部分用 `(cache <数字>)` 括号包裹，视觉上"附加说明"语义
 *   - 数字部分统一复用 status-bar 的 `formatTokens`，k / M 自适应
 *
 * cache 部分严格条件：`cacheReadTokens` 为正数才追加 —— null / 0 / 负值
 * 都按"无 cache 信息"处理（覆盖服务商不暴露 cache 字段、本次 LLM call
 * 无命中、防御异常输入三种场景）。
 */
function formatContextTokens(
  totalTokens: number,
  cacheReadTokens: number | null,
): string {
  const head = `~ ${formatTokens(totalTokens)}`;
  if (cacheReadTokens === null || cacheReadTokens <= 0) return head;
  return `${head} (cache ${formatTokens(cacheReadTokens)})`;
}
