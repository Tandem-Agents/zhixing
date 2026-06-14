/**
 * server.* RPC 命名空间 —— 应用层控制面
 *
 * 作用：
 * 1. 提供跨平台 graceful shutdown 通道（Windows SIGTERM 等价 force-kill，
 *    必须走应用层 RPC 才能真正优雅）
 * 2. 承载 server.info / server.reload 等控制方法
 *
 * `server.shutdown` 设计要点：
 * - **立即 ack**：handler 不 await 实际 shutdown，避免 RPC 自己被 shutdown 切断应答链
 * - **异步触发**：通过 ctx.server.requestShutdown hook 进入 lifecycle.shutdown()
 * - **防御性 null 检查**：requestShutdown 未绑定时抛 RpcErrors.internal
 */

import { RpcAppError, RpcErrors, type MethodEntry } from "../handlers.js";
import {
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  SUPPORTED_PROTOCOL_RANGE,
} from "../protocol.js";

export interface ServerShutdownParams {
  reason?: string;
  timeoutMs?: number;
}

export interface ServerShutdownResult {
  accepted: true;
  phase: "stopping";
  /** ISO timestamp；仅参考，实际完成时机取决于清理链 */
  estimatedCompleteAt: string;
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
    handler(params, ctx): ServerShutdownResult {
      const p = (params ?? {}) as ServerShutdownParams;
      const reason = (typeof p.reason === "string" && p.reason.trim()) || "rpc.server.shutdown";
      const timeoutMs = typeof p.timeoutMs === "number" && p.timeoutMs > 0 ? p.timeoutMs : 30_000;

      const trigger = ctx.server.requestShutdown;
      if (!trigger) {
        // startServer 未正常 resolve 时才可能——等价于 server 没启动成功
        throw RpcErrors.internal("server shutdown not wired yet");
      }

      // 立即返回 ack；shutdown 异步执行，handler 不 await
      // （await 会导致 RPC 连接自己被 server.close 切断，client 收不到响应）
      trigger(reason);

      return {
        accepted: true,
        phase: "stopping",
        estimatedCompleteAt: new Date(Date.now() + timeoutMs).toISOString(),
      };
    },
  };
}

/**
 * server.info — 宿主状态权威视图(/host 命令与版本握手的数据源)。
 *
 * 使用 ctx 内建数据（startedAt / listenAddr / version / 活跃会话 / 连接数 /
 * 内存基线 / 工作区 / 日志路径），不读文件—— vs serve status 读文件可能
 * stale。protocol 供接入面做协议兼容判定(与 auth 握手同源)。
 */
export function buildServerInfoMethod(): MethodEntry {
  return {
    name: "server.info",
    // 状态视图含 workspace 路径 / 会话规模等运维信息——要求认证;
    // 握手前的协议兼容判定由 auth 响应自带的 protocol / version 覆盖。
    requiresAuth: true,
    handler(_params, ctx) {
      const conversations = ctx.server.conversations?.list() ?? [];
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
        // MCP 连接状态快照——/mcp 管理器的状态显示数据面(未装配为空)
        mcpServers: ctx.server.mcpStatuses?.() ?? [],
      };
    },
  };
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
