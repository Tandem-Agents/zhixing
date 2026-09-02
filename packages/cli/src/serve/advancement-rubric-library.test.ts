import { describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "@zhixing/core/authority";
import type { AdvancementRubricArtifactPort } from "@zhixing/core/advancement/application";
import type { GlobalStatePort } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import type { RubricContractDraftSnapshot } from "@zhixing/core";
import { GlobalRubricCatalog, GlobalRubricPublication } from "./advancement-rubric-library.js";

const NOW = "2026-08-03T12:00:00.000Z";

function projectRubricArtifacts(
  artifacts: FileArtifactStore,
): AdvancementRubricArtifactPort {
  return {
    readByDigest: async (digest) => {
      const ref = await artifacts.referenceForDigest(digest);
      return ref ? artifacts.get(ref) : undefined;
    },
    put: (bytes) => artifacts.put(bytes),
  };
}

function draft(): RubricContractDraftSnapshot {
  return {
    draftId: "draft-1",
    originalTurnId: "turn-1",
    source: "generated",
    candidateRubricIds: [],
    title: "交付验收",
    description: "判断任务是否完成。",
    content: {
      passCriteria: ["核心功能完成"],
      evidenceRequirements: [],
      failureHandling: [{ id: "continue", scenario: "未完成", reply: "继续完成。" }],
    },
    createdAt: NOW,
  };
}

describe("advancement Rubric global adapters", () => {
  it("锚点不可用时不伪装已保存", async () => {
    const publication = new GlobalRubricPublication({
      globalState: () => undefined,
      artifacts: () => undefined,
      anchorEpoch: () => undefined,
      now: () => NOW,
    });

    expect(publication.acceptanceOutcome()).toEqual({
      kind: "deferred",
      message: "准则已用于本任务，连接值班设备后可保存到准则库。",
    });
    await expect(publication.publish({
      conversationId: "conv-1",
      draft: draft(),
      persistence: { kind: "save-new" },
    })).resolves.toEqual(publication.acceptanceOutcome());
  });

  it("在线保存先落内容资产，再用稳定请求写全局目录", async () => {
    const artifacts = new FileArtifactStore(await createTempDir("adv-rubric-assets"));
    const mutate = vi.fn(async () => ({ revision: 7 }));
    const state = {
      read: vi.fn(),
      mutate,
    } as unknown as GlobalStatePort;
    const publication = new GlobalRubricPublication({
      globalState: () => state,
      artifacts: () => projectRubricArtifacts(artifacts),
      anchorEpoch: () => 4,
      now: () => NOW,
    });

    expect(publication.acceptanceOutcome().message).toContain("正在独立保存");
    await expect(publication.publish({
      conversationId: "conv-1",
      draft: draft(),
      persistence: { kind: "save-new" },
    })).resolves.toMatchObject({ kind: "saved", revision: 7 });

    expect(mutate).toHaveBeenCalledTimes(1);
    const [mutation, context] = mutate.mock.calls[0]!;
    expect(mutation).toMatchObject({
      kind: "rubric-save-own",
      rubric: { title: "交付验收", description: "判断任务是否完成。" },
    });
    expect(mutation.rubric.content).toMatchObject({ bytes: expect.any(Number) });
    expect(await artifacts.has(mutation.rubric.content)).toBe(true);
    expect(context).toMatchObject({
      principal: { kind: "host", component: "advancement-rubric-publication" },
      requestId: "rubric-publish:draft-1:save-new",
      authority: { domain: "global", anchorEpoch: 4 },
    });
  });

  it("目录内容资产缺失时 fail closed", async () => {
    const artifacts = new FileArtifactStore(await createTempDir("adv-rubric-missing"));
    const state = {
      read: async () => ({
        kind: "asset-index" as const,
        asset: "rubrics" as const,
        revision: 1,
        entries: [{
          id: "rubric-1",
          revision: 1,
          digest: `sha256:${"b".repeat(64)}`,
        }],
      }),
      mutate: vi.fn(),
    } as unknown as GlobalStatePort;
    const catalog = new GlobalRubricCatalog({
      globalState: () => state,
      artifacts: () => projectRubricArtifacts(artifacts),
      anchorEpoch: () => 1,
      now: () => NOW,
    });

    await expect(catalog.load("rubric-1")).rejects.toThrow("content asset is missing");
  });
});
