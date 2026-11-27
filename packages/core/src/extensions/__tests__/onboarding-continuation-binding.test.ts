import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { FileArtifactStore } from "../../authority/artifact-store.js";
import { FileAuthorityCommitLog } from "../../authority/commit-log.js";
import { ExtensionApplication, extensionPublicSnapshot } from "../application.js";
import { ExtensionArtifacts } from "../artifacts.js";
import { ExtensionCandidates } from "../candidate.js";
import type { ExtensionCandidate, ExtensionContinuationBinding } from "../contracts.js";
import {
  ExtensionOnboarding,
  type ExtensionContinuationDeliverResult,
} from "../onboarding.js";

const owners: FileAuthorityCommitLog[] = [];
const managers: ExtensionOnboarding[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop();
  for (const owner of owners.splice(0)) await owner.stopStorageMaintenance();
});

async function setupOnboarding() {
  const root = await createTempDir("ext-pre-send-binding");
  const owner = new FileAuthorityCommitLog(
    join(root, "authority"),
    new FileArtifactStore(join(root, "facts")),
  );
  owners.push(owner);
  const application = new ExtensionApplication({ log: () => owner, assertOwner() {} });
  const code = "export const ok = true;";
  const candidate: ExtensionCandidate = {
    manifest: {
      id: "ext",
      version: "1.0.0",
      digest: createHash("sha256").update(code).digest("hex"),
      runtime: "node24",
      entry: "extension.mjs",
      protocol: 1,
      type: "ext",
      contract: 1,
      declaration: {},
    },
    code,
    provenance: { url: "https://example.com/ext", revision: "v1.0.0", kind: "authored" },
    sources: { "ext.mjs": code },
    build: "Node 24",
  };
  return { root, application, candidate };
}

describe("ExtensionOnboarding durable pre-send continuation binding", () => {
  it("persists (targetConversationId, turnId) before external send and reuses it across retries without double-running", async () => {
    const { root, application, candidate } = await setupOnboarding();
    await application.prepare("op-1", "inst-1", { conversationId: "local-1", request: "connect ext" });

    const deliveries: ExtensionContinuationBinding[] = [];
    let planCalls = 0;
    let attempt = 0;
    let sawBindingInOperationBeforeSend = false;

    const onboarding = new ExtensionOnboarding(
      application,
      new ExtensionArtifacts(join(root, "artifacts")),
      new ExtensionCandidates(join(root, "candidates")),
      {
        validate() {},
        configuration: async () => undefined,
        discard: async () => {},
        changed: async () => {},
        notify: async () => undefined,
        planContinuation: async () => {
          planCalls += 1;
          return {
            targetConversationId: planCalls === 1 ? "local-1" : "main-fallback-should-not-hit",
            turnId: `ext_turn_${planCalls}`,
          };
        },
        deliverContinuation: async (op, binding): Promise<ExtensionContinuationDeliverResult> => {
          deliveries.push(binding);
          const stored = await application.operation(op.id);
          sawBindingInOperationBeforeSend =
            stored?.boundContinuation?.targetConversationId === binding.targetConversationId &&
            stored?.boundContinuation?.turnId === binding.turnId;
          attempt += 1;
          // 前两次模拟网络超时 / 只读查无返回 pending-reconcile
          if (attempt <= 2) {
            return { outcome: "pending-reconcile" };
          }
          return { outcome: "accepted", continuation: { deliveredTo: binding.targetConversationId, turnId: binding.turnId } };
        },
        isActive: () => true,
      },
    );
    managers.push(onboarding);

    // 第一次 reconcile：先绑定后投递，超时保持 pending-reconcile
    await onboarding.reconcile("op-1");
    expect(sawBindingInOperationBeforeSend).toBe(true);
    expect(planCalls).toBe(1);
    const afterFirst = (await application.operation("op-1"))!;
    expect(afterFirst.boundContinuation).toEqual({
      phase: "preparing",
      revision: 1,
      targetConversationId: "local-1",
      turnId: "ext_turn_1",
    });
    expect(afterFirst.notifiedRevision).toBeUndefined();
    // Public snapshot 必须隐藏 boundContinuation
    expect(extensionPublicSnapshot(await application.list()).operations?.[0]).not.toHaveProperty(
      "boundContinuation",
    );

    // 第二、三次 reconcile：即使外部情况变化，也不重规划、也不改投 fallback，复用同一 (local-1, ext_turn_1)
    await onboarding.reconcile("op-1");
    await onboarding.reconcile("op-1");
    expect(planCalls).toBe(1);
    expect(deliveries).toEqual([
      { phase: "preparing", revision: 1, targetConversationId: "local-1", turnId: "ext_turn_1" },
      { phase: "preparing", revision: 1, targetConversationId: "local-1", turnId: "ext_turn_1" },
      { phase: "preparing", revision: 1, targetConversationId: "local-1", turnId: "ext_turn_1" },
    ]);
    expect((await application.operation("op-1"))?.notifiedRevision).toBe(1);
    void candidate;
  });

  it("switches to fallbackTarget only upon explicit terminal-rejected fence and clears stale binding on phase advance", async () => {
    const { root, application, candidate } = await setupOnboarding();
    await application.prepare("op-2", "inst-2", { conversationId: "local-gone", request: "connect ext" });

    const deliveries: string[] = [];
    const onboarding = new ExtensionOnboarding(
      application,
      new ExtensionArtifacts(join(root, "artifacts")),
      new ExtensionCandidates(join(root, "candidates")),
      {
        validate() {},
        configuration: async () => undefined,
        discard: async () => {},
        changed: async () => {},
        notify: async () => undefined,
        planContinuation: async () => ({
          targetConversationId: "local-gone",
          turnId: "ext_primary",
        }),
        deliverContinuation: async (_op, binding) => {
          deliveries.push(`${binding.targetConversationId}:${binding.turnId}`);
          if (binding.targetConversationId === "local-gone") {
            return {
              outcome: "terminal-rejected",
              fallbackTarget: { targetConversationId: "default", turnId: "ext_fallback" },
            };
          }
          return { outcome: "accepted" };
        },
        isActive: () => true,
      },
    );
    managers.push(onboarding);

    await onboarding.reconcile("op-2");
    expect(deliveries).toEqual(["local-gone:ext_primary", "default:ext_fallback"]);
    const notifiedOp = (await application.operation("op-2"))!;
    expect(notifiedOp.notifiedRevision).toBe(1);
    expect(notifiedOp.boundContinuation?.targetConversationId).toBe("default");

    // 推进到下一修订（configuration）后旧 boundContinuation 必须清空
    await application.candidate("op-2", 1, candidate.manifest);
    const nextPhaseOp = (await application.operation("op-2"))!;
    expect(nextPhaseOp.revision).toBe(2);
    expect(nextPhaseOp.boundContinuation).toBeUndefined();
  });
});
