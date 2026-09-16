import { describe, expect, it, vi } from "vitest";
import { createLocalOwnerAssemblyFixture } from "./local-owner-assembly-fixture.js";
import { createLocalConversationCommunicationBinding } from "../conversation-communication-binding.js";
import { LocalConversationRpcRouter } from "../local-conversation-rpc.js";
import type { ConversationCommunicationApplication } from "@zhixing/core/conversation/application";
import { localConversationId } from "@zhixing/core/conversation";
import { ConversationProtocolRuntime } from "../conversation-protocol-runtime.js";
import { createConversationCommunicationAssemblyHandle } from "../conversation-tools.js";

type ConversationMessageReceipt = Awaited<ReturnType<ConversationCommunicationApplication["send"]>>;

describe("local automatic communication notification chain", () => {
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
