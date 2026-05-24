/**
 * 连接层 McpHub —— 管理所有 MCP server 的连接，对上层只暴露"列工具 / 调工具 / 状态 / 关闭"。
 *
 * 职责单一、与集成层解耦：hub 只做连接 + 协议（SDK Client），产出中性的工具目录
 * 与一个 McpCallFn；把目录映射成知行 ToolDefinition 是映射层的事，hub 不反向依赖
 * 装配 / cli。
 *
 * 运行时韧性：已配置（启用）的 server 收敛到 connected —— 无论首次连接失败、首次 tools/list
 * 超时，还是连上后被对端断开，hub 都以指数退避在后台持续重试，连上即恢复，用户无需手动重连。
 * 最近一次失败原因记在状态里供面板展示。
 *
 * 空 server 列表时所有方法天然 no-op（connectAll 空跑、catalog 返回 []、callTool
 * 返回 isError、dispose 空），故 hub 引用恒非空、调用方无需任何判空分支。
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NetworkPolicy } from "@zhixing/network";
import {
  connectAndListTools,
  type ConnectedClient,
  type CreateTransportFn,
} from "./connect.js";
import { toToolResult } from "./result.js";
import { createTransport as defaultCreateTransport } from "./transport.js";
import type {
  McpCallFn,
  McpServerContext,
  McpServerSpec,
  McpToolDescriptor,
  McpTransportKind,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** 后台重连的退避：首次 1s，每次翻倍，封顶 30s 后等间隔无限重试（server 恢复即自愈）。 */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/** 一个已连接 server 暴露给上层的工具目录。 */
export interface McpServerCatalog {
  server: McpServerContext;
  tools: McpToolDescriptor[];
}

/**
 * 一个 server 的运行时状态快照 —— 供用户面板展示全量 server（含未连上、后台重试中的）。
 *
 * 与 `catalog()` 的区别：catalog 只返回 connected 的（喂给映射层装配工具），
 * serverStatuses 返回**所有**受管（启用）server 的运行态（含 connecting）。
 */
export interface McpServerStatus {
  serverId: string;
  transport: McpTransportKind;
  /** connected：工具可用；connecting：未连上、后台退避重试中（error 带最近一次失败原因）。 */
  status: "connected" | "connecting";
  /** 当前可用工具数（仅 connected 非 0）。 */
  toolCount: number;
  /** 最近一次连接失败原因（connecting 且曾失败时有；connected 时无）。 */
  error?: string;
}

export interface McpHub {
  /** 并发连接所有 server（单 server 失败被隔离、不阻塞其余）。装配前调用一次。 */
  connectAll(): Promise<void>;
  /**
   * 热重载：以新规格集增量调整连接 —— 新增的 connect、移除的 disconnect、规格变更的
   * 重连（先断后连）、未变的保持不动。供配置变更时调用，hub 跨 runtime 重建存活，
   * 不会误断未变 server。
   */
  applyConfig(specs: readonly McpServerSpec[]): Promise<void>;
  /** 已连接 server 的工具目录（未连上的 server 不出现）。 */
  catalog(): McpServerCatalog[];
  /** 全部受管 server 的运行时状态（含 connecting）—— 供状态面板展示。 */
  serverStatuses(): McpServerStatus[];
  /** 调用某 server 的工具；server 不可用返回 isError，abort 时让异常冒泡。 */
  callTool: McpCallFn;
  /** 关闭所有连接 / 子进程，清理重连定时器。 */
  dispose(): Promise<void>;
}

export interface McpHubOptions {
  /** 单 server 连接 + 首次 tools/list 的超时（毫秒）。 */
  connectTimeoutMs?: number;
  /** 网络代理配置 —— 透传给 http transport 的 SSRF-safe fetch（继承 network.proxy）。 */
  networkProxy?: NetworkPolicy["proxy"];
  /** transport 构造注入点 —— 默认按 spec 造真实 transport，测试可注入内存传输。 */
  createTransport?: CreateTransportFn;
}

interface Connection {
  context: McpServerContext;
  client?: Client;
  tools: McpToolDescriptor[];
  status: "connected" | "connecting";
  error?: string;
  /** 释放 transport 的额外资源（http 连接池）；stdio 为空。 */
  disposeTransport?: () => Promise<void>;
}

export function createMcpHub(
  specs: readonly McpServerSpec[],
  options: McpHubOptions = {},
): McpHub {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const createTransport = options.createTransport ?? defaultCreateTransport;
  const networkProxy = options.networkProxy;
  const connections = new Map<string, Connection>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 当前规格集 —— connectAll 连这些；applyConfig 据此 diff 出增量并更新。
  let currentSpecs: readonly McpServerSpec[] = specs;

  // 建链复用 connect 原语（与一次性探测同一套安全连接路径）；失败由调用方决定落
  // connected 还是排后台重试。
  function establish(spec: McpServerSpec): Promise<ConnectedClient> {
    return connectAndListTools(spec, {
      createTransport,
      proxy: networkProxy,
      timeoutMs: connectTimeoutMs,
    });
  }

  /**
   * 把建链产物落进 connections 并安装断线监听。
   *
   * onclose 监听 Client 的**公开**回调（SDK 内部已占用 transport.onclose，公开层不与之
   * 冲突）—— 对端断开 transport 时触发后台重连。主动 close（disconnectOne / dispose）
   * 前会先解绑，故不会误触发。
   */
  function setConnected(
    spec: McpServerSpec,
    context: McpServerContext,
    est: ConnectedClient,
  ): void {
    est.client.onclose = () => onPassiveDisconnect(spec, context);
    connections.set(spec.serverId, {
      context,
      client: est.client,
      tools: est.tools,
      status: "connected",
      disposeTransport: est.disposeTransport,
    });
  }

  /**
   * 进入后台重试 —— 标记 connecting（error 带最近一次失败原因，对端干净断开时无）并排下一次
   * 退避重连。首次连接失败、首次 tools/list 超时、连上后断开统一走这里，使已配置 server 收敛
   * 到 connected：连上即恢复，无需用户手动重连。
   */
  function enterRetry(
    spec: McpServerSpec,
    context: McpServerContext,
    error: string | undefined,
    attempt: number,
  ): void {
    connections.set(spec.serverId, {
      context,
      tools: [],
      status: "connecting",
      ...(error !== undefined ? { error } : {}),
    });
    scheduleReconnect(spec, context, attempt);
  }

  /** 对端断开已连接 server 的回调 —— 转 connecting 并排首次重连。 */
  function onPassiveDisconnect(
    spec: McpServerSpec,
    context: McpServerContext,
  ): void {
    const conn = connections.get(spec.serverId);
    // 只处理"仍标记 connected"的连接：重复触发 / 已被主动移除时直接忽略（幂等）。
    if (!conn || conn.status !== "connected") return;
    // 释放断掉那条连接的 transport 资源（http 连接池）；transport 自身已被对端关闭。
    if (conn.disposeTransport) void conn.disposeTransport().catch(() => {});
    enterRetry(spec, context, undefined, 0);
  }

  function scheduleReconnect(
    spec: McpServerSpec,
    context: McpServerContext,
    attempt: number,
  ): void {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** attempt,
      RECONNECT_MAX_DELAY_MS,
    );
    const timer = setTimeout(() => {
      reconnectTimers.delete(spec.serverId);
      void attemptReconnect(spec, context, attempt);
    }, delay);
    // 重连定时器不应单独拖住进程退出（dispose 会显式清，这里是兜底）。
    (timer as { unref?: () => void }).unref?.();
    reconnectTimers.set(spec.serverId, timer);
  }

  async function attemptReconnect(
    spec: McpServerSpec,
    context: McpServerContext,
    attempt: number,
  ): Promise<void> {
    // 定时器等待期间该 server 可能已被移除 / 改规格 —— 不再是当前期望目标则放弃。
    if (!isCurrentSpec(spec)) return;
    try {
      const est = await establish(spec);
      // 建链是异步的：期间该 server 可能被移除或被 applyConfig 改规格，这条新连接已是孤儿，
      // 必须解绑监听并关闭，避免泄漏子进程 / 连接池（仅看状态会误采纳——改规格后它又是 connecting）。
      if (!isCurrentSpec(spec)) {
        est.client.onclose = undefined;
        await est.client.close().catch(() => {});
        await est.disposeTransport?.().catch(() => {});
        return;
      }
      setConnected(spec, context, est);
    } catch (err) {
      // 仍是当前目标才排下一次（退避递增、记录原因）；否则说明已被移除 / 改规格，停手。
      if (isCurrentSpec(spec)) {
        enterRetry(spec, context, errMsg(err), attempt + 1);
      }
    }
  }

  function cancelReconnect(serverId: string): void {
    const timer = reconnectTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(serverId);
    }
  }

  /**
   * 这条 spec 是否仍是当前期望的连接目标 —— serverId 仍在 currentSpecs 且规格未变。
   *
   * 重连建链是异步的：期间 server 可能被移除、或被 applyConfig 改了规格（此时它会以**新**
   * 规格重新进入 connecting）。只看 connecting 状态无法区分"还是原来那次重连"，故按身份判定，
   * 防止过期建链被误采纳成 connected。
   */
  function isCurrentSpec(spec: McpServerSpec): boolean {
    return currentSpecs.some(
      (s) => s.serverId === spec.serverId && specEqual(s, spec),
    );
  }

  async function connectOne(spec: McpServerSpec): Promise<void> {
    const context: McpServerContext = {
      serverId: spec.serverId,
      transport: spec.transport,
    };
    try {
      setConnected(spec, context, await establish(spec));
    } catch (err) {
      // 首次连接失败不终止：进入后台退避重试，server 就绪后自愈（首次 npx 下载 / 临时宕机）。
      enterRetry(spec, context, errMsg(err), 0);
    }
  }

  async function disconnectOne(serverId: string): Promise<void> {
    cancelReconnect(serverId);
    const conn = connections.get(serverId);
    if (conn?.client) {
      // 主动 close 前先解绑 onclose —— 否则 close 触发 onclose 会误排重连（删了又连回来）。
      conn.client.onclose = undefined;
      await conn.client.close().catch(() => {});
    }
    if (conn?.disposeTransport) {
      await conn.disposeTransport().catch(() => {});
    }
    connections.delete(serverId);
  }

  return {
    async connectAll() {
      await Promise.allSettled(currentSpecs.map(connectOne));
    },

    async applyConfig(newSpecs) {
      const newById = new Map(newSpecs.map((s) => [s.serverId, s] as const));
      const oldById = new Map(
        currentSpecs.map((s) => [s.serverId, s] as const),
      );
      // 断开：被移除的 server，以及规格变更的（先断后连）。
      const toDisconnect = [...oldById.keys()].filter((id) => {
        const next = newById.get(id);
        return !next || !specEqual(oldById.get(id)!, next);
      });
      // 连接：新增的 server，以及规格变更的。
      const toConnect = [...newById.values()].filter((s) => {
        const prev = oldById.get(s.serverId);
        return !prev || !specEqual(prev, s);
      });
      currentSpecs = [...newSpecs];
      await Promise.allSettled(toDisconnect.map(disconnectOne));
      await Promise.allSettled(toConnect.map(connectOne));
    },

    catalog() {
      const result: McpServerCatalog[] = [];
      for (const conn of connections.values()) {
        if (conn.status === "connected") {
          result.push({ server: conn.context, tools: conn.tools });
        }
      }
      return result;
    },

    serverStatuses() {
      // 以 currentSpecs 为序（贴合用户配置顺序）联结运行态；连接尚未落定的极短窗口跳过。
      const result: McpServerStatus[] = [];
      for (const spec of currentSpecs) {
        const conn = connections.get(spec.serverId);
        if (!conn) continue;
        result.push({
          serverId: spec.serverId,
          transport: spec.transport,
          status: conn.status,
          toolCount: conn.tools.length,
          ...(conn.error !== undefined ? { error: conn.error } : {}),
        });
      }
      return result;
    },

    callTool: async (serverId, toolName, input, callOptions) => {
      const conn = connections.get(serverId);
      if (!conn || conn.status !== "connected" || !conn.client) {
        return { content: `MCP server "${serverId}" 当前不可用`, isError: true };
      }
      try {
        const outcome = await conn.client.callTool(
          { name: toolName, arguments: input },
          undefined,
          { signal: callOptions.signal },
        );
        return toToolResult(outcome);
      } catch (err) {
        // abort 让异常冒泡，交 tool-executor 统一中断；其余协议 / 连接错误转 isError。
        if (callOptions.signal?.aborted) throw err;
        return {
          content: `MCP 工具 "${toolName}"（${serverId}）调用失败：${errMsg(err)}`,
          isError: true,
        };
      }
    },

    async dispose() {
      for (const id of [...reconnectTimers.keys()]) cancelReconnect(id);
      // 清空期望规格集 —— 在途的重连建链复查时即判为孤儿丢弃，不会在关停后又连回来。
      currentSpecs = [];
      await Promise.allSettled(
        [...connections.values()].flatMap((conn) => {
          if (conn.client) {
            // 解绑后再关 —— 否则 close 触发 onclose 会在退出途中误排重连。
            conn.client.onclose = undefined;
          }
          return [conn.client?.close(), conn.disposeTransport?.()];
        }),
      );
      connections.clear();
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 规格是否等价 —— 决定 applyConfig 是否需要重连某 server（serverId 由 Map key 比较，此处不重复）。 */
function specEqual(a: McpServerSpec, b: McpServerSpec): boolean {
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    a.url === b.url &&
    stringArrayEqual(a.args, b.args) &&
    stringRecordEqual(a.headers, b.headers) &&
    stringRecordEqual(a.env, b.env)
  );
}

function stringArrayEqual(
  a?: readonly string[],
  b?: readonly string[],
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function stringRecordEqual(
  a?: Record<string, string>,
  b?: Record<string, string>,
): boolean {
  if (a === b) return true;
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a?.[k] === b?.[k]);
}
