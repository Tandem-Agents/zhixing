// 可用之后的消息无关准备（prepareAfterUsable）的单一准备责任：在真实准备入口上加可控阻塞，证明
// 准备卡住时发送照常完成、同会话在途时复用同一份、换会话后旧准备不再起新步、停止后不再起新工作。
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "@zhixing/core";
import { ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import type { SessionRuntime } from "@zhixing/owner-kernel/types";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { executorIdForDevice } from "../executor-identity.js";
import { loadOrCreateDeviceKey } from "../mesh-device-key.js";
import {
  TEST_LOCAL_EXECUTOR, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, getOrCreateActiveConversation, expectSettled,
  MemorySecretStore,
} from "./conversation-protocol-runtime-fixture.js";

const CONVERSATION = "after-usable";

function completingRuntime(): SessionRuntime {
  return { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: CONVERSATION,
    async *run(messages) {
      const assistant: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };
      const usage = { inputTokens: 0, outputTokens: 0 };
      return { agentResult: { reason: "completed" as const, message: assistant, usage },
        runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage },
        newMessages: [assistant], durationMs: 1 };
    }, abort: () => false, async dispose() {},
  };
}

async function setup() {
  const home = await createTempDir("after-usable");
  const secretStore = new MemorySecretStore();
  const deviceKey = await loadOrCreateDeviceKey(secretStore);
  const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore, deviceKey, executorId: executorIdForDevice(deviceKey.deviceId) });
  const runtime = completingRuntime();
  let manager!: ConversationManager;
  const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
    localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => runtime } } });
  manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
  const managed = await getOrCreateActiveConversation(authority, manager, CONVERSATION);
  const send = async (turnId: string) => expectSettled(await projectSessionTurn({ manager, managed, text: turnId, turnId,
    runOptions: { source: "interactive", turnContext: { turnId } }, notify: () => {} }));
  await send("history-0");
  const close = async () => { await protocol.stopRecoveryLoop(); await manager.disposeAll(); };
  return { protocol, send, close };
}

/** 让第一步（推进票据前沿）停在闸门上：照常执行原方法，只在放行前不进入；记下每一步被哪个会话日志调用。 */
function gateFirstStep() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const firstStep: object[] = [];
  const affinity: object[] = [];
  const originalFacts = ConversationRunJournal.prototype.dataPlaneTicketFacts;
  const originalAffinity = ConversationRunJournal.prototype.recentExecutorAffinity;
  vi.spyOn(ConversationRunJournal.prototype, "dataPlaneTicketFacts").mockImplementation(async function (this: ConversationRunJournal) {
    firstStep.push(this);
    await gate;
    return originalFacts.call(this);
  });
  vi.spyOn(ConversationRunJournal.prototype, "recentExecutorAffinity").mockImplementation(function (this: ConversationRunJournal) {
    affinity.push(this);
    return originalAffinity.call(this);
  });
  return { open, firstStep, affinity };
}

afterEach(() => { vi.restoreAllMocks(); });

it("accepts and completes a send while preparation is blocked, and shares one in-flight preparation", async () => {
  const { protocol, send, close } = await setup();
  const gate = gateFirstStep();
  try {
    const first = protocol.prepareAfterUsable(CONVERSATION);
    expect(protocol.prepareAfterUsable(CONVERSATION)).toBe(first);
    // 准备卡在第一步时发送照常被接受并收束：前台不等准备，也不等安静
    await send("first");
    // 发送自己的准备段也会读执行端亲和；放行后准备只再走一次后续步骤
    const beforeOpen = gate.affinity.length;
    gate.open();
    await first;
    expect(gate.firstStep).toHaveLength(1);
    expect(gate.affinity.length - beforeOpen).toBe(1);
  } finally { gate.open(); await close(); }
}, 120_000);

it("stops an old conversation's preparation after switching and starts nothing after stop", async () => {
  const { protocol, close } = await setup();
  const gate = gateFirstStep();
  try {
    const old = protocol.prepareAfterUsable(CONVERSATION);
    // 换到另一会话：旧准备被中止，放行后它不再进入后续步骤
    const next = protocol.prepareAfterUsable("after-usable-other").catch(() => undefined);
    gate.open();
    await old;
    await next;
    expect(gate.affinity.filter((journal) => journal === gate.firstStep[0])).toEqual([]);
    // 停止后不再开始新的准备
    const calls = gate.firstStep.length;
    await protocol.stopRecoveryLoop();
    await protocol.prepareAfterUsable(CONVERSATION);
    expect(gate.firstStep).toHaveLength(calls);
  } finally { gate.open(); await close(); }
}, 120_000);

it("waits at stop for a replaced preparation that is still finishing its current step", async () => {
  const { protocol, close } = await setup();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let calls = 0;
  const original = ConversationRunJournal.prototype.dataPlaneTicketFacts;
  // 只有第一次（A 的第一步）停在闸门上；换到 B 后 B 照常走完
  vi.spyOn(ConversationRunJournal.prototype, "dataPlaneTicketFacts").mockImplementation(async function (this: ConversationRunJournal) {
    if (calls++ === 0) await gate;
    return original.call(this);
  });
  try {
    let oldSettled = false;
    void protocol.prepareAfterUsable(CONVERSATION).then(() => { oldSettled = true; }, () => { oldSettled = true; });
    await protocol.prepareAfterUsable("after-usable-other").catch(() => undefined);
    let stopped = false;
    const stopping = protocol.stopRecoveryLoop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A 仍在收尾第一步：停止必须等它，不能因为当前一份（B）已结束就返回
    expect(stopped).toBe(false);
    open();
    await stopping;
    expect(oldSettled).toBe(true);
  } finally { open(); await close(); }
}, 120_000);
