/**
 * health — 健康检查方法（RPC 版）
 *
 * 与 REST GET /api/health 等价，但通过 WebSocket 连接调用。
 * 客户端连接后可以用此方法做心跳探测（虽然 ws 已有 ping/pong，应用层探测可附加业务信息）。
 *
 * 不需要认证：未通过 auth 的连接也可以用 health 探测服务是否可达。
 */

import type { MethodEntry } from "../handlers.js";
import type { HealthStatus } from "../../types.js";

export function buildHealthMethod(): MethodEntry {
  return {
    name: "health",
    requiresAuth: false,
    handler(_params, ctx): HealthStatus {
      return {
        status: "ok",
        version: ctx.server.version,
        uptime: Math.floor((Date.now() - ctx.server.startedAt) / 1000),
      };
    },
  };
}
