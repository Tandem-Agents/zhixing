/**
 * server.* RPC 命名空间 —— 应用层控制面
 *
 * 作用：
 * 1. 提供跨平台 graceful shutdown 通道（Windows SIGTERM 等价 force-kill，
 *    必须走应用层 RPC 才能真正优雅）
 * 2. 承载 server.info / server.reload 等控制方法
 *
 * `server.shutdown` 先耐久 accepted 并完成安全收束，再触发进程清理；
 * RPC 响应只确认可重放的 ready-to-stop，不会把后台失败吞掉。
 */

import { isInternal } from "@zhixing/core";
import { isDeliveryItemId } from "@zhixing/core/delivery";
import { isProtocolIdentifier } from "@zhixing/core/protocol";
import type { ExecutionStatusNotice } from "@zhixing/core/contracts";
import { SESSION_NOTIFICATIONS } from "@zhixing/rpc";
import { RpcAppError, RpcErrors, type MethodEntry } from "../handlers.js";
import {
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  SUPPORTED_PROTOCOL_RANGE,
} from "../protocol.js";
import type { ServerShutdownStrategy } from "../../context.js";
import { requireRpcSurfacePrincipal } from "../surface-identity.js";

export interface ServerShutdownParams {
  requestId: string;
  reason?: string;
  timeoutMs?: number;
  strategy?: ServerShutdownStrategy;
}

export interface ServerShutdownResult {
  accepted: true;
  requestId: string;
  phase: "ready-to-stop";
  strategy: ServerShutdownStrategy;
  /** ISO timestamp；仅参考，实际完成时机取决于清理链 */
  estimatedCompleteAt: string;
}

interface RuntimeControlWorkItem {
  id: string;
  kind: "conversation" | "scheduler" | "delivery" | "schedule";
  label: string;
  count: number;
}

interface RuntimeControlSnapshot {
  accessSurfaces: {
    rpcConnections: number;
    currentConnectionId?: number;
    otherRpcConnections: number;
    channels: unknown[];
    liveChannels: unknown[];
  };
  activeWork: {
    count: number;
    cancellableCount: number;
    drainOnlyCount: number;
    cancellableWork: RuntimeControlWorkItem[];
    drainOnlyWork: RuntimeControlWorkItem[];
  };
  deferredWork: RuntimeControlWorkItem[];
  keepAliveWork: RuntimeControlWorkItem[];
}

/**
 * server.shutdown — 请求优雅停机。
 *
 * 需要认证（防止无凭据 RPC 踢掉服务）。
 */
export function buildServerShutdownMethod(): MethodEntry {
  return {
    name: "server.shutdown",
    requiresAuth: true,
    async handler(params, ctx): Promise<ServerShutdownResult> {
      if (!ctx.connection.loopback) {
        throw RpcErrors.invalidParams("server.shutdown 只能在当前设备本机执行");
      }
      const p = asRecord(params, "server.shutdown");
      const hasReason = Object.prototype.hasOwnProperty.call(p, "reason");
      const hasStrategy = Object.prototype.hasOwnProperty.call(p, "strategy");
      const hasTimeout = Object.prototype.hasOwnProperty.call(p, "timeoutMs");
      assertExactRecord(
        p,
        [
          "requestId",
          ...(hasReason ? ["reason"] : []),
          ...(hasStrategy ? ["strategy"] : []),
          ...(hasTimeout ? ["timeoutMs"] : []),
        ],
        "server.shutdown",
      );
      if (!isProtocolIdentifier(p.requestId)) {
        throw RpcErrors.invalidParams("server.shutdown requires a stable requestId");
      }
      const requestId = p.requestId;
      const reason = hasReason ? stableText(p.reason, "server.shutdown reason") : "rpc.server.shutdown";
      const timeoutMs = hasTimeout ? shutdownTimeoutMs(p.timeoutMs) : 30_000;
      const strategy = normalizeShutdownStrategy(p.strategy);
      const estimatedCompleteAt = shutdownEstimatedCompleteAt(timeoutMs);

      const trigger = ctx.server.requestShutdown;
      const lifecycle = ctx.server.lifecycleShutdown;
      if (!trigger || !lifecycle) {
        // startServer 未正常 resolve 时才可能——等价于 server 没启动成功
        throw RpcErrors.internal("server shutdown not wired yet");
      }

      const prepared = await (async () => {
        try {
          return await lifecycle.prepare({
            requestId,
            reason,
            strategy,
            timeoutMs,
          });
        } catch (error) {
          if (error instanceof RpcAppError) throw error;
          throw new RpcAppError(
            RPC_ERROR_CODES.INTERNAL_ERROR,
            "安全停机未完成",
            { action: "retry-same-request" },
          );
        }
      })();
      queueMicrotask(() => trigger(`${reason}:${strategy}`));

      return {
        accepted: true,
        requestId: prepared.requestId,
        phase: prepared.phase,
        strategy,
        estimatedCompleteAt,
      };
    },
  };
}

/**
 * server.info — 宿主状态权威视图(/status 与版本握手的数据源)。
 *
 * 使用 ctx 内建数据（startedAt / listenAddr / version / 活跃会话 / 连接数 /
 * 内存基线 / 工作区 / 日志路径），不读文件—— vs serve status 读文件可能
 * stale。protocol 供接入面做协议兼容判定(与 auth 握手同源)。
 */
export function buildServerInfoMethod(): MethodEntry {
  const finalityByConnection = new Map<
    number,
    { readonly close: () => void; readonly removeCloseListener: () => void }
  >();
  return {
    name: "server.info",
    // 状态视图含 workspace 路径 / 会话规模等运维信息——要求认证;
    // 握手前的协议兼容判定由 auth 响应自带的 protocol / version 覆盖。
    requiresAuth: true,
    async handler(params, ctx) {
      const conversations = ctx.server.conversations?.list() ?? [];
      const runtimeControl = buildRuntimeControlSnapshot(ctx);
      const statusAfter = parseStatusAfter(params);
      let deliveryStatus: ExecutionStatusNotice[] = [];
      let conversationStatus: ExecutionStatusNotice[] = [];
      let jobStatus: ExecutionStatusNotice[] = [];
      let deliveryStatusNext = statusAfter.delivery;
      let conversationStatusNext = statusAfter.conversations;
      let jobStatusNext = statusAfter.jobs;
      const schedulerNoticePage =
        (await ctx.server.runtimeControl?.schedulerNotices?.(statusAfter.scheduler)) ??
        { notices: [], nextRevision: statusAfter.scheduler };
      const recoveryBackup = await ctx.server.recoveryBackupStatus?.();
      const openFinality = ctx.server.runtimeControl?.openFirstPartyFinality;
      const hasStatusCursors =
        Object.keys(statusAfter.delivery).length > 0 ||
        statusAfter.conversations.length > 0 ||
        statusAfter.jobs.length > 0;
      if (openFinality && hasStatusCursors) {
        const current = finalityByConnection.get(ctx.connection.id);
        current?.removeCloseListener();
        current?.close();
        let live = false;
        const historical: ExecutionStatusNotice[] = [];
        const opened = await openFinality({
          lastSeen: [
            ...Object.entries(statusAfter.delivery).map(
              ([itemId, afterStatusRevision]) => ({
                subject: { execution: "delivery" as const, itemId },
                afterStatusRevision,
              }),
            ),
            ...statusAfter.conversations.map((cursor) => ({
              subject: {
                execution: "conversation" as const,
                conversationId: cursor.conversationId,
                runId: cursor.runId,
              },
              afterStatusRevision: cursor.afterStatusRevision,
            })),
            ...statusAfter.jobs.map((cursor) => ({
              subject: {
                execution: "job" as const,
                taskId: cursor.taskId,
                jobRunId: cursor.jobRunId,
              },
              afterStatusRevision: cursor.afterStatusRevision,
            })),
          ],
          onStatus: (notice) => {
            if (!live) {
              historical.push(notice);
              return;
            }
            const method = statusNotificationMethod(notice);
            if (ctx.connection.tryNotify) {
              if (!ctx.connection.tryNotify(method, notice)) {
                throw new Error(
                  "Authenticated finality connection cannot accept notifications",
                );
              }
              return;
            }
            if (ctx.connection.closed) {
              throw new Error(
                "Authenticated finality connection is already closed",
              );
            }
            ctx.connection.notify(method, notice);
          },
          onResyncRequired: () => {
            ctx.connection.close(1012, "finality-resync-required");
          },
        });
        live = true;
        const removeCloseListener = ctx.connection.onClose(() => {
          if (finalityByConnection.get(ctx.connection.id)?.close === opened.close) {
            finalityByConnection.delete(ctx.connection.id);
          }
          opened.close();
        });
        finalityByConnection.set(ctx.connection.id, {
          close: opened.close,
          removeCloseListener,
        });
        deliveryStatus = historical.filter(
          (notice) => notice.ref.execution === "delivery",
        );
        conversationStatus = historical.filter(
          (notice) => notice.ref.execution === "conversation",
        );
        jobStatus = historical.filter(
          (notice) => notice.ref.execution === "job",
        );
        deliveryStatusNext = Object.fromEntries(
          opened.next.flatMap((cursor) =>
            cursor.subject.execution === "delivery"
              ? [[cursor.subject.itemId, cursor.afterStatusRevision]]
              : [],
          ),
        );
        conversationStatusNext = opened.next.flatMap((cursor) =>
          cursor.subject.execution === "conversation"
            ? [{
                conversationId: cursor.subject.conversationId,
                runId: cursor.subject.runId,
                afterStatusRevision: cursor.afterStatusRevision,
              }]
            : [],
        );
        jobStatusNext = opened.next.flatMap((cursor) =>
          cursor.subject.execution === "job"
            ? [{
                taskId: cursor.subject.taskId,
                jobRunId: cursor.subject.jobRunId,
                afterStatusRevision: cursor.afterStatusRevision,
              }]
            : [],
        );
      } else {
        deliveryStatus = [
          ...((await ctx.server.runtimeControl?.deliveryStatus?.(
            statusAfter.delivery,
          )) ?? []),
        ];
        const conversationPage =
          (await ctx.server.runtimeControl?.conversationStatus?.(
            statusAfter.conversations,
          )) ?? { notices: [], next: [] };
        const jobPage =
          (await ctx.server.runtimeControl?.jobStatus?.(
            statusAfter.jobs,
          )) ?? { notices: [], next: [] };
        conversationStatus = [...conversationPage.notices];
        conversationStatusNext = conversationPage.next;
        jobStatus = [...jobPage.notices];
        jobStatusNext = jobPage.next;
      }
      return {
        version: ctx.server.version,
        protocol: PROTOCOL_VERSION,
        protocolRange: SUPPORTED_PROTOCOL_RANGE,
        pid: process.pid,
        port: ctx.server.listenAddr?.port ?? ctx.server.config.port,
        host: ctx.server.listenAddr?.host ?? ctx.server.config.host,
        startedAt: new Date(ctx.server.startedAt).toISOString(),
        uptimeSec: Math.floor((Date.now() - ctx.server.startedAt) / 1000),
        shutdownAvailable: !!ctx.server.requestShutdown,
        // 运维观测——占用红线的可见面(活跃会话 / 接入面连接 / 内存基线)
        activeConversations: conversations.length,
        busyConversations: conversations.filter((c) => c.busy).length,
        connectionCount: ctx.server.connectionCount?.() ?? 0,
        memoryRssBytes: process.memoryUsage().rss,
        // 宿主单点解析的工作区——接入面的 @ 补全 root 与路径展示取此值
        workspace: ctx.server.hostInfo?.workspace,
        logPath: ctx.server.hostInfo?.logPath,
        ...(recoveryBackup ? { recoveryBackup } : {}),
        // MCP 连接状态快照——/mcp 管理器的状态显示数据面(未装配为空)
        mcpServers: ctx.server.mcpStatuses?.() ?? [],
        // 社交通道状态快照——核心 ready 与外部通道 ready 分离，接入面据此给出真实反馈。
        channels: ctx.server.channels?.listStatuses() ?? [],
        accessSurfaces: runtimeControl.accessSurfaces,
        activeWork: runtimeControl.activeWork,
        deferredWork: runtimeControl.deferredWork,
        keepAliveWork: runtimeControl.keepAliveWork,
        deliveryStatus,
        deliveryStatusNext,
        conversationStatus,
        conversationStatusNext,
        jobStatus,
        jobStatusNext,
        schedulerNotices: schedulerNoticePage.notices,
        schedulerNoticeNext: schedulerNoticePage.nextRevision,
      };
    },
  };
}

export function buildDeliveryResolveMethod(): MethodEntry {
  return {
    name: "delivery.resolve",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = parseDeliveryResolveParams(rawParams);
      const resolve = ctx.server.runtimeControl?.resolveDelivery;
      if (!resolve) throw RpcErrors.internal("delivery resolution is not available");
      const surfacePrincipal = requireRpcSurfacePrincipal(ctx.connection);
      const connectionId = String(ctx.connection.id);
      if (
        !isProtocolIdentifier(surfacePrincipal) ||
        !isProtocolIdentifier(connectionId)
      ) {
        throw RpcErrors.invalidParams("authenticated delivery identity is invalid");
      }
      const principal = ctx.server.conversations?.durableControlPrincipal({
        surfacePrincipal,
        connectionId,
      });
      if (!principal) {
        throw RpcErrors.internal("durable control identity is not available");
      }
      return resolve({
        ...params,
        principal,
      });
    },
  };
}

export function buildServerUpdatePrepareMethod(): MethodEntry {
  return {
    name: "server.update.prepare",
    requiresAuth: true,
    async handler(params, ctx) {
      if (!ctx.connection.loopback) {
        throw RpcErrors.invalidParams("server.update.prepare 只能在当前设备本机执行");
      }
      const value = asRecord(params, "server.update.prepare");
      assertExactRecord(
        value,
        ["candidateManifestDigest", "requestId", "timeoutMs"],
        "server.update.prepare",
      );
      if (!isProtocolIdentifier(value.requestId)) {
        throw RpcErrors.invalidParams("server.update.prepare requires a stable requestId");
      }
      if (typeof value.candidateManifestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.candidateManifestDigest)) {
        throw RpcErrors.invalidParams("server.update.prepare candidate digest is invalid");
      }
      const timeoutMs = shutdownTimeoutMs(value.timeoutMs);
      const lifecycle = ctx.server.lifecycleUpgrade;
      const trigger = ctx.server.requestShutdown;
      if (!lifecycle || !trigger) throw RpcErrors.internal("server update is not available");
      const prepared = await lifecycle.prepare({
        requestId: value.requestId,
        candidateManifestDigest: value.candidateManifestDigest,
        timeoutMs,
      });
      queueMicrotask(() => trigger("program-update"));
      return prepared;
    },
  };
}

export function buildServerUpdateHealthMethod(): MethodEntry {
  return {
    name: "server.update.health",
    requiresAuth: true,
    async handler(params, ctx) {
      if (!ctx.connection.loopback) {
        throw RpcErrors.invalidParams("server.update.health 只能在当前设备本机执行");
      }
      parseEmptyParams(params, "server.update.health");
      const project = ctx.server.programUpdateHealth;
      if (!project) throw RpcErrors.internal("server update health is not available");
      return project();
    },
  };
}

export function buildServerUpdateStatusMethod(): MethodEntry {
  return {
    name: "server.update.status",
    requiresAuth: true,
    async handler(params, ctx) {
      parseEmptyParams(params, "server.update.status");
      const project = ctx.server.programUpdateStatus;
      if (!project) throw RpcErrors.internal("server update status is not available");
      return project();
    },
  };
}

export function buildServerUpdateConsumeNoticeMethod(): MethodEntry {
  return {
    name: "server.update.consumeNotice",
    requiresAuth: true,
    async handler(params, ctx) {
      const value = asRecord(params, "server.update.consumeNotice");
      assertExactRecord(value, ["noticeToken"], "server.update.consumeNotice");
      if (!isProtocolIdentifier(value.noticeToken)) {
        throw RpcErrors.invalidParams("server.update.consumeNotice noticeToken is invalid");
      }
      const consume = ctx.server.programUpdateConsumeNotice;
      if (!consume) {
        throw RpcErrors.internal("server update notice consumption is not available");
      }
      return consume(value.noticeToken);
    },
  };
}

export function buildDutyMigrationTargetsMethod(): MethodEntry {
  return {
    name: "dutyMigration.targets",
    requiresAuth: true,
    async handler(params, ctx) {
      parseEmptyParams(params, "dutyMigration.targets");
      const migration = ctx.server.dutyMigration;
      if (!migration) throw RpcErrors.internal("值班设备迁移当前不可用");
      return runDutyMigrationOperation("targets", async () => ({
        devices: await migration.targets(),
      }));
    },
  };
}

export function buildDutyMigrationPrepareMethod(): MethodEntry {
  return {
    name: "dutyMigration.prepare",
    requiresAuth: true,
    async handler(params, ctx) {
      const migration = ctx.server.dutyMigration;
      if (!migration) throw RpcErrors.internal("值班设备迁移当前不可用");
      const input = parseDutyMigrationParams(params, true);
      return runDutyMigrationOperation("prepare", () => migration.prepare(input));
    },
  };
}

export function buildDutyMigrationCommitMethod(): MethodEntry {
  return {
    name: "dutyMigration.commit",
    requiresAuth: true,
    async handler(params, ctx) {
      const migration = ctx.server.dutyMigration;
      if (!migration) throw RpcErrors.internal("值班设备迁移当前不可用");
      const input = parseDutyMigrationParams(params, false);
      return runDutyMigrationOperation("commit", () => migration.commit(input));
    },
  };
}

export function buildDutyMigrationCancelMethod(): MethodEntry {
  return {
    name: "dutyMigration.cancel",
    requiresAuth: true,
    async handler(params, ctx) {
      const migration = ctx.server.dutyMigration;
      if (!migration) throw RpcErrors.internal("值班设备迁移当前不可用");
      const input = parseDutyMigrationParams(params, false);
      return runDutyMigrationOperation("cancel", () => migration.cancel(input));
    },
  };
}

export function buildDeviceListMethod(): MethodEntry {
  return {
    name: "device.list",
    requiresAuth: true,
    async handler(params, ctx) {
      parseEmptyParams(params, "device.list");
      const lifecycle = ctx.server.deviceLifecycle;
      if (!lifecycle) throw RpcErrors.internal("设备管理当前不可用");
      return { devices: await lifecycle.list() };
    },
  };
}

export function buildDeviceRemoveMethod(): MethodEntry {
  return {
    name: "device.remove",
    requiresAuth: true,
    async handler(params, ctx) {
      const lifecycle = ctx.server.deviceLifecycle;
      if (!lifecycle) throw RpcErrors.internal("设备管理当前不可用");
      const input = parseDeviceRemovalStart(params);
      return runDeviceLifecycleOperation(() => lifecycle.remove(input));
    },
  };
}

export function buildDeviceContinueMethod(): MethodEntry {
  return {
    name: "device.continue",
    requiresAuth: true,
    async handler(params, ctx) {
      const lifecycle = ctx.server.deviceLifecycle;
      if (!lifecycle) throw RpcErrors.internal("设备管理当前不可用");
      const input = parseDeviceRemovalContinue(params);
      return runDeviceLifecycleOperation(() => lifecycle.continue(input));
    },
  };
}

export function buildDeviceStatusMethod(): MethodEntry {
  return {
    name: "device.status",
    requiresAuth: true,
    async handler(params, ctx) {
      const lifecycle = ctx.server.deviceLifecycle;
      if (!lifecycle) throw RpcErrors.internal("设备管理当前不可用");
      const input = parseDeviceRemovalIdentity(params);
      return { state: await lifecycle.status(input) ?? null };
    },
  };
}

export function buildAnchorUninstallPreflightMethod(): MethodEntry {
  return localAnchorUninstallMethod("server.uninstall.preflight", async (params, uninstall) => {
    assertExactRecord(asRecord(params, "server.uninstall.preflight"), [], "server.uninstall.preflight");
    return uninstall.preflight();
  });
}

export function buildAnchorUninstallBeginMethod(): MethodEntry {
  return localAnchorUninstallMethod("server.uninstall.begin", async (params, uninstall) => {
    const value = asRecord(params, "server.uninstall.begin");
    const requestId = stableText(value.requestId, "uninstall requestId");
    const operationId = stableText(value.operationId, "uninstall operationId");
    if (value.path === "migration") {
      assertExactRecord(value, ["operationId", "path", "requestId", "targetName", "transferId"], "server.uninstall.begin migration");
      return uninstall.begin({
        path: "migration",
        requestId,
        operationId,
        transferId: stableText(value.transferId, "uninstall transferId"),
        targetName: stableText(value.targetName, "duty device name"),
      });
    }
    if (value.path === "recovery-backup") {
      assertExactRecord(value, ["operationId", "path", "recoveryPackage", "requestId"], "server.uninstall.begin recovery backup");
      return uninstall.begin({
        path: "recovery-backup",
        requestId,
        operationId,
        recoveryPackage: recoveryPackageText(value.recoveryPackage),
      });
    }
    throw RpcErrors.invalidParams("永久卸载路径必须是 migration 或 recovery-backup");
  });
}

export function buildAnchorUninstallContinueMethod(): MethodEntry {
  return localAnchorUninstallMethod("server.uninstall.continue", async (params, uninstall) => {
    const value = asRecord(params, "server.uninstall.continue");
    assertExactRecord(value, ["confirmBackup", "operationId", "recoveryPackage"], "server.uninstall.continue");
    if (value.confirmBackup !== true) {
      throw RpcErrors.invalidParams("恢复备份卸载需要显式确认");
    }
    return uninstall.continue({
      operationId: stableText(value.operationId, "uninstall operationId"),
      confirmBackup: true,
      recoveryPackage: recoveryPackageText(value.recoveryPackage),
    });
  });
}

export function buildAnchorUninstallCancelMethod(): MethodEntry {
  return localAnchorUninstallMethod("server.uninstall.cancel", async (params, uninstall) => {
    const value = asRecord(params, "server.uninstall.cancel");
    assertExactRecord(value, ["operationId"], "server.uninstall.cancel");
    return uninstall.cancel({
      operationId: stableText(value.operationId, "uninstall operationId"),
    });
  });
}

export function buildAnchorUninstallStatusMethod(): MethodEntry {
  return localAnchorUninstallMethod("server.uninstall.status", async (params, uninstall) => {
    const value = asRecord(params, "server.uninstall.status");
    assertExactRecord(value, ["operationId"], "server.uninstall.status");
    return {
      state: await uninstall.status({
        operationId: stableText(value.operationId, "uninstall operationId"),
      }) ?? null,
    };
  });
}

function localAnchorUninstallMethod(
  name: string,
  operation: (
    params: unknown,
    uninstall: NonNullable<import("../../context.js").ServerContext["anchorUninstall"]>,
  ) => Promise<unknown>,
): MethodEntry {
  return {
    name,
    requiresAuth: true,
    async handler(params, ctx) {
      if (!ctx.connection.loopback) {
        throw RpcErrors.invalidParams("永久卸载只能在当前设备本机执行");
      }
      const uninstall = ctx.server.anchorUninstall;
      if (!uninstall) throw RpcErrors.internal("当前设备不支持永久卸载");
      try {
        return await operation(params, uninstall);
      } catch (error) {
        if (error instanceof RpcAppError) throw error;
        const detail = error instanceof Error ? error.message.toLowerCase() : "";
        if (/confirm|backup|target|ready/u.test(detail)) {
          throw RpcErrors.internal("请先选择可用的值班设备，或验证恢复备份后再继续");
        }
        if (/removal|busy|another/u.test(detail)) {
          throw RpcErrors.busy("请先完成正在进行的设备移除或卸载操作");
        }
        throw RpcErrors.internal("永久卸载尚未完成；安全进度已保留，请使用同一操作继续");
      }
    },
  };
}

function parseDeviceRemovalStart(params: unknown): {
  readonly requestId: string;
  readonly operationId: string;
  readonly targetName: string;
} {
  const value = asRecord(params, "device.remove");
  assertExactRecord(value, ["operationId", "requestId", "targetName"], "device.remove");
  return {
    targetName: stableText(value.targetName, "device name"),
    operationId: stableText(value.operationId, "device removal operationId"),
    requestId: stableText(value.requestId, "device removal requestId"),
  };
}

function parseDeviceRemovalIdentity(params: unknown): {
  readonly targetName: string;
} {
  const value = asRecord(params, "device lifecycle");
  assertExactRecord(value, ["targetName"], "device.status");
  return {
    targetName: stableText(value.targetName, "device name"),
  };
}

function parseDeviceRemovalContinue(params: unknown): {
  readonly targetName: string;
  readonly mode: "transfer" | "destroy" | "lost" | "cancel";
} {
  const value = asRecord(params, "device.continue");
  assertExactRecord(value, ["mode", "targetName"], "device.continue");
  const identity = { targetName: stableText(value.targetName, "device name") };
  if (
    value.mode !== "transfer" && value.mode !== "destroy" &&
    value.mode !== "lost" && value.mode !== "cancel"
  ) {
    throw RpcErrors.invalidParams("设备移除方式必须是 transfer、destroy、lost 或 cancel");
  }
  return { ...identity, mode: value.mode };
}

async function runDeviceLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RpcAppError) throw error;
    const detail = error instanceof Error ? error.message.toLowerCase() : "";
    if (/another|already|busy|owns/u.test(detail)) {
      throw RpcErrors.busy("已有设备移除正在进行，请继续或查询原操作");
    }
    if (/offline|unavailable|reconnect/u.test(detail)) {
      throw RpcErrors.internal("目标设备当前离线：可以等待它重新上线，或明确按失控设备撤销");
    }
    if (/conversation|authority/u.test(detail)) {
      throw RpcErrors.internal("目标设备仍有本地对话，需要先选择收编到值班设备或永久删除");
    }
    throw RpcErrors.internal("设备移除尚未完成；系统已保留安全进度，请使用同一操作继续");
  }
}

function asRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw RpcErrors.invalidParams(`${label} 参数必须是对象`);
  }
  return input as Record<string, unknown>;
}

function assertExactRecord(
  input: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(input).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw RpcErrors.invalidParams(`${label} 参数包含缺失或未知字段`);
  }
}

function stableText(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.length > 480) {
    throw RpcErrors.invalidParams(`${label} 无效`);
  }
  return input.trim();
}

function recoveryPackageText(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 16 * 1024 * 1024) {
    throw RpcErrors.invalidParams("恢复包无效");
  }
  return input;
}

type DutyMigrationOperation = "targets" | "prepare" | "commit" | "cancel";

async function runDutyMigrationOperation<T>(
  operation: DutyMigrationOperation,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RpcAppError) throw error;
    const detail = error instanceof Error ? error.message.toLowerCase() : "";
    if (/another|already.*progress|busy/u.test(detail)) {
      throw RpcErrors.busy("已有一项值班设备迁移正在进行，请先继续或取消现有迁移");
    }
    if (operation === "prepare") {
      if (/credential|secret|unlock/u.test(detail)) {
        throw RpcErrors.internal(
          "目标设备的本地配置尚未解锁，请先在目标设备启动知行并完成配置",
        );
      }
      if (/connect|offline|unavailable|timeout/u.test(detail)) {
        throw RpcErrors.internal(
          "暂时联系不上目标设备，请确认它在线且已与当前设备配对后重试",
        );
      }
      throw RpcErrors.internal(
        "目标设备尚未准备好，请确认它在线、已配对并完成值班配置后重试",
      );
    }
    if (operation === "commit") {
      throw RpcErrors.internal(
        "迁移暂时未完成。系统会保持安全状态，请确认两台设备在线后使用同一迁移编号继续",
      );
    }
    if (operation === "cancel") {
      if (/commit|install|tombstone|abort.*reject/u.test(detail)) {
        throw RpcErrors.invalidParams(
          "设备接管已经开始，不能取消；请继续完成本次迁移，之后可再次迁移",
        );
      }
      throw RpcErrors.internal(
        "取消结果暂时无法确认，请使用同一迁移编号重试；确认取消前不要重新发起迁移",
      );
    }
    throw RpcErrors.internal(
      "暂时无法读取可迁移设备，请确认当前值班设备运行正常后重试",
    );
  }
}

function parseDutyMigrationParams(
  raw: unknown,
  withTarget: true,
): { requestId: string; transferId: string; targetDeviceId: string };
function parseDutyMigrationParams(
  raw: unknown,
  withTarget: false,
): { requestId: string; transferId: string };
function parseDutyMigrationParams(raw: unknown, withTarget: boolean) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw RpcErrors.invalidParams("值班设备迁移参数必须是对象");
  }
  const value = raw as Record<string, unknown>;
  const fields = withTarget
    ? ["requestId", "transferId", "targetDeviceId"]
    : ["requestId", "transferId"];
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !isProtocolIdentifier(value[field]))
  ) {
    throw RpcErrors.invalidParams("值班设备迁移参数无效");
  }
  return withTarget
    ? {
        requestId: value.requestId as string,
        transferId: value.transferId as string,
        targetDeviceId: value.targetDeviceId as string,
      }
    : { requestId: value.requestId as string, transferId: value.transferId as string };
}

function parseEmptyParams(raw: unknown, method: string): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 0) {
    throw RpcErrors.invalidParams(`${method} params must be empty`);
  }
}

function parseDeliveryResolveParams(raw: unknown): {
  requestId: string;
  itemId: string;
  attempt: number;
  anchorEpoch: number;
  openFactDigest: string;
  decision: "user-verified-sent" | "abandon" | "retry-risk-ack";
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw RpcErrors.invalidParams("delivery.resolve params must be an object");
  }
  const value = raw as Record<string, unknown>;
  const fields = [
    "requestId",
    "itemId",
    "attempt",
    "anchorEpoch",
    "openFactDigest",
    "decision",
  ];
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in value)) ||
    !isProtocolIdentifier(value.requestId) ||
    !isDeliveryItemId(value.itemId) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) <= 0 ||
    !Number.isSafeInteger(value.anchorEpoch) ||
    (value.anchorEpoch as number) <= 0 ||
    typeof value.openFactDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.openFactDigest) ||
    !new Set(["user-verified-sent", "abandon", "retry-risk-ack"]).has(
      String(value.decision),
    )
  ) {
    throw RpcErrors.invalidParams("delivery.resolve params are invalid");
  }
  return value as ReturnType<typeof parseDeliveryResolveParams>;
}

function parseStatusAfter(
  params: unknown,
): {
  readonly delivery: Readonly<Record<string, number>>;
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly runId: string;
    readonly afterStatusRevision: number;
  }[];
  readonly jobs: readonly {
    readonly taskId: string;
    readonly jobRunId: string;
    readonly afterStatusRevision: number;
  }[];
  readonly scheduler: number;
} {
  if (params === undefined || params === null) {
    return { delivery: {}, conversations: [], jobs: [], scheduler: 0 };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    throw RpcErrors.invalidParams("server.info params must be an object");
  }
  const value = params as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "deliveryStatusAfter" &&
        key !== "conversationStatusAfter" &&
        key !== "jobStatusAfter" &&
        key !== "schedulerNoticeAfter",
    )
  ) {
    throw RpcErrors.invalidParams("server.info params contain unknown fields");
  }
  const delivery: Record<string, number> = {};
  const scheduler = value.schedulerNoticeAfter === undefined
    ? 0
    : value.schedulerNoticeAfter;
  if (!Number.isSafeInteger(scheduler) || (scheduler as number) < 0) {
    throw RpcErrors.invalidParams("schedulerNoticeAfter is invalid");
  }
  if (value.deliveryStatusAfter !== undefined) {
    if (
      value.deliveryStatusAfter === null ||
      typeof value.deliveryStatusAfter !== "object" ||
      Array.isArray(value.deliveryStatusAfter)
    ) {
      throw RpcErrors.invalidParams("deliveryStatusAfter must be an object");
    }
    for (const [itemId, revision] of Object.entries(
      value.deliveryStatusAfter as Record<string, unknown>,
    )) {
      if (
        !isDeliveryItemId(itemId) ||
        !Number.isSafeInteger(revision) ||
        (revision as number) < 0
      ) {
        throw RpcErrors.invalidParams("deliveryStatusAfter is invalid");
      }
      delivery[itemId] = revision as number;
    }
  }
  const conversations: Array<{
    conversationId: string;
    runId: string;
    afterStatusRevision: number;
  }> = [];
  if (value.conversationStatusAfter !== undefined) {
    if (!Array.isArray(value.conversationStatusAfter)) {
      throw RpcErrors.invalidParams("conversationStatusAfter must be an array");
    }
    if (value.conversationStatusAfter.length > 64) {
      throw RpcErrors.invalidParams("conversationStatusAfter exceeds 64 cursors");
    }
    const seen = new Set<string>();
    for (const entry of value.conversationStatusAfter) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw RpcErrors.invalidParams("conversationStatusAfter is invalid");
      }
      const cursor = entry as Record<string, unknown>;
      if (
        Object.keys(cursor).length !== 3 ||
        !isProtocolIdentifier(cursor.conversationId) ||
        !isProtocolIdentifier(cursor.runId) ||
        !Number.isSafeInteger(cursor.afterStatusRevision) ||
        (cursor.afterStatusRevision as number) < 0
      ) {
        throw RpcErrors.invalidParams("conversationStatusAfter is invalid");
      }
      const key = JSON.stringify([cursor.conversationId, cursor.runId]);
      if (seen.has(key)) {
        throw RpcErrors.invalidParams("conversationStatusAfter contains duplicate cursors");
      }
      seen.add(key);
      conversations.push({
        conversationId: cursor.conversationId as string,
        runId: cursor.runId as string,
        afterStatusRevision: cursor.afterStatusRevision as number,
      });
    }
  }
  const jobs: Array<{
    taskId: string;
    jobRunId: string;
    afterStatusRevision: number;
  }> = [];
  if (value.jobStatusAfter !== undefined) {
    if (!Array.isArray(value.jobStatusAfter)) {
      throw RpcErrors.invalidParams("jobStatusAfter must be an array");
    }
    if (value.jobStatusAfter.length > 64) {
      throw RpcErrors.invalidParams("jobStatusAfter exceeds 64 cursors");
    }
    const seen = new Set<string>();
    for (const entry of value.jobStatusAfter) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw RpcErrors.invalidParams("jobStatusAfter is invalid");
      }
      const cursor = entry as Record<string, unknown>;
      if (
        Object.keys(cursor).length !== 3 ||
        !isProtocolIdentifier(cursor.taskId) ||
        !isProtocolIdentifier(cursor.jobRunId) ||
        !Number.isSafeInteger(cursor.afterStatusRevision) ||
        (cursor.afterStatusRevision as number) < 0
      ) {
        throw RpcErrors.invalidParams("jobStatusAfter is invalid");
      }
      const key = JSON.stringify([cursor.taskId, cursor.jobRunId]);
      if (seen.has(key)) {
        throw RpcErrors.invalidParams("jobStatusAfter contains duplicate cursors");
      }
      seen.add(key);
      jobs.push({
        taskId: cursor.taskId as string,
        jobRunId: cursor.jobRunId as string,
        afterStatusRevision: cursor.afterStatusRevision as number,
      });
    }
  }
  return { delivery, conversations, jobs, scheduler: scheduler as number };
}

function statusNotificationMethod(notice: ExecutionStatusNotice): string {
  switch (notice.ref.execution) {
    case "conversation":
      return SESSION_NOTIFICATIONS.status;
    case "job":
      return "job.status";
    case "delivery":
      return "delivery.status";
  }
}

function normalizeShutdownStrategy(value: unknown): ServerShutdownStrategy {
  if (value === undefined) return "immediate";
  if (value === "immediate" || value === "drain" || value === "cancel") return value;
  throw RpcErrors.invalidParams(
    'server.shutdown strategy must be "immediate", "drain", or "cancel"',
  );
}

function shutdownTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw RpcErrors.invalidParams("server.shutdown timeoutMs must be a finite positive number");
  }
  return value;
}

function shutdownEstimatedCompleteAt(timeoutMs: number): string {
  const estimated = new Date(Date.now() + timeoutMs);
  if (!Number.isFinite(estimated.getTime())) {
    throw RpcErrors.invalidParams("server.shutdown timeoutMs cannot be represented as an ETA");
  }
  return estimated.toISOString();
}

function buildRuntimeControlSnapshot(
  ctx: Parameters<NonNullable<MethodEntry["handler"]>>[1],
): RuntimeControlSnapshot {
  const channels = ctx.server.channels?.listStatuses() ?? [];
  const liveChannels = channels.filter(
    (s) => s.state === "connected" || s.state === "connecting",
  );
  const rpcConnections = ctx.server.connectionCount?.() ?? 0;
  const currentConnectionId =
    typeof ctx.connection.id === "number" ? ctx.connection.id : undefined;
  const otherRpcConnections =
    currentConnectionId === undefined ? rpcConnections : Math.max(0, rpcConnections - 1);

  const cancellableWork: RuntimeControlWorkItem[] = [];
  for (const conversation of ctx.server.conversations?.list() ?? []) {
    const pendingCount = Number(conversation.pendingCount ?? 0);
    const count = (conversation.busy ? 1 : 0) + pendingCount;
    if (count <= 0) continue;
    cancellableWork.push({
      id: `conversation:${conversation.conversationId}`,
      kind: "conversation",
      label: conversation.conversationId,
      count,
    });
  }

  const runCount = ctx.server.scheduler?.activeTaskCount ?? 0;
  if (runCount > 0) {
    cancellableWork.push({
      id: "scheduler:runs",
      kind: "scheduler",
      label: "正在执行的定时任务",
      count: runCount,
    });
  }

  const deferredWork: RuntimeControlWorkItem[] = [];
  const deliveryStats = ctx.server.runtimeControl?.deliveryStats?.();
  const deferredCount = deliveryStats === undefined ? 0 : Math.max(0, deliveryStats.pending);
  if (deferredCount > 0) {
    deferredWork.push({
      id: "delivery:queue",
      kind: "delivery",
      label: "待投递消息",
      count: deferredCount,
    });
  }

  const keepAliveTasks =
    ctx.server.scheduler?.listTasks().filter((task) => task.enabled && !isInternal(task)) ??
    [];
  const keepAliveWork =
    keepAliveTasks.length > 0
      ? [
          {
            id: "scheduler:enabled",
            kind: "schedule" as const,
            label: "已启用定时任务",
            count: keepAliveTasks.length,
          },
        ]
      : [];

  const cancellableCount = sumCounts(cancellableWork);
  const drainOnlyWork: RuntimeControlWorkItem[] = [];
  const drainOnlyCount = sumCounts(drainOnlyWork);

  return {
    accessSurfaces: {
      rpcConnections,
      currentConnectionId,
      otherRpcConnections,
      channels,
      liveChannels,
    },
    activeWork: {
      count: cancellableCount + drainOnlyCount,
      cancellableCount,
      drainOnlyCount,
      cancellableWork,
      drainOnlyWork,
    },
    deferredWork,
    keepAliveWork,
  };
}

function sumCounts(items: readonly RuntimeControlWorkItem[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

// ─── llm.complete ───

interface LlmCompleteParams {
  prompt?: string;
  role?: unknown;
}

/**
 * llm.complete — 接入面的轻推理通道(单发文本,无对话历史)。
 *
 * 服务管理流程的小段推理(/mcp 接入向导的源解析 / 提取等),不是对话面——
 * 对话经 session.send。仅可信面(authenticated + loopback)可用:LLM 调用
 * 消耗用户配额,与 confirmation 持久授权同一信任判据。
 */
export function buildLlmCompleteMethod(): MethodEntry {
  return {
    name: "llm.complete",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<{ text: string }> {
      if (!(ctx.connection.authenticated && ctx.connection.loopback)) {
        throw RpcErrors.invalidParams(
          "llm.complete is only available to trusted (loopback) surfaces",
        );
      }
      const params = (rawParams ?? {}) as LlmCompleteParams;
      if (typeof params.prompt !== "string" || params.prompt.length === 0) {
        throw RpcErrors.invalidParams("llm.complete requires non-empty 'prompt'");
      }
      if (
        params.role !== undefined &&
        params.role !== "main" &&
        params.role !== "light"
      ) {
        throw RpcErrors.invalidParams(
          "llm.complete 'role' must be \"main\" or \"light\"",
        );
      }
      const complete = ctx.server.llmComplete;
      if (!complete) {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "LLM completion channel not configured on server",
        );
      }
      return { text: await complete(params.prompt, params.role) };
    },
  };
}
