/**
 * RpcManagementFacade —— cli 管理面命令(/trust /skills /journal /people /host)
 * 的 RPC 方法收口。
 *
 * 与会话 / 调度 facade 同纪律:方法域封装、不持连接;方法名字符串只在此一处,
 * 命令 handler 变薄后不散落 RPC 细节。各域返回形状以宿主方法实现为源,
 * 此处按消费面做最小结构声明。
 */

import type { ChannelStatus, PermissionRule, SkillMode } from "@zhixing/core";
import {
  RPC_ERROR_CODES,
  RpcClientError,
  type SessionSecurityResult,
} from "@zhixing/server";
import type { CoreHostLink } from "./core-host-connection.js";

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

export class RpcManagementFacade {
  constructor(private readonly link: CoreHostLink) {}

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

  async journalStats(): Promise<unknown> {
    const client = await this.link.getClient();
    const result = await client.request<{ stats: unknown }>(
      "memory.journalStats",
    );
    return result.stats;
  }

  async peopleList(): Promise<unknown[]> {
    const client = await this.link.getClient();
    const result = await client.request<{ people: unknown[] }>(
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
  async llmComplete(prompt: string, role?: "main" | "light"): Promise<string> {
    const client = await this.link.getClient();
    const result = await client.request<{ text: string }>("llm.complete", {
      prompt,
      role,
    });
    return result.text;
  }
}
