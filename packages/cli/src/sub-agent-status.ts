/**
 * 子 agent 状态条 —— 通过 EventBus meta.lineage 把"派发型工具"(如 Task)的
 * 主调用与其子 agent 工具事件关联起来,在终端实时显示
 * `[Task#N: <desc>] <最近工具>` 单行状态。
 *
 * "派发型工具"判定:
 *   查询 cli 包内的 tool-render-strategy 表(单一事实源),
 *   策略 === "sub-agent-status" 的工具由本订阅器接管渲染;
 *   主路径 renderer.handleEvent 同时跳过这些工具的 ⟡ 卡片,避免双重渲染。
 *   当前唯一注册的派发型工具是 Task,下方数据流以 Task 为示例。
 *
 * 数据流:
 *   主 bus.tool:call_start(派发型工具,lineage="main")
 *     → 累积 TaskN + desc + pauseUI + 输出初始状态条
 *   子 bus.tool:call_start(lineage="main/sub-...")  ← 经父 bus 冒泡
 *     → 关联 (顺序匹配:第一个 sub-X 即当前 Task) + \r 刷新 [Task#N: desc] <toolName>...
 *   子 bus.tool:call_end                             ← 经父 bus 冒泡
 *     → \r 刷新 [Task#N: desc] <toolName> ✓/✗ <duration>ms
 *   主 bus.tool:call_end(派发型工具,lineage="main")
 *     → \n 收尾 + 输出 [Task#N: desc] ✓/✗ <total>s + 重置等待状态
 *   agent:run_end
 *     → 兜底重置 (N 计数器跨 run 不复用)
 *
 * 与 Renderer 关系:
 *   - 走 EventBus 通道,与 Renderer.handleEvent 走 AgentYield 通道完全解耦,
 *     互不污染主 spinner / 工具卡片渲染主路径。
 *   - 通过 pauseUI 钩子在状态条输出前停 spinner,避免动画覆盖。
 *   - 与主路径"哪些工具不渲染 ⟡ 卡片"共享 tool-render-strategy 表 —— 任何加表/
 *     改表两侧自动一致,不存在策略漂移。
 *
 * 顺序匹配的简化前提与已知 trade-off:
 *   - 单 Task / N=1 场景:tool-executor 自动回退串行(canRunParallel 要求 N≥2),
 *     "首个未关联的 sub-X lineage 即当前 Task" 顺序匹配仍精确,本模块行为零变化
 *   - 多 Task 并发场景(主 LLM 同 turn 派 N≥2 Task):tool-executor 走并发分支
 *     (Promise.allSettled 真并行),N 个 sub agent 几乎同时 agent:run_start /
 *     tool:call_start,顺序匹配会因 lineage 串扰而 UX 退化(子工具事件可能错关联到
 *     另一个 Task#N 的状态条);**功能不破**,只是单行刷新内容混乱
 *   - 精确归属升级(sub_agent_id ↔ Task#N):横跨 4 包(ToolExecutionContext 加
 *     toolCallId / Task 工具 emit 关联事件 / runChildAgent reserve subAgentId /
 *     本模块状态机改 Map<toolCallId, TaskState>),作为独立工单跟进,与并发分支
 *     无强耦合,不阻塞已落地的并发能力
 *
 * TTY 行为:
 *   - TTY:\r 单行刷新(spec 要求"只显示最近一个工具,避免堆叠")
 *   - 非 TTY:不写 \r 控制符(避免 CI / pipe / 重定向日志爆炸或乱码),
 *     仅在 Task 起止时各打一行,中间子工具事件静默(可观测性走 EventBus 直采)。
 *     状态机内部仍维护 currentTask / currentSubLineage(逻辑层不分支,仅输出层
 *     做 TTY/非 TTY 二选一),保证 Task 收尾路径的关闭条件在两种模式下一致。
 */

import chalk from "chalk";
import type { AgentEventMap, EventMeta, IEventBus } from "@zhixing/core";
import { getToolRenderStrategy } from "./tool-render-strategy.js";

// ─── 视觉常量 ───

const ICON_TASK = "⌬";
const ICON_OK = chalk.green("✓");
const ICON_FAIL = chalk.red("✗");

// 状态条最大可视宽度兜底(用于 \r 清行)。
// 实际清行宽度取 max(本行写入长度, MIN_CLEAR_WIDTH),足以覆盖前一次的状态条残留。
const MIN_CLEAR_WIDTH = 60;

// 工具卡片 summary 截断:子 agent 工具的"最近工具"长度可控,避免单 Task 状态条
// 超出终端列宽后换行混乱(\r 单行刷新前提是状态条不换行)
const TOOL_SUMMARY_MAX_LEN = 40;

// description 截断:防 LLM 输出超长描述把 [Task#N: desc] 前缀撑爆
const DESC_MAX_LEN = 30;

// ─── 装载句柄 ───

export interface SubAgentStatusHandle {
  /** run 结束 finally 调一次:卸载所有 listener,避免跨 run 累积 */
  dispose(): void;
}

/**
 * 装载子 agent 状态条 EventBus 订阅。
 *
 * @param eventBus 主 bus(子 bus 事件冒泡至此带 meta.lineage="main/sub-...")
 * @param pauseUI  状态条输出前的 spinner 暂停钩子;无 renderer 时传 no-op
 */
export function setupSubAgentStatus(
  eventBus: IEventBus<AgentEventMap>,
  pauseUI: () => void,
): SubAgentStatusHandle {
  // closure 状态:per-handle(per-run)生命周期,run_end 兜底重置
  // taskCounter:本 run 内已开启的 Task 数量(1-based 显示)
  // currentTask:当前正在执行的 Task 上下文,null 表无 Task 在跑
  // currentSubLineage:已关联到 currentTask 的子 bus lineage(顺序匹配:首个 sub-X)
  // currentToolLabel:子 agent 最近一次 tool_start 的工具名(\r 刷新内容)
  // taskStartAt:Task 起始 epoch ms(用于收尾 duration)
  // currentLineLength:上次 stdout 写入的可视长度,清行宽度参考
  let taskCounter = 0;
  let currentTask: { n: number; desc: string; toolCallId: string } | null = null;
  let currentSubLineage: string | null = null;
  let currentToolLabel: string | null = null;
  let taskStartAt = 0;
  let currentLineLength = 0;

  const isMainLineage = (meta?: EventMeta): boolean =>
    meta?.lineage === "main";

  const isSubLineage = (meta?: EventMeta): boolean =>
    typeof meta?.lineage === "string" && meta.lineage.startsWith("main/sub-");

  // 构造清行 ANSI 前缀（仅供 caller 与新内容拼接为单次 write，避免分段刷新闪烁）。
  // 非 TTY / 当前无内容时返回空串——caller 正常拼接后行为等同"无 prefix"。
  const buildClearPrefix = (): string => {
    if (!process.stdout.isTTY || currentLineLength === 0) return "";
    const width = Math.max(currentLineLength, MIN_CLEAR_WIDTH);
    return `\r${" ".repeat(width)}\r`;
  };

  const clearLine = (): void => {
    const prefix = buildClearPrefix();
    if (!prefix) return;
    process.stdout.write(prefix);
    currentLineLength = 0;
  };

  // \r 单行刷新（子工具中间帧专用）：TTY 模式正常刷，非 TTY 静默——中间帧在
  // CI / pipe 下每个工具 2 次的输出会形成日志爆炸，可观测性走 EventBus 直采。
  // 清行 + 新内容合并为单次 stdout.write 避免 TTY 分段刷新视觉抖动。
  const writeStreamLine = (line: string): void => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`${buildClearPrefix()}\r${line}`);
    currentLineLength = line.length;
  };

  // 整行输出（Task 起止帧专用）：两种模式都打整行，但 TTY 模式下先清掉残留
  // 状态条再打，避免上一行尾巴混入。收尾换 \n 让下一行回到正常输出流。
  // 清行 + 新内容合并为单次 stdout.write。
  const writeFrameLine = (line: string): void => {
    process.stdout.write(`${buildClearPrefix()}${line}\n`);
    currentLineLength = 0;
  };

  const truncate = (s: string, max: number): string =>
    s.length <= max ? s : `${s.slice(0, max - 1)}…`;

  const formatTaskHead = (n: number, desc: string): string =>
    `${chalk.cyan(ICON_TASK)} ${chalk.cyan(`[Task#${n}: ${truncate(desc, DESC_MAX_LEN)}]`)}`;

  const resetTaskState = (): void => {
    currentTask = null;
    currentSubLineage = null;
    currentToolLabel = null;
    taskStartAt = 0;
  };

  // ─── 订阅 ───

  // 主 bus 工具事件是否由本订阅器接管 —— 查 cli 包内的渲染策略表(单一事实源),
  // 与 renderer.handleEvent 主路径的"跳过哪些工具"完全对齐,不存在两侧逻辑漂移
  const isStatusBarTool = (name: string): boolean =>
    getToolRenderStrategy(name) === "sub-agent-status";

  const onToolStart = (
    payload: AgentEventMap["tool:call_start"],
    meta?: EventMeta,
  ): void => {
    // 主 bus 的"由本订阅器接管的工具"调用 = 一个新 Task 开启
    if (isMainLineage(meta) && isStatusBarTool(payload.name)) {
      const desc = extractDescription(payload.input);
      taskCounter += 1;
      currentTask = { n: taskCounter, desc, toolCallId: payload.id };
      currentSubLineage = null;
      currentToolLabel = null;
      taskStartAt = Date.now();
      pauseUI();
      writeFrameLine(
        `  ${formatTaskHead(taskCounter, desc)} ${chalk.dim("启动子 agent...")}`,
      );
      return;
    }

    // 子 bus 冒泡的工具事件 = 当前 Task 内部进度
    if (isSubLineage(meta) && currentTask !== null) {
      // 顺序匹配:首个 sub-X lineage 视为当前 Task 关联子 agent
      // (单 Task / N=1 时 tool-executor 自动回退串行,匹配精确;
      // 多 Task 并发时此匹配会 UX 退化,见模块顶部 JSDoc trade-off 段)
      if (currentSubLineage === null) {
        currentSubLineage = meta!.lineage!;
      }
      // 仅显示自己关联的 sub-X 事件(避免并发场景下其他 sub 事件串扰本行)
      if (meta!.lineage !== currentSubLineage) return;

      currentToolLabel = formatToolLabel(payload.name, payload.input);
      pauseUI();
      writeStreamLine(
        `  ${formatTaskHead(currentTask.n, currentTask.desc)} ${chalk.dim(currentToolLabel)} ${chalk.dim("...")}`,
      );
    }
  };

  const onToolEnd = (
    payload: AgentEventMap["tool:call_end"],
    meta?: EventMeta,
  ): void => {
    // 子 bus 冒泡的工具结束:刷新本行尾部添加状态 + 耗时(中间帧)
    if (
      isSubLineage(meta) &&
      currentTask !== null &&
      currentSubLineage !== null &&
      meta!.lineage === currentSubLineage &&
      currentToolLabel !== null
    ) {
      const status = payload.success ? ICON_OK : ICON_FAIL;
      pauseUI();
      writeStreamLine(
        `  ${formatTaskHead(currentTask.n, currentTask.desc)} ${chalk.dim(currentToolLabel)} ${status} ${chalk.dim(`${payload.duration}ms`)}`,
      );
      return;
    }

    // 主 bus 的"由本订阅器接管的工具"结束:整 Task 收尾,清状态 + 输出最终帧
    if (
      isMainLineage(meta) &&
      isStatusBarTool(payload.name) &&
      currentTask !== null &&
      currentTask.toolCallId === payload.id
    ) {
      const totalSec = ((Date.now() - taskStartAt) / 1000).toFixed(1);
      const status = payload.success ? ICON_OK : ICON_FAIL;
      pauseUI();
      writeFrameLine(
        `  ${formatTaskHead(currentTask.n, currentTask.desc)} ${status} ${chalk.dim(`${totalSec}s`)}`,
      );
      resetTaskState();
    }
  };

  const onRunEnd = (): void => {
    // 兜底:run 异常退出 / Task 还没收尾即 run_end
    // 重置内部状态,N 计数器随 handle 释放(下次 setup 时归零)
    if (currentTask !== null) {
      clearLine();
      resetTaskState();
    }
  };

  const offToolStart = eventBus.on("tool:call_start", onToolStart);
  const offToolEnd = eventBus.on("tool:call_end", onToolEnd);
  const offRunEnd = eventBus.on("agent:run_end", onRunEnd);

  return {
    dispose() {
      offToolStart();
      offToolEnd();
      offRunEnd();
      clearLine();
      resetTaskState();
      taskCounter = 0;
    },
  };
}

// ─── 工具内部辅助 ───

/**
 * 从派发型工具 input 提取 description(状态条头部展示用)。
 *
 * Task 工具入口的 assertCallContract 已 fail-fast 拦截缺失/纯空白,正常路径
 * 必有非空字符串;此处兜底仅防御未来新增的派发型工具未声明 description 字段
 * (运行时输出层兜底,不让状态条因数据缺陷而崩溃)。
 */
function extractDescription(input: Record<string, unknown>): string {
  const raw = input["description"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return "(unnamed task)";
}

/**
 * 子 agent 工具的"最近工具"标签:工具名 + 简要 summary。
 *
 * 与 render.ts 主 path 的 getToolSummary 保持视觉一致:
 *   read/write → 显示 path
 *   bash       → 显示前 60 字符 cmd
 *   其他       → 仅工具名
 */
function formatToolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read":
    case "write": {
      const path = typeof input["path"] === "string" ? input["path"] : "";
      return path ? truncatePlain(`${name} ${path}`, TOOL_SUMMARY_MAX_LEN) : name;
    }
    case "bash": {
      const cmd = typeof input["command"] === "string" ? input["command"] : "";
      return cmd ? truncatePlain(`${name} "${cmd}"`, TOOL_SUMMARY_MAX_LEN) : name;
    }
    case "grep": {
      const pattern = typeof input["pattern"] === "string" ? input["pattern"] : "";
      return pattern
        ? truncatePlain(`${name} "${pattern}"`, TOOL_SUMMARY_MAX_LEN)
        : name;
    }
    case "glob": {
      const glob = typeof input["glob_pattern"] === "string" ? input["glob_pattern"] : "";
      return glob ? truncatePlain(`${name} "${glob}"`, TOOL_SUMMARY_MAX_LEN) : name;
    }
    default:
      return name;
  }
}

function truncatePlain(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
