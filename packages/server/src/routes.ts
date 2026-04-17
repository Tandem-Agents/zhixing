/**
 * REST 端点
 *
 * 仅用于无状态查询。有状态操作（会话、调度、订阅）走 WebSocket + JSON-RPC。
 *
 * 端点列表：
 * - GET /api/health  → 服务存活探测（无需认证）
 * - GET /api/status  → 服务详细状态（无需认证，仅本地访问）
 *
 * 设计要点：
 * - 健康检查不依赖任何外部资源（即使 scheduler 未启动也返回 ok）
 * - 状态查询通过 ServerContext 拿运行时数据
 * - 所有响应都是 application/json
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.js";
import type { HealthStatus, ServerStatus } from "./types.js";

/**
 * 路由分发结果。返回 false 表示当前请求不属于 REST 端点（让上层路由继续匹配，如 WebSocket）。
 */
export function dispatchRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): boolean {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/api/health") {
    sendJson(res, 200, buildHealth(ctx));
    return true;
  }

  if (method === "GET" && url === "/api/status") {
    sendJson(res, 200, buildStatus(ctx));
    return true;
  }

  // /api/* 但未匹配 → 404 JSON
  if (url.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not Found", path: url });
    return true;
  }

  return false;
}

// ─── 端点实现 ───

function buildHealth(ctx: ServerContext): HealthStatus {
  return {
    status: "ok",
    version: ctx.version,
    uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
  };
}

function buildStatus(ctx: ServerContext): ServerStatus {
  const mem = process.memoryUsage();
  return {
    running: true,
    pid: process.pid,
    port: ctx.listenAddr?.port ?? ctx.config.port,
    host: ctx.listenAddr?.host ?? ctx.config.host,
    uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
    version: ctx.version,
    startedAt: new Date(ctx.startedAt).toISOString(),
    scheduler: ctx.scheduler
      ? {
          taskCount: ctx.scheduler.listTasks().length,
          activeTaskCount: ctx.scheduler.activeTaskCount,
        }
      : undefined,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
    },
  };
}

// ─── 工具 ───

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text).toString(),
  });
  res.end(text);
}
