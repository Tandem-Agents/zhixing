/**
 * auth — 认证方法
 *
 * 流程：
 * 1. 客户端连接 WebSocket
 * 2. 客户端发 auth { token, client?: { id, version } }
 * 3. 服务端校验 token === ctx.server.token
 * 4. 通过 → connection.authenticated = true，返回 { protocol, server, capabilities }
 * 5. 不通过 → 返回 UNAUTHORIZED 错误，连接保持开启（客户端可重试）
 *
 * 设计要点：
 * - 时序攻击防护：用恒定时间比较 token（即使 MVP 风险低，也应该这么做）
 * - protocol 协商：当前 v1 单一版本，未来可基于 client.minProtocol/maxProtocol 协商
 * - capabilities 列出当前服务支持的能力（如 schedule、background、monitor）
 */

import { timingSafeEqual } from "node:crypto";
import type { MethodEntry } from "../handlers.js";
import { RpcErrors } from "../handlers.js";

const PROTOCOL_VERSION = 1;

interface AuthParams {
  token?: string;
  client?: {
    id?: string;
    version?: string;
  };
}

interface AuthResult {
  protocol: number;
  server: {
    version: string;
  };
  capabilities: string[];
}

export function buildAuthMethod(): MethodEntry {
  return {
    name: "auth",
    requiresAuth: false,
    handler(rawParams, ctx): AuthResult {
      const params = (rawParams ?? {}) as AuthParams;

      if (typeof params.token !== "string" || params.token.length === 0) {
        throw RpcErrors.invalidParams("auth requires a non-empty 'token' parameter");
      }

      if (!safeEqual(params.token, ctx.server.token)) {
        throw RpcErrors.unauthorized("Invalid token");
      }

      ctx.connection.authenticated = true;
      ctx.connection.clientInfo = params.client;

      return {
        protocol: PROTOCOL_VERSION,
        server: { version: ctx.server.version },
        // S2.C 阶段只有 auth/health；后续阶段动态扩展
        capabilities: collectCapabilities(ctx.server),
      };
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  // timingSafeEqual 要求两个 Buffer 长度相同
  // 长度不同时直接返回 false（不会泄露真实长度信息——攻击者已经知道发送了多少字节）
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  return timingSafeEqual(bufA, bufB);
}

function collectCapabilities(server: { scheduler?: unknown; conversations?: unknown }): string[] {
  const caps: string[] = [];
  if (server.conversations) caps.push("session");
  if (server.scheduler) caps.push("schedule");
  return caps;
}
