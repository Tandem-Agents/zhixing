/**
 * scheduler.json 从属投影的同步读取 —— turn-context 注入用。
 *
 * cli 去自起 Scheduler 后没有本地实例，而 turn-context 的 SchedulerProvider 是同步契约
 * （shouldInject / render 同步调 getStatus），故同步读磁盘投影（核心宿主单写者的只读快照）。
 * scheduler.json 小、per-turn 读开销可忽略；文件不存在 / 损坏（宿主没跑过 / 无任务）返回空摘要。
 * 只纳入外部任务（isInternal 过滤）—— 内部系统维护不进 agent 上下文。
 */

import { readFileSync } from "node:fs";
import {
  computeStatusSummary,
  isInternal,
  getSchedulerStorePath,
  type ScheduledTask,
  type TaskStatusSummary,
} from "@zhixing/core";

/**
 * 读 scheduler.json 投影的全部任务 —— 宿主单写者的只读快照（依赖原子 rename，读到的
 * 要么旧版要么新版完整快照）。文件不存在 / 损坏 → 空数组：读者无法修复、只能优雅降级。
 *
 * 这是 cli 侧所有「读投影」的单一入口——turn-context 摘要与 RpcSchedulerFacade.list()
 * 都经它，两条投影路径的降级语义由此统一（不再一条抛原始 JSON 错、一条返空）。
 * 不做内部/外部过滤，调用方按视角自行用 isInternal 筛。
 */
export function readSchedulerTasksSync(
  storePath: string = getSchedulerStorePath(),
): ScheduledTask[] {
  try {
    const raw = readFileSync(storePath, "utf-8");
    return (JSON.parse(raw) as { tasks?: ScheduledTask[] }).tasks ?? [];
  } catch {
    return []; // 文件不存在 / 损坏（宿主没跑过、或还没任务）
  }
}

export function readSchedulerSummarySync(
  storePath: string = getSchedulerStorePath(),
): TaskStatusSummary {
  const tasks = readSchedulerTasksSync(storePath).filter((t) => !isInternal(t));
  return computeStatusSummary(tasks, new Date());
}

/** ensure 守候窗口：近期任务在此窗口内则宿主守到触发（与 idle reaper 的 near 窗口一致）。 */
const NEAR_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * cli 启动轻检查判据 —— 是否该在启动时主动 ensure 核心宿主（否则纯聊天零后台）。
 * 命中条件（同步读 scheduler.json 投影）：
 * - 文件不存在（全新 / 首次）—— 视为「系统维护未 seed = 逾期」，需拉起 seed + 跑（破死锁）。
 * - 有内部维护任务逾期，或根本没有内部任务行 —— 同上，无行 = 逾期。
 * - 有近期外部（用户）任务待触发 —— 守候到触发。
 */
export function shouldEnsureOnStartup(
  storePath: string = getSchedulerStorePath(),
): boolean {
  let tasks: ScheduledTask[];
  try {
    const raw = readFileSync(storePath, "utf-8");
    tasks = (JSON.parse(raw) as { tasks?: ScheduledTask[] }).tasks ?? [];
  } catch {
    return true; // 全新 / 首次：系统维护尚未 seed，需拉起
  }

  const now = Date.now();
  const internal = tasks.filter((t) => isInternal(t));
  const maintenanceDue =
    internal.length === 0 ||
    internal.some(
      (t) =>
        t.enabled &&
        t.state.nextRunAt &&
        new Date(t.state.nextRunAt).getTime() <= now,
    );
  if (maintenanceDue) return true;

  return tasks
    .filter((t) => !isInternal(t))
    .some(
      (t) =>
        t.enabled &&
        t.state.nextRunAt &&
        new Date(t.state.nextRunAt).getTime() - now <= NEAR_WINDOW_MS,
    );
}
