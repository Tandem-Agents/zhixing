// 首发窗口内的定时补漏：本次接纳为立即可调度 → run 接管 → 首次进入 provider 之间，定时恢复轮把只带这次接纳登记的会话
// 错开一轮（登记与代际保留，下一轮照常）；新登记、其他会话、显式请求与全局步不受影响。
// 真实协议运行时、权威日志、日志 journal 与执行端边界；模型是可控替身，在进入 provider 之前可以卡住。
import { ForegroundActivity } from "@zhixing/core/resources";
import { type Message } from "@zhixing/core";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import { type SessionRuntime } from "@zhixing/owner-kernel/types";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { TEST_DURABLE_IO_TIMEOUT_MS, TEST_LOCAL_EXECUTOR, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, getOrCreateActiveConversation, expectSettled, MemorySecretStore } from "./conversation-protocol-runtime-fixture.js";

interface Gate { readonly reached: Promise<void>; arrive(): void; readonly held: Promise<void>; release(): void }
function gate(): Gate {
  let arrive!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { reached, arrive, held, release };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 等运行卡在 provider 之前；首发先结束（失败）就直接报出，不空等到用例超时
const reached = (held: Gate, outcome: Promise<unknown>) => Promise.race([held.reached,
  outcome.then(() => { throw new Error("first send ended before reaching the provider"); })]);

describe("ConversationProtocolRuntime first-send recovery window", () => {
  async function windowHarness(name: string) {
    const home = await createTempDir(name);
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    // 每个会话下一次运行卡在哪一段（用一次即撤）：进入 provider 之前、等模型（进入 provider 之后）、收束（模型结束后提交结果包）
    type Stage = "before-provider" | "model-wait" | "settlement";
    const stageGates = new Map<string, { readonly stage: Stage; readonly gate: Gate }>();
    const executions = new Map<string, number>();
    const pass = async (conversationId: string, stage: Stage) => {
      const held = stageGates.get(conversationId);
      if (!held || held.stage !== stage) return;
      stageGates.delete(conversationId); held.gate.arrive(); await held.gate.held;
    };
    const runtimeFor = (conversationId: string): SessionRuntime => ({ ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run(messages, options) {
        executions.set(conversationId, (executions.get(conversationId) ?? 0) + 1);
        await pass(conversationId, "before-provider");
        options?.modelProviderPhases?.entered();
        await pass(conversationId, "model-wait");
        options?.modelProviderPhases?.settled();
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage }, newMessages: [assistant], durationMs: 1 };
      }, abort: () => false, async dispose() {} });
    let manager!: ConversationManager;
    const failures: string[] = [];
    const protocol = createProtocol({ authority, manager: () => manager, onFailure: (error: unknown, context: unknown) => { failures.push(`${JSON.stringify(context)} ${String(error)}`); }, interactions: new DurableConversationInteractionObserver(), foreground: new ForegroundActivity(),
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async (conversationId: string) => runtimeFor(conversationId) } } });
    manager = new ConversationManager({ create: async (conversationId: string) => runtimeFor(conversationId) }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    // 启动时的就绪恢复已完成（生产里它在恢复循环开始之前）；此后的义务只经登记进入队列
    await protocol.recoverReadinessProjections();
    // 逐会话恢复链的标志步：首发运行路径不调用，逐会话链在基底准备之后调用（恢复调度起来的运行发布终态时也会调用）；
    // 可按会话卡住，使一轮恢复停在途中
    const original = ConversationRunJournal.prototype.resumeCommittedProjections;
    const chainGates = new Map<string, Gate>();
    const chain = vi.spyOn(ConversationRunJournal.prototype, "resumeCommittedProjections").mockImplementation(async function (this: ConversationRunJournal) {
      const held = chainGates.get(this.conversationId);
      if (held) { chainGates.delete(this.conversationId); held.arrive(); await held.held; }
      return original.call(this);
    });
    const chainCalls = (conversationId: string) =>
      chain.mock.contexts.filter((journal) => (journal as ConversationRunJournal).conversationId === conversationId).length;
    // 收束段卡点：本机运行模型结束后经日志提交结果包
    const originalSubmit = ConversationRunJournal.prototype.submitBundle;
    const submit = vi.spyOn(ConversationRunJournal.prototype, "submitBundle").mockImplementation(async function (this: ConversationRunJournal, ...args: Parameters<typeof originalSubmit>) {
      await pass(this.conversationId, "settlement");
      return originalSubmit.apply(this, args);
    });
    const conversation = (conversationId: string) => getOrCreateActiveConversation(authority, manager, conversationId);
    // 生产首发的接纳入口：manager.admitTurn 的 beforeEnqueue 调 admitDurableTurn（立即可调度时准备接纳并持前台），
    // 执行时 run() 按同一会话、接入身份与轮次接管这份准备
    const turn = async (conversationId: string, turnId: string) => {
      const managed = await conversation(conversationId);
      const options = { source: "interactive" as const, surfacePrincipal: "rpc:owner", turnContext: { turnId } };
      const admitted = await manager.admitDurableTurn({ conversationId, input: "hello", invocation: { kind: "agent", source: "interactive" },
        surfacePrincipal: "rpc:owner", options });
      expect(admitted.shouldEnqueue).toBe(true);
      return projectSessionTurn({ manager, managed, text: "hello", turnId, runOptions: options, notify: () => {} });
    };
    const admit = (conversationId: string, turnId: string) => protocol.admit({ conversationId, input: "queued",
      invocation: { kind: "agent", source: "interactive" }, surfacePrincipal: "rpc:owner",
      options: { source: "interactive", turnContext: { turnId } } });
    const holdAt = (conversationId: string, stage: Stage) => { const held = gate(); stageGates.set(conversationId, { stage, gate: held }); return held; };
    const holdProvider = (conversationId: string) => holdAt(conversationId, "before-provider");
    const holdChain = (conversationId: string) => { const held = gate(); chainGates.set(conversationId, held); return held; };
    return { authority, protocol, manager, failures, chainCalls, executions: (conversationId: string) => executions.get(conversationId) ?? 0,
      conversation, turn, admit, holdAt, holdProvider, holdChain,
      close: async () => {
        for (const held of [...[...stageGates.values()].map((entry) => entry.gate), ...chainGates.values()]) held.release();
        chain.mockRestore();
        submit.mockRestore();
        await protocol.stopRecoveryLoop();
        await manager.disposeAll();
      } };
  }

  it("skips the first send's own recovery chain in a periodic round inside the window, keeps the mark and handles it in the next round", async () => {
    const h = await windowHarness("first-send-window-defer");
    const globalPages = vi.spyOn(h.authority.controlAdmission, "pendingCancellations");
    const globalRounds = () => globalPages.mock.calls.filter((call) => call[1] === undefined).length;
    try {
      const provider = h.holdProvider("conv-a");
      const outcome = h.turn("conv-a", "turn-a");
      // 已过票据接纳、start-and-report 与打开运行输入，尚未进入 provider
      await reached(provider, outcome);
      h.protocol.startRecoveryLoop(100);
      await h.protocol.whileRecoveryPaused(async () => {
        // 首轮已结束：全局步照常，首发会话的逐会话链没有重做；暂停期间计时器到点只记欠一轮
        expect(globalRounds()).toBe(1);
        expect(h.chainCalls("conv-a")).toBe(0);
        await sleep(300);
      });
      // 暂停结束立即补上第二轮：窗口仍开着，但每个窗口至多错开一次，保留的登记这一轮处理
      await h.protocol.whileRecoveryPaused(async () => {
        expect(globalRounds()).toBe(2);
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      provider.release();
      expectSettled(await outcome);
    } finally { globalPages.mockRestore(); await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("handles a newer obligation of the same conversation and other conversations in the same round, rotating only the deferred mark", async () => {
    const h = await windowHarness("first-send-window-newer");
    try {
      // B：任务未交 run() 交回的真义务，排在 A 的首发登记之后
      const provider = h.holdProvider("conv-a");
      const outcome = h.turn("conv-a", "turn-a");
      await reached(provider, outcome);
      await h.conversation("conv-b");
      const deferred = await h.admit("conv-b", "turn-b");
      h.protocol.deferScheduling("conv-b", deferred.runId);
      h.protocol.startRecoveryLoop(60_000);
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBe(0);
        expect(h.chainCalls("conv-b")).toBeGreaterThan(0);
      });
      await h.protocol.stopRecoveryLoop();
      // A 在窗口内又收到一条后续输入：登记代际变化，不再只是首发那一次的例行登记，下一轮照原路径处理
      await h.admit("conv-a", "turn-a-2");
      h.protocol.startRecoveryLoop(60_000);
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      provider.release();
      expectSettled(await outcome);
    } finally { await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["completed", "failed-before-attempt", "deferred", "cancelled", "stopped"] as const)("releases the window when the first send is %s; the next periodic round handles the conversation", async (exit) => {
    const name = `conv-${exit}`;
    const h = await windowHarness(`first-send-window-${exit}`);
    // 接管之后、尝试开始之前失败一次（读取下一次尝试序号）
    const original = ConversationRunJournal.prototype.nextAssignmentAttempt;
    let attemptFailures = 0;
    const attempt = vi.spyOn(ConversationRunJournal.prototype, "nextAssignmentAttempt").mockImplementation(function (this: ConversationRunJournal, ...args: Parameters<typeof original>) {
      if (exit === "failed-before-attempt" && attemptFailures === 0) { attemptFailures++; return Promise.reject(new Error("attempt read failed")); }
      return original.apply(this, args);
    });
    try {
      if (exit === "completed") {
        expectSettled(await h.turn(name, `turn-${exit}`));
      } else if (exit === "failed-before-attempt") {
        expect((await h.turn(name, `turn-${exit}`)).kind).toBe("error");
        expect(attemptFailures).toBe(1);
      } else {
        await h.conversation(name);
        const admitted = await h.admit(name, `turn-${exit}`);
        expect(admitted.shouldSchedule).toBe(true);
        if (exit === "deferred") h.protocol.deferScheduling(name, admitted.runId);
        else if (exit === "cancelled") await h.protocol.cancelAdmitted(name, admitted.runId);
        // 停止循环即释放窗口：登记未变、这个窗口也还没错开过，重新开始后的第一轮照常处理
        else await h.protocol.stopRecoveryLoop();
      }
      h.protocol.startRecoveryLoop(60_000);
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls(name)).toBeGreaterThan(0);
      });
    } finally { attempt.mockRestore(); await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("completes an explicit recovery of a conversation the in-flight periodic round did not select, without running beside that round", async () => {
    const h = await windowHarness("first-send-window-explicit");
    try {
      await h.conversation("conv-a");
      await h.conversation("conv-b");
      const deferred = await h.admit("conv-b", "turn-b");
      h.protocol.deferScheduling("conv-b", deferred.runId);
      // 定时轮已选定队列（只有 B）并停在 B 的逐会话链里
      const slow = h.holdChain("conv-b");
      h.protocol.startRecoveryLoop(60_000);
      await slow.reached;
      const explicit = h.protocol.recoverConversation("conv-a");
      await sleep(200);
      // 在途的一轮结束之前不另起一轮并发处理
      expect(h.chainCalls("conv-a")).toBe(0);
      slow.release();
      await explicit;
      expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      expect(h.chainCalls("conv-b")).toBeGreaterThan(0);
    } finally { await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("does not defer an explicit recovery of the conversation inside its first-send window", async () => {
    const h = await windowHarness("first-send-window-explicit-target");
    try {
      const provider = h.holdProvider("conv-a");
      const outcome = h.turn("conv-a", "turn-a");
      await reached(provider, outcome);
      await h.protocol.recoverConversation("conv-a");
      expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      provider.release();
      expectSettled(await outcome);
    } finally { await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["model-wait", "settlement"] as const)("defers the first periodic round once while the local owner is in %s, then handles the kept mark in the next round", async (stage) => {
    const h = await windowHarness(`first-send-window-${stage}`);
    try {
      const held = h.holdAt("conv-a", stage);
      const outcome = h.turn("conv-a", "turn-a");
      await reached(held, outcome);
      h.protocol.startRecoveryLoop(100);
      await h.protocol.whileRecoveryPaused(async () => {
        // 本机持有者仍在负责这次运行：第一轮让开一次，登记保留
        expect(h.chainCalls("conv-a")).toBe(0);
        await sleep(300);
      });
      // 持有者跨过第二轮：这个窗口已让过，第二轮照常处理
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      held.release();
      expectSettled(await outcome);
      expect(h.executions("conv-a")).toBe(1);
    } finally { await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("handles an independent obligation of the same conversation arriving while the model is waited on, without running the turn twice", async () => {
    const h = await windowHarness("first-send-window-independent");
    try {
      const held = h.holdAt("conv-a", "model-wait");
      const outcome = h.turn("conv-a", "turn-a");
      await reached(held, outcome);
      // 同会话的独立登记（任务未交接一类的交回）：窗口不再只含本次例行登记
      h.protocol.deferScheduling("conv-a", "run:independent-obligation");
      h.protocol.startRecoveryLoop(60_000);
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      held.release();
      expectSettled(await outcome);
      expect(h.executions("conv-a")).toBe(1);
    } finally { await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("does not wash an independent mark made between admission's two registrations into routine", async () => {
    const h = await windowHarness("first-send-window-admission-gap");
    const target = h.authority.controlAdmission.pendingCancellations.bind(h.authority.controlAdmission);
    let injected = false;
    const spy = vi.spyOn(h.authority.controlAdmission, "pendingCancellations").mockImplementation(async (...args: Parameters<typeof target>) => {
      // 接纳首次登记之后、第二次登记之前，读取本会话待决取消时插入一条独立登记
      if (!injected && (args[1] as { conversationId?: string } | undefined)?.conversationId === "conv-a") {
        injected = true;
        h.protocol.deferScheduling("conv-a", "run:handover-during-admission");
      }
      return target(...args);
    });
    try {
      const held = h.holdProvider("conv-a");
      const outcome = h.turn("conv-a", "turn-a");
      await reached(held, outcome);
      expect(injected).toBe(true);
      h.protocol.startRecoveryLoop(60_000);
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      held.release();
      expectSettled(await outcome);
    } finally { spy.mockRestore(); await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("keeps an independent mark that was already pending before the admission ahead of the first send's routine marks", async () => {
    const h = await windowHarness("first-send-window-prior-mark");
    try {
      await h.conversation("conv-a");
      // 接纳之前已有的独立交接登记（旧任务交回一类），还没被任何一轮处理
      h.protocol.deferScheduling("conv-a", "run:older-handover");
      const held = h.holdProvider("conv-a");
      const outcome = h.turn("conv-a", "turn-a");
      await reached(held, outcome);
      h.protocol.startRecoveryLoop(60_000);
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      held.release();
      expectSettled(await outcome);
      expect(h.executions("conv-a")).toBe(1);
    } finally { await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("keeps an independent mark that arrives while the admission itself is being applied", async () => {
    const h = await windowHarness("first-send-window-apply-mark");
    const lookup = h.authority.controlAdmission.lookup.bind(h.authority.controlAdmission);
    let injected = false;
    const spy = vi.spyOn(h.authority.controlAdmission, "lookup").mockImplementation(async (...args: Parameters<typeof lookup>) => {
      const body = (args[0] as { envelope?: { body?: { t?: string; conversationId?: string } } }).envelope?.body;
      // 输入接纳写入之前（接纳的首次登记之前、跨 await 的那一段）到达一条同会话的独立登记
      if (!injected && body?.t === "input" && body.conversationId === "conv-a") {
        injected = true;
        h.protocol.deferScheduling("conv-a", "run:handover-during-apply");
      }
      return lookup(...args);
    });
    try {
      const held = h.holdProvider("conv-a");
      const outcome = h.turn("conv-a", "turn-a");
      await reached(held, outcome);
      expect(injected).toBe(true);
      h.protocol.startRecoveryLoop(60_000);
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      held.release();
      expectSettled(await outcome);
    } finally { spy.mockRestore(); await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("does not let a new run of the same conversation refresh the yield before the kept mark is handled", async () => {
    const h = await windowHarness("first-send-window-no-refresh");
    try {
      const first = h.holdProvider("conv-a");
      const firstOutcome = h.turn("conv-a", "turn-a");
      await reached(first, firstOutcome);
      h.protocol.startRecoveryLoop(100);
      let secondOutcome!: Promise<unknown>;
      let second!: Gate;
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBe(0);
        // 第一次运行结束、新运行立刻接着开始（新窗口），都在下一轮之前
        first.release();
        expectSettled(await firstOutcome);
        second = h.holdProvider("conv-a");
        secondOutcome = h.turn("conv-a", "turn-a-2");
        await reached(second, secondOutcome);
        await sleep(300);
      });
      await h.protocol.whileRecoveryPaused(async () => {
        expect(h.chainCalls("conv-a")).toBeGreaterThan(0);
      });
      second.release();
      expectSettled(await secondOutcome as Awaited<ReturnType<typeof h.turn>>);
    } finally { await h.close(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});
