// 宿主模式下本地执行帧的执行作用域：开始执行前打开、帧出口关闭；执行以待确认离开执行帧之后，
// 同一进程不重启，执行端租约到期后的恢复一轮即退休它的资源根。权威时钟由注入控制，只证明时序合同。
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { type SessionRuntime } from "@zhixing/owner-kernel/types";
import { ConversationAssignmentLedger } from "@zhixing/executor";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import {
  MemorySecretStore,
  TEST_DURABLE_IO_TIMEOUT_MS,
  TEST_RUNTIME_AUTHORITY_FACTS,
  createProtocol,
  getOrCreateActiveConversation,
  setupAuthorityRuntime,
} from "./conversation-protocol-runtime-fixture.js";

describe("宿主模式下本地执行的资源退休", () => {
  it("执行帧在开始前打开作用域、出口关闭；以待确认结束后不重启，租约到期的恢复一轮即退休", async () => {
    const home = await createTempDir("conversation-lost-execution");
    let offsetMs = 0;
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      lostExecutionRetirement: true,
      clock: () => new Date(Date.now() + offsetMs).toISOString(),
    });
    const governor = authority.executorResourceGovernor!;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-lost-execution",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        throw new Error("model failed");
      },
      abort: () => false,
      async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
    });
    const conversationId = "conversation-lost-execution";
    await getOrCreateActiveConversation(authority, manager, conversationId);
    // 未完成副作用让运行以待确认结束：执行端没有终局，根留在 active
    const openEffects = vi.spyOn(ConversationAssignmentLedger.prototype, "hasOpenSideEffects").mockResolvedValue(true);
    const execution = protocol.run({ conversationId, input: "check", messages: [{ role: "user", content: [{ type: "text", text: "check" }] }], baseRevision: 0,
      runtime, invocation: { kind: "agent", source: "interactive" }, options: { turnContext: { turnId: "rpc:lost-execution" }, source: "interactive" } });
    const failure = await (async () => {
      try { let step = await execution.next(); while (!step.done) step = await execution.next(); }
      catch (error) { return error; }
      finally { openEffects.mockRestore(); }
    })();
    // 开始执行成功（宿主模式下没有作用域会在开始前被拒），失败首因是执行体本身
    expect(String((failure as Error).message ?? failure)).not.toContain("execution scope");
    const [lease] = await governor.activeAssignmentReceipts();
    expect(lease).toBeDefined();
    // 执行帧已关闭作用域：本进程不再持有它
    expect(() => governor.assertExecutionScope(lease!.activation.assignmentId)).toThrow("execution scope");

    // 不重启：权威墙钟越过租约后的恢复一轮退休。治理首次判断后按单调时钟计时，这里无法注入单调时钟，
    // 所以首次判断放在拨钟之后；“未到期不退休”与“首次判断后按单调时钟”由 executor 层用例证明。
    offsetMs = 60 * 60 * 1_000;
    await protocol.recover();
    expect(await governor.activeAssignmentReceipts()).toHaveLength(0);
    expect((await governor.snapshot()).reservations.get(lease!.reservationId)?.state).toBe("reclaimed");
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});
