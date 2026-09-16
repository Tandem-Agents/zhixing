import { describe, expect, it, vi } from "vitest";
import { createLocalOwnerAssemblyFixture } from "./local-owner-assembly-fixture.js";
import { createLocalConversationCommunicationBinding } from "../conversation-communication-binding.js";
import { ExecutorFirstPartyRpcRouter, LocalConversationRpcRouter } from "../local-conversation-rpc.js";
import { CurrentAnchorFirstPartyRpcRouter } from "../first-party-conversation-mesh.js";
import { buildBuiltinRegistry } from "@zhixing/server";
import { RpcConversationFacade } from "../../runtime/rpc-conversation-facade.js";
import type { ConversationCommunicationApplication } from "@zhixing/core/conversation/application";
import { localConversationId } from "@zhixing/core/conversation";
import { ConversationProtocolRuntime } from "../conversation-protocol-runtime.js";
import { createConversationCommunicationAssemblyHandle } from "../conversation-tools.js";
import { ConversationController } from "../../runtime/conversation-controller.js";
import { createObservedTurnPresenter } from "../../runtime/observed-turn-presenter.js";

type ConversationMessageReceipt = Awaited<ReturnType<ConversationCommunicationApplication["send"]>>;

describe("local automatic communication notification chain", () => {
  it.each(["completed", "failed"] as const)("replays offline %s through the real facade and owner routes exactly once", async ending => {
    const fixture = await createLocalOwnerAssemblyFixture({ profile: "executor-only", run: async function* (messages) {
      if (ending === "failed") throw new Error("离线期间失败");
      const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "离线期间完成" }] };
      return { agentResult: { reason: "completed", message: assistant, usage: { inputTokens: 1, outputTokens: 1 } },
        runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage: { inputTokens: 1, outputTokens: 1 } }, newMessages: [assistant], durationMs: 1 };
    } });
    const handlers = new Map<string, (value: never) => void>();
    const listen = (method: string) => (handler: (value: never) => void) => { handlers.set(method, handler); return () => { handlers.delete(method); }; };
    let disconnect = () => {};
    const makeConnection = (id: number) => ({ id, closed: false, authenticated: true, loopback: true, clientInfo: { id: "test", version: "1" }, surfacePrincipal: "rpc:test", surfaceGeneration: 1,
      notify: vi.fn((method: string, params: unknown) => handlers.get(method)?.(params as never)),
      onClose: vi.fn((fn: () => void) => { disconnect = fn; return () => {}; }),
    });
    let connection = makeConnection(81);
    let controller: ConversationController | undefined;
    try {
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      const local = new LocalConversationRpcRouter({ deviceId: fixture.authority.deviceId, owner: fixture.port, remoteFor: () => { throw new Error("not remote"); } });
      const anchorRequest = vi.fn(async () => ({ conversationStatus: [], conversationStatusNext: [] }));
      const router = new ExecutorFirstPartyRpcRouter({ local, currentAnchor: new CurrentAnchorFirstPartyRpcRouter({ deviceId: fixture.authority.deviceId,
        currentAnchorDeviceId: () => "another-anchor", remoteFor: () => ({ dispatch: anchorRequest }) as never }) });
      const registry = buildBuiltinRegistry();
      const request = vi.fn(async (method: string, params: unknown) => registry.dispatch(method, params, {
        connection, server: { conversationRpc: router, serverInfoRuntime: { conversationStatus: fixture.port.statusHistory } },
      } as never));
      const conversation = new RpcConversationFacade({ getClient: async () => ({ request }),
        onNotification: (method: string, handler: (value: never) => void) => listen(method)(handler),
      } as never);
      const writer = { line: vi.fn(), ensureSegmentBreak: vi.fn() }, onYield = vi.fn();
      const presenter = createObservedTurnPresenter({ writer, flushOutput: vi.fn(), isLocalTurn: () => false, width: () => 160 });
      controller = new ConversationController({ conversation, workscene: {} as never, onYield,
        onObservedInputs: value => presenter.onObservedInputs(value),
        onObservedTurnDelta: value => presenter.onObservedTurnDelta(value),
        onObservedTurnComplete: value => presenter.onObservedTurnComplete(value),
      }, { conversationId, name: "B", mode: { kind: "main" } });
      await controller.start();
      connection.closed = true; disconnect();
      const receipt = await createLocalConversationCommunicationBinding(fixture.port).invoke("source-a", { action: "send", conversationId, operationId: "offline", input: "请处理" }) as ConversationMessageReceipt;
      await vi.waitFor(async () => {
        if (ending === "completed") expect(await fixture.port.finalHistory(conversationId, 0)).toHaveLength(1);
        else expect((await fixture.port.statusHistory([{ conversationId, runId: receipt.runId, afterStatusRevision: 0 }])).notices.some(notice => notice.state === "failed")).toBe(true);
      }, { timeout: 20000 });
      expect(connection.notify).not.toHaveBeenCalled();
      connection = makeConnection(82);
      await controller.reattachActiveObserver();
      await vi.waitFor(() => expect(JSON.stringify(onYield.mock.calls)).toContain(ending === "completed" ? "离线期间完成" : "来信处理未完成"));
      expect(writer.line).toHaveBeenCalledOnce();
      expect(writer.line.mock.calls[0]?.[0]).toContain("来自对话 source-a: 请处理");
      const final = connection.notify.mock.calls.find(([method]) => method === "session.final")?.[1];
      if (ending === "completed") expect(final).toMatchObject({ runId: receipt.runId });
      else expect(request.mock.calls.some(([method]) => method === "session.statusHistory")).toBe(true);
      await controller.reattachActiveObserver();
      if (final) connection.notify("session.final", final);
      expect(writer.line).toHaveBeenCalledOnce();
      expect(onYield).toHaveBeenCalledOnce();
      expect(fixture.runtime.executions()).toBe(1);
      expect(anchorRequest).not.toHaveBeenCalled();
      if (ending === "failed") {
        await createLocalConversationCommunicationBinding(fixture.port).invoke("source-a", { action: "send", conversationId, operationId: "live", input: "重连后任务" });
        await vi.waitFor(() => expect(onYield).toHaveBeenCalledTimes(2), { timeout: 20000 });
        expect(connection.notify.mock.calls.some(([method, notice]) => method === "session.status" && (notice as { state: string }).state === "failed")).toBe(true);
        expect(fixture.runtime.executions()).toBe(2);
      }
    } finally { controller?.dispose(); await fixture.assembly.close(); }
  }, 60000);

  it("a durably queued recovery uses the already bound communication port exactly once", async () => {
    const handle = createConversationCommunicationAssemblyHandle();
    let conversationId = "";
    const invoke = vi.fn(async () => ({ conversations: [], partial: false }));
    const fixture = await createLocalOwnerAssemblyFixture({ profile: "anchor-executor", run: async function* (messages) {
      await handle.port.invoke(conversationId, { action: "discover" });
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "恢复完成" }] };
      return { agentResult: { reason: "completed", message, usage: { inputTokens: 1, outputTokens: 1 } },
        runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, message], usage: { inputTokens: 1, outputTokens: 1 } }, newMessages: [message], durationMs: 1 };
    } });
    conversationId = localConversationId(fixture.authority.deviceId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const recover = ConversationProtocolRuntime.prototype.recover;
    let seeded = false;
    const recovery = vi.spyOn(ConversationProtocolRuntime.prototype, "recover").mockImplementation(async function (this: ConversationProtocolRuntime) {
      if (!seeded) {
        seeded = true;
        const pending = await this.admit({ conversationId, input: "恢复中的任务", invocation: { kind: "agent", source: "interactive" }, surfacePrincipal: "rpc:test",
          options: { surfacePrincipal: "rpc:test", source: "interactive", turnContext: { turnId: "pending", turnOrigin: { channel: "rpc", messageIdentity: { id: "pending", source: { kind: "conversation", conversationId: "source" } } } } } });
        this.deferScheduling(conversationId, pending.runId);
      }
      return recover.call(this);
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(fixture.runtime.executions()).toBe(0);
      handle.bind({ invoke });
      await fixture.assembly.start();
      await vi.waitFor(async () => expect(await fixture.port.communicationMessages.inspect(conversationId, "pending")).toMatchObject({ state: "committed" }), { timeout: 20000 });
      expect(invoke).toHaveBeenCalledExactlyOnceWith(conversationId, { action: "discover" });
      expect(fixture.runtime.executions()).toBe(1);
    } finally { recovery.mockRestore(); await fixture.assembly.close(); }
  }, 60000);
  it.each(["completed", "error", "cancelled"] as const)("publishes durable inputs, output and terminal state without a local sender: %s", async (ending) => {
    let proceed!: () => void;
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const fixture = await createLocalOwnerAssemblyFixture({ profile: "executor-only", run: async function* (messages, options) {
      await options!.onProtocolEvent!({ event: "agent:run_start", payload: { prompt: "原始要求" } }, {});
      yield { type: "text_delta", text: "处理中" };
      await gate;
      if (ending === "error") throw new Error("fixture provider failed");
      if (ending === "cancelled") yield { type: "text_delta", text: "不应显示" };
      const received = await options!.inputPort!.receive({ boundary: 1, closing: false });
      await options!.onProtocolEvent!({ event: "agent:input_received", payload: { inputs: received.map(message => ({ text: "补充要求", identity: message.inputIdentity! })) } }, {});
      await options!.inputPort!.close();
      const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "处理完成" }] };
      yield { type: "text_delta", text: "处理完成" };
      return { agentResult: { reason: "completed", message: assistant, usage: { inputTokens: 1, outputTokens: 1 } },
        runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, ...received, assistant], usage: { inputTokens: 1, outputTokens: 1 } }, newMessages: [...received, assistant], durationMs: 1 };
    } });
    const connection = { id: 17, closed: false, authenticated: true, loopback: true, clientInfo: { id: "test", version: "1" }, surfacePrincipal: "rpc:test", surfaceGeneration: 1, notify: vi.fn(), onClose: vi.fn(() => () => {}) };
    try {
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      const router = new LocalConversationRpcRouter({ deviceId: fixture.authority.deviceId, owner: fixture.port, remoteFor: () => { throw new Error("not remote"); } });
      await router.dispatch({ method: "session.subscribe", params: { conversationId }, connection });
      const binding = createLocalConversationCommunicationBinding(fixture.port);
      const first = await binding.invoke("source-c", { action: "send", conversationId, operationId: "initial", input: "原始要求" }) as ConversationMessageReceipt;
      await vi.waitFor(() => expect(connection.notify.mock.calls.some(([method, value]) => method === "session.assignmentStream" && value.payload.kind === "agent-yield")).toBe(true), { timeout: 15000 });
      expect(connection.notify.mock.calls.some(([method, value]) => method === "session.assignmentStream" && value.meta.turnOrigin?.messageIdentity?.source.conversationId === "source-c")).toBe(true);
      const second = await binding.invoke("source-a", { action: "send", conversationId, operationId: "append", input: "补充要求" }) as ConversationMessageReceipt;
      expect(second.runId).toBe(first.runId);
      if (ending === "cancelled") await router.dispatch({ method: "session.abort", params: { conversationId, runId: first.runId, requestId: "cancel-test", acceptLimitedCapabilities: true }, connection });
      proceed();
      if (ending === "completed") {
        await vi.waitFor(() => expect(connection.notify.mock.calls.some(([method]) => method === "session.final")).toBe(true), { timeout: 20000 });
        const appended = connection.notify.mock.calls.find(([method, value]) => method === "session.assignmentStream" && value.payload.kind === "agent-event" && value.payload.event.event === "agent:input_received")?.[1];
        expect(appended.payload.event.payload.inputs[0].identity).toEqual({ id: second.messageId, source: { kind: "conversation", conversationId: "source-a" } });
        const read = await binding.invoke("source-a", { action: "read", conversationId }) as { runs: { record: { messages: unknown[] } }[] };
        expect(JSON.stringify(read.runs)).toContain(second.messageId);
      } else {
        await vi.waitFor(() => expect(connection.notify.mock.calls.some(([method, value]) => method === "session.status" && value.state === (ending === "error" ? "failed" : "cancelled"))).toBe(true), { timeout: 20000 });
        expect(connection.notify.mock.calls.some(([method, value]) => method === "session.assignmentStream" && value.payload.yield?.text === "不应显示")).toBe(false);
      }
      expect(connection.notify.mock.calls.some(([method]) => method === "session.delta" || method === "session.complete")).toBe(false);
      expect(fixture.runtime.executions()).toBe(1);
    } finally { proceed(); await fixture.assembly.close(); }
  }, 60000);
});
