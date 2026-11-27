import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "@zhixing-ai/core/authority";
import type {
  AssignmentGlobalQueryPort,
  ExecutionAssetSnapshot,
  GlobalReadResult,
  GlobalStatePort,
  Signature,
} from "@zhixing-ai/core/contracts";
import {
  createSignedExecutionAssetSnapshot,
  createSignedExecutionAssetSnapshotV2,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import { encodeSkillPackageArchive } from "@zhixing-ai/core/skills/archive";
import {
  SkillCatalogLoadApplicationService,
  projectV1SkillEntryToV2,
  type SkillCatalogEntry,
  type SkillCatalogEntryV2,
} from "@zhixing-ai/core/skills/catalog";
import { createTempDir } from "@zhixing-ai/test-utils";
import { createAssignmentSkillPorts } from "../runtime/assignment-skill-adapter.js";
import { FileExecutionAssetCache } from "./execution-asset-cache.js";

const NOW = "2026-11-26T12:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "test-key",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) {
      throw new TypeError("Signature mismatch");
    }
  },
};

function makeV1Entry(
  id: string,
  contentRef: SkillCatalogEntry["contentRef"],
  revision = 1,
): SkillCatalogEntry {
  const base: Omit<SkillCatalogEntry, "digest"> = {
    id,
    name: id,
    description: `${id} desc`,
    source: "own",
    mode: "work",
    pinned: false,
    disabled: false,
    createdAt: NOW,
    usage: null,
    contentRef,
    revision,
  };
  return { ...base, digest: protocolDigest("SkillCatalogEntry", 1, base) };
}

function makeV2Entry(input: {
  readonly id: string;
  readonly contentRef: SkillCatalogEntryV2["contentRef"];
  readonly packageRef?: SkillCatalogEntryV2["packageRef"];
  readonly revision?: number;
  readonly visibility?: SkillCatalogEntryV2["visibility"];
  readonly disabled?: boolean;
}): SkillCatalogEntryV2 {
  const projected = projectV1SkillEntryToV2(makeV1Entry(input.id, input.contentRef, input.revision ?? 1));
  const base: Omit<SkillCatalogEntryV2, "digest"> = {
    ...projected,
    disabled: input.disabled ?? false,
    visibility: input.visibility ?? { modelAutoIndex: true, userSlashCommand: true },
    ...(input.packageRef ? { packageRef: input.packageRef } : {}),
  };
  const { digest: _old, ...withoutDigest } = base as Omit<SkillCatalogEntryV2, "digest"> & {
    digest?: string;
  };
  return {
    ...withoutDigest,
    digest: protocolDigest("SkillCatalogEntry", 2, withoutDigest),
  };
}

describe("ExecutionAssetCache dual-generation matrix & zero-whole-read contract", () => {
  it("handles v1-only, v1-newer, v2-newer visibility projection, and v2-only publish transitions", async () => {
    const fs = await import("node:fs/promises");
    const dir = await createTempDir("cache-v2-matrix");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const artifacts = new FileArtifactStore(path.join(dir, "artifacts"));
    const contentRef = await artifacts.put(Buffer.from("# Skill\nBody\n", "utf8"));
    const v1OnlyEntry = makeV1Entry("slash-only", contentRef, 1);

    // 1. v1-only state -> skill-catalog-v2 & skill-get-v2 project valid v2 digests cleanly
    const v1Cache = new FileExecutionAssetCache(
      path.join(dir, "v1-only", "execution-assets.json"),
      artifacts,
      verifier,
    );
    const v1Snap: ExecutionAssetSnapshot = createSignedExecutionAssetSnapshot(
      {
        snapshotRevision: 3,
        skillCatalogRevision: 1,
        skills: [v1OnlyEntry],
        rubrics: [],
        promptAssets: [],
        generatedAt: NOW,
      },
      signer,
    );
    await v1Cache.install(v1Snap);
    const catV2FromV1 = await v1Cache.read({ kind: "skill-catalog-v2", includeDisabled: false });
    expect(catV2FromV1.kind).toBe("skill-catalog-v2");
    if (catV2FromV1.kind !== "skill-catalog-v2") throw new Error("unreachable");
    expect(catV2FromV1.entries).toHaveLength(1);
    expect(catV2FromV1.entries[0]?.visibility).toEqual({
      modelAutoIndex: true,
      userSlashCommand: true,
    });
    const getV2FromV1 = await v1Cache.read({ kind: "skill-get-v2", skillId: "slash-only" });
    expect(getV2FromV1.kind === "skill-get-v2" && getV2FromV1.entry?.digest).toBe(
      catV2FromV1.entries[0]?.digest,
    );

    // 2. v1-newer beats older v2 in both v1 and v2 reads
    await v1Cache.installV2(
      createSignedExecutionAssetSnapshotV2(
        {
          snapshotRevision: 2,
          skillCatalogRevision: 1,
          skills: [
            makeV2Entry({
              id: "stale-v2",
              contentRef,
              visibility: { modelAutoIndex: true, userSlashCommand: true },
            }),
          ],
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      ),
    );
    const getFromNewerV1 = await v1Cache.read({ kind: "skill-get-v2", skillId: "slash-only" });
    expect(getFromNewerV1.kind === "skill-get-v2" && getFromNewerV1.entry?.id).toBe("slash-only");

    // 3. v2-newer with modelAutoIndex:false, userSlashCommand:true -> hidden in v1 skill-catalog(includeDisabled:false) & offline-asset
    await v1Cache.installV2(
      createSignedExecutionAssetSnapshotV2(
        {
          snapshotRevision: 5,
          skillCatalogRevision: 2,
          skills: [
            makeV2Entry({
              id: "slash-only",
              contentRef,
              revision: 2,
              disabled: false,
              visibility: { modelAutoIndex: false, userSlashCommand: true },
            }),
          ],
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      ),
    );
    const v1ModelCat = await v1Cache.read({ kind: "skill-catalog", includeDisabled: false });
    expect(v1ModelCat.kind === "skill-catalog" && v1ModelCat.entries).toEqual([]);
    const v2Cat = await v1Cache.read({ kind: "skill-catalog-v2", includeDisabled: false });
    expect(v2Cat.kind === "skill-catalog-v2" && v2Cat.entries[0]?.disabled).toBe(false);

    // 4. publishFromAuthority bumps both snapshots even on v2-only package attachment change and never swallows domain errors
    const pubCache = new FileExecutionAssetCache(
      path.join(dir, "pub", "execution-assets.json"),
      artifacts,
      verifier,
    );
    const badState = {
      async read() {
        throw new Error("This global state adapter only owns the workscene domain");
      },
      async mutate() {
        throw new Error("unused");
      },
    } as GlobalStatePort;
    await expect(
      pubCache.publishFromAuthority({
        state: badState,
        anchorEpoch: 1,
        signer,
        generatedAt: NOW,
      }),
    ).rejects.toThrow("This global state adapter only owns the workscene domain");

    const pkg1 = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "# Skill\nBody\n" },
      { path: "notes/a.txt", content: "v1" },
    ]);
    const pkg2 = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "# Skill\nBody\n" },
      { path: "notes/a.txt", content: "v2" },
    ]);
    const pkgRef1 = await artifacts.put(pkg1.bytes);
    const pkgRef2 = await artifacts.put(pkg2.bytes);
    let rev = 1;
    let activeEntry = makeV2Entry({ id: "pkg-skill", contentRef, packageRef: pkgRef1, revision: 1 });
    const authorityState = {
      async read(query): Promise<GlobalReadResult> {
        if (query.kind === "skill-catalog-v2") {
          return { kind: "skill-catalog-v2", catalogRevision: rev, entries: [activeEntry] };
        }
        return { kind: "asset-index", entries: [] };
      },
      async mutate() {
        throw new Error("unused");
      },
    } as GlobalStatePort;
    const snapA = await pubCache.publishFromAuthority({
      state: authorityState,
      anchorEpoch: 1,
      signer,
      generatedAt: NOW,
    });
    expect(snapA.skills[0]?.disabled).toBe(false);
    const snapAV2 = await pubCache.currentV2();
    expect(snapAV2?.snapshotRevision).toBe(snapA.snapshotRevision);

    // Change packageRef only + visibility modelAutoIndex:false
    rev = 2;
    activeEntry = makeV2Entry({
      id: "pkg-skill",
      contentRef,
      packageRef: pkgRef2,
      revision: 2,
      visibility: { modelAutoIndex: false, userSlashCommand: true },
    });
    const snapB = await pubCache.publishFromAuthority({
      state: authorityState,
      anchorEpoch: 1,
      signer,
      generatedAt: NOW,
    });
    const snapBV2 = await pubCache.currentV2();
    expect(snapB.snapshotRevision).toBeGreaterThan(snapA.snapshotRevision);
    expect(snapBV2?.snapshotRevision).toBe(snapB.snapshotRevision);
    expect(snapB.skills[0]?.disabled).toBe(true);
    expect(snapBV2?.skills[0]?.packageRef).toEqual(pkgRef2);
  });

  it("performs 0 full FileArtifactStore.get reads during offline catalog query & paginated 4 B leaf load", async () => {
    const fs = await import("node:fs/promises");
    const dir = await createTempDir("cache-zero-get");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const artifacts = new FileArtifactStore(path.join(dir, "artifacts"));
    const cache = new FileExecutionAssetCache(
      path.join(dir, "cache", "execution-assets.json"),
      artifacts,
      verifier,
    );
    const leafText = "FOUR";
    const skillMd = "---\nname: big\ndescription: 918 KiB archive\n---\nRoot\n";
    const { bytes: archiveBytes } = encodeSkillPackageArchive([
      { path: "SKILL.md", content: skillMd },
      { path: "templates/a.txt", content: "A".repeat(460 * 1024) },
      { path: "templates/b.txt", content: "B".repeat(460 * 1024) },
      { path: "leaf.txt", content: leafText },
    ]);
    expect(archiveBytes.byteLength).toBeGreaterThan(918 * 1024);
    const contentRef = await artifacts.put(Buffer.from(skillMd, "utf8"));
    const packageRef = await artifacts.put(archiveBytes);
    const entry = makeV2Entry({ id: "big", contentRef, packageRef });
    await cache.installV2(
      createSignedExecutionAssetSnapshotV2(
        {
          snapshotRevision: 2,
          skillCatalogRevision: 1,
          skills: [entry],
          rubrics: [],
          promptAssets: [],
          generatedAt: NOW,
        },
        signer,
      ),
    );

    const getSpy = vi.spyOn(FileArtifactStore.prototype, "get");
    const rangeSpy = vi.spyOn(FileArtifactStore.prototype, "readRange");

    const loader = new SkillCatalogLoadApplicationService({
      readScope: async (skillId) => {
        const res = await cache.read({ kind: "skill-get-v2", skillId });
        return {
          kind: "assignment",
          entry: res.kind === "skill-get-v2" ? res.entry : null,
          overlay: [],
          issuedAt: NOW,
        };
      },
      readContent: async (ref) => Buffer.from(await artifacts.get(ref)).toString("utf8"),
      readByteRange: async (ref, offset, length) =>
        cache.readArtifactRange(ref, offset, length),
      stageUsage: async () => {},
    });
    const navPage = await loader.readPackage({ id: "user:big" });
    expect("navigation" in navPage).toBe(true);
    if (!("navigation" in navPage)) throw new Error("expected package page");
    const leafPage = await loader.readPackage({
      id: "user:big",
      resource: "leaf.txt",
      expectedVersion: navPage.packageVersion,
    });
    expect("content" in leafPage).toBe(true);
    if (!("content" in leafPage)) throw new Error("expected package resource");
    expect(leafPage.content).toBe(leafText);
    expect(getSpy).toHaveBeenCalledTimes(0);
    expect(rangeSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("assignment adapter re-throws corrupt skill errors and computes valid v2 digest on v1 fallback", async () => {
    const fs = await import("node:fs/promises");
    const dir = await createTempDir("adapter-fallback");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const artifacts = new FileArtifactStore(path.join(dir, "artifacts"));
    const contentRef = await artifacts.put(Buffer.from("# Hi\n", "utf8"));
    const v1Entry = makeV1Entry("legacy-one", contentRef);

    const ports = createAssignmentSkillPorts(artifacts, { admissionLlm: null });
    const { runContextStorage } = await import("@zhixing-ai/orchestrator/runtime");
    const { validateGlobalQueryResult } = await import("@zhixing-ai/core/protocol");

    // Fallback when peer rejects skill-get-v2 as unsupported
    const legacyPort: AssignmentGlobalQueryPort = {
      async read(query) {
        if (query.kind === "skill-get-v2") {
          throw new Error("Global query kind is invalid");
        }
        return { kind: "skill-get", catalogRevision: 1, entry: v1Entry };
      },
    };
    const loaded = await runContextStorage.run(
      {
        conversationId: "conv-1",
        assignmentId: "asg-1",
        assignmentIssuedAt: NOW,
        globalQuery: legacyPort,
        assignmentMutations: {
          stage: async () => ({
            recordSeq: 1,
            requestId: "r1",
            mutationDigest: `sha256:${"0".repeat(64)}`,
            mutation: { kind: "skill-usage", skillId: "legacy-one", occurredAt: NOW, hitDelta: 1 },
          }),
          readOverlay: async () => [],
        },
        artifacts,
      },
      async () => {
        const res = await legacyPort.read({ kind: "skill-get", skillId: "legacy-one" });
        const entryV2 =
          res.kind === "skill-get" && res.entry ? projectV1SkillEntryToV2(res.entry) : null;
        expect(() =>
          validateGlobalQueryResult(
            { kind: "skill-get-v2", skillId: "legacy-one" },
            { kind: "skill-get-v2", catalogRevision: 1, entry: entryV2 },
          ),
        ).not.toThrow();
        return ports.loadApplication.load({ id: "user:legacy-one", operationId: "op-load-1" });
      },
    );
    expect("body" in loaded).toBe(true);

    // Corrupt error must NOT be swallowed by fallback
    const corruptPort: AssignmentGlobalQueryPort = {
      async read(query) {
        if (query.kind === "skill-get-v2") {
          throw new Error("Execution asset v2 skill body is missing or corrupt: legacy-one");
        }
        return { kind: "skill-get", catalogRevision: 1, entry: v1Entry };
      },
    };
    await expect(
      runContextStorage.run(
        {
          conversationId: "conv-2",
          assignmentId: "asg-2",
          assignmentIssuedAt: NOW,
          globalQuery: corruptPort,
          assignmentMutations: {
            stage: async () => {
              throw new Error("unused");
            },
            readOverlay: async () => [],
          },
          artifacts,
        },
        () => ports.loadApplication.load({ id: "user:legacy-one", operationId: "op-load-2" }),
      ),
    ).rejects.toThrow("Execution asset v2 skill body is missing or corrupt");
  });

  it("R2-1a: skips full body reads on unchanged publish/syncSourceV2 and only reads newly changed refs incrementally", async () => {
    const dir = await createTempDir("cache-v2-r2-1a");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const artifacts = new FileArtifactStore(path.join(dir, "artifacts"));
    const refA = await artifacts.put(Buffer.from("# Skill A\nbody a\n", "utf8"));
    const refB = await artifacts.put(Buffer.from("# Skill B\nbody b\n", "utf8"));
    const refB2 = await artifacts.put(Buffer.from("# Skill B\nbody b v2\n", "utf8"));
    const refC = await artifacts.put(Buffer.from("# Skill C\nbody c\n", "utf8"));
    const rubricRef = await artifacts.put(Buffer.from('{"rubric":1}\n', "utf8"));

    let catalogRev = 1;
    let skills: SkillCatalogEntryV2[] = [
      projectV1SkillEntryToV2(makeV1Entry("skill-a", refA, 1)),
      projectV1SkillEntryToV2(makeV1Entry("skill-b", refB, 1)),
    ];
    const rubrics = [{ id: "r-1", kind: "rubrics" as const, digest: rubricRef.digest, revision: 1 }];
    const state: GlobalStatePort = {
      async read(query) {
        if (query.kind === "skill-catalog-v2") {
          return { kind: "skill-catalog-v2", catalogRevision: catalogRev, entries: skills };
        }
        if (query.kind === "asset-index" && query.asset === "rubrics") {
          return { kind: "asset-index", entries: rubrics };
        }
        return { kind: "asset-index", entries: [] };
      },
      mutate: (async () => {
        throw new Error("unused");
      }) as GlobalStatePort["mutate"],
    };

    const cache = new FileExecutionAssetCache(
      path.join(dir, "execution-assets.json"),
      artifacts,
      verifier,
    );
    await cache.publishFromAuthority({ state, anchorEpoch: 1, signer, generatedAt: NOW });

    const getSpy = vi.spyOn(artifacts, "get");
    const refForDigestSpy = vi.spyOn(artifacts, "referenceForDigest");
    const readIdentitySpy = vi.spyOn(artifacts, "readIdentity");

    // Unchanged publish + syncSourceV2 must do 0 full reads and 0 referenceForDigest calls
    await cache.publishFromAuthority({ state, anchorEpoch: 1, signer, generatedAt: NOW });
    const sync1 = await cache.syncSourceV2();
    expect(sync1?.indexRefs).toEqual([{ digest: rubricRef.digest, bytes: rubricRef.bytes }]);
    expect(getSpy).toHaveBeenCalledTimes(0);
    expect(refForDigestSpy).toHaveBeenCalledTimes(0);
    expect(readIdentitySpy).toHaveBeenCalledTimes(2);

    getSpy.mockClear();
    refForDigestSpy.mockClear();
    readIdentitySpy.mockClear();

    // Incremental change: skill-a unchanged, skill-b updated to refB2, skill-c added
    catalogRev = 2;
    skills = [
      skills[0]!,
      projectV1SkillEntryToV2(makeV1Entry("skill-b", refB2, 2)),
      projectV1SkillEntryToV2(makeV1Entry("skill-c", refC, 1)),
    ];
    await cache.publishFromAuthority({ state, anchorEpoch: 1, signer, generatedAt: NOW });
    const readDigests = getSpy.mock.calls.map(([ref]) => ref.digest).sort();
    expect(readDigests).toEqual([refB2.digest, refC.digest].sort());
    expect(readDigests).not.toContain(refA.digest);
    expect(refForDigestSpy).toHaveBeenCalledTimes(0);
  });

  it("R2-2: aborts installV2 right before atomic rename when authorization is revoked mid-publish", async () => {
    const dir = await createTempDir("cache-v2-pre-rename-revoke");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const artifacts = new FileArtifactStore(path.join(dir, "artifacts"));
    const contentRef = await artifacts.put(Buffer.from("# Skill\n", "utf8"));
    const skill = projectV1SkillEntryToV2(makeV1Entry("skill-x", contentRef, 1));
    const snapshot = createSignedExecutionAssetSnapshotV2(
      {
        snapshotRevision: 2,
        skillCatalogRevision: 1,
        skills: [skill],
        rubrics: [],
        promptAssets: [],
        generatedAt: NOW,
      },
      signer,
    );
    const cachePath = path.join(dir, "execution-assets.json");
    const v2Path = path.join(dir, "execution-assets-v2.json");
    const cache = new FileExecutionAssetCache(cachePath, artifacts, verifier);

    let authCalls = 0;
    await expect(
      cache.installV2(snapshot, {
        assertAuthorized: () => {
          authCalls += 1;
          if (authCalls >= 3) {
            throw new Error("Peer authorization revoked immediately before rename");
          }
        },
      }),
    ).rejects.toThrow("Peer authorization revoked immediately before rename");

    expect(authCalls).toBe(3);
    await expect(stat(v2Path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${v2Path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
