import { open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FileArtifactStore } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssetIndexEntry,
  AssignmentGlobalQueryPort,
  ExecutionAssetBundle,
  ExecutionAssetSnapshot,
  ExecutionAssetSnapshotV2,
  GlobalReadResult,
  GlobalStatePort,
} from "@zhixing-ai/core/contracts";
import {
  projectSkillEntryToV1,
  projectV1SkillEntryToV2,
  type SkillCatalogEntryV2,
} from "@zhixing-ai/core/skills/catalog";
import {
  byteDigest,
  createSignedExecutionAssetSnapshot,
  createSignedExecutionAssetSnapshotV2,
  protocolDigest,
  validateExecutionAssetSnapshot,
  validateGlobalQuery,
  validateGlobalQueryResult,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing-ai/core/persistence";
import {
  assertPresentSkillEntryV2,
  assertSkillCatalogTransitionV2,
  executionAssetsV2Path,
  installExecutionAssetSnapshotV2,
  publishExecutionAssetSnapshotV2,
  readCatalogV2FromCache,
  readExecutionAssetSnapshotV2,
  snapshotV2ContentIdentity,
  writeDurableJsonV2,
} from "./execution-asset-cache-v2.js";

const EMPTY_CACHE_REVISION = 1;

export interface ExecutionAssetCatalogPort extends AssignmentGlobalQueryPort {
  readArtifact(digest: string): Promise<Uint8Array | undefined>;
  readArtifactRange?(
    refOrDigest: ArtifactRef | string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined>;
}

export interface ExecutionAssetV2SyncSource {
  readonly v2Snapshot: ExecutionAssetSnapshotV2;
  readonly indexRefs?: readonly ArtifactRef[];
  readonly readArtifactRange: (
    ref: ArtifactRef,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
}

/** Narrow S4 cache: signed indexes are durable; immutable bodies stay in ArtifactStore. */
export class FileExecutionAssetCache implements ExecutionAssetCatalogPort {
  constructor(
    private readonly filePath: string,
    private readonly artifacts: FileArtifactStore,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  static emptyRevision(): number {
    return EMPTY_CACHE_REVISION;
  }

  async current(): Promise<ExecutionAssetSnapshot | undefined> {
    const value = await readJsonIfPresent(this.filePath);
    return value === undefined
      ? undefined
      : validateExecutionAssetSnapshot(value, this.verifier);
  }

  async currentV2(): Promise<ExecutionAssetSnapshotV2 | undefined> {
    return await readExecutionAssetSnapshotV2(
      executionAssetsV2Path(this.filePath),
      this.verifier,
    );
  }

  async readArtifact(digest: string): Promise<Uint8Array | undefined> {
    try {
      const ref = await this.artifacts.referenceForDigest(digest);
      return ref ? await this.artifacts.get(ref) : undefined;
    } catch {
      return undefined;
    }
  }

  async readArtifactRange(
    refOrDigest: ArtifactRef | string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    try {
      if (typeof refOrDigest !== "string") {
        return await this.artifacts.readRange(refOrDigest, offset, length);
      }
      const info = await stat(this.artifacts.pathFor({ digest: refOrDigest, bytes: 0 }));
      if (!info.isFile()) return undefined;
      return await this.artifacts.readRange(
        { digest: refOrDigest, bytes: info.size },
        offset,
        length,
      );
    } catch {
      return undefined;
    }
  }

  /** Missing cache means builtin-only; a present but corrupt cache fails closed. */
  async read(query: Parameters<AssignmentGlobalQueryPort["read"]>[0]): Promise<GlobalReadResult> {
    const validated = validateGlobalQuery(query);
    if (
      validated.kind === "skill-catalog-v2" ||
      validated.kind === "skill-get-v2"
    ) {
      return await readCatalogV2FromCache({
        query: validated,
        v1Snapshot: await this.current(),
        v2Snapshot: await this.currentV2(),
        artifacts: this.artifacts,
      });
    }
    if (
      validated.kind !== "skill-catalog" &&
      validated.kind !== "skill-get" &&
      validated.kind !== "asset-index"
    ) {
      throw new Error("Execution asset cache does not expose global authority data");
    }
    const snapshot = await this.current();
    const v2Snapshot = await this.currentV2();
    const useV2 = Boolean(v2Snapshot && (!snapshot || v2Snapshot.snapshotRevision >= snapshot.snapshotRevision));
    if (validated.kind === "skill-catalog") {
      if (useV2 && v2Snapshot) {
        const filteredPairs = v2Snapshot.skills
          .map((v2Entry) => ({
            v2: v2Entry,
            v1: projectSkillEntryToV1(v2Entry, "skill-catalog"),
          }))
          .filter(({ v1 }) =>
            (validated.includeDisabled === true || !v1.disabled) &&
            (validated.mode === undefined || v1.mode === validated.mode),
          )
          .slice(0, validated.limit ?? Number.POSITIVE_INFINITY);
        const entries = await assertReadableSkills(
          filteredPairs.map((pair) => pair.v1),
          this.artifacts,
        );
        await Promise.all(
          filteredPairs.map((pair) => assertPresentPackageRef(pair.v2, this.artifacts)),
        );
        return validateGlobalQueryResult(validated, {
          kind: "skill-catalog",
          catalogRevision: v2Snapshot.skillCatalogRevision,
          entries,
        });
      }
      const filteredV1 = snapshot
        ? snapshot.skills
            .filter((entry) =>
              (validated.includeDisabled === true || !entry.disabled) &&
              (validated.mode === undefined || entry.mode === validated.mode),
            )
            .slice(0, validated.limit ?? Number.POSITIVE_INFINITY)
        : [];
      const entries = snapshot
        ? await assertReadableSkills(filteredV1, this.artifacts)
        : [];
      return validateGlobalQueryResult(validated, {
        kind: "skill-catalog",
        catalogRevision: snapshot?.skillCatalogRevision ?? 0,
        entries,
      });
    }
    if (validated.kind === "skill-get") {
      if (useV2 && v2Snapshot) {
        const rawEntry = v2Snapshot.skills.find((candidate) => candidate.id === validated.skillId);
        const entry = rawEntry ? projectSkillEntryToV1(rawEntry, "skill-catalog") : undefined;
        if (entry && rawEntry) {
          await assertReadableSkill(entry, this.artifacts);
          await assertPresentPackageRef(rawEntry, this.artifacts);
        }
        return validateGlobalQueryResult(validated, {
          kind: "skill-get",
          catalogRevision: v2Snapshot.skillCatalogRevision,
          entry: entry ?? null,
        });
      }
      const entry = snapshot?.skills.find((candidate) => candidate.id === validated.skillId);
      if (entry) await assertReadableSkill(entry, this.artifacts);
      return validateGlobalQueryResult(validated, {
        kind: "skill-get",
        catalogRevision: snapshot?.skillCatalogRevision ?? 0,
        entry: entry ?? null,
      });
    }
    const indexSnapshot = useV2 && v2Snapshot ? v2Snapshot : snapshot;
    let entries: AssetIndexEntry[] = [];
    if (validated.asset === "skills") {
      const v1Skills =
        useV2 && v2Snapshot
          ? await assertReadableSkills(
              v2Snapshot.skills.map((entry) => projectSkillEntryToV1(entry, "offline-asset")),
              this.artifacts,
            )
          : snapshot
            ? await assertReadableSkills(snapshot.skills, this.artifacts)
            : [];
      entries = v1Skills.map((entry) => ({
        id: entry.id,
        kind: "skills" as const,
        revision: entry.revision,
        digest: entry.contentRef.digest,
      }));
    } else if (indexSnapshot) {
      entries = await filterPresentIndex(
        validated.asset === "rubrics" ? indexSnapshot.rubrics : indexSnapshot.promptAssets,
        this.artifacts,
      );
    }
    return validateGlobalQueryResult(validated, { kind: "asset-index", entries });
  }

  async publishFromAuthority(input: {
    readonly state: GlobalStatePort;
    readonly anchorEpoch: number;
    readonly signer: ProtocolSigner;
    readonly generatedAt: string;
  }): Promise<ExecutionAssetSnapshot> {
    const context = {
      principal: { kind: "host" as const, component: "execution-asset-snapshot" },
      requestId: `execution-assets:${input.generatedAt}`,
      deadlineAt: new Date(Date.parse(input.generatedAt) + 30_000).toISOString(),
      authority: { domain: "global" as const, anchorEpoch: input.anchorEpoch },
    };
    let skillCatalogRevision: number;
    let rawV2Skills: readonly SkillCatalogEntryV2[];
    try {
      const skillsV2Result = validateGlobalQueryResult(
        { kind: "skill-catalog-v2", includeDisabled: true },
        await input.state.read({ kind: "skill-catalog-v2", includeDisabled: true }, context),
      );
      if (skillsV2Result.kind !== "skill-catalog-v2") {
        throw new TypeError("Execution asset authority returned another v2 skill catalog type");
      }
      skillCatalogRevision = skillsV2Result.catalogRevision;
      rawV2Skills = skillsV2Result.entries;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/^(?:Unexpected execution asset query: skill-catalog-v2|Global query kind is invalid|Unsupported global query)/u.test(
          error.message,
        )
      ) {
        throw error;
      }
      const skillsV1Result = validateGlobalQueryResult(
        { kind: "skill-catalog", includeDisabled: true },
        await input.state.read({ kind: "skill-catalog", includeDisabled: true }, context),
      );
      if (skillsV1Result.kind !== "skill-catalog") {
        throw new TypeError("Execution asset authority returned another result type");
      }
      skillCatalogRevision = skillsV1Result.catalogRevision;
      rawV2Skills = skillsV1Result.entries.map((entry) => projectV1SkillEntryToV2(entry));
    }
    const rubricsResult = validateGlobalQueryResult(
      { kind: "asset-index", asset: "rubrics" },
      await input.state.read({ kind: "asset-index", asset: "rubrics" }, context),
    );
    let promptResult: GlobalReadResult = { kind: "asset-index", entries: [] };
    try {
      promptResult = validateGlobalQueryResult(
        { kind: "asset-index", asset: "prompt-assets" },
        await input.state.read({ kind: "asset-index", asset: "prompt-assets" }, context),
      );
    } catch {
      // Prompt assets have no authority producer in configurations that do not enable them.
    }
    if (
      rubricsResult.kind !== "asset-index" ||
      promptResult.kind !== "asset-index"
    ) {
      throw new TypeError("Execution asset authority returned another result type");
    }
    const v2Path = executionAssetsV2Path(this.filePath);
    const releaseV1 = await acquireFileLock(`${this.filePath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Execution asset snapshot",
    });
    try {
      const releaseV2 = await acquireFileLock(`${v2Path}.lock`, {
        staleMs: 30_000,
        waitMs: 10_000,
        resourceName: "Execution asset snapshot v2",
      });
      try {
        const currentV1 = await this.current();
        const currentV2 = await this.currentV2();
        const candidateV1Skills = rawV2Skills.map((entry) =>
          projectSkillEntryToV1(entry, "offline-asset"),
        );
        assertSkillCatalogTransition(
          currentV1,
          skillCatalogRevision,
          candidateV1Skills,
        );
        assertSkillCatalogTransitionV2(
          currentV2,
          skillCatalogRevision,
          rawV2Skills,
        );
        const presentRubrics = await filterPresentIndex(rubricsResult.entries, this.artifacts);
        const presentPromptAssets = await filterPresentIndex(promptResult.entries, this.artifacts);
        const candidateV1Identity = protocolDigest("ExecutionAssetSnapshotContent", 1, {
          skillCatalogRevision,
          skills: candidateV1Skills,
          rubrics: presentRubrics,
          promptAssets: presentPromptAssets,
        });
        const candidateV2Identity = snapshotV2ContentIdentity({
          skillCatalogRevision,
          skills: rawV2Skills,
          rubrics: presentRubrics,
          promptAssets: presentPromptAssets,
        });
        const candidateV1Changed =
          !currentV1 || snapshotContentIdentity(currentV1) !== candidateV1Identity;
        const candidateV2Changed =
          !currentV2 ||
          snapshotV2ContentIdentity({
            skillCatalogRevision: currentV2.skillCatalogRevision,
            skills: currentV2.skills,
            rubrics: currentV2.rubrics,
            promptAssets: currentV2.promptAssets,
          }) !== candidateV2Identity;
        if (
          currentV1 &&
          currentV2 &&
          currentV2.snapshotRevision >= currentV1.snapshotRevision &&
          !candidateV1Changed &&
          !candidateV2Changed
        ) {
          await Promise.all(
            rawV2Skills.map((entry) => assertPresentSkillEntryV2(entry, this.artifacts)),
          );
          return currentV1;
        }

        const verifiedSkillRefs = new Map<string, number>();
        for (const previous of currentV2?.skills ?? []) {
          verifiedSkillRefs.set(previous.contentRef.digest, previous.contentRef.bytes);
          if (previous.packageRef) {
            verifiedSkillRefs.set(previous.packageRef.digest, previous.packageRef.bytes);
          }
        }
        const v2Skills = await assertIncrementallyReadableSkillEntriesV2(
          rawV2Skills,
          this.artifacts,
          verifiedSkillRefs,
        );
        const v1Skills = v2Skills.map((entry) => projectSkillEntryToV1(entry, "offline-asset"));
        const verifiedIndexDigests = new Set<string>([
          ...(currentV2?.rubrics ?? []).map((item) => item.digest),
          ...(currentV2?.promptAssets ?? []).map((item) => item.digest),
        ]);
        const rubrics = await filterIncrementallyReadableIndex(
          rubricsResult.entries,
          this.artifacts,
          verifiedIndexDigests,
        );
        const promptAssets = await filterIncrementallyReadableIndex(
          promptResult.entries,
          this.artifacts,
          verifiedIndexDigests,
        );
        const v1ContentIdentity = protocolDigest("ExecutionAssetSnapshotContent", 1, {
          skillCatalogRevision,
          skills: v1Skills,
          rubrics,
          promptAssets,
        });
        const v2ContentIdentity = snapshotV2ContentIdentity({
          skillCatalogRevision,
          skills: v2Skills,
          rubrics,
          promptAssets,
        });
        const v1Changed =
          !currentV1 || snapshotContentIdentity(currentV1) !== v1ContentIdentity;
        const v2Changed =
          !currentV2 ||
          snapshotV2ContentIdentity({
            skillCatalogRevision: currentV2.skillCatalogRevision,
            skills: currentV2.skills,
            rubrics: currentV2.rubrics,
            promptAssets: currentV2.promptAssets,
          }) !== v2ContentIdentity;
        if (
          currentV1 &&
          currentV2 &&
          currentV2.snapshotRevision >= currentV1.snapshotRevision &&
          !v1Changed &&
          !v2Changed
        ) {
          return currentV1;
        }
        const nextSnapshotRevision =
          Math.max(
            currentV1?.snapshotRevision ?? EMPTY_CACHE_REVISION,
            currentV2?.snapshotRevision ?? EMPTY_CACHE_REVISION,
          ) + 1;
        if (!Number.isSafeInteger(nextSnapshotRevision)) {
          throw new Error("Execution asset snapshot revision is exhausted");
        }
        let writtenV1: ExecutionAssetSnapshot | undefined;
        if (v1Changed) {
          writtenV1 = createSignedExecutionAssetSnapshot(
            {
              snapshotRevision: nextSnapshotRevision,
              skillCatalogRevision,
              skills: v1Skills,
              rubrics,
              promptAssets,
              generatedAt: input.generatedAt,
            },
            input.signer,
          );
          await writeDurableJson(this.filePath, writtenV1);
        }
        const writtenV2 = createSignedExecutionAssetSnapshotV2(
          {
            snapshotRevision: nextSnapshotRevision,
            skillCatalogRevision,
            skills: v2Skills,
            rubrics,
            promptAssets,
            generatedAt: input.generatedAt,
          },
          input.signer,
        );
        await writeDurableJsonV2(v2Path, writtenV2);
        return writtenV1 ?? currentV1!;
      } finally {
        await releaseV2();
      }
    } finally {
      await releaseV1();
    }
  }

  async install(snapshotInput: ExecutionAssetSnapshot): Promise<ExecutionAssetSnapshot> {
    const snapshot = validateExecutionAssetSnapshot(snapshotInput, this.verifier);
    const release = await acquireFileLock(`${this.filePath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Execution asset snapshot",
    });
    try {
      const current = await this.current();
      if (current?.digest === snapshot.digest) return current;
      assertSkillCatalogTransition(
        current,
        snapshot.skillCatalogRevision,
        snapshot.skills,
      );
      if (current && snapshot.snapshotRevision <= current.snapshotRevision) {
        throw new TypeError("Execution asset snapshot revision cannot be rewritten or rolled back");
      }
      await writeDurableJson(this.filePath, snapshot);
      return snapshot;
    } finally {
      await release();
    }
  }

  async publishV2FromAuthority(input: {
    readonly state: GlobalStatePort;
    readonly anchorEpoch: number;
    readonly signer: ProtocolSigner;
    readonly generatedAt: string;
    readonly rubrics: ExecutionAssetSnapshot["rubrics"];
    readonly promptAssets: ExecutionAssetSnapshot["promptAssets"];
  }): Promise<ExecutionAssetSnapshotV2> {
    return await publishExecutionAssetSnapshotV2({
      v2FilePath: executionAssetsV2Path(this.filePath),
      artifacts: this.artifacts,
      state: input.state,
      anchorEpoch: input.anchorEpoch,
      signer: input.signer,
      verifier: this.verifier,
      generatedAt: input.generatedAt,
      rubrics: input.rubrics,
      promptAssets: input.promptAssets,
    });
  }

  async bundle(): Promise<ExecutionAssetBundle | undefined> {
    const snapshot = await this.current();
    if (!snapshot) return undefined;
    const refs = await snapshotArtifactRefs(snapshot, this.artifacts);
    return {
      v: 1,
      snapshot,
      artifacts: await Promise.all(refs.map(async (ref) => ({
        ref,
        contentBase64: Buffer.from(await this.artifacts.get(ref)).toString("base64"),
      }))),
    };
  }

  async installBundle(bundle: ExecutionAssetBundle): Promise<ExecutionAssetSnapshot> {
    if (bundle.v !== 1 || !Array.isArray(bundle.artifacts)) {
      throw new TypeError("Execution asset bundle is invalid");
    }
    const snapshot = validateExecutionAssetSnapshot(bundle.snapshot, this.verifier);
    const expected = new Map(
      (await expectedSnapshotDigests(snapshot)).map((digest) => [digest, undefined as ArtifactRef | undefined]),
    );
    const prepared: Array<{ ref: ArtifactRef; bytes: Uint8Array }> = [];
    for (const item of bundle.artifacts) {
      if (!item || typeof item !== "object" || typeof item.contentBase64 !== "string") {
        throw new TypeError("Execution asset bundle artifact is invalid");
      }
      const bytes = Buffer.from(item.contentBase64, "base64");
      if (bytes.toString("base64") !== item.contentBase64) {
        throw new TypeError("Execution asset bundle artifact encoding is invalid");
      }
      if (
        !Number.isSafeInteger(item.ref?.bytes) ||
        item.ref.bytes < 0 ||
        item.ref.bytes !== bytes.byteLength ||
        item.ref.digest !== byteDigest(bytes) ||
        !expected.has(item.ref.digest) ||
        expected.get(item.ref.digest) !== undefined
      ) {
        throw new TypeError("Execution asset bundle artifact identity is invalid");
      }
      const declaredSkillRef = snapshot.skills.find(
        (entry) => entry.contentRef.digest === item.ref.digest,
      )?.contentRef;
      if (declaredSkillRef && declaredSkillRef.bytes !== item.ref.bytes) {
        throw new TypeError("Execution asset skill body does not match its signed reference");
      }
      expected.set(item.ref.digest, item.ref);
      prepared.push({ ref: item.ref, bytes });
    }
    if ([...expected.values()].some((ref) => ref === undefined)) {
      throw new TypeError("Execution asset bundle is incomplete");
    }
    for (const item of prepared) {
      const stored = await this.artifacts.put(item.bytes);
      if (stored.digest !== item.ref.digest || stored.bytes !== item.ref.bytes) {
        throw new TypeError("Execution asset bundle artifact changed while installing");
      }
    }
    return this.install(snapshot);
  }

  async installV2(
    snapshotInput: ExecutionAssetSnapshotV2,
    options?: {
      readonly signal?: AbortSignal;
      readonly assertAuthorized?: () => void | Promise<void>;
    },
  ): Promise<ExecutionAssetSnapshotV2> {
    return await installExecutionAssetSnapshotV2({
      v2FilePath: executionAssetsV2Path(this.filePath),
      artifacts: this.artifacts,
      snapshot: snapshotInput,
      verifier: this.verifier,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
    });
  }

  async syncSourceV2(): Promise<ExecutionAssetV2SyncSource | undefined> {
    const v2Snapshot = await this.currentV2();
    if (!v2Snapshot) return undefined;
    const refs = new Map<string, ArtifactRef>();
    for (const item of [...v2Snapshot.rubrics, ...v2Snapshot.promptAssets]) {
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(this.artifacts.pathFor({ digest: item.digest, bytes: 0 }));
      } catch (error) {
        throw new Error(`Execution asset v2 index artifact missing: ${item.digest}`, {
          cause: error,
        });
      }
      if (!info.isFile()) {
        throw new Error(`Execution asset v2 index artifact missing: ${item.digest}`);
      }
      refs.set(item.digest, { digest: item.digest, bytes: info.size });
    }
    const indexRefs = [...refs.values()].sort((left, right) =>
      left.digest.localeCompare(right.digest, "en-US"),
    );
    return {
      v2Snapshot,
      ...(indexRefs.length > 0 ? { indexRefs } : {}),
      readArtifactRange: (ref, offset, length) =>
        this.artifacts.readRange(ref, offset, length),
    };
  }

}

async function assertReadableSkills(
  entries: ExecutionAssetSnapshot["skills"],
  artifacts: FileArtifactStore,
): Promise<ExecutionAssetSnapshot["skills"]> {
  await Promise.all(entries.map((entry) => assertReadableSkill(entry, artifacts)));
  return entries;
}

async function assertReadableSkill(
  entry: ExecutionAssetSnapshot["skills"][number],
  artifacts: FileArtifactStore,
): Promise<void> {
  try {
    await artifacts.readIdentity(entry.contentRef);
  } catch (error) {
    throw new Error(
      `Execution asset skill body is missing or corrupt: ${entry.id}`,
      { cause: error },
    );
  }
}

async function assertPresentPackageRef(
  entry: SkillCatalogEntryV2,
  artifacts: FileArtifactStore,
): Promise<void> {
  if (!entry.packageRef) return;
  try {
    await artifacts.readIdentity(entry.packageRef);
  } catch (error) {
    throw new Error(
      `Execution asset skill body is missing or corrupt: ${entry.id}`,
      { cause: error },
    );
  }
}

async function filterPresentIndex(
  entries: ExecutionAssetSnapshot["rubrics"],
  artifacts: FileArtifactStore,
): Promise<ExecutionAssetSnapshot["rubrics"]> {
  const present = await Promise.all(entries.map(async (entry) => {
    try {
      const info = await stat(artifacts.pathFor({ digest: entry.digest, bytes: 0 }));
      return info.isFile() ? entry : undefined;
    } catch {
      return undefined;
    }
  }));
  return present.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

async function assertIncrementallyReadableSkillEntriesV2(
  entries: readonly SkillCatalogEntryV2[],
  artifacts: FileArtifactStore,
  verifiedRefs: ReadonlyMap<string, number>,
): Promise<SkillCatalogEntryV2[]> {
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await assertIncrementallyReadableRef(entry.contentRef, artifacts, verifiedRefs, `content (${entry.id})`);
        if (entry.packageRef) {
          await assertIncrementallyReadableRef(entry.packageRef, artifacts, verifiedRefs, `package (${entry.id})`);
        }
      } catch (error) {
        throw new Error(`Execution asset v2 skill body is missing or corrupt: ${entry.id}`, {
          cause: error,
        });
      }
    }),
  );
  return [...entries];
}

async function assertIncrementallyReadableRef(
  ref: ArtifactRef,
  artifacts: FileArtifactStore,
  verifiedRefs: ReadonlyMap<string, number>,
  label: string,
): Promise<void> {
  if (verifiedRefs.get(ref.digest) === ref.bytes) {
    await artifacts.readIdentity(ref);
    return;
  }
  const bytes = await artifacts.get(ref);
  if (bytes.byteLength !== ref.bytes || byteDigest(bytes) !== ref.digest) {
    throw new Error(`Execution asset v2 ${label} digest mismatch`);
  }
}

async function filterIncrementallyReadableIndex(
  entries: ExecutionAssetSnapshot["rubrics"],
  artifacts: FileArtifactStore,
  verifiedDigests: ReadonlySet<string>,
): Promise<ExecutionAssetSnapshot["rubrics"]> {
  const verified = await Promise.all(
    entries.map(async (entry) => {
      if (verifiedDigests.has(entry.digest)) {
        try {
          const info = await stat(artifacts.pathFor({ digest: entry.digest, bytes: 0 }));
          return info.isFile() ? entry : undefined;
        } catch {
          return undefined;
        }
      }
      const ref = await artifacts.referenceForDigest(entry.digest);
      return ref && (await isReadable(ref, artifacts)) ? entry : undefined;
    }),
  );
  return verified.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

async function isReadable(ref: ArtifactRef, artifacts: FileArtifactStore): Promise<boolean> {
  try {
    await artifacts.get(ref);
    return true;
  } catch {
    return false;
  }
}

async function snapshotArtifactRefs(
  snapshot: ExecutionAssetSnapshot,
  artifacts: FileArtifactStore,
): Promise<ArtifactRef[]> {
  const refs = new Map<string, ArtifactRef>();
  for (const entry of snapshot.skills) refs.set(entry.contentRef.digest, entry.contentRef);
  for (const entry of [...snapshot.rubrics, ...snapshot.promptAssets]) {
    const ref = await artifacts.referenceForDigest(entry.digest);
    if (!ref) throw new Error(`Execution asset body is missing: ${entry.digest}`);
    refs.set(ref.digest, ref);
  }
  return [...refs.values()].sort((left, right) => left.digest.localeCompare(right.digest, "en-US"));
}

async function expectedSnapshotDigests(snapshot: ExecutionAssetSnapshot): Promise<string[]> {
  return [...new Set([
    ...snapshot.skills.map((entry) => entry.contentRef.digest),
    ...snapshot.rubrics.map((entry) => entry.digest),
    ...snapshot.promptAssets.map((entry) => entry.digest),
  ])].sort((left, right) => left.localeCompare(right, "en-US"));
}

function snapshotContentIdentity(snapshot: ExecutionAssetSnapshot): string {
  return protocolDigest("ExecutionAssetSnapshotContent", 1, {
    skillCatalogRevision: snapshot.skillCatalogRevision,
    skills: snapshot.skills,
    rubrics: snapshot.rubrics,
    promptAssets: snapshot.promptAssets,
  });
}

function assertSkillCatalogTransition(
  current: ExecutionAssetSnapshot | undefined,
  nextRevision: number,
  nextSkills: ExecutionAssetSnapshot["skills"],
): void {
  if (!current) return;
  if (nextRevision < current.skillCatalogRevision) {
    throw new TypeError("Skill catalog revision cannot be rolled back");
  }
  if (
    nextRevision === current.skillCatalogRevision &&
    skillCatalogIdentity(nextRevision, nextSkills) !==
      skillCatalogIdentity(current.skillCatalogRevision, current.skills)
  ) {
    throw new TypeError(
      "Skill catalog revision cannot change signed Skill content or order",
    );
  }
}

function skillCatalogIdentity(
  catalogRevision: number,
  skills: ExecutionAssetSnapshot["skills"],
): string {
  return protocolDigest("ExecutionAssetSkillCatalog", 1, {
    catalogRevision,
    skills,
  });
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
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
    await rename(temporary, filePath);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
