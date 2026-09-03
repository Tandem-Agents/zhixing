import {
  assertLocalConversationIdForDevice,
  isNonEmptyUserTurnInput,
  userTurnInputFromText,
  type UserTurnInput,
} from "@zhixing/core";
import {
  ConversationApplicationError,
  mergeConversationDirectoryViews,
  type ConversationDirectoryApplication,
  type ConversationDirectoryEntry,
} from "@zhixing/core/conversation/application";
import { createConversationResolutionFence } from "@zhixing/owner-kernel/conversation-control";
import { canonicalize, isProtocolIdentifier } from "@zhixing/core/protocol";
import type {
  SessionConversationEntry,
  SessionListResult,
  SessionNewResult,
  SessionResumeResult,
  SessionTaskListResult,
  SessionTaskListUpdateResult,
} from "@zhixing/rpc";
import {
  RPC_ERROR_CODES,
  RpcAppError,
  RpcErrors,
  requireRpcSurfacePrincipal,
  type FirstPartyConversationRpcRouter,
} from "@zhixing/server";
import type { LocalConversationOwnerPort } from "./local-conversation-owner.js";
import {
  FirstPartyConversationMeshClient,
  isCurrentAnchorRelayMethod,
  type FirstPartyIngressConnection,
} from "./first-party-conversation-mesh.js";
import { createLocalConversationDirectoryApplication } from "./local-conversation-directory-application.js";

export const LOCAL_CONVERSATION_RPC_METHODS = Object.freeze([
  "session.abort",
  "session.advancementCancel",
  "session.advancementConfirm",
  "session.advancementDetail",
  "session.advancementRevise",
  "session.clear",
  "session.compact",
  "session.contextBudget",
  "session.delete",
  "session.history",
  "session.list",
  "session.new",
  "session.rename",
  "session.resolve",
  "session.resume",
  "session.security",
  "session.send",
  "session.subscribe",
  "session.taskList",
  "session.taskListUpdate",
  "session.unsubscribe",
  "session.usage",
  "confirmation.list",
  "confirmation.resolve",
] as const);

const LOCAL_METHODS = new Set<string>(LOCAL_CONVERSATION_RPC_METHODS);

/** executor-only 第一方入口：只覆盖已冻结的 session 方法，不接管其它 RPC。 */
export class LocalConversationRpcRouter
  implements FirstPartyConversationRpcRouter
{
  readonly #observers = new Map<string, Map<number, FirstPartyConnection>>();
  readonly #connections = new Map<number, () => void>();
  readonly #remote = new Map<string, FirstPartyConversationMeshClient>();
  readonly #application: ConversationDirectoryApplication;

  constructor(
    private readonly input: {
      readonly deviceId: string;
      readonly owner: LocalConversationOwnerPort;
      readonly remoteFor: (deviceId: string) => FirstPartyConversationMeshClient;
    },
  ) {
    this.#application = createLocalConversationDirectoryApplication({
      owner: input.owner,
      observerCount: (conversationId) =>
        this.#observers.get(conversationId)?.size ?? 0,
    });
    input.owner.subscribeConversationFacts((fact) => {
      this.#notify(fact.conversationId, "session.changed", {
        conversationId: fact.conversationId,
        change: fact.kind === "conversation-cleared" ? "cleared" : "deleted",
      });
      if (fact.kind === "conversation-deleted") {
        this.#observers.delete(fact.conversationId);
      }
    });
  }

  async dispatch(input: {
    readonly method: string;
    readonly params: unknown;
    readonly connection: FirstPartyConnection;
    readonly dispatchCanonical?: () => Promise<unknown>;
  }): Promise<
    | { readonly handled: false }
    | { readonly handled: true; readonly result: unknown }
  > {
    if (!LOCAL_METHODS.has(input.method)) return { handled: false };
    this.#trackConnection(input.connection);
    try {
      const routed = await this.#routeCurrentOwner(
        input.method,
        input.params,
        input.connection,
        input.dispatchCanonical,
      );
      if (routed.handled) return routed;
      return {
        handled: true,
        result: await this.#handle(input.method, input.params, input.connection),
      };
    } catch (error) {
      if (error instanceof RpcAppError) throw error;
      throw new RpcAppError(
        RPC_ERROR_CODES.INTERNAL_ERROR,
        "这次操作没有完成，请稍后重试；已保存的内容不会丢失。",
      );
    }
  }

  async #routeCurrentOwner(
    method: string,
    rawParams: unknown,
    connection: FirstPartyConnection,
    dispatchCanonical?: () => Promise<unknown>,
  ): Promise<
    | { readonly handled: false }
    | { readonly handled: true; readonly result: unknown }
  > {
    const params = objectParams(rawParams);
    if (method === "session.list") {
      return { handled: true, result: await this.#listAllOwners(connection) };
    }
    if (method === "session.new") return { handled: false };
    if (method === "confirmation.list" && params.conversationId === undefined) {
      return {
        handled: true,
        result: await this.#listAllConfirmations(connection, dispatchCanonical),
      };
    }
    const value = params.conversationId ?? params.sessionId;
    if (typeof value !== "string") {
      if (method === "confirmation.resolve") {
        throw RpcErrors.invalidParams(
          "confirmation.resolve requires 'conversationId' from the pending item",
        );
      }
      return { handled: false };
    }
    const conversationId = this.#conversationId(params, method);
    const authority = await this.input.owner.currentAuthority(conversationId);
    if (
      authority.state === "current" &&
      authority.deviceId === this.input.deviceId
    ) {
      if (method.startsWith("confirmation.")) {
        if (!dispatchCanonical) {
          throw new Error("Canonical confirmation dispatch is unavailable");
        }
        return { handled: true, result: await dispatchCanonical() };
      }
      return { handled: false };
    }
    if (authority.state === "frozen" || authority.state === "importing") {
      throw RpcErrors.busy(
        "这个对话正在安全接管中，请稍后重试；已保存内容不会丢失。",
      );
    }
    if (authority.deviceId === this.input.deviceId) {
      throw RpcErrors.notFound("这个对话已不可用，请从列表中重新选择。");
    }
    const result = await this.#remoteFor(authority.deviceId).dispatch(
      method,
      { ...params, conversationId },
      connection,
    );
    if (method === "session.resume" || method === "session.subscribe") {
      this.#subscribe(conversationId, connection);
    } else if (method === "session.unsubscribe") {
      this.#observers.get(conversationId)?.delete(connection.id);
    }
    return { handled: true, result };
  }

  async #listAllOwners(connection: FirstPartyConnection): Promise<SessionListResult> {
    const local = await this.#list();
    const routes = await this.input.owner.listConversationAuthorities();
    const byDevice = new Map<string, Set<string>>();
    for (const route of routes) {
      if (
        route.authority.deviceId === this.input.deviceId ||
        route.authority.state !== "fenced"
      ) continue;
      let ids = byDevice.get(route.authority.deviceId);
      if (!ids) {
        ids = new Set();
        byDevice.set(route.authority.deviceId, ids);
      }
      ids.add(route.conversationId);
    }
    const remoteEntries: ConversationDirectoryEntry[] = [];
    for (const [deviceId, ids] of byDevice) {
      const remote = await this.#remoteFor(deviceId).dispatch(
        "session.list",
        {},
        connection,
      ) as SessionListResult;
      remoteEntries.push(
        ...remote.conversations
          .filter((item) => ids.has(item.conversationId))
          .map(projectWireConversationEntry),
      );
    }
    const merged = mergeConversationDirectoryViews(
      {
        conversations: local.conversations.map(projectWireConversationEntry),
        ...(local.availability ? { availability: local.availability } : {}),
      },
      remoteEntries,
    );
    return {
      conversations: merged.conversations.map(projectDomainConversationEntry),
      ...(merged.availability ? { availability: merged.availability } : {}),
    };
  }

  async #listAllConfirmations(
    connection: FirstPartyConnection,
    dispatchCanonical?: () => Promise<unknown>,
  ): Promise<{
    readonly items: readonly unknown[];
  }> {
    if (!dispatchCanonical) {
      throw new Error("Canonical confirmation dispatch is unavailable");
    }
    const local = await dispatchCanonical() as { readonly items?: readonly unknown[] };
    const byDevice = new Map<string, string[]>();
    for (const [conversationId, observers] of this.#observers) {
      if (!observers.has(connection.id)) continue;
      const authority = await this.input.owner.currentAuthority(conversationId);
      if (authority.deviceId === this.input.deviceId || authority.state !== "fenced") continue;
      const values = byDevice.get(authority.deviceId) ?? [];
      values.push(conversationId);
      byDevice.set(authority.deviceId, values);
    }
    const items: unknown[] = [...(local.items ?? [])];
    for (const [deviceId, conversationIds] of [...byDevice].sort(([a], [b]) => a.localeCompare(b, "en-US"))) {
      for (const conversationId of conversationIds.sort()) {
        const result = await this.#remoteFor(deviceId).dispatch(
          "confirmation.list",
          { conversationId },
          connection,
        ) as { readonly items?: readonly unknown[] };
        items.push(...(result.items ?? []));
      }
    }
    items.sort((left, right) => confirmationItemKey(left).localeCompare(
      confirmationItemKey(right),
      "en-US",
    ));
    return { items };
  }

  #remoteFor(deviceId: string): FirstPartyConversationMeshClient {
    let client = this.#remote.get(deviceId);
    if (!client) {
      client = this.input.remoteFor(deviceId);
      this.#remote.set(deviceId, client);
    }
    return client;
  }

  async #handle(
    method: string,
    rawParams: unknown,
    connection: FirstPartyConnection,
  ): Promise<unknown> {
    const params = objectParams(rawParams);
    switch (method) {
      case "session.list":
        return this.#list();
      case "session.new": {
        requireContinuationConsent(params);
        return (await this.#application.create()) satisfies SessionNewResult;
      }
      case "session.resume": {
        requireContinuationConsent(params);
        const conversationId = this.#conversationId(params, method);
        const alreadySubscribed =
          this.#observers.get(conversationId)?.has(connection.id) ?? false;
        this.#subscribe(conversationId, connection);
        try {
          const resumed = await this.#application.resume({
            kind: "resume",
            conversationId,
            caller: {
              kind: "host",
              component: "local-conversation-rpc",
            },
          });
          return {
            conversationId: resumed.conversationId,
            name: resumed.name,
            active: resumed.active,
            busy: resumed.busy,
            ...(resumed.advancement
              ? { advancement: resumed.advancement }
              : {}),
            ...(resumed.adoptionReview
              ? { adoptionReview: resumed.adoptionReview }
              : {}),
          } satisfies SessionResumeResult;
        } catch (error) {
          if (
            error instanceof ConversationApplicationError &&
            error.code === "not-found" &&
            !alreadySubscribed
          ) {
            this.#observers.get(conversationId)?.delete(connection.id);
          }
          throw mapLocalConversationApplicationError(error, "resume");
        }
      }
      case "session.subscribe": {
        const conversationId = this.#conversationId(params, method);
        const exists = (await this.input.owner.listConversations()).includes(
          conversationId,
        );
        if (exists) this.#subscribe(conversationId, connection);
        return { subscribed: exists };
      }
      case "session.unsubscribe": {
        const conversationId = this.#conversationId(params, method);
        this.#observers.get(conversationId)?.delete(connection.id);
        return { unsubscribed: true };
      }
      case "session.history":
        return this.#history(params);
      case "session.send":
        return this.#send(params, connection);
      case "session.abort": {
        requireContinuationConsent(params);
        const conversationId = this.#conversationId(params, method);
        const requestId = requiredIdentifier(params.requestId, "取消请求");
        try {
          await this.#application.abort({
            kind: "abort",
            conversationId,
            operationId: requestId,
            caller: {
              kind: "surface",
              surfacePrincipal: requireRpcSurfacePrincipal(connection),
              connectionId: String(connection.id),
            },
          });
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "abort");
        }
        return undefined;
      }
      case "session.resolve": {
        const value = parseSessionResolve(params);
        try {
          return await this.#application.resolveUncertain({
            kind: "resolve-uncertain",
            conversationId: value.conversationId,
            runId: value.runId,
            operationId: value.requestId,
            resolutionFence: createConversationResolutionFence(value.ownerEpoch),
            openFactDigest: value.openFactDigest,
            decision: value.decision,
            caller: {
              kind: "surface",
              surfacePrincipal: requireRpcSurfacePrincipal(connection),
              connectionId: String(connection.id),
            },
          });
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "resolve");
        }
      }
      case "session.rename": {
        requireContinuationConsent(params);
        const conversationId = this.#conversationId(params, method);
        if (typeof params.name !== "string") {
          throw RpcErrors.invalidParams("对话名称不能为空。");
        }
        try {
          const renamed = await this.#application.rename({
            kind: "rename",
            conversationId,
            name: params.name,
          });
          this.#notify(conversationId, "session.changed", {
            conversationId,
            change: "renamed",
            name: renamed.fact.name,
          });
          return {
            conversationId: renamed.conversationId,
            name: renamed.name,
          };
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "rename");
        }
      }
      case "session.clear": {
        requireContinuationConsent(params);
        const conversationId = this.#conversationId(params, method);
        try {
          const cleared = await this.#application.clear({
            kind: "clear",
            conversationId,
            operationId: requiredIdentifier(params.requestId, "清空请求"),
            caller: {
              kind: "host",
              component: "local-conversation-rpc",
            },
          });
          return { cleared: cleared.cleared };
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "clear");
        }
      }
      case "session.delete": {
        requireContinuationConsent(params);
        const conversationId = this.#conversationId(params, method);
        try {
          await this.#application.delete({
            kind: "delete",
            conversationId,
            operationId: requiredIdentifier(params.requestId, "删除请求"),
            caller: {
              kind: "host",
              component: "local-conversation-rpc",
            },
          });
          return undefined;
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "delete");
        }
      }
      case "session.taskList": {
        const conversationId = this.#conversationId(params, method);
        try {
          return (await this.#application.queryTaskList({
            kind: "task-list",
            conversationId,
          })) satisfies SessionTaskListResult;
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "task-list");
        }
      }
      case "session.taskListUpdate":
        requireContinuationConsent(params);
        return this.#updateTaskList(params);
      case "session.advancementDetail": {
        const conversationId = this.#conversationId(params, method);
        return { conversationId, detail: null };
      }
      case "session.advancementCancel":
      case "session.advancementConfirm":
      case "session.advancementRevise":
        throw RpcErrors.busy(
          "这项确认当前暂不可处理；当前对话已保留，完整能力恢复后可继续。",
        );
      case "session.compact": {
        requireContinuationConsent(params);
        const conversationId = this.#conversationId(params, method);
        try {
          return await this.#application.compact({
            kind: "compact",
            conversationId,
          });
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "compact");
        }
      }
      case "session.contextBudget": {
        const conversationId = this.#conversationId(params, method);
        try {
          return await this.#application.queryContextBudget({
            kind: "context-budget",
            conversationId,
          });
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "context-budget");
        }
      }
      case "session.usage": {
        const conversationId = this.#conversationId(params, method);
        try {
          return await this.#application.queryUsage({
            kind: "usage",
            conversationId,
          });
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "usage");
        }
      }
      case "session.security": {
        const conversationId = this.#conversationId(params, method);
        try {
          return await this.#application.querySecurity({
            kind: "security",
            conversationId,
          });
        } catch (error) {
          throw mapLocalConversationApplicationError(error, "security");
        }
      }
      default:
        return undefined;
    }
  }

  async #list(): Promise<SessionListResult> {
    const view = await this.#application.queryList();
    return {
      conversations: view.conversations.map(projectDomainConversationEntry),
      ...(view.availability ? { availability: view.availability } : {}),
    };
  }

  async #history(params: Record<string, unknown>) {
    const conversationId = this.#conversationId(params, "session.history");
    const before = transcriptCursor(params.before);
    if (params.limit !== undefined && typeof params.limit !== "number") {
      throw RpcErrors.invalidParams("历史记录条数必须是正整数。");
    }
    try {
      return await this.#application.queryHistory({
        kind: "history",
        conversationId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(before ? { before } : {}),
      });
    } catch (error) {
      throw mapLocalConversationApplicationError(error, "history");
    }
  }

  async #send(
    params: Record<string, unknown>,
    connection: FirstPartyConnection,
  ) {
    requireContinuationConsent(params);
    const conversationId = this.#conversationId(params, "session.send");
    const turnId = requiredIdentifier(params.turnId, "消息");
    const input = normalizeInput(params);
    const caller = {
      kind: "surface" as const,
      surfacePrincipal: "surface:local:first-party",
      connectionId: String(connection.id),
    };
    const turnIdentity = this.#application.prepareAgentTurnIdentity({
      kind: "prepare-agent-turn-identity",
      turnId,
      identitySource: "provided",
      caller,
    });
    this.#subscribe(conversationId, connection);
    const turn = this.input.owner.createAgentTurnExecution({
      input,
      notify: (method, payload) => this.#notify(conversationId, method, payload),
    });
    let admitted;
    try {
      admitted = await this.#application.admitAgentTurn({
        kind: "admit-agent-turn",
        conversationId,
        input,
        turnIdentity,
        caller,
        execution: turn.execution,
      });
    } catch (error) {
      throw mapLocalConversationApplicationError(error, "send");
    }
    return {
      conversationId,
      sessionId: conversationId,
      turnId,
      ...(admitted.runId ? { runId: admitted.runId } : {}),
    };
  }

  async #updateTaskList(
    params: Record<string, unknown>,
  ): Promise<SessionTaskListUpdateResult> {
    const conversationId = this.#conversationId(params, "session.taskListUpdate");
    const requestId = requiredIdentifier(params.requestId, "任务更新");
    const action = objectParams(params.action);
    const domainAction = action.kind === "add" && typeof action.content === "string"
      ? { kind: "add" as const, content: action.content }
      : action.kind === "done" && typeof action.token === "string"
        ? { kind: "done" as const, token: action.token }
        : undefined;
    if (!domainAction) {
      throw RpcErrors.invalidParams("任务操作无效，请使用 /task new 或 /task done。");
    }
    try {
      const outcome = await this.#application.updateTaskList({
        kind: "update-task-list",
        conversationId,
        operationId: requestId,
        action: domainAction,
      });
      if (outcome.fact) {
        this.#notify(conversationId, "session.changed", {
          conversationId,
          change: "taskList",
          taskList: outcome.fact.taskList,
        });
      }
      return outcome.result;
    } catch (error) {
      throw mapLocalConversationApplicationError(error, "task-list");
    }
  }

  #conversationId(params: Record<string, unknown>, method: string): string {
    const value = params.conversationId ?? params.sessionId;
    if (typeof value !== "string") {
      throw RpcErrors.invalidParams(`${method} 缺少对话标识。`);
    }
    try {
      assertLocalConversationIdForDevice(value, this.input.deviceId);
    } catch {
      throw RpcErrors.notFound(
        "这个对话当前不可修改，请从列表中重新选择或在完整能力恢复后重试。",
      );
    }
    return value;
  }

  #subscribe(conversationId: string, connection: FirstPartyConnection): void {
    let observers = this.#observers.get(conversationId);
    if (!observers) {
      observers = new Map();
      this.#observers.set(conversationId, observers);
    }
    observers.set(connection.id, connection);
  }

  #notify(conversationId: string, method: string, params: unknown): void {
    for (const connection of this.#observers.get(conversationId)?.values() ?? []) {
      if (!connection.closed) connection.notify(method, params);
    }
  }

  #trackConnection(connection: FirstPartyConnection): void {
    if (this.#connections.has(connection.id)) return;
    const remove = connection.onClose(() => {
      this.#connections.delete(connection.id);
      for (const observers of this.#observers.values()) {
        observers.delete(connection.id);
      }
      for (const client of this.#remote.values()) void client.close(connection);
    });
    this.#connections.set(connection.id, remove);
  }
}

/** Executor-only composition selects exactly one owner before dispatch. */
export class ExecutorFirstPartyRpcRouter
  implements FirstPartyConversationRpcRouter
{
  constructor(private readonly input: {
    readonly local: FirstPartyConversationRpcRouter;
    readonly currentAnchor: FirstPartyConversationRpcRouter;
  }) {}

  dispatch(input: Parameters<FirstPartyConversationRpcRouter["dispatch"]>[0]) {
    if (LOCAL_METHODS.has(input.method)) return this.input.local.dispatch(input);
    if (isCurrentAnchorRelayMethod(input.method)) {
      return this.input.currentAnchor.dispatch(input);
    }
    return Promise.resolve({ handled: false } as const);
  }
}

interface FirstPartyConnection extends FirstPartyIngressConnection {
  readonly id: number;
  readonly closed: boolean;
  notify(method: string, params: unknown): void;
  onClose(handler: () => void): () => void;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RpcErrors.invalidParams("请求格式无效，请重试。");
  }
  return value as Record<string, unknown>;
}

function requireContinuationConsent(params: Record<string, unknown>): void {
  if (params.acceptLimitedCapabilities !== true) {
    throw RpcErrors.invalidParams("继续前请先明确接受当前会话能力限制。");
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  if (!isProtocolIdentifier(value)) {
    throw RpcErrors.invalidParams(`${label}缺少有效的请求标识。`);
  }
  return value;
}

function parseSessionResolve(params: Record<string, unknown>): {
  readonly requestId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly ownerEpoch: number;
  readonly openFactDigest: string;
  readonly decision:
    | "user-verified-side-effects"
    | "user-abandoned"
    | "user-retry-acknowledged";
} {
  const fields = [
    "requestId",
    "conversationId",
    "runId",
    "ownerEpoch",
    "openFactDigest",
    "decision",
  ];
  const decisions = new Set([
    "user-verified-side-effects",
    "user-abandoned",
    "user-retry-acknowledged",
  ]);
  if (
    Object.keys(params).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in params)) ||
    !isProtocolIdentifier(params.requestId) ||
    !isProtocolIdentifier(params.conversationId) ||
    !isProtocolIdentifier(params.runId) ||
    !Number.isSafeInteger(params.ownerEpoch) ||
    (params.ownerEpoch as number) < 0 ||
    typeof params.openFactDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(params.openFactDigest) ||
    typeof params.decision !== "string" ||
    !decisions.has(params.decision)
  ) {
    throw RpcErrors.invalidParams("session.resolve params are invalid");
  }
  return params as ReturnType<typeof parseSessionResolve>;
}

function projectDomainConversationEntry(
  entry: ConversationDirectoryEntry,
): SessionConversationEntry {
  return {
    conversationId: entry.conversationId,
    name: entry.name,
    createdAt: entry.createdAt,
    lastActiveAt: entry.lastActiveAt,
    active: entry.active,
    busy: entry.busy,
    observerCount: entry.observerCount,
    pendingCount: entry.pendingCount,
    ...(entry.advancement ? { advancement: entry.advancement } : {}),
  };
}

function projectWireConversationEntry(
  entry: SessionConversationEntry,
): ConversationDirectoryEntry {
  return {
    conversationId: entry.conversationId,
    name: entry.name,
    createdAt: entry.createdAt,
    lastActiveAt: entry.lastActiveAt,
    active: entry.active,
    busy: entry.busy,
    observerCount: entry.observerCount,
    pendingCount: entry.pendingCount,
    ...(entry.advancement ? { advancement: entry.advancement } : {}),
  };
}

function mapLocalConversationApplicationError(
  error: unknown,
  operation:
    | "history"
    | "resume"
    | "rename"
    | "clear"
    | "delete"
    | "abort"
    | "resolve"
    | "send"
    | "task-list"
    | "compact"
    | "context-budget"
    | "usage"
    | "security",
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(
      "当前可用会话中没有这个对话，请从列表中重新选择。",
    );
  }
  if (error.code === "busy") {
    return RpcErrors.busy(
      ((operation === "compact" && error.reason === "compact-unavailable") ||
        (operation === "context-budget" &&
          error.reason === "context-budget-unavailable") ||
        (operation === "usage" && error.reason === "usage-unavailable") ||
        (operation === "security" && error.reason === "security-unavailable"))
        ? "这项查看或维护暂不可用；你仍可继续当前对话，完整能力恢复后再试。"
        : operation === "send" && error.reason === "turn-queue-full"
          ? "Conversation has too many pending messages"
          : "这个对话正在处理其他操作，请稍后重试。",
    );
  }
  return RpcErrors.invalidParams(
    operation === "send"
      ? "消息缺少有效的请求标识。"
      : operation === "abort"
      ? "取消请求缺少有效的请求标识。"
      : operation === "resolve"
        ? "session.resolve params are invalid"
    : operation === "clear" || operation === "delete"
      ? operation === "clear"
        ? "清空请求缺少有效的请求标识。"
        : "删除请求缺少有效的请求标识。"
      : operation === "resume"
        ? "对话标识无效，请从列表中重新选择。"
      : operation === "rename"
      ? "对话名称不能为空。"
      : error.message.includes("cursor")
        ? "历史记录位置无效，请重新打开对话。"
        : "历史记录条数必须是正整数。",
  );
}

function normalizeInput(params: Record<string, unknown>): UserTurnInput {
  const value = typeof params.text === "string"
    ? userTurnInputFromText(params.text)
    : params.input;
  if (!isNonEmptyUserTurnInput(value)) {
    throw RpcErrors.invalidParams("消息不能为空。");
  }
  return value;
}

function transcriptCursor(value: unknown) {
  if (value === undefined) return undefined;
  const cursor = objectParams(value);
  if (
    cursor.shardId !== "owner-log" ||
    !Number.isSafeInteger(cursor.runIndex) ||
    (cursor.runIndex as number) < 0
  ) {
    throw RpcErrors.invalidParams("历史记录位置无效，请重新打开对话。");
  }
  return { shardId: "owner-log", runIndex: cursor.runIndex as number };
}

function confirmationItemKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `~:${canonicalize(value)}`;
  }
  const item = value as Record<string, unknown>;
  const conversationId = typeof item.conversationId === "string"
    ? item.conversationId
    : "";
  const requestId = typeof item.requestId === "string" ? item.requestId : "";
  return `${conversationId}:${requestId}:${canonicalize(value)}`;
}
