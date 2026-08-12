/**
 * RpcManagementFacade —— cli 管理面命令(/trust /skills /journal /people /host)
 * 的 RPC 方法收口。
 *
 * 与会话 / 调度 facade 同纪律:方法域封装、不持连接;方法名字符串只在此一处,
 * 命令 handler 变薄后不散落 RPC 细节。各域返回形状以宿主方法实现为源,
 * 此处按消费面做最小结构声明。
 */

import type {
  ChannelStatus,
  MemoryLogicalEntry,
  PermissionRule,
  SkillMode,
} from "@zhixing/core";
import {
  RPC_ERROR_CODES,
  RpcClientError,
} from "@zhixing/server";
import type { SessionSecurityResult } from "@zhixing/rpc";
import type { CoreHostRpcLink } from "./core-host-connection.js";

/** skill.list 条目——补全候选与管理器消费的最小面(宿主返回 SkillStore 全集) */
export interface SkillListEntry {
  id: string;
  name?: string;
  description?: string;
  pinned?: boolean;
  disabled?: boolean;
  mode?: SkillMode;
  [key: string]: unknown;
}

export interface SkillListResult {
  skills: SkillListEntry[];
  structuralVersion: number;
}

export type ServerShutdownStrategy = "immediate" | "drain" | "cancel";

export interface RuntimeControlWorkItem {
  id: string;
  kind: "conversation" | "scheduler" | "delivery" | "schedule";
  label: string;
  count: number;
}

export interface ServerAccessSurfaces {
  rpcConnections: number;
  currentConnectionId?: number;
  otherRpcConnections: number;
  channels: ChannelStatus[];
  liveChannels: ChannelStatus[];
}

export interface ServerActiveWork {
  count: number;
  cancellableCount: number;
  drainOnlyCount: number;
  cancellableWork: RuntimeControlWorkItem[];
  drainOnlyWork: RuntimeControlWorkItem[];
}

export interface ServerInfoResult {
  version: string;
  protocol: number;
  pid: number;
  port?: number;
  host?: string;
  startedAt: string;
  uptimeSec: number;
  activeConversations: number;
  busyConversations: number;
  connectionCount: number;
  memoryRssBytes: number;
  workspace?: string | null;
  logPath?: string;
  recoveryBackup?: {
    state: "not-configured" | "pending-verification" | "recoverable";
  };
  channels?: ChannelStatus[];
  accessSurfaces?: ServerAccessSurfaces;
  activeWork?: ServerActiveWork;
  deferredWork?: RuntimeControlWorkItem[];
  keepAliveWork?: RuntimeControlWorkItem[];
  [key: string]: unknown;
}

export interface ServerShutdownRequest {
  reason?: string;
  timeoutMs?: number;
  strategy?: ServerShutdownStrategy;
}

export interface DutyMigrationTarget {
  deviceId: string;
  displayName: string;
  ready: boolean;
  code?: "unavailable";
}

export interface DeviceRemovalCandidate {
  displayName: string;
  reachable: boolean;
}

export interface DeviceRemovalState {
  phase:
    | "waiting-for-device"
    | "needs-conversation-decision"
    | "moving-conversations"
    | "revoking-access"
    | "cleaning-device"
    | "removed"
    | "cancelled";
  conversations: string[];
  localData: "known" | "removed" | "unknown";
  credentialActions: string[];
}

export interface AnchorUninstallPreflight {
  migrationTargets: Array<{ displayName: string; ready: boolean }>;
  recoveryBackupReady: boolean;
}

export interface AnchorUninstallState {
  phase:
    | "choose-safe-path"
    | "moving-duty-device"
    | "backup-verified"
    | "retiring-device"
    | "ready-to-uninstall"
    | "uninstalled"
    | "cancelled";
  nextAction?: "choose-device" | "confirm-backup" | "continue";
}

export class RpcManagementFacade {
  constructor(private readonly link: CoreHostRpcLink) {}

  // ─── trust ───

  async trustList(conversationId?: string): Promise<PermissionRule[]> {
    const client = await this.link.getClient();
    const result = await client.request<{ rules: PermissionRule[] }>(
      "trust.list",
      { conversationId },
    );
    return result.rules;
  }

  async trustRevoke(ruleId: string, conversationId?: string): Promise<boolean> {
    const client = await this.link.getClient();
    try {
      const result = await client.request<{ revoked: boolean }>("trust.revoke", {
        ruleId,
        conversationId,
      });
      return result.revoked;
    } catch (err) {
      if (err instanceof RpcClientError && err.code === RPC_ERROR_CODES.NOT_FOUND) {
        return false;
      }
      throw err;
    }
  }

  async securityStatus(conversationId: string): Promise<SessionSecurityResult> {
    const client = await this.link.getClient();
    return client.request<SessionSecurityResult>("session.security", {
      conversationId,
    });
  }

  // ─── skill ───

  async skillList(): Promise<SkillListResult> {
    const client = await this.link.getClient();
    return client.request<SkillListResult>("skill.list");
  }

  async skillSetState(
    skillId: string,
    patch: { pinned?: boolean; disabled?: boolean; mode?: SkillMode },
  ): Promise<void> {
    const client = await this.link.getClient();
    await client.request("skill.setState", { skillId, ...patch });
  }

  async skillArchive(skillId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("skill.archive", { skillId });
  }

  /** 技能集结构变更推送(skill.changed,写后宿主广播)——补全候选刷新驱动。 */
  onSkillChanged(handler: (structuralVersion: number) => void): () => void {
    return this.link.onNotification("skill.changed", (p) => {
      const payload = p as { structuralVersion?: number };
      handler(payload.structuralVersion ?? 0);
    });
  }

  // ─── memory ───

  async profileGet(): Promise<MemoryLogicalEntry | null> {
    const client = await this.link.getClient();
    const result = await client.request<{ profile: MemoryLogicalEntry | null }>(
      "memory.profileGet",
    );
    return result.profile;
  }

  async journalStats(): Promise<unknown> {
    const client = await this.link.getClient();
    const result = await client.request<{ stats: unknown }>(
      "memory.journalStats",
    );
    return result.stats;
  }

  async peopleList(): Promise<MemoryLogicalEntry[]> {
    const client = await this.link.getClient();
    const result = await client.request<{ people: MemoryLogicalEntry[] }>(
      "memory.peopleList",
    );
    return result.people;
  }

  // ─── server ───

  async serverInfo(): Promise<ServerInfoResult> {
    const client = await this.link.getClient();
    return client.request<ServerInfoResult>("server.info");
  }

  /** 只读取当前已连接宿主状态；无连接时返回 null，不发现、不拉起。 */
  async serverInfoIfConnected(): Promise<ServerInfoResult | null> {
    const client = this.link.getConnectedClient?.();
    if (!client) return null;
    return client.request<ServerInfoResult>("server.info").catch(() => null);
  }

  async dutyMigrationTargets(): Promise<DutyMigrationTarget[]> {
    const client = await this.link.getClient();
    const result = await client.request<unknown>(
      "dutyMigration.targets",
    );
    return decodeDutyMigrationTargets(result);
  }

  async dutyMigrationPrepare(input: {
    requestId: string;
    transferId: string;
    targetDeviceId: string;
  }): Promise<{ stage: "ready" }> {
    const client = await this.link.getClient();
    return client.request<{ stage: "ready" }>("dutyMigration.prepare", input);
  }

  async dutyMigrationCommit(input: {
    requestId: string;
    transferId: string;
  }): Promise<{ stage: "completed" }> {
    const client = await this.link.getClient();
    return client.request<{ stage: "completed" }>("dutyMigration.commit", input);
  }

  async dutyMigrationCancel(input: {
    requestId: string;
    transferId: string;
  }): Promise<{ stage: "cancelled" }> {
    const client = await this.link.getClient();
    return client.request<{ stage: "cancelled" }>("dutyMigration.cancel", input);
  }

  async deviceList(): Promise<DeviceRemovalCandidate[]> {
    const client = await this.link.getClient();
    const result = await client.request<unknown>("device.list");
    return decodeDeviceRemovalCandidates(result);
  }

  async deviceRemove(input: {
    requestId: string;
    operationId: string;
    targetName: string;
  }): Promise<{ conversations: string[]; hasAcceptedWork: boolean }> {
    const client = await this.link.getClient();
    const result = await client.request<unknown>("device.remove", input);
    if (
      !isPlainRecord(result) ||
      !hasExactKeys(result, ["conversations", "hasAcceptedWork"]) ||
      !Array.isArray(result.conversations) ||
      result.conversations.some((value) => typeof value !== "string") ||
      typeof result.hasAcceptedWork !== "boolean"
    ) {
      throw new TypeError("Device removal preflight response is invalid");
    }
    return {
      conversations: result.conversations as string[],
      hasAcceptedWork: result.hasAcceptedWork,
    };
  }

  async deviceContinue(input: {
    targetName: string;
    mode: "transfer" | "destroy" | "lost" | "cancel";
  }): Promise<DeviceRemovalState> {
    const client = await this.link.getClient();
    return decodeDeviceRemovalState(await client.request<unknown>("device.continue", input));
  }

  async deviceStatus(input: {
    targetName: string;
  }): Promise<DeviceRemovalState | null> {
    const client = await this.link.getClient();
    const result = await client.request<unknown>("device.status", input);
    if (!isPlainRecord(result) || !hasExactKeys(result, ["state"])) {
      throw new TypeError("Device removal status response is invalid");
    }
    return result.state === null ? null : decodeDeviceRemovalState(result.state);
  }

  async anchorUninstallPreflight(): Promise<AnchorUninstallPreflight> {
    const client = await this.link.getClient();
    return decodeAnchorUninstallPreflight(
      await client.request<unknown>("server.uninstall.preflight"),
    );
  }

  async anchorUninstallBegin(input:
    | {
        path: "migration";
        requestId: string;
        operationId: string;
        transferId: string;
        targetName: string;
      }
      | {
          path: "recovery-backup";
          requestId: string;
          operationId: string;
          recoveryPackage: string;
        }): Promise<AnchorUninstallState> {
    const client = await this.link.getClient();
    return decodeAnchorUninstallState(
      await client.request<unknown>("server.uninstall.begin", input),
    );
  }

  async anchorUninstallContinue(input: {
    operationId: string;
    confirmBackup: true;
    recoveryPackage: string;
  }): Promise<AnchorUninstallState> {
    const client = await this.link.getClient();
    return decodeAnchorUninstallState(
      await client.request<unknown>("server.uninstall.continue", input),
    );
  }

  async anchorUninstallCancel(operationId: string): Promise<AnchorUninstallState> {
    const client = await this.link.getClient();
    return decodeAnchorUninstallState(
      await client.request<unknown>("server.uninstall.cancel", { operationId }),
    );
  }

  /** 请求宿主优雅退出(flush 落盘)——/config 热重载与运行控制共用通道。 */
  async serverShutdown(request?: string | ServerShutdownRequest): Promise<void> {
    const client = await this.link.getClient();
    const params =
      typeof request === "string" || request === undefined
        ? { reason: request }
        : request;
    await client.request("server.shutdown", params);
  }

  // ─── llm(可信面轻推理通道) ───

  /** 单发文本调用(无对话历史)——管理流程(/mcp 接入向导等)的小段推理。 */
  async llmComplete(
    prompt: string,
    role?: "main" | "light",
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw abortError(signal);
    const client = signal
      ? await abortable(this.link.getClient(), signal)
      : await this.link.getClient();
    const request = client.request<{ text: string }>("llm.complete", {
      prompt,
      role,
    });
    const result = signal ? await abortable(request, signal) : await request;
    return result.text;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function decodeDutyMigrationTargets(input: unknown): DutyMigrationTarget[] {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["devices"]) || !Array.isArray(input.devices)) {
    throw new TypeError("Duty-device migration target response is invalid");
  }
  return input.devices.map((candidate) => {
    if (!isPlainRecord(candidate)) {
      throw new TypeError("Duty-device migration target must be an object");
    }
    const keys = candidate.code === undefined
      ? ["deviceId", "displayName", "ready"]
      : ["code", "deviceId", "displayName", "ready"];
    if (
      !hasExactKeys(candidate, keys) ||
      typeof candidate.deviceId !== "string" ||
      typeof candidate.displayName !== "string" ||
      typeof candidate.ready !== "boolean" ||
      (candidate.code !== undefined && candidate.code !== "unavailable")
    ) {
      throw new TypeError("Duty-device migration target fields are invalid");
    }
    return Object.freeze({
      deviceId: candidate.deviceId,
      displayName: candidate.displayName,
      ready: candidate.ready,
      ...(candidate.code === undefined ? {} : { code: candidate.code }),
    });
  });
}

function decodeDeviceRemovalCandidates(input: unknown): DeviceRemovalCandidate[] {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["devices"]) || !Array.isArray(input.devices)) {
    throw new TypeError("Device list response is invalid");
  }
  return input.devices.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(candidate, ["displayName", "reachable"]) ||
      typeof candidate.displayName !== "string" ||
      typeof candidate.reachable !== "boolean"
    ) {
      throw new TypeError("Device list entry is invalid");
    }
    return { displayName: candidate.displayName, reachable: candidate.reachable };
  });
}

function decodeDeviceRemovalState(input: unknown): DeviceRemovalState {
  if (!isPlainRecord(input) || !hasExactKeys(input, [
    "conversations",
    "credentialActions",
    "localData",
    "phase",
  ])) {
    throw new TypeError("Device removal state is invalid");
  }
  const phases = new Set<DeviceRemovalState["phase"]>([
    "waiting-for-device",
    "needs-conversation-decision",
    "moving-conversations",
    "revoking-access",
    "cleaning-device",
    "removed",
    "cancelled",
  ]);
  if (
    typeof input.phase !== "string" ||
    !phases.has(input.phase as DeviceRemovalState["phase"]) ||
    (input.localData !== "known" && input.localData !== "removed" && input.localData !== "unknown") ||
    !Array.isArray(input.conversations) ||
    input.conversations.some((value) => typeof value !== "string") ||
    !Array.isArray(input.credentialActions) ||
    input.credentialActions.some((value) => typeof value !== "string")
  ) {
    throw new TypeError("Device removal state fields are invalid");
  }
  return {
    phase: input.phase as DeviceRemovalState["phase"],
    conversations: input.conversations as string[],
    localData: input.localData,
    credentialActions: input.credentialActions as string[],
  };
}

function decodeAnchorUninstallPreflight(input: unknown): AnchorUninstallPreflight {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ["migrationTargets", "recoveryBackupReady"]) ||
    typeof input.recoveryBackupReady !== "boolean" ||
    !Array.isArray(input.migrationTargets)
  ) {
    throw new TypeError("Uninstall preflight response is invalid");
  }
  const migrationTargets = input.migrationTargets.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(candidate, ["displayName", "ready"]) ||
      typeof candidate.displayName !== "string" ||
      typeof candidate.ready !== "boolean"
    ) {
      throw new TypeError("Uninstall migration target is invalid");
    }
    return { displayName: candidate.displayName, ready: candidate.ready };
  });
  return { migrationTargets, recoveryBackupReady: input.recoveryBackupReady };
}

function decodeAnchorUninstallState(input: unknown): AnchorUninstallState {
  if (!isPlainRecord(input)) throw new TypeError("Uninstall state is invalid");
  const keys = input.nextAction === undefined ? ["phase"] : ["nextAction", "phase"];
  if (!hasExactKeys(input, keys)) throw new TypeError("Uninstall state shape is invalid");
  const phases = new Set<AnchorUninstallState["phase"]>([
    "choose-safe-path",
    "moving-duty-device",
    "backup-verified",
    "retiring-device",
    "ready-to-uninstall",
    "uninstalled",
    "cancelled",
  ]);
  if (typeof input.phase !== "string" || !phases.has(input.phase as AnchorUninstallState["phase"])) {
    throw new TypeError("Uninstall phase is invalid");
  }
  if (
    input.nextAction !== undefined &&
    input.nextAction !== "choose-device" &&
    input.nextAction !== "confirm-backup" &&
    input.nextAction !== "continue"
  ) {
    throw new TypeError("Uninstall next action is invalid");
  }
  return {
    phase: input.phase as AnchorUninstallState["phase"],
    ...(input.nextAction === undefined
      ? {}
      : { nextAction: input.nextAction as AnchorUninstallState["nextAction"] }),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
