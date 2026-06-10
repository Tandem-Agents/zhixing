/**
 * cli 装配层 SegmentManager 外部依赖工厂 —— REPL + serve 共享。
 *
 * 段切换的"内部依赖"（provider / model capability / estimator / eventBus）由
 * orchestrator 在 createAgentRuntime 内部解析；"外部依赖"由 cli 装配层注入：
 *
 *   - taskListReader：让段切换决策能读 in-progress 任务（用于 defer 判定）。
 *     适配自 TaskListService（in-memory + per-conversation cache），同步读、
 *     conversation 不存在 / cache miss → 返 false 与 ephemeral 路径自然对齐。
 *
 *   - persistence：把 SegmentMeta 累积写入 conversation meta 的 segmentMetadata。
 *     注意 marker 本身**不落 transcript** —— 它经 `segment:new_started` 事件流向
 *     orchestrator accumulator、随 RunResult 带出，由会话层在接受协议中折叠
 *     注意力窗口（压缩是窗口的视图操作，原文持久化 append-only 不参与）。
 *
 * 抽离独立 helper 而非内联到 RuntimeSession：REPL bootstrap / REPL reload swap /
 * serve per-session / serve ephemeral 四个装配点共享同一工厂——避免任一处
 * 漏装、避免"两入口不对齐"类回归。
 */

import {
  createSegmentPersistence,
  type IConversationRepository,
  type SegmentPersistence,
  type TaskListReader,
} from "@zhixing/core";
import type { TaskListService } from "@zhixing/tools-builtin";

export interface CliSegmentDeps {
  readonly taskListReader: TaskListReader;
  readonly persistence: SegmentPersistence;
}

export interface CliSegmentDepsInput {
  readonly taskListService: TaskListService;
  readonly conversationRepo: IConversationRepository;
}

export function createCliSegmentDeps(input: CliSegmentDepsInput): CliSegmentDeps {
  return {
    taskListReader: createTaskListReaderFromService(input.taskListService),
    persistence: createSegmentPersistence({
      conversationRepo: input.conversationRepo,
    }),
  };
}

/**
 * 把 TaskListService 适配成 TaskListReader。
 *
 * 实现契约：同步返回（service.getInProgressTasks 走 in-memory cache）；
 * conversation 不存在 / 未 prime / 未 set 都返 false。
 */
export function createTaskListReaderFromService(
  service: TaskListService,
): TaskListReader {
  return {
    hasInProgress(conversationId) {
      return service.getInProgressTasks(conversationId).length > 0;
    },
  };
}
