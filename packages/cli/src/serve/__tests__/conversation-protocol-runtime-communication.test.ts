// 拆分自 conversation-protocol-runtime.test.ts（按主题分文件以便并行执行）：communication。
import { ConfirmationBroker, buildConfirmationRequest } from "@zhixing/core/confirmation";
import { ConfirmationHub } from "@zhixing/owner-kernel/confirmation-hub";
import { createConfirmationBridge } from "@zhixing/rpc";
import { createMcpManagementTools } from "../mcp-tools.js";
import { createServerConfirmationBinding, createServerConversationBinding } from "../server-product-bindings.js";
import { buildConfirmationListMethod, buildConfirmationResolveMethod } from "../../../../server/src/rpc/methods/confirmation.js";
import { type Message } from "@zhixing/core";
import { runAgentLoop, MockLLMProvider, type AgentYield, type RunResult } from "@zhixing/core/loop";
import { ConversationCommunicationApplicationService, ConversationDirectoryApplicationService, type ConversationMessageExecutionRequest } from "@zhixing/core/conversation/application";
import { createConversationAgentTurnAdmissionPort } from "@zhixing/owner-kernel/conversation-agent-turn-admission";
import { trackMessages } from "../../../../orchestrator/src/runtime/track-messages.js";
import { createEventBus } from "@zhixing/core/events";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { createConversationTool } from "../conversation-tools.js";
import { createConversationCommunicationBinding } from "../conversation-communication-binding.js";
import { SkillCatalogLoadApplicationService } from "@zhixing/core/skills/catalog";
import { skillNameToId } from "@zhixing/core/skills/id";
import { BUILTIN_TOOL_FACTORIES } from "@zhixing/tools-builtin";
import { createSignedTrustRuleSnapshot, protocolDigest } from "@zhixing/core/protocol";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationProtocolRuntime, DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { TEST_DURABLE_IO_TIMEOUT_MS, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, getOrCreateActiveConversation, expectSettled, MemorySecretStore, worksceneContinuationHarness } from "./conversation-protocol-runtime-fixture.js";

describe("ConversationProtocolRuntime", () => {
  it("conversation communication unit 2: model tools load, discover, read, send busy input and reply after A has finished", async () => {
    const home = await createTempDir("conversation-model-tools");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const ids = ["dialog-a", "dialog-b"];
    const skillId = skillNameToId("对话通信");
    const providers = [new MockLLMProvider([
      { toolCalls: [{ id: "load", name: "load_skill", input: { id: skillId } }] },
      { toolCalls: [{ id: "locate", name: "conversation", input: { action: "discover" } }] },
      { toolCalls: [{ id: "read", name: "conversation", input: { action: "read", conversationId: ids[1] } }] },
      { toolCalls: [{ id: "send-first", name: "conversation", input: { action: "send", conversationId: ids[1], input: "请核实后回信" } }] },
      { toolCalls: [{ id: "send-busy", name: "conversation", input: { action: "send", conversationId: ids[1], input: "补充检查边界" } }] },
      { text: "已发送，结束本轮。" },
      { text: "收到核实结论。" },
    ]), new MockLLMProvider([
      { text: "核实中。" },
      { toolCalls: [{ id: "reply-read", name: "conversation", input: { action: "read" } }] },
      { toolCalls: [{ id: "reply", name: "conversation", input: { action: "send", conversationId: ids[0], input: "核实通过" } }] },
      { text: "已回复。" },
    ])];
    let manager!: ConversationManager;
    let binding!: ReturnType<typeof createConversationCommunicationBinding>;
    let bStarted!: () => void; const whenBStarts = new Promise<void>(resolve => { bStarted = resolve; });
    let aFinished!: () => void; const whenAFinishes = new Promise<void>(resolve => { aFinished = resolve; });
    const committed: string[] = [];
    const executionDiagnostics: unknown[] = [];
    const runtimeFactory: RuntimeFactory = { create: async (id) => ({
      ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: id,
      async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
        if (id === ids[1]) { bStarted(); await whenAFinishes; }
        const captured: Message[] = [];
        const pending: import("@zhixing/core").ToolResultBlock[] = [];
        const communication = createConversationTool({ invoke: async (source, request) => {
          const response = await binding.invoke(source, request);
          if (source === ids[0] && request.action === "send" && request.input === "请核实后回信") await whenBStarts;
          return response;
        } });
        const load = BUILTIN_TOOL_FACTORIES.load_skill({ skillCatalogLoad: new SkillCatalogLoadApplicationService({ readScope: async () => ({ kind: "builtin-only" }), readContent: async () => { throw new Error("unexpected user skill"); }, stageUsage: async () => {} }) } as never);
        const generator = runAgentLoop({ provider: providers[ids.indexOf(id)]!, model: "mock-model", messages: [...messages], tools: [load, communication],
          deps: { executeTool: (tool, input, context) => tool.call(input, { ...context, turnId: options?.turnContext?.turnId }) },
          inputPort: { receive: async boundary => { const values = await options!.inputPort!.receive(boundary); captured.push(...values); return values; }, close: () => options!.inputPort!.close() },
        });
        while (true) {
          const step = await runContextStorage.run({ bus: createEventBus(), lineage: "main", conversationId: id }, () => generator.next());
          if (step.done) { executionDiagnostics.push({ id, result: step.value }); return { agentResult: step.value, runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, ...captured], usage: step.value.usage }, newMessages: captured, durationMs: 1 }; }
          if (step.value.type === "tool_end" && step.value.result.isError) executionDiagnostics.push(step.value.result);
          trackMessages(step.value, captured, pending); yield step.value;
        }
      }, abort: () => false, dispose: async () => {},
    }) };
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    const execute = protocol.run.bind(protocol);
    vi.spyOn(protocol, "run").mockImplementation(async function* (input) {
      try { return yield* execute(input); }
      catch (error) { executionDiagnostics.push(String(error)); throw error; }
    });
    manager = new ConversationManager(runtimeFactory, undefined, {
      durableTurnExecutor: protocol,
      appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "owner-log", appended: true }),
      onTurnCommitted: ({ conversationId }) => { committed.push(conversationId); if (conversationId === ids[0]) aFinished(); },
    });
    for (const id of ids) await getOrCreateActiveConversation(authority, manager, id);
    const context = { principal: { kind: "host" as const, component: "communication-test" }, requestId: "history", deadlineAt: new Date(Date.now() + 120000).toISOString() };
    const directory = new ConversationDirectoryApplicationService({
      storage: {
        list: async () => ids.map((id, index) => ({ conversationId: id, name: index ? "核实" : "发起", createdAt: "2026-09-16T00:00:00Z", lastActiveAt: "2026-09-16T00:00:00Z" })),
        create: async () => { throw new Error("must not create"); }, rename: async () => null,
        readHistory: async (id, request) => { const page = await protocol.sessionState.readTranscriptTail(id, context, request.before, request.limit); return { runs: [...page.records].reverse().map(record => ({ record, shardId: "owner-log" })), hasMore: !!page.next }; },
      },
      runtime: { read: id => ({ active: true, busy: manager.getSession(id)?.busy ?? false, pendingCount: 0, observerCount: 0 }) },
      agentTurns: createConversationAgentTurnAdmissionPort({ manager }),
      agentTurnIdentity: { exists: async id => ids.includes(id), create: async () => { throw new Error("must not create"); }, ensure: async () => {} },
    });
    binding = createConversationCommunicationBinding({ directory, manager, messages: { inspect: (id, messageId) => protocol.inspectMessage(id, messageId), inputsOutsideHistory: id => protocol.messageInputsOutsideHistory(id) } });
    try {
      const initial = await binding.invoke(ids[0]!, { action: "send", conversationId: ids[0]!, operationId: "initial", input: "请联系核实对话" }) as { messageId: string };
      await vi.waitFor(() => expect(committed, JSON.stringify(executionDiagnostics)).toHaveLength(3), { timeout: 40000, interval: 250 });
      expect(await binding.invoke(ids[0]!, { action: "observe", conversationId: ids[0]!, messageId: initial.messageId })).toMatchObject({ state: "committed" });
      const a = await binding.invoke(ids[0]!, { action: "read", conversationId: ids[0]! }) as Awaited<ReturnType<ConversationCommunicationApplicationService["read"]>>;
      const b = await binding.invoke(ids[0]!, { action: "read", conversationId: ids[1]! }) as typeof a;
      expect(a.runs).toHaveLength(2); expect(b.runs).toHaveLength(1);
      expect(committed[0]).toBe(ids[0]);
      expect(b.runs[0]!.record.messages.filter(message => message.inputIdentity).map(message => message.inputIdentity?.source)).toEqual([{ kind: "conversation", conversationId: ids[0] }, { kind: "conversation", conversationId: ids[0] }]);
      expect(a.runs[0]!.record.messages[0]?.inputIdentity?.source).toEqual({ kind: "conversation", conversationId: ids[1] });
      expect(providers[0]!.callCount).toBe(7); expect(providers[1]!.callCount).toBe(4);
      expect(providers[1]!.calls[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "补充检查边界" }]);
      expect(providers[0]!.calls[1]?.messages.at(-1)?.content[0]).toMatchObject({ type: "tool_result", isError: false });
      const outputs = a.runs.flatMap(run => run.record.messages).flatMap(message => message.content).filter(block => block.type === "tool_result");
      expect(outputs.every(block => !block.isError)).toBe(true);
      const receipts = outputs.map(block => { try { return JSON.parse(block.content); } catch { return null; } }).filter(value => value?.accepted);
      expect(receipts).toHaveLength(2); expect(receipts[0].runId).toBe(receipts[1].runId);
      for (const receipt of receipts) expect(await binding.invoke(ids[0]!, { action: "observe", conversationId: ids[1]!, messageId: receipt.messageId })).toMatchObject({ disposition: "consumed", state: "committed" });
      expect(committed).toHaveLength(3);
    } finally { aFinished(); await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it("conversation communication unit 1: durable busy input, retry, closing race, provenance and history recovery", async () => {
    const home = await createTempDir("conversation-input-boundary");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const conversationId = "communication-target";
    const caller = { kind: "surface" as const, surfacePrincipal: "rpc:owner", connectionId: "communication-test" };
    const context = { principal: { kind: "host" as const, component: "communication-test" }, requestId: "history", deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    let manager!: ConversationManager;
    let application!: ConversationCommunicationApplicationService;
    let userApplication!: ConversationCommunicationApplicationService;
    let firstRunId = "";
    let executions = 0;
    let busyReceipt!: Awaited<ReturnType<ConversationCommunicationApplicationService["send"]>>;
    let closingReceipt!: typeof busyReceipt;
    let closingSent = false;
    const outcomes: unknown[] = [];
    const provider = new MockLLMProvider([
      { toolCalls: [{ id: "read-1", name: "work", input: {} }] },
      { text: "processed busy inputs" },
      { text: "processed closing input" },
      { text: "processed recovered input" },
    ]);
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
        executions++;
        const received: Message[] = [];
        const pending: import("@zhixing/core").ToolResultBlock[] = [];
        const port = options!.inputPort!;
        expect(port).toBeDefined();
        const iterator = runAgentLoop({ provider, model: "mock-model", messages: [...messages],
          tools: [{ name: "work", description: "fixture", inputSchema: { type: "object" }, isReadOnly: true, isParallelSafe: true, needsPermission: false,
            call: async () => {
              const request = { conversationId, operationId: "from-a", input: "请补充分析" };
              busyReceipt = await application.send(request);
              expect(await application.send(request)).toEqual(busyReceipt);
              expect((await application.observe({ conversationId, messageId: busyReceipt.messageId }))?.consumed).toBe(false);
              expect((await application.read({ conversationId })).inputsOutsideHistory.find((entry) => entry.message.inputIdentity?.id === busyReceipt.messageId)?.message.inputIdentity?.source).toEqual({ kind: "conversation", conversationId: "source-a" });
              await expect(application.send({ ...request, input: "different" })).rejects.toThrow();
              await userApplication.send({ conversationId, operationId: "from-user", input: "用户补充" });
              // 丢弃可重建投影后，来信仍然存在；活动端口与新 journal 共用权威顺序。
              protocol.releaseConversation(conversationId);
              expect((await application.observe({ conversationId, messageId: busyReceipt.messageId }))?.runId).toBe(busyReceipt.runId);
              return { content: "tool done", isError: false };
            },
          }],
          inputPort: {
            receive: async (boundary) => {
              const input = await port.receive(boundary);
              if (input.length > 0) {
                expect(await port.receive(boundary)).toEqual(input);
                received.push(...structuredClone(input));
              }
              if (boundary.closing && input.length === 0 && !closingSent) {
                closingSent = true;
                closingReceipt = await application.send({ conversationId, operationId: "during-close", input: "收尾时的新消息" });
              }
              return input;
            },
            close: () => port.close(),
          },
        });
        while (true) {
          const step = await iterator.next();
          if (step.done) return { agentResult: step.value, runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, ...received], usage: step.value.usage }, newMessages: received, durationMs: 1 };
          trackMessages(step.value, received, pending);
          yield step.value;
        }
      },
      abort: () => false, async dispose() {},
    };
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
      appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "owner-log", appended: true }),
    });
    await getOrCreateActiveConversation(authority, manager, conversationId);
    const directory = new ConversationDirectoryApplicationService({
      storage: {
        list: async () => [{ conversationId, name: "目标", createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:00.000Z" }],
        create: async () => { throw new Error("must not create"); }, rename: async () => null,
        readHistory: async (id, request) => { const page = await protocol.sessionState.readTranscriptTail(id, context, request.before, request.limit); return { runs: [...page.records].reverse().map(record => ({ record, shardId: "owner-log" })), hasMore: !!page.next }; },
      },
      runtime: { read: id => ({ active: true, busy: manager.getSession(id)?.busy ?? false, pendingCount: 0, observerCount: 0 }) },
      agentTurns: createConversationAgentTurnAdmissionPort({ manager }),
      agentTurnIdentity: { exists: async id => id === conversationId, create: async () => { throw new Error("must not create"); }, ensure: async () => {} },
    });
    const execution = (request: ConversationMessageExecutionRequest) => ({
      execute: async ({ conversationId: id, turnId }: { conversationId: string; turnId: string }) => {
        try { outcomes.push(await projectSessionTurn({ manager, managed: manager.getSession(id)!, input: request.input, turnId, runOptions: { source: "interactive", surfacePrincipal: request.caller.surfacePrincipal, turnContext: { turnId, turnOrigin: request.turnOrigin } }, notify: () => {} })); }
        finally { manager.setBusy(id, false); }
      },
      cancelPending: () => {},
    });
    const shared = { directory, caller, messages: {
      inspect: (id: string, messageId: string) => protocol.inspectMessage(id, messageId),
      inputsOutsideHistory: (id: string) => protocol.messageInputsOutsideHistory(id),
    }, execution };
    application = new ConversationCommunicationApplicationService({ ...shared, source: { kind: "conversation", conversationId: "source-a" } });
    userApplication = new ConversationCommunicationApplicationService({ ...shared, source: { kind: "user" } });
    try {
      await expect(application.send({ conversationId: "missing", operationId: "bad", input: "no" })).rejects.toThrow("not found");
      expect(executions).toBe(0);
      const initial = await userApplication.send({ conversationId, operationId: "initial", input: "原任务" });
      firstRunId = initial.runId;
      await vi.waitFor(() => expect(outcomes).toHaveLength(2), { timeout: 20000 });
      for (const outcome of outcomes) expectSettled(outcome as Parameters<typeof expectSettled>[0]);
      expect(busyReceipt.runId).toBe(firstRunId);
      expect(closingReceipt.runId).not.toBe(firstRunId);
      expect(executions).toBe(2);
      expect(provider.callCount).toBe(3);
      expect(manager.getObserverConnectionIds(conversationId).has(caller.connectionId)).toBe(false);
      expect(provider.calls[1]!.messages.slice(-3).map(m => m.content[0]?.type)).toEqual(["tool_result", "text", "text"]);
      expect(provider.calls[1]!.messages.slice(-2).map(m => m.inputIdentity?.source.kind)).toEqual(["conversation", "user"]);
      const history = await application.read({ conversationId });
      expect(history.runs).toHaveLength(2);
      expect(history.inputsOutsideHistory).toEqual([]);
      const inputs = history.runs.flatMap(r => r.record.messages).filter(m => m.inputIdentity);
      expect(inputs).toHaveLength(4);
      expect(new Set(inputs.map(m => m.inputIdentity!.id)).size).toBe(4);
      expect((await application.observe({ conversationId, messageId: busyReceipt.messageId }))).toMatchObject({ consumed: true, disposition: "consumed", state: "committed", message: { inputIdentity: { source: { kind: "conversation", conversationId: "source-a" } } } });
      expect((await application.discover()).conversations[0]).toMatchObject({ name: "目标", summary: "processed closing input" });
      protocol.releaseConversation(conversationId);
      await protocol.recoverConversation(conversationId);
      expect((await application.read({ conversationId })).runs).toEqual(history.runs);
      expect(await application.send({ conversationId, operationId: "from-a", input: "请补充分析" })).toEqual(busyReceipt);
      expect(executions).toBe(2);
      const pendingIdentity = { id: "message-before-restart", source: { kind: "conversation" as const, conversationId: "source-a" } };
      const pending = await protocol.admit({ conversationId, input: "尚未开始的来信", invocation: { kind: "agent", source: "interactive" },
        surfacePrincipal: caller.surfacePrincipal, options: { surfacePrincipal: caller.surfacePrincipal, source: "interactive", turnContext: { turnId: pendingIdentity.id, turnOrigin: { channel: "rpc", messageIdentity: pendingIdentity } } } });
      expect(await protocol.inspectMessage(conversationId, pendingIdentity.id)).toMatchObject({ state: "queued", consumed: false, disposition: "pending", runId: pending.runId });
      await protocol.stopRecoveryLoop(); await manager.disposeAll();
      const restartedAuthority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
      await restartedAuthority.resourceGovernor.snapshot();
      let restartedManager!: ConversationManager;
      const restarted = createProtocol({ authority: restartedAuthority, manager: () => restartedManager, interactions: new DurableConversationInteractionObserver() });
      restartedManager = new ConversationManager({ create: async () => runtime }, undefined, {
        durableTurnExecutor: restarted, onTurnCommitted: () => {},
        appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "owner-log", appended: false }),
      });
      try {
        await restarted.recoverConversation(conversationId);
        await vi.waitFor(async () => {
          await restarted.recoverConversation(conversationId);
          expect(await restarted.inspectMessage(conversationId, pendingIdentity.id)).toMatchObject({ state: "committed", consumed: true });
        }, { timeout: 20000, interval: 100 });
        expect(await restarted.inspectMessage(conversationId, busyReceipt.messageId)).toMatchObject({ consumed: true, state: "committed", runId: firstRunId });
        expect(await restarted.inspectMessage(conversationId, initial.messageId)).toMatchObject({ consumed: true, state: "committed" });
        const recovered = await restarted.sessionState.readTranscriptTail(conversationId, context, undefined, 10);
        expect(recovered.records.flatMap(r => r.messages).filter(m => m.inputIdentity)).toHaveLength(5);
        expect(recovered.records.flatMap(r => r.messages).find(m => m.inputIdentity?.id === pendingIdentity.id)?.inputIdentity).toEqual(pendingIdentity);
        expect(executions).toBe(3);
      } finally { await restarted.stopRecoveryLoop(); await restartedManager.disposeAll(); }
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it.each(["tool-limit", "text-limit", "cancel", "error"] as const)("conversation communication termination: %s preserves stopped input without restarting", async (ending) => {
    const home = await createTempDir("conversation-input-termination");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const conversationId = "communication-termination";
    const caller = { kind: "surface" as const, surfacePrincipal: "rpc:owner", connectionId: "communication-test" };
    const context = { principal: { kind: "host" as const, component: "communication-test" }, requestId: "history", deadlineAt: new Date(Date.now() + 120_000).toISOString() };
    const controller = new AbortController();
    let manager!: ConversationManager;
    let application!: ConversationCommunicationApplicationService;
    let receipt!: Awaited<ReturnType<ConversationCommunicationApplicationService["send"]>>;
    let executions = 0;
    const outcomes: unknown[] = [];
    const send = { conversationId, operationId: "from-a", input: "请补充分析" };
    const admitIncoming = async () => {
      receipt = await application.send(send);
      expect(await application.observe({ conversationId, messageId: receipt.messageId })).toMatchObject({ consumed: false, disposition: "pending" });
    };
    const provider = new MockLLMProvider([ending === "tool-limit"
      ? { toolCalls: [{ id: "work-1", name: "work", input: {} }] }
      : ending === "error" ? { error: new Error("provider unavailable") } : { text: "done" }]);
    const chat = provider.chat.bind(provider);
    provider.chat = async function* (request) {
      if (ending !== "tool-limit") await admitIncoming();
      if (ending === "cancel") await protocol.cancel({
        conversationId, runId: receipt.runId, requestId: "cancel-current",
        principal: { surfacePrincipal: caller.surfacePrincipal, deviceId: authority.deviceId, connectionId: caller.connectionId },
      });
      yield* chat(request);
    };
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
        executions++;
        const received: Message[] = [];
        const pending: import("@zhixing/core").ToolResultBlock[] = [];
        const port = options!.inputPort!;
        const iterator = runAgentLoop({ provider, model: "mock-model", maxTurns: ending.endsWith("limit") ? 1 : 3,
          messages: [...messages], abortSignal: controller.signal,
          tools: [{ name: "work", description: "fixture", inputSchema: { type: "object" }, isReadOnly: true, isParallelSafe: true, needsPermission: false,
            call: async () => { await admitIncoming(); return { content: "done", isError: false }; } }],
          inputPort: {
            receive: async (boundary) => { const input = await port.receive(boundary); received.push(...input); return input; },
            close: async () => {
              await port.close();
              expect(await application.observe({ conversationId, messageId: receipt.messageId })).toMatchObject({ consumed: false, disposition: "stopped" });
            },
          },
        });
        while (true) {
          const step = await iterator.next();
          if (step.done) return { agentResult: step.value, runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, ...received], usage: step.value.usage }, newMessages: received, durationMs: 1 };
          trackMessages(step.value, received, pending);
          yield step.value;
        }
      },
      abort: reason => { const fresh = !controller.signal.aborted; controller.abort(reason); return fresh; }, async dispose() {},
    };
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
      appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "owner-log", appended: true }),
    });
    await getOrCreateActiveConversation(authority, manager, conversationId);
    const directory = new ConversationDirectoryApplicationService({
      storage: {
        list: async () => [{ conversationId, name: "目标", createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:00.000Z" }],
        create: async () => { throw new Error("must not create"); }, rename: async () => null,
        readHistory: async (id, request) => { const page = await protocol.sessionState.readTranscriptTail(id, context, request.before, request.limit); return { runs: [...page.records].reverse().map(record => ({ record, shardId: "owner-log" })), hasMore: !!page.next }; },
      },
      runtime: { read: id => ({ active: true, busy: manager.getSession(id)?.busy ?? false, pendingCount: 0, observerCount: 0 }) },
      agentTurns: createConversationAgentTurnAdmissionPort({ manager }),
      agentTurnIdentity: { exists: async id => id === conversationId, create: async () => { throw new Error("must not create"); }, ensure: async () => {} },
    });
    const shared = { directory, caller, messages: {
      inspect: (id: string, messageId: string) => protocol.inspectMessage(id, messageId),
      inputsOutsideHistory: (id: string) => protocol.messageInputsOutsideHistory(id),
    }, execution: (request: ConversationMessageExecutionRequest) => ({
      execute: async ({ conversationId: id, turnId }: { conversationId: string; turnId: string }) => {
        try { outcomes.push(await projectSessionTurn({ manager, managed: manager.getSession(id)!, input: request.input, turnId,
          runOptions: { source: "interactive", surfacePrincipal: caller.surfacePrincipal, turnContext: { turnId, turnOrigin: request.turnOrigin } }, notify: () => {} })); }
        finally { manager.setBusy(id, false); }
      }, cancelPending: () => {},
    }) };
    application = new ConversationCommunicationApplicationService({ ...shared, source: { kind: "conversation", conversationId: "source-a" } });
    const userApplication = new ConversationCommunicationApplicationService({ ...shared, source: { kind: "user" } });
    try {
      const initial = await userApplication.send({ conversationId, operationId: "initial", input: "原任务" });
      await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 20000 });
      expectSettled(outcomes[0] as Parameters<typeof expectSettled>[0]);
      expect(receipt.runId).toBe(initial.runId);
      const expectedState = ending === "text-limit" ? "committed" : ending === "cancel" ? "cancelled" : "failed";
      const before = await application.read({ conversationId });
      const status = await application.observe({ conversationId, messageId: receipt.messageId });
      expect(status).toMatchObject({ runId: initial.runId, state: expectedState, consumed: false, disposition: "stopped",
        message: { content: [{ type: "text", text: send.input }], inputIdentity: { id: receipt.messageId, source: { kind: "conversation", conversationId: "source-a" } } } });
      expect(before.inputsOutsideHistory.filter(entry => entry.message.inputIdentity?.id === receipt.messageId)).toEqual([status]);
      expect(before.runs.flatMap(r => r.record.messages).some(m => m.inputIdentity?.id === receipt.messageId)).toBe(false);
      expect(before.runs).toHaveLength(ending === "text-limit" ? 1 : 0);
      protocol.releaseConversation(conversationId);
      await protocol.recoverConversation(conversationId);
      expect(await application.read({ conversationId })).toEqual(before);
      expect(await application.send(send)).toEqual(receipt);
      await protocol.recoverConversation(conversationId);
      expect(await application.observe({ conversationId, messageId: receipt.messageId })).toEqual(status);
      expect(executions).toBe(1);
      expect(provider.callCount).toBe(1);
      // 已明确清空的输入不得从历史之外的投影重新出现。
      expect(await protocol.writeSession({ conversationId, requestId: "clear-after-stop", mutation: { kind: "window-op", op: "clear" },
        principal: protocol.controlPrincipal({ surfacePrincipal: caller.surfacePrincipal, connectionId: caller.connectionId }), conversationExists: async () => true })).toMatchObject({ status: "accepted" });
      protocol.releaseConversation(conversationId);
      expect((await application.read({ conversationId })).inputsOutsideHistory).toEqual([]);
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it("projects isolated support MCP confirmation to its real source across reconnect without exposing it to another observer", async () => {
    const scene = "ws:reports:primary";
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const hub = new ConfirmationHub();
    const candidate = { serverId: "demo", source: "inferred", entry: { command: "fixture-server" }, secretFields: [{ key: "TOKEN", label: "访问密钥", hint: "安全输入", example: "" }] };
    let supportId = "";
    const f = await worksceneContinuationHarness(undefined, {
      initialConversationId: scene,
      firstControl: { intent: { kind: "exit", handoff: { goal: "交付报告", constraints: [], completed: [], remaining: ["接入资料服务"] } } },
      beforeRun: async (id, origin) => {
        if (!id.startsWith("workscene-support-")) return;
        supportId = id;
        hub.attach("support", broker, { conversationId: id });
        const tool = createMcpManagementTools({} as never, { deviceId: "anchor-device", revision: () => "fixture" })[1]!;
        await broker.requestConfirmation(buildConfirmationRequest({ toolName: tool.name, input: { candidate }, workingDirectory: "", result: {} as never, contextId: { kind: "main" }, sessionType: "interactive", id: "support-connect", requiresExplicitConfirmation: true, confirmationDisplayContext: tool.confirmationDisplayContext, turnOrigin: origin }));
      },
    });
    const owner = { id: 1, authenticated: true, loopback: true, closed: false, surfacePrincipal: "rpc:owner", notify: vi.fn() };
    const observer = { ...owner, id: 2, surfacePrincipal: "rpc:other", notify: vi.fn() };
    const connections = new Set([owner, observer]);
    const source = (entry: { conversationId?: string; request: import("@zhixing/core/confirmation").ConfirmationRequest }) => f.application.interactionSource(entry.conversationId!, entry.request.turnOrigin);
    const binding = createServerConfirmationBinding(hub, source);
    const server = { confirmation: binding, conversation: createServerConversationBinding(f.manager) };
    const bridge = createConfirmationBridge({ connections, hub, conversations: f.manager, continuationSource: source });
    f.manager.addObserver(scene, "1", { allowInactive: true });
    f.manager.addObserver(scene, "2", { allowInactive: true });
    try {
      await f.start();
      await vi.waitFor(async () => {
        await f.protocol.recoverConversation(scene);
        if (supportId) await f.protocol.recoverConversation(supportId);
        expect(owner.notify).toHaveBeenCalledWith("confirmation.pending", expect.objectContaining({ conversationId: supportId, request: expect.anything() }));
      }, { timeout: 15000, interval: 100 });
      expect(f.manager.getObserverConnectionIds(supportId).size).toBe(0);
      expect(observer.notify).not.toHaveBeenCalled();
      const display = hub.findEntry("support-connect")!.request.display.body;
      expect(JSON.stringify(display)).toContain("anchor-device");
      expect(JSON.stringify(display)).toContain(scene);
      expect(JSON.stringify(display)).toContain("/mcp");
      await expect(buildConfirmationResolveMethod().handler({ requestId: "support-connect", decision: { kind: "allow-once" } }, { server, connection: observer } as never)).rejects.toThrow();
      f.manager.removeObserverFromAll("1"); owner.closed = true;
      const reconnected = { ...owner, id: 3, closed: false, notify: vi.fn() };
      connections.add(reconnected);
      f.manager.addObserver(scene, "3", { allowInactive: true });
      const listed = await buildConfirmationListMethod().handler({}, { server, connection: reconnected } as never);
      expect(listed).toMatchObject({ items: [{ conversationId: supportId, request: { id: "support-connect" } }] });
      expect(await buildConfirmationListMethod().handler({ conversationId: scene }, { server, connection: reconnected } as never)).toEqual(listed);
      await expect(buildConfirmationResolveMethod().handler({ requestId: "support-connect", decision: { kind: "deny", reason: "不用新增连接" } }, { server, connection: reconnected } as never)).resolves.toEqual({ ok: true });
      expect(reconnected.notify).toHaveBeenCalledWith("confirmation.resolved", expect.objectContaining({ conversationId: supportId }));
      await vi.waitFor(async () => {
        await f.protocol.recoverConversation(supportId); await f.protocol.recoverConversation(scene);
        expect(f.executions).toEqual([scene, supportId, scene]);
        expect((await f.historySources(scene)).at(-1)?.state).toBe("committed");
      }, { timeout: TEST_DURABLE_IO_TIMEOUT_MS, interval: 500 });
    } finally {
      broker.cancelAll("session-end"); bridge.dispose();
      await f.protocol.stopRecoveryLoop(); await f.manager.disposeAll();
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("returns unavailable isolated execution durably instead of admitting an unexecutable support run", async () => {
    const scene = "ws:reports:primary";
    const f = await worksceneContinuationHarness(undefined, { initialConversationId: scene, firstControl: { intent: { kind: "exit", handoff: { goal: "交付报告", constraints: [], completed: [], remaining: ["接入资料"] } } }, canRunIsolatedMain: false });
    await f.start();
    await vi.waitFor(async () => { await f.protocol.recoverConversation(scene); expect(f.executions).toEqual([scene, scene]); expect((await f.historySources(scene)).at(-1)?.state).toBe("committed"); }, { timeout: 15000, interval: 100 });
    await f.application.recover(scene); await f.protocol.recoverConversation(scene);
    expect(f.executions).toEqual([scene, scene]);
    const runs = await f.historySources(scene);
    expect(runs.filter((run) => run.origin?.worksceneContinuation?.kind === "result")).toHaveLength(1);
    await f.protocol.stopRecoveryLoop(); await f.manager.disposeAll();
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("restores the original admission workspace after isolated support without leaking it to the helper", async () => {
    const f = await worksceneContinuationHarness(undefined, { initialConversationId: "bound-main", withWorkspace: true, firstControl: { intent: { kind: "delegate_mcp", candidate: { serverId: "demo", source: "inferred", entry: { command: "node" }, secretFields: [] }, handoff: { goal: "完成原项目", constraints: [], completed: [], remaining: ["核实后继续原项目"] } } } });
    const prepare = f.prepare!;
    try {
      await f.start();
      const original = (await f.historySources("bound-main"))[0]!;
      expect(original.environment).toEqual(f.environment);
      f.protocol.releaseConversation("bound-main");
      expect((await f.historySources("bound-main"))[0]!.environment).toEqual(f.environment);
      await vi.waitFor(async () => {
        await f.protocol.recoverConversation("bound-main");
        const helper = f.executions.find(id => id.startsWith("workscene-support-"));
        if (helper) await f.protocol.recoverConversation(helper);
        expect((await f.historySources("bound-main")).at(-1)?.origin?.worksceneContinuation?.kind).toBe("result");
        expect((await f.historySources("bound-main")).at(-1)?.state).toBe("committed");
      }, { timeout: 30000, interval: 500 });
      const helper = f.executions[1]!;
      expect(f.executions).toEqual(["bound-main", helper, "bound-main"]);
      expect((await f.historySources(helper))[0]?.environment).toBeUndefined();
      const returned = (await f.historySources("bound-main")).at(-1)!;
      expect(returned.environment).toEqual(f.environment);
      const assignments = await Promise.all(prepare.mock.results.map(result => result.value));
      expect(assignments.map(a => a.environment.workspace?.bindingRef)).toEqual([f.environment!.workspace.bindingRef, undefined, f.environment!.workspace.bindingRef]);
      await f.application.recover("bound-main");
      expect(f.executions).toHaveLength(3);
    } finally {
      prepare.mockRestore();
      await f.protocol.stopRecoveryLoop(); await f.manager.disposeAll(); await f.authority.startupCleanup.run();
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("workscene continuation survives projection eviction and preserves one admission/result chain", async () => {
    const f = await worksceneContinuationHarness();
    await f.start();
    const source = (await f.historySources("main-handoff"))[0]!;
    expect(source.control?.intent.handoff?.goal).toBe("交付报告");
    f.protocol.releaseConversation("main-handoff");
    expect((await f.historySources("main-handoff"))[0]?.control).toEqual(source.control);
    await vi.waitFor(async () => {
      await f.protocol.recoverConversation("main-handoff");
      await f.protocol.recoverConversation("ws:reports:primary");
      expect(f.executions).toEqual(["main-handoff", "ws:reports:primary", "main-handoff"]);
    }, { timeout: TEST_DURABLE_IO_TIMEOUT_MS, interval: 100 });
    await f.protocol.recover();
    await f.application.recover("main-handoff");
    await f.application.recover("ws:reports:primary");
    expect(f.executions).toHaveLength(3);
    const returns = (await f.historySources("main-handoff")).filter((item) => item.origin?.worksceneContinuation?.kind === "result");
    expect(returns).toHaveLength(1);
    expect(returns[0]?.state).toBe("committed");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("workscene continuation obeys an empty durable batch cancel after source commit", async () => {
    const f = await worksceneContinuationHarness();
    await f.start();
    const before = (await f.historySources("main-handoff"))[0]!;
    expect(before.current).toBe(true);
    const cancelled = await f.protocol.cancel({ conversationId: "main-handoff", requestId: "cancel-handoff", principal: { surfacePrincipal: "rpc:owner", deviceId: f.authority.deviceId, connectionId: "test" } });
    expect(cancelled.dispositions).toEqual([]);
    f.protocol.releaseConversation("main-handoff");
    const after = (await f.historySources("main-handoff"))[0]!;
    expect(after.current).toBe(false);
    await f.application.recover("main-handoff");
    expect(await f.manager.findDurableRunByIngress("ws:reports:primary", `handoff:${protocolDigest("WorksceneContinuation", 1, { conversationId: before.conversationId, runId: before.runId })}`, "interactive")).toBeUndefined();
    expect(f.executions).toEqual(["main-handoff"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["现在进度如何？", "补充要求：报告用中文"])("workscene continuation preserves entrusted work for ordinary input: %s", async (text) => {
    const f = await worksceneContinuationHarness();
    await f.start();
    await f.application.recover("main-handoff");
    const child = (await f.historySources("ws:reports:primary"))[0]!;
    expect(child.state).toBe("queued");
    await f.protocol.admit({ conversationId: "main-handoff", input: text, invocation: { kind: "agent", source: "interactive" }, options: { source: "interactive", turnContext: { turnId: "new-user-intent" } }, surfacePrincipal: "rpc:owner" });
    await f.application.recover("main-handoff");
    f.protocol.releaseConversation("main-handoff");
    expect((await f.historySources("ws:reports:primary"))[0]?.state).toBe("queued");
    expect(await f.protocol.isWorksceneContinuationCurrent({ conversationId: child.conversationId, runId: child.runId })).toBe(true);
    expect(f.executions).toEqual(["main-handoff"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["conversation-clear", "conversation-delete"] as const)("workscene continuation stops descendants after %s", async (kind) => {
    const f = await worksceneContinuationHarness();
    await f.start();
    await f.application.recover("main-handoff");
    await f.protocol.writeSession({ conversationId: "main-handoff", requestId: `stop:${kind}`, mutation: kind === "conversation-clear" ? { kind: "window-op", op: "clear" } : { kind }, principal: f.protocol.controlPrincipal({ surfacePrincipal: "rpc:owner", connectionId: "lifecycle-handoff" }), conversationExists: async () => true });
    await f.application.recover("main-handoff");
    expect((await f.historySources("main-handoff"))[0]?.current).toBe(false);
    expect((await f.historySources("ws:reports:primary"))[0]?.state).toBe("cancelled");
    expect(f.executions).toEqual(["main-handoff"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("workscene continuation keeps target-side supplemental input without cancelling its delegation", async () => {
    const f = await worksceneContinuationHarness();
    await f.start();
    await f.application.recover("main-handoff");
    const target = "ws:reports:primary";
    await f.protocol.admit({ conversationId: target, input: "报告需要包含来源", invocation: { kind: "agent", source: "interactive" }, options: { source: "interactive", turnContext: { turnId: "target-new-intent" } }, surfacePrincipal: "rpc:owner" });
    await f.application.recover(target);
    expect((await f.historySources(target))[0]?.state).toBe("queued");
    expect(f.executions).toEqual(["main-handoff"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it("workscene continuation precisely stops a committed source and replays the stop without reviving descendants", async () => {
    const f = await worksceneContinuationHarness();
    await f.start();
    await f.application.recover("main-handoff");
    const source = (await f.historySources("main-handoff"))[0]!;
    const request = { conversationId: source.conversationId, runId: source.runId, requestId: "stop-original", principal: f.protocol.controlPrincipal({ surfacePrincipal: "rpc:owner", connectionId: "stop-source" }) };
    await f.protocol.cancel(request);
    f.protocol.releaseConversation(source.conversationId);
    await f.protocol.cancel(request);
    expect((await f.historySources(source.conversationId))[0]).toMatchObject({ state: "committed", current: false });
    await f.application.recover(source.conversationId);
    expect((await f.historySources("ws:reports:primary"))[0]?.state).toBe("cancelled");
    expect(f.executions).toEqual(["main-handoff"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it("workscene continuation commits a targeted stop before a new handoff in the same turn and replays both", async () => {
    const f = await worksceneContinuationHarness((tasks) => {
      expect(tasks).toHaveLength(1);
      const { conversationId, runId } = tasks[0]!;
      return { intent: { kind: "enter", sceneId: "replacement", handoff: { goal: "整理新报告", constraints: [], completed: [], remaining: ["整理新资料"] } }, stops: [{ conversationId, runId }] };
    });
    await f.start();
    await f.application.recover("main-handoff");
    const managed = await f.manager.getOrCreate("main-handoff");
    expectSettled(await projectSessionTurn({ manager: f.manager, managed, text: "停止原报告，改为整理新报告", turnId: "replace-original", runOptions: { source: "interactive", surfacePrincipal: "rpc:owner", turnContext: { turnId: "replace-original" } }, notify: () => {} }));
    await f.application.recover("main-handoff");
    f.protocol.releaseConversation("main-handoff");
    await f.application.recover("main-handoff");
    expect((await f.historySources("main-handoff"))[0]).toMatchObject({ state: "committed", current: false });
    expect((await f.historySources("ws:reports:primary"))[0]?.state).toBe("cancelled");
    expect(await f.historySources("ws:replacement:primary")).toHaveLength(1);
    expect((await f.historySources("ws:replacement:primary"))[0]?.state).toBe("queued");
    expect(f.executions).toEqual(["main-handoff", "main-handoff"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it("workscene continuation consumes the issued root stop after returning and redelegating, including durable reload", async () => {
    let rootRunId: string;
    const f = await worksceneContinuationHarness((tasks, index) => {
      if (index === 3) return { intent: { kind: "enter", sceneId: "second", handoff: { goal: "交付报告", constraints: ["不发布"], completed: ["第一阶段完成"], remaining: ["第二阶段核实"] } } };
      if (index === 4) {
        expect(tasks).toEqual([{ conversationId: "main-handoff", runId: rootRunId, goal: "交付报告" }]);
        const target = { conversationId: "main-handoff", runId: rootRunId };
        return { intent: { kind: "stop_task", ...target }, stops: [target] };
      }
      return undefined;
    });
    await f.start();
    rootRunId = (await f.historySources("main-handoff"))[0]!.runId;
    await vi.waitFor(async () => {
      for (const id of ["main-handoff", "ws:reports:primary", "ws:second:primary"]) await f.protocol.recoverConversation(id);
      expect(f.executions).toEqual(["main-handoff", "ws:reports:primary", "main-handoff", "ws:second:primary"]);
      expect((await f.historySources("main-handoff"))[0]?.current).toBe(false);
    }, { timeout: TEST_DURABLE_IO_TIMEOUT_MS, interval: 100 });
    for (const id of ["main-handoff", "ws:reports:primary", "ws:second:primary"]) f.protocol.releaseConversation(id);
    await f.application.stop({ conversationId: "ws:second:primary", target: { conversationId: "main-handoff", runId: rootRunId }, requestId: "repeat-root-stop" });
    await f.protocol.recover();
    expect((await f.historySources("main-handoff"))[0]).toMatchObject({ state: "committed", current: false });
    expect(await f.application.tasks("ws:second:primary")).toEqual([]);
    expect(f.executions).toHaveLength(4);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});
