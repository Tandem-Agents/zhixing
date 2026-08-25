import { FileArtifactStore } from "@zhixing/core/authority";
import type {
  GlobalReadResult,
  GlobalStatePort,
  Signature,
  SkillCatalogEntry,
} from "@zhixing/core/contracts";
import {
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { stringifyRubricDraft, rubricDocumentId, parseRubricDocument } from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { GlobalRubricCatalog } from "./advancement-rubric-library.js";
import { FileExecutionAssetCache } from "./execution-asset-cache.js";

const NOW = "2026-08-07T00:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device:anchor",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

describe("FileExecutionAssetCache", { timeout: 30_000 }, () => {
  it("publishes, transfers and reads a version-bound path-free cache", async () => {
    const sourceArtifacts = new FileArtifactStore(await createTempDir("execution-assets-source"));
    const skillRef = await sourceArtifacts.put(Buffer.from("# skill\nread-only", "utf8"));
    const rubricRaw = stringifyRubricDraft({
      title: "本地交付验收",
      description: "从冻结缓存读取",
      content: {
        passCriteria: ["缓存命中。"],
        evidenceRequirements: ["读取冻结资产。"],
        failureHandling: [{ scenario: "未命中", reply: "继续使用本地草案。" }],
      },
    });
    const rubricRef = await sourceArtifacts.put(Buffer.from(rubricRaw, "utf8"));
    const promptRef = await sourceArtifacts.put(Buffer.from("local prompt", "utf8"));
    const skill = skillEntry(skillRef);
    const rubricId = rubricDocumentId(parseRubricDocument(rubricRaw));
    const state = stateFor({ skill, rubricId, rubricRef, promptRef });
    const source = new FileExecutionAssetCache(
      `${await createTempDir("execution-assets-state")}/snapshot.json`,
      sourceArtifacts,
      verifier,
    );

    const snapshot = await source.publishFromAuthority({
      state,
      anchorEpoch: 4,
      signer,
      generatedAt: NOW,
    });
    expect(snapshot.snapshotRevision).toBe(2);
    await expect(source.read({ kind: "skill-get", skillId: skill.id })).resolves.toMatchObject({
      kind: "skill-get",
      catalogRevision: 7,
      entry: { id: skill.id, contentRef: skillRef },
    });
    await expect(source.read({ kind: "asset-index", asset: "rubrics" })).resolves.toEqual({
      kind: "asset-index",
      entries: [{ id: rubricId, kind: "rubrics", revision: 3, digest: rubricRef.digest }],
    });

    const targetArtifacts = new FileArtifactStore(await createTempDir("execution-assets-target"));
    const target = new FileExecutionAssetCache(
      `${await createTempDir("execution-assets-target-state")}/snapshot.json`,
      targetArtifacts,
      verifier,
    );
    const bundle = await source.bundle();
    if (!bundle) throw new Error("source execution asset bundle is missing");
    await target.installBundle(bundle);
    await expect(target.read({ kind: "skill-catalog", includeDisabled: true })).resolves.toEqual(
      await source.read({ kind: "skill-catalog", includeDisabled: true }),
    );
    const catalog = new GlobalRubricCatalog({
      globalState: () => undefined,
      artifacts: () => undefined,
      anchorEpoch: () => undefined,
      executionAssets: () => target,
    });
    await expect(catalog.load(rubricId)).resolves.toMatchObject({
      id: rubricId,
      title: "本地交付验收",
    });

    await targetArtifacts.delete(skillRef);
    await expect(target.read({ kind: "skill-get", skillId: skill.id })).resolves.toEqual({
      kind: "skill-get",
      catalogRevision: 7,
      entry: null,
    });
  });

  it("rejects incomplete bundles and revision rewrites before installing an index", async () => {
    const artifacts = new FileArtifactStore(await createTempDir("execution-assets-reject"));
    const skillRef = await artifacts.put(Buffer.from("skill", "utf8"));
    const skill = skillEntry(skillRef);
    const cache = new FileExecutionAssetCache(
      `${await createTempDir("execution-assets-reject-state")}/snapshot.json`,
      artifacts,
      verifier,
    );
    const snapshot = await cache.publishFromAuthority({
      state: stateFor({ skill }),
      anchorEpoch: 1,
      signer,
      generatedAt: NOW,
    });
    const bundle = await cache.bundle();
    if (!bundle) throw new Error("execution asset bundle is missing");
    const target = new FileExecutionAssetCache(
      `${await createTempDir("execution-assets-reject-target")}/snapshot.json`,
      new FileArtifactStore(await createTempDir("execution-assets-reject-artifacts")),
      verifier,
    );
    await expect(target.installBundle({ ...bundle, artifacts: [] })).rejects.toThrow("incomplete");
    await target.installBundle(bundle);
    await expect(target.install({
      ...snapshot,
      digest: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow("digest is invalid");
  });
});

function skillEntry(contentRef: SkillCatalogEntry["contentRef"]): SkillCatalogEntry {
  const entry: Omit<SkillCatalogEntry, "digest"> = {
    id: "skill:local-cache",
    name: "本地缓存技能",
    description: "只读缓存技能",
    source: "own",
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: NOW,
    usage: null,
    contentRef,
    revision: 2,
  };
  return { ...entry, digest: protocolDigest("SkillCatalogEntry", 1, entry) };
}

function stateFor(input: {
  readonly skill: SkillCatalogEntry;
  readonly rubricId?: string;
  readonly rubricRef?: SkillCatalogEntry["contentRef"];
  readonly promptRef?: SkillCatalogEntry["contentRef"];
}): GlobalStatePort {
  return {
    async read(query): Promise<GlobalReadResult> {
      if (query.kind === "skill-catalog") {
        return { kind: "skill-catalog", catalogRevision: 7, entries: [input.skill] };
      }
      if (query.kind === "asset-index" && query.asset === "rubrics") {
        return {
          kind: "asset-index",
          entries: input.rubricId && input.rubricRef
            ? [{ id: input.rubricId, kind: "rubrics", revision: 3, digest: input.rubricRef.digest }]
            : [],
        };
      }
      if (query.kind === "asset-index" && query.asset === "prompt-assets") {
        return {
          kind: "asset-index",
          entries: input.promptRef
            ? [{ id: "prompt:local", kind: "prompt-assets", revision: 5, digest: input.promptRef.digest }]
            : [],
        };
      }
      throw new Error(`Unexpected execution asset query: ${query.kind}`);
    },
    async mutate() {
      throw new Error("Execution asset test state is read-only");
    },
  } as GlobalStatePort;
}
