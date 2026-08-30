import { createHash } from "node:crypto";
import {
  assertLocalConversationIdForDevice,
  isNonEmptyUserTurnInput,
  userTurnInputFromText,
  type TaskItem,
  type TaskListState,
  type UserTurnInput,
} from "@zhixing/core";
import {
  ConversationApplicationError,
  mergeConversationDirectoryViews,
  type ConversationDirectoryApplication,
  type ConversationDirectoryEntry,
} from "@zhixing/core/conversation/application";
import type { AuthorityCallContext } from "@zhixing/core/contracts";
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
        "这次本机操作没有完成，请稍后重试；重新连接后会继续处理已保存的内容。",
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
        requireLocalConsent(params);
        return (await this.#application.create()) satisfies SessionNewResult;
      }
      case "session.resume": {
        requireLocalConsent(params);
        const conversationId = this.#conversationId(params, method);
        if (!(await this.input.owner.listConversations()).includes(conversationId)) {
          throw RpcErrors.notFound("这台电脑上没有这个对话，请从列表中重新选择。");
        }
        const meta = await this.input.owner.sessionState.readSessionMeta(
          conversationId,
          context(`resume:${conversationId}`),
        );
        this.#subscribe(conversationId, connection);
        return {
          conversationId,
          name: meta.name ?? "本机对话",
          active: false,
          busy: false,
        } satisfies SessionResumeResult;
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
        requireLocalConsent(params);
        const conversationId = this.#conversationId(params, method);
        const requestId = requiredIdentifier(params.requestId, "取消请求");
        await this.input.owner.cancelTurns({ conversationId, requestId });
        return undefined;
      }
      case "session.resolve": {
        const value = parseSessionResolve(params);
        return this.input.owner.resolveDurableUncertain({
          ...value,
          surfacePrincipal: requireRpcSurfacePrincipal(connection),
          connectionId: String(connection.id),
        });
      }
      case "session.rename": {
        requireLocalConsent(params);
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
        requireLocalConsent(params);
        const conversationId = this.#conversationId(params, method);
        await this.#mutate(
          conversationId,
          requiredIdentifier(params.requestId, "清空请求"),
          { kind: "window-op", op: "clear" },
        );
        this.#notify(conversationId, "session.changed", {
          conversationId,
          change: "cleared",
        });
        return { cleared: true };
      }
      case "session.delete": {
        requireLocalConsent(params);
        const conversationId = this.#conversationId(params, method);
        await this.#mutate(
          conversationId,
          requiredIdentifier(params.requestId, "删除请求"),
          { kind: "conversation-delete" },
        );
        this.#notify(conversationId, "session.changed", {
          conversationId,
          change: "deleted",
        });
        this.#observers.delete(conversationId);
        return undefined;
      }
      case "session.taskList": {
        const conversationId = this.#conversationId(params, method);
        return {
          taskList: await this.input.owner.sessionState.readTaskList(
            conversationId,
            context(`task-list:${conversationId}`),
          ),
        } satisfies SessionTaskListResult;
      }
      case "session.taskListUpdate":
        requireLocalConsent(params);
        return this.#updateTaskList(params);
      case "session.advancementDetail": {
        const conversationId = this.#conversationId(params, method);
        return { conversationId, detail: null };
      }
      case "session.advancementCancel":
      case "session.advancementConfirm":
      case "session.advancementRevise":
        throw RpcErrors.busy(
          "这项确认需要连接值班设备；当前对话已保留，可在重新连接后继续。",
        );
      case "session.compact":
      case "session.contextBudget":
      case "session.security":
      case "session.usage":
        throw RpcErrors.busy(
          "这项查看或维护暂不可用；你仍可继续本机对话，重新连接后再试。",
        );
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
    requireLocalConsent(params);
    const conversationId = this.#conversationId(params, "session.send");
    const turnId = requiredIdentifier(params.turnId, "消息");
    const input = normalizeInput(params);
    this.#subscribe(conversationId, connection);
    const admitted = await this.input.owner.admitTurn({
      conversationId,
      input,
      turnId,
      notify: (method, payload) => this.#notify(conversationId, method, payload),
    });
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
    const current = await this.input.owner.sessionState.readTaskList(
      conversationId,
      context(`task-list-read:${requestId}`),
    );
    let next: TaskListState;
    let message: string;
    if (action.kind === "add") {
      const content = nonEmptyText(action.content, "任务内容");
      const item: TaskItem = {
        id: stableRequest("task", { requestId, content }).slice(-32),
        content,
        status: "pending",
      };
      next = { items: [...current.items, item] };
      message = `✓ 添加：“${content}”`;
    } else if (action.kind === "done") {
      const token = nonEmptyText(action.token, "任务序号或标识");
      const target = locateTask(current.items, token);
      if (!target) {
        return {
          ok: false,
          message: `未找到任务：“${token}”。使用 /tasklist 查看当前列表。`,
          taskList: current,
        };
      }
      next = {
        items: current.items.map((item) =>
          item.id === target.id ? { ...item, status: "completed" as const } : item
        ),
      };
      message = `✓ 完成：“${target.content}”`;
    } else {
      throw RpcErrors.invalidParams("任务操作无效，请使用 /task new 或 /task done。");
    }
    await this.#mutate(conversationId, requestId, {
      kind: "task-list-op",
      op: { op: "set", state: next },
    });
    this.#notify(conversationId, "session.changed", {
      conversationId,
      change: "taskList",
      taskList: next,
    });
    return { ok: true, message, taskList: next };
  }

  async #mutate(
    conversationId: string,
    requestId: string,
    mutation: Parameters<LocalConversationOwnerPort["mutateSession"]>[1],
  ): Promise<void> {
    if (!(await this.input.owner.listConversations()).includes(conversationId)) {
      throw RpcErrors.notFound("这台电脑上没有这个对话，请从列表中重新选择。");
    }
    await this.input.owner.mutateSession(
      conversationId,
      mutation,
      context(requestId),
    );
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
        "这个对话目前无法在这台电脑修改，请连接值班设备后重试。",
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

function context(requestId: string): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "local-conversation-rpc" },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RpcErrors.invalidParams("请求格式无效，请重试。");
  }
  return value as Record<string, unknown>;
}

function requireLocalConsent(params: Record<string, unknown>): void {
  if (params.continueLocally !== true) {
    throw RpcErrors.invalidParams(
      "继续前请确认使用这台电脑新建或恢复本机对话。",
    );
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

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw RpcErrors.invalidParams(`${label}不能为空。`);
  }
  return value.trim();
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
  operation: "history" | "rename",
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(
      "这台电脑上没有这个对话，请从列表中重新选择。",
    );
  }
  return RpcErrors.invalidParams(
    operation === "rename"
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

function stableRequest(kind: string, payload: unknown): string {
  return `local-${kind}-${createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex")
    .slice(0, 32)}`;
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

function locateTask(items: readonly TaskItem[], token: string): TaskItem | undefined {
  if (/^\d+$/u.test(token)) {
    const index = Number.parseInt(token, 10) - 1;
    if (index >= 0 && index < items.length) return items[index];
  }
  const matches = items.filter((item) => item.id.startsWith(token));
  return matches.length === 1 ? matches[0] : undefined;
}
