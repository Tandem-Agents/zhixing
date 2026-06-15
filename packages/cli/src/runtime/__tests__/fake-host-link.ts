/**
 * CoreHostLink 的测试替身——RPC 设施测试共用。
 *
 * 记录 request 调用、可注入响应、可模拟宿主推送 notification;
 * getClient 可替换为抛错实现以断言"不连宿主"的被动语义。
 */

import type { RpcClient } from "@zhixing/server";
import type { CoreHostLink } from "../core-host-connection.js";

export interface RecordedRequest {
  method: string;
  params: unknown;
}

export function makeFakeHostLink(opts: { connected?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  let responder: (method: string, params: unknown) => unknown = () => ({});
  const connected = opts.connected ?? true;

  const client = {
    request: async (method: string, params?: unknown) => {
      requests.push({ method, params });
      return responder(method, params);
    },
  } as unknown as RpcClient;

  const link: CoreHostLink = {
    getClient: async () => client,
    getConnectedClient: () => (connected ? client : null),
    onNotification: (method, handler) => {
      let set = handlers.get(method);
      if (!set) {
        set = new Set();
        handlers.set(method, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };

  return {
    link,
    requests,
    /** 注入 request 响应(按 method 分支返回)。 */
    setResponder(fn: (method: string, params: unknown) => unknown): void {
      responder = fn;
    },
    /** 模拟宿主推送 notification。 */
    notify(method: string, params: unknown): void {
      for (const handler of [...(handlers.get(method) ?? [])]) handler(params);
    },
    /** 当前挂在某通知上的 handler 数(断言退订)。 */
    handlerCount(method: string): number {
      return handlers.get(method)?.size ?? 0;
    },
  };
}

/** getClient 即抛错的 link——断言读路径 / 订阅不主动连宿主。 */
export function makeUnreachableHostLink(): CoreHostLink {
  return {
    getClient: async () => {
      throw new Error("不应连接宿主");
    },
    getConnectedClient: () => null,
    onNotification: () => () => {},
  };
}
