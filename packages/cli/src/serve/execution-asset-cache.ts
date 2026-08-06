import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FileArtifactStore } from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentGlobalQueryPort,
  ExecutionAssetBundle,
  ExecutionAssetSnapshot,
  GlobalReadResult,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import {
  byteDigest,
  createSignedExecutionAssetSnapshot,
  protocolDigest,
  validateExecutionAssetSnapshot,
  validateGlobalQuery,
  validateGlobalQueryResult,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";

const EMPTY_CACHE_REVISION = 1;

export interface ExecutionAssetCatalogPort extends AssignmentGlobalQueryPort {
  readArtifact(digest: string): Promise<Uint8Array | undefined>;
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

  async readArtifact(digest: string): Promise<Uint8Array | undefined> {
    try {
      const ref = await this.artifacts.referenceForDigest(digest);
      return ref ? await this.artifacts.get(ref) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A corrupt cache is indistinguishable from a miss to local runtime consumers. */
  async read(query: Parameters<AssignmentGlobalQueryPort["read"]>[0]): Promise<GlobalReadResult> {
    const validated = validateGlobalQuery(query);
    if (
      validated.kind !== "skill-catalog" &&
      validated.kind !== "skill-get" &&
      validated.kind !== "asset-index"
    ) {
      throw new Error("Execution asset cache does not expose global authority data");
    }
    const snapshot = await this.#safeCurrent();
    if (validated.kind === "skill-catalog") {
      const entries = snapshot
        ? await filterReadableSkills(snapshot.skills, this.artifacts)
        : [];
      return validateGlobalQueryResult(validated, {
        kind: "skill-catalog",
        catalogRevision: snapshot?.skillCatalogRevision ?? 0,
        entries: entries.filter((entry) =>
          (validated.includeDisabled === true || !entry.disabled) &&
          (validated.mode === undefined || entry.mode === validated.mode),
        ).slice(0, validated.limit ?? Number.POSITIVE_INFINITY),
      });
    }
    if (validated.kind === "skill-get") {
      const entry = snapshot?.skills.find((candidate) => candidate.id === validated.skillId);
      const readable = entry && await isReadable(entry.contentRef, this.artifacts)
        ? entry
        : null;
      return validateGlobalQueryResult(validated, {
        kind: "skill-get",
        catalogRevision: snapshot?.skillCatalogRevision ?? 0,
        entry: readable,
      });
    }
    const entries = snapshot
      ? validated.asset === "skills"
        ? (await filterReadableSkills(snapshot.skills, this.artifacts)).map((entry) => ({
            id: entry.id,
            kind: "skills" as const,
            revision: entry.revision,
            digest: entry.contentRef.digest,
          }))
        : await filterReadableIndex(
            validated.asset === "rubrics" ? snapshot.rubrics : snapshot.promptAssets,
            this.artifacts,
          )
      : [];
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
    const skillsResult = validateGlobalQueryResult(
      { kind: "skill-catalog", includeDisabled: true },
      await input.state.read({ kind: "skill-catalog", includeDisabled: true }, context),
    );
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
      skillsResult.kind !== "skill-catalog" ||
      rubricsResult.kind !== "asset-index" ||
      promptResult.kind !== "asset-index"
    ) {
      throw new TypeError("Execution asset authority returned another result type");
    }
    const skills = await filterReadableSkills(skillsResult.entries, this.artifacts);
    const rubrics = await filterReadableIndex(rubricsResult.entries, this.artifacts);
    const promptAssets = await filterReadableIndex(promptResult.entries, this.artifacts);
    const contentIdentity = protocolDigest("ExecutionAssetSnapshotContent", 1, {
      skillCatalogRevision: skillsResult.catalogRevision,
      skills,
      rubrics,
      promptAssets,
    });
    const release = await acquireFileLock(`${this.filePath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Execution asset snapshot",
    });
    try {
      const current = await this.current();
      if (current && snapshotContentIdentity(current) === contentIdentity) return current;
      const snapshotRevision = current
        ? current.snapshotRevision + 1
        : EMPTY_CACHE_REVISION + 1;
      if (!Number.isSafeInteger(snapshotRevision)) {
        throw new Error("Execution asset snapshot revision is exhausted");
      }
      const snapshot = createSignedExecutionAssetSnapshot({
        snapshotRevision,
        skillCatalogRevision: skillsResult.catalogRevision,
        skills,
        rubrics,
        promptAssets,
        generatedAt: input.generatedAt,
      }, input.signer);
      await writeDurableJson(this.filePath, snapshot);
      return snapshot;
    } finally {
      await release();
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
      if (current && snapshot.snapshotRevision <= current.snapshotRevision) {
        throw new TypeError("Execution asset snapshot revision cannot be rewritten or rolled back");
      }
      await writeDurableJson(this.filePath, snapshot);
      return snapshot;
    } finally {
      await release();
    }
  }

  async bundle(): Promise<ExecutionAssetBundle | undefined> {
    const snapshot = await this.#safeCurrent();
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

  async #safeCurrent(): Promise<ExecutionAssetSnapshot | undefined> {
    try {
      return await this.current();
    } catch {
      return undefined;
    }
  }
}

async function filterReadableSkills(
  entries: ExecutionAssetSnapshot["skills"],
  artifacts: FileArtifactStore,
): Promise<ExecutionAssetSnapshot["skills"]> {
  const readable = await Promise.all(entries.map(async (entry) =>
    await isReadable(entry.contentRef, artifacts) ? entry : undefined,
  ));
  return readable.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

async function filterReadableIndex(
  entries: ExecutionAssetSnapshot["rubrics"],
  artifacts: FileArtifactStore,
): Promise<ExecutionAssetSnapshot["rubrics"]> {
  const readable = await Promise.all(entries.map(async (entry) => {
    const ref = await artifacts.referenceForDigest(entry.digest);
    return ref && await isReadable(ref, artifacts) ? entry : undefined;
  }));
  return readable.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
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
