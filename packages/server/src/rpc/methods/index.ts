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
  buildSessionSubscribeMethod,
  buildSessionUnsubscribeMethod,
  buildSessionRenameMethod,
  buildSessionClearMethod,
  buildSessionCompactMethod,
  buildSessionContextBudgetMethod,
  buildSessionNewMethod,
  buildSessionResumeMethod,
  buildSessionTaskListUpdateMethod,
  buildSessionTaskListMethod,
} from "./session.js";
import {
  buildWorksceneListMethod,
  buildWorksceneCreateMethod,
  buildWorksceneRenameMethod,
  buildWorksceneDeleteMethod,
  buildWorksceneEnterMethod,
  buildWorksceneExitMethod,
} from "./workscene.js";
import {
  buildScheduleListMethod,
  buildScheduleCreateMethod,
  buildScheduleUpdateMethod,
  buildScheduleDeleteMethod,
  buildScheduleRunMethod,
  buildScheduleAbortRunMethod,
} from "./schedule.js";
import {
  buildServerShutdownMethod,
  buildServerInfoMethod,
  buildLlmCompleteMethod,
} from "./server.js";
import { buildTrustListMethod, buildTrustRevokeMethod } from "./trust.js";
import {
  buildSkillListMethod,
  buildSkillSetStateMethod,
  buildSkillArchiveMethod,
} from "./skill.js";
import {
  buildMemoryJournalStatsMethod,
  buildMemoryPeopleListMethod,
} from "./memory.js";
import {
  buildConfirmationListMethod,
  buildConfirmationResolveMethod,
} from "./confirmation.js";

export interface BuiltinMethodsOptions {
  /** 后续阶段会注入更多依赖（scheduler 等） */
}

/**
 * 构建包含所有内置方法的 HandlerRegistry。
 * 调用方可继续 register 自定义方法。
 *
 * 注意：session.* 方法需要 ctx.server.conversations 被注入；scheduler.* 同理。
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
    buildSessionSubscribeMethod(),
    buildSessionUnsubscribeMethod(),
    buildSessionRenameMethod(),
    // session 命令执行体(cli 命令 handler 变薄后的宿主侧执行)
    buildSessionClearMethod(),
    buildSessionCompactMethod(),
    buildSessionContextBudgetMethod(),
    buildSessionNewMethod(),
    buildSessionResumeMethod(),
    buildSessionTaskListUpdateMethod(),
    buildSessionTaskListMethod(),
    // workscene.*（场景管理面 + 进出执行体）
    buildWorksceneListMethod(),
    buildWorksceneCreateMethod(),
    buildWorksceneRenameMethod(),
    buildWorksceneDeleteMethod(),
    buildWorksceneEnterMethod(),
    buildWorksceneExitMethod(),
    // schedule.*
    buildScheduleListMethod(),
    buildScheduleCreateMethod(),
    buildScheduleUpdateMethod(),
    buildScheduleDeleteMethod(),
    buildScheduleRunMethod(),
    buildScheduleAbortRunMethod(),
    // server.*（控制面：shutdown / info）+ llm 轻推理通道(可信面)
    buildServerShutdownMethod(),
    buildServerInfoMethod(),
    buildLlmCompleteMethod(),
    // trust.*（信任规则管理面）
    buildTrustListMethod(),
    buildTrustRevokeMethod(),
    // skill.*（技能库管理面 + 补全候选源,写后广播 skill.changed）
    buildSkillListMethod(),
    buildSkillSetStateMethod(),
    buildSkillArchiveMethod(),
    // memory.*（记忆域查看面,只读）
    buildMemoryJournalStatsMethod(),
    buildMemoryPeopleListMethod(),
    // confirmation.*（远程权限确认：list / resolve —— RPC 客户端用；pending/resolved 推送由 ConfirmationBridge 处理）
    buildConfirmationListMethod(),
    buildConfirmationResolveMethod(),
  ]);
  return registry;
}
