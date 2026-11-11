// 执行端账本对维护准入背压的段外接续（注入背压的受控反例，不是完整的后台占额度竞争）：
// 单次背压照常接续并收束；等待中取消则醒来后不再进入操作；持续背压按轮次上限或期限有界结束，不挂住。
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "@zhixing-ai/core";
import { StorageMaintenanceAdmissionError, runWithMaintenanceUrgency } from "@zhixing-ai/core/resources";
import { ConversationAssignmentLedger } from "@zhixing-ai/executor";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import type { SessionRuntime } from "@zhixing-ai/owner-kernel/types";
import { projectSessionTurn } from "@zhixing-ai/rpc";
import { createTempDir } from "@zhixing-ai/test-utils";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { executorIdForDevice } from "../executor-identity.js";
import { loadOrCreateDeviceKey } from "../mesh-device-key.js";
import {
  TEST_LOCAL_EXECUTOR, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, getOrCreateActiveConversation, expectSettled,
  MemorySecretStore,
} from "./conversation-protocol-runtime-fixture.js";

const CONVERSATION = "ledger-maintenance-retry";

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

/** 搭好协议运行时；执行端启动这一步进行中时，执行端日志的投影事务按 reject() 决定是否被维护准入背压拒绝。 */
async function setup(reject: (rejected: number) => boolean, retryAfterMs = 10, onReject?: () => void) {
  const home = await createTempDir("ledger-maintenance-retry");
  const secretStore = new MemorySecretStore();
  const deviceKey = await loadOrCreateDeviceKey(secretStore);
  const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore, deviceKey, executorId: executorIdForDevice(deviceKey.deviceId) });
  const runtime = completingRuntime();
  let manager!: ConversationManager;
  const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
    localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => runtime } } });
  manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
  const managed = await getOrCreateActiveConversation(authority, manager, CONVERSATION);
  const counts = { starting: 0, rejected: 0 };
  const originalStart = ConversationAssignmentLedger.prototype.start;
  vi.spyOn(ConversationAssignmentLedger.prototype, "start").mockImplementation(async function (this: ConversationAssignmentLedger, ...args: Parameters<ConversationAssignmentLedger["start"]>) {
    counts.starting++;
    try { return await originalStart.apply(this, args); } finally { counts.starting--; }
  });
  const log = authority.executorLog;
  const originalTransact = log.transactProjection.bind(log);
  vi.spyOn(log, "transactProjection").mockImplementation(((...args: Parameters<typeof log.transactProjection>) => {
    if (counts.starting > 0 && reject(counts.rejected)) {
      counts.rejected++;
      onReject?.();
      return Promise.reject(new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "probe-unavailable", retryAfterMs }));
    }
    return originalTransact(...args);
  }) as typeof log.transactProjection);
  const turn = () => projectSessionTurn({ manager, managed, text: "first", turnId: "first",
    runOptions: { source: "interactive", turnContext: { turnId: "first" } }, notify: () => {} });
  const close = async () => { await protocol.stopRecoveryLoop(); await manager.disposeAll(); };
  return { counts, turn, close };
}

afterEach(() => { vi.restoreAllMocks(); });

it("continues an executor ledger step rejected once by maintenance backpressure instead of failing the run", async () => {
  const { counts, turn, close } = await setup((rejected) => rejected === 0);
  try {
    expectSettled(await turn());
    expect(counts.rejected).toBe(1);
  } finally { await close(); }
}, 120_000);

it("attempts no further ledger transaction after cancellation during the backpressure wait", async () => {
  const cancel = new AbortController();
  // 第一次被拒后很快取消；等待（200 ms）中途醒来，查到取消就不再进入
  const { counts, turn, close } = await setup(() => true, 200, () => { setTimeout(() => cancel.abort(), 20); });
  try {
    await runWithMaintenanceUrgency(() => "background", cancel.signal, () => turn()).catch(() => undefined);
    expect(counts.rejected).toBe(1);
  } finally { await close(); }
}, 120_000);

it("ends persistent backpressure within the round limit or deadline instead of hanging", async () => {
  const { counts, turn, close } = await setup(() => true, 10);
  try {
    await turn().catch(() => undefined);
    // 每轮 10 ms：至多 64 轮重做后照原样抛出，不无限接续
    expect(counts.rejected).toBeGreaterThan(1);
    expect(counts.rejected).toBeLessThanOrEqual(65);
  } finally { await close(); }
}, 120_000);
