/**
 * confirmation.* RPC 方法 —— RPC 接入面与 ConfirmationHub 的操作入口
 *
 * 方法：
 *   - `confirmation.list`：列出当前连接可见的 pending（按 observer 过滤）
 *   - `confirmation.resolve`：应答一个 pending——**仅发起接入面可答**
 *     (entry 的 turnOrigin.triggeredBy 与 caller 连接匹配),旁观 observer
 *     可见不可代答;decision 能力按接入面信任级分级(见白名单注释)
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
 * ConfirmationDecision.kind 白名单——按接入面信任级分级。
 *
 * 信任边界在身份而非传输形态:cli 收编后本机接入面同样经 RPC,"进程内 = 可信"
 * 的旧前提不复存在。trusted = authenticated(持 home 凭证)+ loopback(本机)——
 * 可信面可提交完整决策(含持久授权,统一沉淀宿主 permissionStore);非可信面
 * 维持受限白名单,"远程不得沉淀永久规则"的安全意图在身份模型下完整保留
 * (远程接入面的可信身份模型留待真实需求)。
 *
 * 两级都不包含 cancelled / expired / edit-then-allow：
 *   - cancelled / expired 不是用户决策——由 broker 内部产生
 *   - edit-then-allow：需要改工具输入，远程 UX 未设计
 *
 * 自由文本拒绝：通过 `{ kind: "deny", reason: "..." }` 表达——RPC 客户端传 reason
 * 即可把理由回流给 AI，无需独立 kind。
 */
const RESTRICTED_KINDS: ReadonlySet<ConfirmationDecision["kind"]> = new Set([
  "allow-once",
  "deny",
]);

const TRUSTED_KINDS: ReadonlySet<ConfirmationDecision["kind"]> = new Set([
  "allow-once",
  "deny",
  "allow-session",
  "allow-context",
  "allow-global",
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

      // ── 2. kind 白名单——按接入面信任级分级 ──
      //   trusted = authenticated(requiresAuth 已保证)+ loopback(本机)。
      const trusted = ctx.connection.authenticated && ctx.connection.loopback;
      const allowedKinds = trusted ? TRUSTED_KINDS : RESTRICTED_KINDS;
      if (!allowedKinds.has(params.decision.kind as ConfirmationDecision["kind"])) {
        throw RpcErrors.invalidParams(
          `confirmation.resolve does not support kind "${params.decision.kind}" for this surface (allowed: ${[...allowedKinds].join(", ")})`,
        );
      }

      // ── 2b. decision 结构校验——坏结构在边界拒绝,pending 保持未解决 ──
      //   持久授权决策缺 pattern 若放行,会在执行侧读 pattern 时延迟成运行期
      //   异常,而 pending 已被消费(不可逆)。
      validateDecisionShape(params.decision);

      const hub = requireHub(ctx.server);

      // ── 3. 应答权——仅发起接入面可答 ──
      //   先查 entry——未找到直接回 "already-resolved-or-not-found"。
      //   确认是可执行控制:旁观 observer 可见(list / pending 推送)不可代答,
      //   跟随权由结构保证——entry 的 turnOrigin 必须是 RPC 入口且发起连接
      //   就是 caller。渠道(飞书)turn 的确认在渠道侧应答,RPC caller 非
      //   发起面;ephemeral(定时任务)确认无 RPC 发起者,同样拒绝。
      const entry = hub.findEntry(params.requestId);
      if (!entry) {
        return { ok: false, reason: "already-resolved-or-not-found" };
      }

      const callerId = String(ctx.connection.id);
      const origin = entry.request.turnOrigin;
      if (origin?.channel !== "rpc" || origin.triggeredBy !== callerId) {
        throw RpcErrors.unauthorized(
          "Only the originating surface may resolve this confirmation",
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

/**
 * decision 的 runtime 结构校验——kind 白名单之后的第二道边界。
 * 持久授权(allow-session / context / global)必须携带合法 SuggestedPattern
 * ({ pattern: { tool, argument }, label });deny 的 reason 若有须为字符串。
 */
function validateDecisionShape(decision: {
  kind: string;
  [key: string]: unknown;
}): void {
  if (
    decision.kind === "allow-session" ||
    decision.kind === "allow-context" ||
    decision.kind === "allow-global"
  ) {
    const pattern = decision.pattern as
      | { pattern?: { tool?: unknown; argument?: unknown }; label?: unknown }
      | undefined;
    const inner = pattern?.pattern;
    const valid =
      !!inner &&
      typeof inner.tool === "string" &&
      inner.tool.length > 0 &&
      typeof inner.argument === "string" &&
      typeof pattern.label === "string";
    if (!valid) {
      throw RpcErrors.invalidParams(
        `confirmation.resolve kind "${decision.kind}" requires pattern { pattern: { tool, argument }, label }`,
      );
    }
  }
  if (decision.kind === "deny" && decision.reason !== undefined) {
    if (typeof decision.reason !== "string") {
      throw RpcErrors.invalidParams(
        "confirmation.resolve deny 'reason' must be a string when provided",
      );
    }
  }
}

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
