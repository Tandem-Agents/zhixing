import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FileArtifactStore } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssetIndexEntry,
  ExecutionAssetSnapshot,
  ExecutionAssetSnapshotV2,
  GlobalQuery,
  GlobalReadResult,
  GlobalStatePort,
} from "@zhixing-ai/core/contracts";
import {
  projectV1SkillEntryToV2,
  type SkillCatalogEntryV2,
} from "@zhixing-ai/core/skills/catalog";
import {
  byteDigest,
  createSignedExecutionAssetSnapshotV2,
  protocolDigest,
  validateExecutionAssetSnapshotV2,
  validateGlobalQueryResult,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing-ai/core/persistence";

const INITIAL_CACHE_REVISION = 2;

export function executionAssetsV2Path(v1FilePath: string): string {
  const dir = path.dirname(v1FilePath);
  const base = path.basename(v1FilePath, ".json");
  return path.join(dir, `${base}-v2.json`);
}

export async function readExecutionAssetSnapshotV2(
  v2FilePath: string,
  verifier: ProtocolSignatureVerifier,
): Promise<ExecutionAssetSnapshotV2 | undefined> {
  try {
    const raw = JSON.parse(await readFile(v2FilePath, "utf8")) as unknown;
    return validateExecutionAssetSnapshotV2(raw, verifier);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function assertPresentSkillEntryV2(
  entry: SkillCatalogEntryV2,
  artifacts: FileArtifactStore,
): Promise<void> {
  try {
    await artifacts.readIdentity(entry.contentRef);
    if (entry.packageRef) {
      await artifacts.readIdentity(entry.packageRef);
    }
  } catch (error) {
    throw new Error(`Execution asset v2 skill body is missing or corrupt: ${entry.id}`, {
      cause: error,
    });
  }
}

export async function assertReadableSkillEntryV2(
  entry: SkillCatalogEntryV2,
  artifacts: FileArtifactStore,
): Promise<void> {
  try {
    const contentBytes = await artifacts.get(entry.contentRef);
    if (contentBytes.byteLength !== entry.contentRef.bytes || byteDigest(contentBytes) !== entry.contentRef.digest) {
      throw new Error(`Execution asset v2 content digest mismatch: ${entry.id}`);
    }
    if (entry.packageRef) {
      const pkgBytes = await artifacts.get(entry.packageRef);
      if (pkgBytes.byteLength !== entry.packageRef.bytes || byteDigest(pkgBytes) !== entry.packageRef.digest) {
        throw new Error(`Execution asset v2 package digest mismatch: ${entry.id}`);
      }
    }
  } catch (error) {
    throw new Error(`Execution asset v2 skill body is missing or corrupt: ${entry.id}`, { cause: error });
  }
}

export async function assertReadableSkillEntriesV2(
  entries: readonly SkillCatalogEntryV2[],
  artifacts: FileArtifactStore,
): Promise<SkillCatalogEntryV2[]> {
  await Promise.all(entries.map((entry) => assertReadableSkillEntryV2(entry, artifacts)));
  return [...entries];
}

export async function collectSnapshotV2ArtifactRefs(
  snapshot: ExecutionAssetSnapshotV2,
  artifacts: FileArtifactStore,
): Promise<ArtifactRef[]> {
  const refs = new Map<string, ArtifactRef>();
  for (const entry of snapshot.skills) {
    refs.set(entry.contentRef.digest, entry.contentRef);
    if (entry.packageRef) {
      refs.set(entry.packageRef.digest, entry.packageRef);
    }
  }
  for (const entry of [...snapshot.rubrics, ...snapshot.promptAssets]) {
    const ref = await artifacts.referenceForDigest(entry.digest);
    if (!ref) {
      throw new Error(`Execution asset v2 referenced artifact missing: ${entry.digest}`);
    }
    refs.set(ref.digest, ref);
  }
  return [...refs.values()].sort((left, right) => left.digest.localeCompare(right.digest, "en-US"));
}

export async function publishExecutionAssetSnapshotV2(input: {
  readonly v2FilePath: string;
  readonly artifacts: FileArtifactStore;
  readonly state: GlobalStatePort;
  readonly anchorEpoch: number;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly generatedAt: string;
  readonly rubrics: readonly AssetIndexEntry[];
  readonly promptAssets: readonly AssetIndexEntry[];
  readonly minSnapshotRevision?: number;
}): Promise<ExecutionAssetSnapshotV2> {
  const context = {
    principal: { kind: "host" as const, component: "execution-asset-snapshot" },
    requestId: `execution-assets-v2:${input.generatedAt}`,
    deadlineAt: new Date(Date.parse(input.generatedAt) + 30_000).toISOString(),
    authority: { domain: "global" as const, anchorEpoch: input.anchorEpoch },
  };
  const skillsV2Result = validateGlobalQueryResult(
    { kind: "skill-catalog-v2", includeDisabled: true },
    await input.state.read({ kind: "skill-catalog-v2", includeDisabled: true }, context),
  );
  if (skillsV2Result.kind !== "skill-catalog-v2") {
    throw new TypeError("Execution asset authority returned another v2 skill catalog type");
  }
  const skills = await assertReadableSkillEntriesV2(skillsV2Result.entries, input.artifacts);
  const contentIdentity = snapshotV2ContentIdentity({
    skillCatalogRevision: skillsV2Result.catalogRevision,
    skills,
    rubrics: input.rubrics,
    promptAssets: input.promptAssets,
  });
  const release = await acquireFileLock(`${input.v2FilePath}.lock`, {
    staleMs: 30_000,
    waitMs: 10_000,
    resourceName: "Execution asset snapshot v2",
  });
  try {
    const current = await readExecutionAssetSnapshotV2(input.v2FilePath, input.verifier);
    assertSkillCatalogTransitionV2(current, skillsV2Result.catalogRevision, skills);
    const targetMinRevision = input.minSnapshotRevision ?? INITIAL_CACHE_REVISION;
    if (
      current &&
      current.snapshotRevision >= targetMinRevision &&
      snapshotV2ContentIdentity({
        skillCatalogRevision: current.skillCatalogRevision,
        skills: current.skills,
        rubrics: current.rubrics,
        promptAssets: current.promptAssets,
      }) === contentIdentity
    ) {
      return current;
    }
    const snapshotRevision = Math.max(
      current ? current.snapshotRevision + 1 : INITIAL_CACHE_REVISION,
      targetMinRevision,
    );
    if (!Number.isSafeInteger(snapshotRevision)) {
      throw new Error("Execution asset v2 snapshot revision is exhausted");
    }
    const snapshot = createSignedExecutionAssetSnapshotV2(
      {
        snapshotRevision,
        skillCatalogRevision: skillsV2Result.catalogRevision,
        skills,
        rubrics: [...input.rubrics],
        promptAssets: [...input.promptAssets],
        generatedAt: input.generatedAt,
      },
      input.signer,
    );
    await writeDurableJsonV2(input.v2FilePath, snapshot);
    return snapshot;
  } finally {
    await release();
  }
}

export async function installExecutionAssetSnapshotV2(input: {
  readonly v2FilePath: string;
  readonly artifacts: FileArtifactStore;
  readonly snapshot: ExecutionAssetSnapshotV2;
  readonly verifier: ProtocolSignatureVerifier;
  readonly signal?: AbortSignal;
  readonly assertAuthorized?: () => void | Promise<void>;
}): Promise<ExecutionAssetSnapshotV2> {
  input.signal?.throwIfAborted();
  await input.assertAuthorized?.();
  const snapshot = validateExecutionAssetSnapshotV2(input.snapshot, input.verifier);
  await assertReadableSkillEntriesV2(snapshot.skills, input.artifacts);
  for (const item of [...snapshot.rubrics, ...snapshot.promptAssets]) {
    const ref = await input.artifacts.referenceForDigest(item.digest);
    if (!ref) {
      throw new Error(`Execution asset v2 referenced index body is missing: ${item.digest}`);
    }
  }
  const release = await acquireFileLock(`${input.v2FilePath}.lock`, {
    staleMs: 30_000,
    waitMs: 10_000,
    resourceName: "Execution asset snapshot v2",
  });
  try {
    input.signal?.throwIfAborted();
    await input.assertAuthorized?.();
    const current = await readExecutionAssetSnapshotV2(input.v2FilePath, input.verifier);
    if (current?.digest === snapshot.digest) return current;
    assertSkillCatalogTransitionV2(current, snapshot.skillCatalogRevision, snapshot.skills);
    if (current && snapshot.snapshotRevision <= current.snapshotRevision) {
      throw new TypeError("Execution asset v2 snapshot revision cannot be rewritten or rolled back");
    }
    await writeDurableJsonV2(input.v2FilePath, snapshot, async () => {
      input.signal?.throwIfAborted();
      await input.assertAuthorized?.();
    });
    return snapshot;
  } finally {
    await release();
  }
}

export async function readCatalogV2FromCache(input: {
  readonly query: Extract<GlobalQuery, { kind: "skill-catalog-v2" | "skill-get-v2" }>;
  readonly v1Snapshot: ExecutionAssetSnapshot | undefined;
  readonly v2Snapshot: ExecutionAssetSnapshotV2 | undefined;
  readonly artifacts: FileArtifactStore;
}): Promise<GlobalReadResult> {
  const v2 = input.v2Snapshot;
  const v1 = input.v1Snapshot;
  const useV2 = Boolean(v2 && (!v1 || v2.snapshotRevision >= v1.snapshotRevision));
  const query = input.query;
  if (query.kind === "skill-catalog-v2") {
    let filtered: SkillCatalogEntryV2[];
    let catalogRevision = 0;
    if (useV2 && v2) {
      catalogRevision = v2.skillCatalogRevision;
      filtered = v2.skills
        .filter(
          (entry) =>
            (query.includeDisabled === true || !entry.disabled) &&
            (query.mode === undefined || entry.mode === query.mode),
        )
        .slice(0, query.limit ?? Number.POSITIVE_INFINITY);
      await Promise.all(
        filtered.map((entry) => assertPresentSkillEntryV2(entry, input.artifacts)),
      );
    } else if (v1) {
      catalogRevision = v1.skillCatalogRevision;
      const filteredV1 = v1.skills
        .filter(
          (entry) =>
            (query.includeDisabled === true || !entry.disabled) &&
            (query.mode === undefined || entry.mode === query.mode),
        )
        .slice(0, query.limit ?? Number.POSITIVE_INFINITY);
      filtered = filteredV1.map((item) => projectV1SkillEntryToV2(item));
      await Promise.all(
        filtered.map((entry) => assertPresentSkillEntryV2(entry, input.artifacts)),
      );
    } else {
      filtered = [];
    }
    return validateGlobalQueryResult(query, {
      kind: "skill-catalog-v2",
      catalogRevision,
      entries: filtered,
    });
  }
  const targetId = query.skillId;
  if (useV2 && v2) {
    const entry = v2.skills.find((item) => item.id === targetId) ?? null;
    if (entry) await assertPresentSkillEntryV2(entry, input.artifacts);
    return validateGlobalQueryResult(input.query, {
      kind: "skill-get-v2",
      catalogRevision: v2.skillCatalogRevision,
      entry,
    });
  }
  const fallback = v1?.skills.find((item) => item.id === targetId) ?? null;
  const entry = fallback ? projectV1SkillEntryToV2(fallback) : null;
  if (entry) await assertPresentSkillEntryV2(entry, input.artifacts);
  return validateGlobalQueryResult(input.query, {
    kind: "skill-get-v2",
    catalogRevision: v1?.skillCatalogRevision ?? 0,
    entry,
  });
}

export function snapshotV2ContentIdentity(input: {
  readonly skillCatalogRevision: number;
  readonly skills: readonly SkillCatalogEntryV2[];
  readonly rubrics: readonly AssetIndexEntry[];
  readonly promptAssets: readonly AssetIndexEntry[];
}): string {
  return protocolDigest("ExecutionAssetSnapshotContent", 2, {
    skillCatalogRevision: input.skillCatalogRevision,
    skills: input.skills,
    rubrics: input.rubrics,
    promptAssets: input.promptAssets,
  });
}

export function assertSkillCatalogTransitionV2(
  current: ExecutionAssetSnapshotV2 | undefined,
  nextRevision: number,
  nextSkills: readonly SkillCatalogEntryV2[],
): void {
  if (!current) return;
  if (nextRevision < current.skillCatalogRevision) {
    throw new TypeError("Skill catalog v2 revision cannot be rolled back");
  }
  if (
    nextRevision === current.skillCatalogRevision &&
    protocolDigest("ExecutionAssetSkillCatalog", 2, { catalogRevision: nextRevision, skills: nextSkills }) !==
      protocolDigest("ExecutionAssetSkillCatalog", 2, {
        catalogRevision: current.skillCatalogRevision,
        skills: current.skills,
      })
  ) {
    throw new TypeError("Skill catalog v2 revision cannot change signed Skill content or order");
  }
}

export async function writeDurableJsonV2(
  filePath: string,
  value: unknown,
  beforePublish?: () => void | Promise<void>,
): Promise<void> {
  const parent = path.dirname(filePath);
  await ensureDurableDirectory(parent);
  const temporary = `${filePath}.tmp`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await beforePublish?.();
    await rename(temporary, filePath);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
