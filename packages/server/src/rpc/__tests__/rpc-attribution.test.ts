/**
 * RPC 请求发起的存储工作按已注册方法名归属：经会话路由与常规派发两条路径都带同一标签，处理函数跨过 await 后仍在；
 * 内层产品接口的标签照旧覆盖；未注册的方法不产生标签（标签集合有限）。
 */
import { describe, expect, it } from "vitest";
import { currentLogAttributionRefs, runWithLogAttribution } from "@zhixing-ai/core/logging";
import { HandlerRegistry, type HandlerContext } from "../handlers.js";

// 存储观测在操作开始时读的就是这份上下文：跨过计时器后再取
const callers = async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return currentLogAttributionRefs();
};

function context(route?: (input: { dispatchCanonical: () => Promise<unknown> }) => Promise<{ handled: boolean; result?: unknown }>): HandlerContext {
  return {
    connection: { authenticated: true },
    server: route ? { conversationRpc: { dispatch: route } } : {},
  } as unknown as HandlerContext;
}

describe("RPC 请求的存储工作归属", () => {
  it("常规派发：处理函数里的工作带 rpc:<方法>", async () => {
    const registry = new HandlerRegistry();
    registry.register({ name: "session.readState", handler: callers });
    expect(await registry.dispatch("session.readState", {}, context())).toEqual([{ kind: "caller", id: "rpc:session.readState" }]);
  });

  it("经会话路由派发同样带标签；内层产品接口标签覆盖外层", async () => {
    const registry = new HandlerRegistry();
    registry.register({ name: "session.send", handler: callers });
    const routed = context(async ({ dispatchCanonical }) => ({ handled: true, result: await dispatchCanonical() }));
    expect(await registry.dispatch("session.send", {}, routed)).toEqual([{ kind: "caller", id: "rpc:session.send" }]);
    const product = context(async () => ({ handled: true, result: await runWithLogAttribution("product:conversation.send", callers) }));
    expect(await registry.dispatch("session.send", {}, product)).toEqual([{ kind: "caller", id: "product:conversation.send" }]);
  });

  it("未注册的方法照旧拒绝，不产生标签", async () => {
    const registry = new HandlerRegistry();
    await expect(registry.dispatch("not.registered", {}, context())).rejects.toThrow(/Method not found/);
    expect(currentLogAttributionRefs()).toEqual([]);
  });
});
