import { writeFile } from "node:fs/promises";
import { FileArtifactStore } from "@zhixing/core/authority";
import type {
  AssignmentGlobalQueryPort,
  GlobalReadResult,
  GlobalStatePort,
  Signature,
  SkillCatalogEntry,
} from "@zhixing/core/contracts";
import {
  createSignedExecutionAssetSnapshot,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { SkillCatalogKernelProjectionApplicationService } from "@zhixing/core/skills/catalog";
import {
  parseRubricDocument,
  rubricDocumentId,
  skillNameToId,
  stringifyRubricDraft,
} from "@zhixing/core";
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
  it("preserves Authority order and produces byte-equal local/Executor Skill projections", async () => {
    const sourceArtifacts = new FileArtifactStore(await createTempDir("execution-assets-source"));
    const mainZRef = await sourceArtifacts.put(Buffer.from("# main z\nread-only", "utf8"));
    const mainARef = await sourceArtifacts.put(Buffer.from("# main a\nread-only", "utf8"));
    const extraMainRefs = await Promise.all(
      Array.from({ length: 19 }, (_, index) =>
        sourceArtifacts.put(Buffer.from(`# main extra ${index}\nread-only`, "utf8"))
      ),
    );
    const disabledShadowRef = await sourceArtifacts.put(
      Buffer.from("# disabled user shadow\nread-only", "utf8"),
    );
    const workRef = await sourceArtifacts.put(Buffer.from("# work\nread-only", "utf8"));
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
    const skills = [
      skillEntry(mainZRef, {
        id: "skill:z-authority-first",
        name: "Z first",
        createdAt: "2026-08-06T23:59:59.000Z",
      }),
      skillEntry(mainARef, {
        id: "skill:a-authority-second",
        name: "A second",
        createdAt: "2026-08-06T23:59:58.000Z",
      }),
      ...extraMainRefs.map((ref, index) => skillEntry(ref, {
        id: `skill:authority-${String(19 - index).padStart(2, "0")}`,
        name: `Authority ${index}`,
        createdAt: `2026-08-06T23:59:${String(57 - index).padStart(2, "0")}.000Z`,
      })),
      skillEntry(disabledShadowRef, {
        id: skillNameToId("提炼技能"),
        name: "Disabled user shadow",
        disabled: true,
        createdAt: "2026-08-06T23:59:38.000Z",
      }),
      skillEntry(workRef, {
        id: "skill:work",
        name: "Work",
        mode: "work",
        createdAt: "2026-08-06T23:59:37.000Z",
      }),
    ];
    const rubricId = rubricDocumentId(parseRubricDocument(rubricRaw));
    const state = stateFor({ skills, rubricId, rubricRef, promptRef });
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
    expect(snapshot.skills.map(({ id }) => id)).toEqual(skills.map(({ id }) => id));
    await expect(source.read({ kind: "skill-get", skillId: skills[0]!.id })).resolves.toMatchObject({
      kind: "skill-get",
      catalogRevision: 7,
      entry: { id: skills[0]!.id, contentRef: mainZRef },
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
    for (const mode of ["main", "work"] as const) {
      await expect(projectSkills(target, mode)).resolves.toEqual(
        await projectSkills(authorityQuery(state), mode),
      );
    }
    const installedEntry = await target.read({
      kind: "skill-get",
      skillId: skills[0]!.id,
    });
    if (installedEntry.kind !== "skill-get" || !installedEntry.entry) {
      throw new Error("installed Skill entry is missing");
    }
    await expect(targetArtifacts.get(installedEntry.entry.contentRef)).resolves.toEqual(
      Buffer.from("# main z\nread-only", "utf8"),
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

    await targetArtifacts.delete(mainZRef);
    await expect(target.read({ kind: "skill-catalog", includeDisabled: true }))
      .rejects.toThrow("skill body is missing or corrupt");
    await expect(target.read({ kind: "skill-get", skillId: skills[0]!.id }))
      .rejects.toThrow("skill body is missing or corrupt");
    await expect(target.bundle()).rejects.toThrow();
  });

  it("rejects incomplete, rolled-back and same-revision-equivocating Skill catalogs", async () => {
    const artifacts = new FileArtifactStore(await createTempDir("execution-assets-reject"));
    const firstRef = await artifacts.put(Buffer.from("first", "utf8"));
    const secondRef = await artifacts.put(Buffer.from("second", "utf8"));
    const skills = [
      skillEntry(firstRef, {
        id: "skill:z-first",
        name: "First",
        createdAt: "2026-08-06T23:59:59.000Z",
      }),
      skillEntry(secondRef, {
        id: "skill:a-second",
        name: "Second",
        createdAt: "2026-08-06T23:59:58.000Z",
      }),
    ];
    const cache = new FileExecutionAssetCache(
      `${await createTempDir("execution-assets-reject-state")}/snapshot.json`,
      artifacts,
      verifier,
    );
    const snapshot = await cache.publishFromAuthority({
      state: stateFor({ skills }),
      anchorEpoch: 1,
      signer,
      generatedAt: NOW,
    });
    const bundle = await cache.bundle();
    if (!bundle) throw new Error("execution asset bundle is missing");
    const targetArtifacts = new FileArtifactStore(
      await createTempDir("execution-assets-reject-artifacts"),
    );
    const target = new FileExecutionAssetCache(
      `${await createTempDir("execution-assets-reject-target")}/snapshot.json`,
      targetArtifacts,
      verifier,
    );
    await expect(target.installBundle({ ...bundle, artifacts: [] })).rejects.toThrow("incomplete");
    await expect(target.current()).resolves.toBeUndefined();
    await target.installBundle(bundle);

    const reorderedSkills = [
      skillEntry(secondRef, {
        id: "skill:a-second",
        name: "Second",
        createdAt: "2026-08-06T23:59:59.000Z",
      }),
      skillEntry(firstRef, {
        id: "skill:z-first",
        name: "First",
        createdAt: "2026-08-06T23:59:58.000Z",
      }),
    ];
    const reordered = createSignedExecutionAssetSnapshot({
      snapshotRevision: snapshot.snapshotRevision + 1,
      skillCatalogRevision: snapshot.skillCatalogRevision,
      skills: reorderedSkills,
      rubrics: snapshot.rubrics,
      promptAssets: snapshot.promptAssets,
      generatedAt: "2026-08-07T00:00:01.000Z",
    }, signer);
    await expect(target.installBundle({
      v: 1,
      snapshot: reordered,
      artifacts: bundle.artifacts,
    })).rejects.toThrow(
      "cannot change signed Skill content or order",
    );

    const rolledBack = createSignedExecutionAssetSnapshot({
      snapshotRevision: snapshot.snapshotRevision + 1,
      skillCatalogRevision: snapshot.skillCatalogRevision - 1,
      skills: snapshot.skills,
      rubrics: snapshot.rubrics,
      promptAssets: snapshot.promptAssets,
      generatedAt: "2026-08-07T00:00:01.000Z",
    }, signer);
    await expect(target.installBundle({
      v: 1,
      snapshot: rolledBack,
      artifacts: bundle.artifacts,
    })).rejects.toThrow(
      "Skill catalog revision cannot be rolled back",
    );

    const promptBytes = Buffer.from("next prompt", "utf8");
    const promptRef = await targetArtifacts.put(promptBytes);
    const independentPromptUpdate = createSignedExecutionAssetSnapshot({
      snapshotRevision: snapshot.snapshotRevision + 1,
      skillCatalogRevision: snapshot.skillCatalogRevision,
      skills: snapshot.skills,
      rubrics: snapshot.rubrics,
      promptAssets: [{
        id: "prompt:next",
        kind: "prompt-assets",
        revision: 1,
        digest: promptRef.digest,
      }],
      generatedAt: "2026-08-07T00:00:01.000Z",
    }, signer);
    await expect(target.installBundle({
      v: 1,
      snapshot: independentPromptUpdate,
      artifacts: [
        ...bundle.artifacts,
        { ref: promptRef, contentBase64: promptBytes.toString("base64") },
      ],
    })).resolves.toEqual(
      independentPromptUpdate,
    );
  });

  it("fails closed when the signed index or an Authority-declared Skill body is corrupt", async () => {
    const artifacts = new FileArtifactStore(await createTempDir("execution-assets-corrupt"));
    const skillRef = await artifacts.put(Buffer.from("skill", "utf8"));
    const skill = skillEntry(skillRef);
    const filePath = `${await createTempDir("execution-assets-corrupt-state")}/snapshot.json`;
    const cache = new FileExecutionAssetCache(filePath, artifacts, verifier);
    await cache.publishFromAuthority({
      state: stateFor({ skills: [skill] }),
      anchorEpoch: 1,
      signer,
      generatedAt: NOW,
    });
    await writeFile(filePath, "{}\n", "utf8");
    await expect(cache.read({ kind: "skill-catalog", includeDisabled: true }))
      .rejects.toThrow();
    await expect(cache.bundle()).rejects.toThrow();

    const missingArtifacts = new FileArtifactStore(
      await createTempDir("execution-assets-missing-authority"),
    );
    const missingRef = await missingArtifacts.put(Buffer.from("missing", "utf8"));
    await missingArtifacts.delete(missingRef);
    const missingCache = new FileExecutionAssetCache(
      `${await createTempDir("execution-assets-missing-state")}/snapshot.json`,
      missingArtifacts,
      verifier,
    );
    await expect(missingCache.publishFromAuthority({
      state: stateFor({ skills: [skillEntry(missingRef)] }),
      anchorEpoch: 1,
      signer,
      generatedAt: NOW,
    })).rejects.toThrow("skill body is missing or corrupt");
    await expect(missingCache.current()).resolves.toBeUndefined();
  });
});

function skillEntry(
  contentRef: SkillCatalogEntry["contentRef"],
  input: {
    readonly id?: string;
    readonly name?: string;
    readonly mode?: "main" | "work";
    readonly disabled?: boolean;
    readonly createdAt?: string;
  } = {},
): SkillCatalogEntry {
  const entry: Omit<SkillCatalogEntry, "digest"> = {
    id: input.id ?? "skill:local-cache",
    name: input.name ?? "本地缓存技能",
    description: "只读缓存技能",
    source: "own",
    mode: input.mode ?? "main",
    pinned: false,
    disabled: input.disabled ?? false,
    createdAt: input.createdAt ?? NOW,
    usage: null,
    contentRef,
    revision: 2,
  };
  return { ...entry, digest: protocolDigest("SkillCatalogEntry", 1, entry) };
}

function stateFor(input: {
  readonly skills: readonly SkillCatalogEntry[];
  readonly rubricId?: string;
  readonly rubricRef?: SkillCatalogEntry["contentRef"];
  readonly promptRef?: SkillCatalogEntry["contentRef"];
}): GlobalStatePort {
  return {
    async read(query): Promise<GlobalReadResult> {
      if (query.kind === "skill-catalog") {
        return { kind: "skill-catalog", catalogRevision: 7, entries: [...input.skills] };
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

function projectSkills(
  query: AssignmentGlobalQueryPort,
  mode: "main" | "work",
) {
  return new SkillCatalogKernelProjectionApplicationService({
    async readCatalog() {
      const result = await query.read({
        kind: "skill-catalog",
        includeDisabled: true,
      });
      if (result.kind !== "skill-catalog") {
        throw new Error("Skill catalog query returned another result type");
      }
      return {
        catalogRevision: result.catalogRevision,
        entries: result.entries,
      };
    },
  }).project(mode);
}

function authorityQuery(state: GlobalStatePort): AssignmentGlobalQueryPort {
  return {
    read: (query) => state.read(query, {
      principal: { kind: "host", component: "execution-asset-cache-test" },
      requestId: "execution-asset-cache-test",
      deadlineAt: "2026-08-07T00:01:00.000Z",
      authority: { domain: "global", anchorEpoch: 4 },
    }),
  };
}
