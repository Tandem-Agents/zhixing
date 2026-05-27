/**
 * confirmation.* RPC 方法 —— Web UI / IDE 客户端与 ConfirmationHub 的操作入口
 *
 * 参见 remote-confirmation-execution.md §3.9：
 *   - `confirmation.list`：列出当前连接可见的 pending（按 observer 过滤）
 *   - `confirmation.resolve`：解决一个 pending（Web UI 按钮点击用）
 *
 * 推送（不是方法）：
 *   - `confirmation.pending` / `confirmation.resolved` 由 ConfirmationBridge 推送
 *
 * 安全性：所有方法要求认证。`confirmation.list` 默认只返回当前连接作为 observer
 * 的会话；显式传 conversationId 时要求 caller 是该会话的 observer（否则过滤空）。
 */

import type { ConfirmationDecision, ConfirmationRequest } from "@zhixing/core";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import type { HubEntry } from "../../confirmation/hub.js";

/**
 * 远程 RPC 允许的 ConfirmationDecision.kind 白名单。
 *
 * 为什么不包含 allow-session / allow-workspace / allow-global：
 *   spec §2.2 明确"持久授权走本地 /trust 命令，远程路径不支持"——否则远程
 *   客户端可以一键批准后，在本地 PermissionStore 留下永久规则，绕过本地审计。
 *
 * 为什么不包含 cancelled / expired / edit-then-allow：
 *   - cancelled / expired 不是用户决策——由 broker 内部产生
 *   - edit-then-allow：需要改工具输入，远程 UX 未设计
 *
 * 自由文本拒绝：通过 `{ kind: "deny", reason: "..." }` 表达——RPC 客户端传 reason
 * 即可把理由回流给 AI，无需独立 kind。
 */
const REMOTE_ALLOWED_KINDS: ReadonlySet<ConfirmationDecision["kind"]> = new Set([
  "allow-once",
  "deny",
]);

// ─── list ───

interface ConfirmationListParams {
  /**
   * 可选——仅返回某会话的 pending。未提供时返回"当前连接作为 observer 的所有会话"的 pending。
   * 显式指定的 conversationId 也必须是当前连接的 observer（否则过滤为空）。
   */
  conversationId?: string;
}

interface ConfirmationListItem {
  requestId: string;
  conversationId?: string;
  tool: string;
  operationSummary: string;
  riskLevel?: string;
  expiresAt: number;
  turnOrigin?: unknown;
}

interface ConfirmationListResult {
  items: ConfirmationListItem[];
}

export function buildConfirmationListMethod(): MethodEntry {
  return {
    name: "confirmation.list",
    requiresAuth: true,
    handler(rawParams, ctx): ConfirmationListResult {
      const params = (rawParams ?? {}) as ConfirmationListParams;
      const hub = requireHub(ctx.server);
      const conversations = requireConversations(ctx.server);
      const connectionId = String(ctx.connection.id);

      const all = hub.listAllPending();
      let visible: HubEntry[];

      if (typeof params.conversationId === "string" && params.conversationId) {
        // 显式指定：仅当 caller 是该会话的 observer 才返回
        const observerIds = conversations.getObserverConnectionIds(
          params.conversationId,
        );
        if (!observerIds.has(connectionId)) {
          visible = [];
        } else {
          visible = all.filter((e) => e.conversationId === params.conversationId);
        }
      } else {
        // 未指定：返回"caller 是 observer 的所有会话"的 pending；ephemeral（无 convId）不暴露
        visible = all.filter((e) => {
          if (!e.conversationId) return false;
          const observerIds = conversations.getObserverConnectionIds(
            e.conversationId,
          );
          return observerIds.has(connectionId);
        });
      }

      return { items: visible.map(toListItem) };
    },
  };
}

// ─── resolve ───

interface ConfirmationResolveParams {
  requestId?: string;
  decision?: ConfirmationDecision;
}

interface ConfirmationResolveResult {
  ok: boolean;
  reason?: string;
}

export function buildConfirmationResolveMethod(): MethodEntry {
  return {
    name: "confirmation.resolve",
    requiresAuth: true,
    handler(rawParams, ctx): ConfirmationResolveResult {
      const params = (rawParams ?? {}) as ConfirmationResolveParams;

      // ── 1. 参数 shape ──
      if (typeof params.requestId !== "string" || !params.requestId) {
        throw RpcErrors.invalidParams("confirmation.resolve requires 'requestId'");
      }
      if (!params.decision || typeof params.decision !== "object") {
        throw RpcErrors.invalidParams("confirmation.resolve requires 'decision'");
      }
      if (typeof params.decision.kind !== "string") {
        throw RpcErrors.invalidParams(
          "confirmation.resolve decision must have 'kind'",
        );
      }

      // ── 2. kind 白名单（spec §2.2：远程路径不支持持久授权） ──
      if (!REMOTE_ALLOWED_KINDS.has(params.decision.kind as ConfirmationDecision["kind"])) {
        throw RpcErrors.invalidParams(
          `confirmation.resolve does not support kind "${params.decision.kind}" from remote (allowed: ${[...REMOTE_ALLOWED_KINDS].join(", ")})`,
        );
      }

      const hub = requireHub(ctx.server);
      const conversations = requireConversations(ctx.server);

      // ── 3. 权限校验 ──
      //   先查 entry——未找到直接回 "already-resolved-or-not-found"（此时也
      //   无 conversation 可查，权限无意义）。
      //   找到后根据 conversationId 判断：
      //     - 有 conversationId → caller 必须是 observer
      //     - 无 conversationId（ephemeral）→ MVP 拒绝远程 resolve，等 admin role 体系
      const entry = hub.findEntry(params.requestId);
      if (!entry) {
        return { ok: false, reason: "already-resolved-or-not-found" };
      }

      const callerId = String(ctx.connection.id);
      if (entry.conversationId) {
        const observerIds = conversations.getObserverConnectionIds(
          entry.conversationId,
        );
        if (!observerIds.has(callerId)) {
          throw RpcErrors.unauthorized(
            `Not an observer of conversation "${entry.conversationId}"`,
          );
        }
      } else {
        // ephemeral（scheduler 触发的 confirmation 等）——当前不允许远程 resolve
        throw RpcErrors.unauthorized(
          "Remote resolve of ephemeral confirmations is not permitted (requires admin role, not yet implemented)",
        );
      }

      // ── 4. 实际 resolve（race：权限校验后到 resolve 之间可能已被其它路径解决） ──
      const ok = hub.resolve(params.requestId, params.decision);
      if (!ok) {
        return { ok: false, reason: "already-resolved-or-not-found" };
      }
      return { ok: true };
    },
  };
}

// ─── 工具 ───

function requireHub(server: ServerContext) {
  if (!server.confirmationHub) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "ConfirmationHub not configured on server",
    );
  }
  return server.confirmationHub;
}

function requireConversations(server: ServerContext) {
  if (!server.conversations) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "ConversationManager not configured on server",
    );
  }
  return server.conversations;
}

function toListItem(entry: HubEntry): ConfirmationListItem {
  const req: ConfirmationRequest = entry.request;
  return {
    requestId: req.id,
    conversationId: entry.conversationId,
    tool: req.tool,
    operationSummary: req.display.title,
    riskLevel: req.decision?.riskLevel,
    expiresAt: req.expiresAt,
    turnOrigin: req.turnOrigin,
  };
}
