/**
 * 内置 RPC 方法注册器
 *
 * 把所有 buildXxxMethod 集中到一处，便于：
 * - 一键注册所有方法（startServer 调用）
 * - 后续阶段按需追加（session、schedule、background、monitor 等）
 */

import { HandlerRegistry } from "../handlers.js";
import { buildAuthMethod } from "./auth.js";
import { buildHealthMethod } from "./health.js";
import {
  buildSessionSendMethod,
  buildSessionListMethod,
  buildSessionHistoryMethod,
  buildSessionAbortMethod,
  buildSessionDeleteMethod,
} from "./session.js";
import {
  buildScheduleListMethod,
  buildScheduleCreateMethod,
  buildScheduleUpdateMethod,
  buildScheduleDeleteMethod,
  buildScheduleRunMethod,
} from "./schedule.js";

export interface BuiltinMethodsOptions {
  /** 后续阶段会注入更多依赖（scheduler 等） */
}

/**
 * 构建包含所有内置方法的 HandlerRegistry。
 * 调用方可继续 register 自定义方法。
 *
 * 注意：session.* 方法需要 ctx.server.sessions 被注入；scheduler.* 同理。
 * 注册方法本身不要求依赖存在——运行时缺失依赖才报错。
 */
export function buildBuiltinRegistry(_opts: BuiltinMethodsOptions = {}): HandlerRegistry {
  const registry = new HandlerRegistry();
  registry.registerAll([
    buildAuthMethod(),
    buildHealthMethod(),
    // session.*
    buildSessionSendMethod(),
    buildSessionListMethod(),
    buildSessionHistoryMethod(),
    buildSessionAbortMethod(),
    buildSessionDeleteMethod(),
    // schedule.*
    buildScheduleListMethod(),
    buildScheduleCreateMethod(),
    buildScheduleUpdateMethod(),
    buildScheduleDeleteMethod(),
    buildScheduleRunMethod(),
  ]);
  return registry;
}
