/**
 * server.* RPC 命名空间 —— 应用层控制面
 *
 * 作用：
 * 1. 提供跨平台 graceful shutdown 通道（Windows SIGTERM 等价 force-kill，
 *    必须走应用层 RPC 才能真正优雅）
 * 2. 将来可扩展 server.info / server.reload 等控制方法（Step 18 / Step 20 预留）
 *
 * `server.shutdown` 设计要点：
 * - **立即 ack**：handler 不 await 实际 shutdown，避免 RPC 自己被 shutdown 切断应答链
 * - **异步触发**：通过 ctx.server.requestShutdown hook 进入 lifecycle.shutdown()
 * - **防御性 null 检查**：requestShutdown 未绑定时抛 RpcErrors.internal
 */

import { RpcErrors, type MethodEntry } from "../handlers.js";

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
 * server.info — 读取运行时摘要（state 文件 + PID 文件 + uptime）。
 *
 * 本 Level 使用 ctx 内建数据（startedAt / listenAddr / version），不读文件
 * —— 给状态查询一个可靠的 authoritative 视图（vs serve status 读文件可能 stale）。
 * 未来可扩展更多运维信息。
 */
export function buildServerInfoMethod(): MethodEntry {
  return {
    name: "server.info",
    requiresAuth: false, // 仅本地可达，info 不含敏感信息
    handler(_params, ctx) {
      return {
        version: ctx.server.version,
        pid: process.pid,
        port: ctx.server.listenAddr?.port ?? ctx.server.config.port,
        host: ctx.server.listenAddr?.host ?? ctx.server.config.host,
        startedAt: new Date(ctx.server.startedAt).toISOString(),
        uptimeSec: Math.floor((Date.now() - ctx.server.startedAt) / 1000),
        shutdownAvailable: !!ctx.server.requestShutdown,
      };
    },
  };
}
