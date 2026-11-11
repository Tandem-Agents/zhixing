import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationBroker, type ConfirmationDecision, type ConfirmationRequest } from "@zhixing-ai/core/confirmation";
import { canonicalize, type ConversationInteractionOutcome } from "@zhixing-ai/core/protocol";
import {
  DurablePermissionRuleStore,
  ExplicitApprovalEffects,
  explicitApprovalBucket,
  explicitApprovalRuleId,
} from "@zhixing-ai/core/security";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  DurableConversationInteractionObserver,
  type DurableInteractionBinding,
} from "./durable-conversation-interactions.js";

const SCOPE = { kind: "workspace", hash: "binding-a", revision: 1 } as const;
const BUCKET = explicitApprovalBucket(SCOPE, "allow-context");
const PATTERN = { pattern: { tool: "bash", argument: "npm test" }, label: "npm test" };

/**
 * 执行端台账替身：按真实 InProcessAssignmentSubmission.finishAndMirror 的顺序先耐久记交互
 * 结果、再冲刷镜像；同一结果重放幂等，不同结果冲突。可分别注入"结果未落盘"与"镜像冲刷失败"。
 */
function ledgerDouble() {
  const outcomes = new Map<string, ConversationInteractionOutcome>();
  const faults = { finish: 0, mirror: 0 };
  const finishAndMirror = vi.fn(async (_assignmentId: string, requestId: string, outcome: ConversationInteractionOutcome) => {
    if (faults.finish > 0) {
      faults.finish -= 1;
      throw new Error("ledger finish failed");
    }
    const existing = outcomes.get(requestId);
    if (existing && canonicalize(existing) !== canonicalize(outcome)) {
      throw new Error("Interaction requestId already has a different terminal result");
    }
    outcomes.set(requestId, outcome);
    if (faults.mirror > 0) {
      faults.mirror -= 1;
      throw new Error("mirror flush failed");
    }
  });
  const flushInteractionMirrors = vi.fn(async () => {
    if (faults.mirror > 0) {
      faults.mirror -= 1;
      throw new Error("mirror flush failed");
    }
    return 0;
  });
  return { outcomes, faults, finishAndMirror, flushInteractionMirrors };
}

async function fixture(options: { readonly rootDir?: string } = {}) {
  const rootDir = options.rootDir ?? await createTempDir("trust-approval-lifecycle");
  const store = new DurablePermissionRuleStore(rootDir);
  const effects = new ExplicitApprovalEffects(store);
  const observer = new DurableConversationInteractionObserver({ explicitApprovals: effects });
  const broker = new ConfirmationBroker({ lifecycleObserver: observer });
  const ledger = ledgerDouble();
  const binding = {
    assignmentId: "assignment-1",
    conversationId: "conversation-1",
    surfacePrincipal: "surface:origin",
    broker,
    ledger: {
      requestInteraction: async () => ({ accepted: true }),
      interactionStreamEvents: async () => [],
      conversationInteractionOutcome: async (_assignmentId: string, requestId: string) => ledger.outcomes.get(requestId),
    },
    submission: { finishAndMirror: ledger.finishAndMirror, flushInteractionMirrors: ledger.flushInteractionMirrors },
    context: {},
    stream: { append: vi.fn(async () => undefined) },
    streamMeta: {},
  } as unknown as DurableInteractionBinding;
  const request = (id: string): ConfirmationRequest => ({
    id, tool: "bash", toolInput: { command: "npm test" }, workingDirectory: "",
    display: { title: "运行命令", body: { kind: "generic", summary: "npm test" }, cwd: "" },
    options: [{ kind: "allow-once", label: "允许" }],
    sessionType: "interactive", contextId: SCOPE, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  const ask = async (id: string) => {
    const decision = observer.withBinding(binding, () => broker.requestConfirmation(request(id)));
    await vi.waitFor(() => expect(broker.listPending().map((entry) => entry.request.id)).toContain(id));
    // 包一层：直接返回 Promise 会被 async 函数等到决定落定
    return { decision };
  };
  return { rootDir, store, effects, observer, broker, ledger, ask };
}

const allowContext: ConfirmationDecision = { kind: "allow-context", pattern: PATTERN };

describe("显式持久批准接在执行端耐久决定上", () => {
  it("待生效记录写失败：决定回到待确认、不落规则，改为仅本次照常放行", async () => {
    const parent = await createTempDir("trust-approval-blocked");
    const rootDir = path.join(parent, "permissions");
    fs.writeFileSync(rootDir, "not a directory");
    const { broker, store, ask, ledger } = await fixture({ rootDir });
    const { decision } = await ask("request-1");
    await expect(broker.resolveDurably("request-1", allowContext)).rejects.toThrow();
    expect(broker.listPending().map((entry) => entry.request.id)).toEqual(["request-1"]);
    expect(ledger.outcomes.has("request-1")).toBe(false);
    await expect(broker.resolveDurably("request-1", { kind: "allow-once" })).resolves.toBe(true);
    expect((await decision).kind).toBe("allow-once");
    expect(store.context(BUCKET)).toEqual([]);
  });

  it("耐久结果未落盘：回到待确认，待生效记录不生效，改选仅本次后被清掉", async () => {
    const { broker, store, ask, ledger } = await fixture();
    const { decision } = await ask("request-1");
    ledger.faults.finish = 1;
    await expect(broker.resolveDurably("request-1", allowContext)).rejects.toThrow("ledger finish failed");
    expect(broker.listPending().map((entry) => entry.request.id)).toEqual(["request-1"]);
    expect(store.context(BUCKET)).toEqual([]);
    expect(store.unacceptedApprovals(BUCKET)).toHaveLength(1);
    await expect(broker.resolveDurably("request-1", { kind: "allow-once" })).resolves.toBe(true);
    expect((await decision).kind).toBe("allow-once");
    expect(store.unacceptedApprovals(BUCKET)).toEqual([]);
    expect(store.context(BUCKET)).toEqual([]);
  });

  it("接纳后镜像冲刷失败：不回队，规则生效", async () => {
    const { broker, store, effects, ask, ledger } = await fixture();
    const { decision } = await ask("request-1");
    ledger.faults.mirror = 2;
    await expect(broker.resolveDurably("request-1", allowContext)).resolves.toBe(true);
    expect((await decision).kind).toBe("allow-context");
    expect(broker.listPending()).toEqual([]);
    expect(store.context(BUCKET).map((rule) => rule.id)).toEqual([explicitApprovalRuleId(BUCKET, "request-1")]);
    expect(effects.state("request-1")).toMatchObject({ kind: "effective", materialized: true });
  });

  it("接纳后物化失败：本次放行、规则已生效，重开按耐久决定恢复", async () => {
    const { rootDir, broker, store, effects, ask, ledger } = await fixture();
    const { decision } = await ask("request-1");
    // 先让待生效记录落盘，再让同一范围文件的下一次替换失败
    const prepare = effects.prepare.bind(effects);
    const file = path.join(rootDir, `${BUCKET}.json`);
    vi.spyOn(effects, "prepare").mockImplementation(async (input) => {
      await prepare(input);
      const saved = fs.readFileSync(file);
      fs.rmSync(file);
      fs.mkdirSync(file);
      fs.writeFileSync(`${file}.saved`, saved);
    });
    await expect(broker.resolveDurably("request-1", allowContext)).resolves.toBe(true);
    expect((await decision).kind).toBe("allow-context");
    expect(effects.state("request-1")).toMatchObject({ kind: "effective", materialized: false });
    expect(store.context(BUCKET)).toHaveLength(1);

    // 模拟进程在物化前结束：文件里只有待生效记录
    fs.rmSync(file, { recursive: true });
    fs.renameSync(`${file}.saved`, file);
    const reopened = new DurablePermissionRuleStore(rootDir);
    expect(reopened.context(BUCKET)).toEqual([]);
    const outcome = ledger.outcomes.get("request-1");
    await new ExplicitApprovalEffects(reopened).reconcile(BUCKET, async (entry) =>
      outcome?.t === "answered" && outcome.decisionDigest === entry.decisionDigest ? "accepted" : "rejected");
    expect(reopened.context(BUCKET).map((rule) => rule.id)).toEqual([explicitApprovalRuleId(BUCKET, "request-1")]);
  });

  it("取消先赢时批准不落规则；批准先赢后再取消或换决定不改变结果", async () => {
    const first = await fixture();
    const { decision: cancelled } = await first.ask("request-cancel");
    expect(first.broker.cancel("request-cancel", "aborted")).toBe(true);
    await expect(first.broker.resolveDurably("request-cancel", allowContext)).resolves.toBe(false);
    expect((await cancelled).kind).toBe("cancelled");
    expect(first.store.context(BUCKET)).toEqual([]);
    expect(first.store.unacceptedApprovals(BUCKET)).toEqual([]);

    const second = await fixture();
    const { decision: approved } = await second.ask("request-allow");
    const resolving = second.broker.resolveDurably("request-allow", allowContext);
    await expect(second.broker.resolveDurably("request-allow", { kind: "allow-global", pattern: PATTERN })).resolves.toBe(false);
    await expect(resolving).resolves.toBe(true);
    expect((await approved).kind).toBe("allow-context");
    second.broker.cancel("request-allow", "aborted");
    expect(second.store.context(BUCKET)).toHaveLength(1);
    expect(second.store.global()).toEqual([]);
  });

  it("规则撤销后重放同一答复不复活", async () => {
    const { broker, store, ask } = await fixture();
    const { decision } = await ask("request-1");
    await broker.resolveDurably("request-1", allowContext);
    await decision;
    await expect(store.revoke(explicitApprovalRuleId(BUCKET, "request-1"))).resolves.toBe(true);
    await expect(broker.resolveDurably("request-1", allowContext)).resolves.toBe(false);
    expect(store.context(BUCKET)).toEqual([]);
  });

  it("不支持持久批准的执行端：持久决定在接纳前被拒、回到待确认", async () => {
    const observer = new DurableConversationInteractionObserver();
    const broker = new ConfirmationBroker({ lifecycleObserver: observer });
    const ledger = ledgerDouble();
    const binding = {
      assignmentId: "assignment-1", surfacePrincipal: "surface:origin", broker,
      ledger: { requestInteraction: async () => ({ accepted: true }), interactionStreamEvents: async () => [] },
      submission: { finishAndMirror: ledger.finishAndMirror }, context: {}, stream: { append: vi.fn() }, streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const pending = observer.withBinding(binding, () => broker.requestConfirmation({
      id: "request-1", tool: "bash", toolInput: {}, workingDirectory: "",
      display: { title: "运行命令", body: { kind: "generic", summary: "npm test" }, cwd: "" },
      options: [{ kind: "allow-once", label: "允许" }], sessionType: "interactive", contextId: SCOPE,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }));
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    await expect(broker.resolveDurably("request-1", allowContext)).rejects.toThrow(/不支持持久授权/u);
    expect(ledger.finishAndMirror).not.toHaveBeenCalled();
    broker.cancelAll("aborted");
    await pending;
  });
});
