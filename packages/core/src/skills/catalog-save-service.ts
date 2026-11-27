import type { ArtifactRef, Digest } from "../contracts/index.js";
import { parseFrontmatter, stringifyFrontmatter } from "../frontmatter.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import {
  SKILL_PACKAGE_ROOT_PATH,
  decodeSkillPackageArchive,
  encodeSkillPackageArchive,
  normalizeSkillPackagePath,
  type SkillPackageMemberInput,
} from "./archive.js";
import { parseQualifiedSkillId, skillNameToId } from "./id.js";
import { applyOverlayMutation, normalizeEntryToV2 } from "./package-pagination.js";
import {
  DEFAULT_SKILL_VISIBILITY,
  parseSkillVisibilityFromFrontmatter,
  type SkillCatalogEntry,
  type SkillCatalogEntryV2,
  type SkillMode,
  type SkillVisibility,
} from "./types.js";

export type SkillCatalogSaveErrorCode =
  | "unattended-skill-mutation-forbidden"
  | "revision-conflict"
  | "invalid-draft";

export class SkillCatalogSaveError extends Error {
  constructor(
    readonly code: SkillCatalogSaveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillCatalogSaveError";
  }
}

export interface SkillCatalogSaveResourceDraft {
  readonly path: string;
  readonly content: string;
  readonly mediaType?: string;
  readonly summary?: string;
}

/** Skill-owned input for the skill_save / save_skill create/update use case. */
export interface SkillCatalogSaveDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly mode: SkillMode;
  readonly visibility?: SkillVisibility;
  readonly resources?: readonly SkillCatalogSaveResourceDraft[];
  readonly expectedRevision?: number;
  readonly expectedVersion?: string;
  readonly forceOverwrite?: boolean;
}

export interface SkillCatalogSaveOutcome {
  readonly id: string;
  readonly name: string;
  readonly outcome: "created" | "updated";
  readonly scrubbedCount: number;
  readonly packageVersion?: string;
}

export interface SkillCatalogSaveBaselinePreview {
  readonly id: string;
  readonly existingEntry: SkillCatalogEntryV2 | null;
  readonly baselineVersion?: string;
  readonly resolvedVisibility: SkillVisibility;
  readonly rootDocument: string;
  readonly finalResources: readonly SkillCatalogSaveResourceDraft[];
  readonly scrubbedCount: number;
}

/** The only application entry for save_skill / skill_save. Bindings retain product copy only. */
export interface SkillCatalogSaveApplication {
  validateSaveBaseline?(
    draft: SkillCatalogSaveDraft,
    operationId?: string,
  ): Promise<SkillCatalogSaveBaselinePreview>;
  save(
    draft: SkillCatalogSaveDraft,
    operationId?: string,
  ): Promise<SkillCatalogSaveOutcome>;
}

export interface SkillCatalogSaveRecord {
  readonly name: string;
  readonly description: string;
  readonly content: ArtifactRef;
}

export interface SkillCatalogSaveRecordV2 extends SkillCatalogSaveRecord {
  readonly visibility: SkillVisibility;
  readonly packageRef?: ArtifactRef;
}

export type SkillCatalogSaveOverlayMutation =
  | {
      readonly kind: "skill-create";
      readonly record: SkillCatalogSaveRecord;
      readonly mode: SkillMode;
    }
  | {
      readonly kind: "skill-admit";
      readonly record: SkillCatalogSaveRecord;
      readonly mode: SkillMode;
    }
  | {
      readonly kind: "skill-update";
      readonly skillId: string;
      readonly record: SkillCatalogSaveRecord;
      readonly mode: SkillMode;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "skill-create-v2";
      readonly record: SkillCatalogSaveRecordV2;
      readonly mode: SkillMode;
    }
  | {
      readonly kind: "skill-admit-v2";
      readonly record: SkillCatalogSaveRecordV2;
      readonly mode: SkillMode;
    }
  | {
      readonly kind: "skill-update-v2";
      readonly skillId: string;
      readonly record: SkillCatalogSaveRecordV2;
      readonly mode: SkillMode;
      readonly expectedRevision: number;
    };

export interface SkillCatalogSaveOverlayRecord {
  readonly recordSeq: number;
  readonly requestIdentity: string;
  readonly mutation: SkillCatalogSaveOverlayMutation;
  readonly mutationDigest: Digest;
}

export type SkillCatalogSaveMutation = Exclude<
  SkillCatalogSaveOverlayMutation,
  { readonly kind: "skill-admit" | "skill-admit-v2" }
>;

/**
 * Path-free Correctness adapter required by the Skill-owned save use case.
 * Runtime composition supplies artifact, global-read and assignment-stage mechanics;
 * it does not decide upsert, overlay, format or operation identity semantics.
 */
export interface SkillCatalogSaveCorrectnessPort {
  readCatalogEntry(skillId: string): Promise<SkillCatalogEntry | null>;
  readCatalogEntryV2?(skillId: string): Promise<SkillCatalogEntryV2 | null>;
  readOverlay(): Promise<readonly SkillCatalogSaveOverlayRecord[]>;
  requestIdentityFor(operationId: string): string;
  putContent(document: string): Promise<ArtifactRef>;
  putBytes?(bytes: Uint8Array): Promise<ArtifactRef>;
  readContent?(content: ArtifactRef): Promise<string>;
  readBytes?(ref: ArtifactRef): Promise<Uint8Array>;
  stage(
    operationId: string,
    mutation: Extract<SkillCatalogSaveMutation, { readonly kind: "skill-create" | "skill-update" }>,
  ): Promise<void>;
  stageV2?(
    operationId: string,
    mutation: Extract<SkillCatalogSaveMutation, { readonly kind: "skill-create-v2" | "skill-update-v2" }>,
  ): Promise<void>;
  allowGlobalSkillMutation?(): boolean;
  assignmentIssuedAt(): string;
}

interface NormalizedSaveDraft {
  readonly id: string;
  readonly normalizedName: string;
  readonly normalizedDescription: string;
  readonly normalizedBody: string;
  readonly scrubbedResources:
    | Array<SkillPackageMemberInput & { readonly content: string }>
    | undefined;
  readonly scrubbedCount: number;
  readonly visibilityFromFrontmatter: SkillVisibility;
}

/** Skill-owned save use case over the assignment-scoped Correctness adapter. */
export class SkillCatalogSaveApplicationService
  implements SkillCatalogSaveApplication
{
  constructor(private readonly correctness: SkillCatalogSaveCorrectnessPort) {}

  async validateSaveBaseline(
    draft: SkillCatalogSaveDraft,
    operationId?: string,
  ): Promise<SkillCatalogSaveBaselinePreview> {
    this.#assertMutationAllowed();
    const normalized = this.#normalizeAndScrubDraft(draft);
    const stagedOperationId = operationId ? `${operationId}:save` : undefined;
    const currentState = await this.#readCurrent(
      normalized.id,
      stagedOperationId === undefined
        ? undefined
        : this.correctness.requestIdentityFor(stagedOperationId),
    );
    await this.#assertBaselineMatches(draft, currentState.entry);
    const { effectiveVisibility, rootDocument, finalResources } =
      await this.#resolveSaveRootAndResources(draft, normalized, currentState.entry);
    const baselineVersion = currentState.entry
      ? ((await this.#resolvePackageVersion(currentState.entry)) ?? undefined)
      : undefined;
    return {
      id: normalized.id,
      existingEntry: currentState.entry,
      ...(baselineVersion ? { baselineVersion } : {}),
      resolvedVisibility: effectiveVisibility,
      rootDocument,
      finalResources: finalResources.map((res) => ({
        path: res.path,
        content: res.content,
        ...(res.mediaType !== undefined ? { mediaType: res.mediaType } : {}),
        ...(res.summary !== undefined ? { summary: res.summary } : {}),
      })),
      scrubbedCount: normalized.scrubbedCount,
    };
  }

  async #resolveSaveRootAndResources(
    draft: SkillCatalogSaveDraft,
    normalized: NormalizedSaveDraft,
    existingEntry: SkillCatalogEntryV2 | null,
  ): Promise<{
    readonly effectiveVisibility: SkillVisibility;
    readonly rootDocument: string;
    readonly finalResources: Array<SkillPackageMemberInput & { readonly content: string }>;
  }> {
    const effectiveVisibility: SkillVisibility =
      draft.visibility ??
      existingEntry?.visibility ??
      normalized.visibilityFromFrontmatter;
    const rootDocument = stringifyFrontmatter(
      {
        name: normalized.normalizedName,
        description: normalized.normalizedDescription,
        ...(effectiveVisibility.modelAutoIndex === false
          ? { "disable-model-invocation": true }
          : {}),
        ...(effectiveVisibility.userSlashCommand === false
          ? { "disable-slash-command": true }
          : {}),
      },
      normalized.normalizedBody,
    );

    // 保留已有附件（仅改根而省略 resources 时沿用既有附属成员）
    let existingResources: Array<SkillPackageMemberInput & { readonly content: string }> = [];
    if (
      existingEntry &&
      draft.resources === undefined &&
      existingEntry.packageRef &&
      this.correctness.readBytes
    ) {
      const prevBytes = await this.correctness.readBytes(existingEntry.packageRef);
      const decodedPrev = decodeSkillPackageArchive(prevBytes);
      existingResources = decodedPrev.members
        .filter((m) => m.meta.path !== SKILL_PACKAGE_ROOT_PATH)
        .map((m) => ({
          path: m.meta.path,
          content: m.text,
          kind: "resource" as const,
          mediaType: m.meta.mediaType,
          summary: m.meta.summary,
        }));
    }

    const finalResources: Array<SkillPackageMemberInput & { readonly content: string }> =
      normalized.scrubbedResources !== undefined
        ? normalized.scrubbedResources
        : existingResources;

    return { effectiveVisibility, rootDocument, finalResources };
  }

  async save(
    draft: SkillCatalogSaveDraft,
    operationId?: string,
  ): Promise<SkillCatalogSaveOutcome> {
    this.#assertMutationAllowed();
    const normalized = this.#normalizeAndScrubDraft(draft);
    const { id, normalizedName, normalizedDescription, scrubbedCount } = normalized;

    const stagedOperationId = operationId ? `${operationId}:save` : undefined;
    const currentState = await this.#readCurrent(
      id,
      stagedOperationId === undefined
        ? undefined
        : this.correctness.requestIdentityFor(stagedOperationId),
    );

    const { effectiveVisibility, rootDocument, finalResources } =
      await this.#resolveSaveRootAndResources(draft, normalized, currentState.entry);

    const encodedPackage = encodeSkillPackageArchive([
      { path: SKILL_PACKAGE_ROOT_PATH, content: rootDocument, kind: "root" },
      ...finalResources,
    ]);

    const content = await this.correctness.putContent(rootDocument);
    if (!operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }

    const needsV2 =
      Boolean(this.correctness.stageV2) &&
      (finalResources.length > 0 ||
        !effectiveVisibility.modelAutoIndex ||
        !effectiveVisibility.userSlashCommand ||
        currentState.entry?.packageRef !== undefined ||
        currentState.entry?.visibility !== undefined);

    let packageRef: ArtifactRef | undefined;
    if (finalResources.length > 0) {
      if (!this.correctness.putBytes) {
        throw new SkillCatalogSaveError(
          "invalid-draft",
          "Multi-member skill package requires binary artifact storage",
        );
      }
      packageRef = await this.correctness.putBytes(encodedPackage.bytes);
    }

    let candidate: SkillCatalogSaveMutation;
    if (needsV2 && this.correctness.stageV2) {
      const recordV2: SkillCatalogSaveRecordV2 = {
        name: normalizedName,
        description: normalizedDescription,
        content,
        visibility: effectiveVisibility,
        ...(packageRef ? { packageRef } : {}),
      };
      candidate = currentState.entry
        ? {
            kind: "skill-update-v2",
            skillId: currentState.entry.id,
            record: recordV2,
            mode: draft.mode,
            expectedRevision: currentState.entry.revision,
          }
        : {
            kind: "skill-create-v2",
            record: recordV2,
            mode: draft.mode,
          };
    } else {
      const recordV1: SkillCatalogSaveRecord = {
        name: normalizedName,
        description: normalizedDescription,
        content,
      };
      candidate = currentState.entry
        ? {
            kind: "skill-update",
            skillId: currentState.entry.id,
            record: recordV1,
            mode: draft.mode,
            expectedRevision: currentState.entry.revision,
          }
        : {
            kind: "skill-create",
            record: recordV1,
            mode: draft.mode,
          };
    }

    const replayMutation = currentState.replayRecord?.mutation;
    const exactReplay =
      replayMutation !== undefined &&
      isSkillCatalogSaveMutation(replayMutation) &&
      sameSkillSaveDraft(replayMutation, candidate);

    if (!exactReplay) {
      await this.#assertBaselineMatches(draft, currentState.entry);
    }

    const mutation = exactReplay ? replayMutation : candidate;
    if (mutation.kind === "skill-create-v2" || mutation.kind === "skill-update-v2") {
      if (!this.correctness.stageV2) {
        throw new Error("Skill v2 staging requires stageV2 support");
      }
      await this.correctness.stageV2(stagedOperationId!, mutation);
    } else {
      await this.correctness.stage(stagedOperationId!, mutation);
    }

    return {
      id,
      name: normalizedName,
      outcome:
        mutation.kind === "skill-update" || mutation.kind === "skill-update-v2"
          ? "updated"
          : "created",
      scrubbedCount,
      packageVersion: encodedPackage.packageVersion,
    };
  }

  #assertMutationAllowed(): void {
    if (this.correctness.allowGlobalSkillMutation?.() === false) {
      throw new SkillCatalogSaveError(
        "unattended-skill-mutation-forbidden",
        "无值守运行禁止修改全局技能库",
      );
    }
  }

  #normalizeAndScrubDraft(draft: SkillCatalogSaveDraft): NormalizedSaveDraft {
    if (
      typeof draft?.name !== "string" || typeof draft.description !== "string" ||
      typeof draft.body !== "string" || (draft.mode !== "main" && draft.mode !== "work")
    ) {
      throw new Error("Skill save draft is invalid");
    }
    const parsedName = parseQualifiedSkillId(draft.name);
    if (parsedName.namespace === "system") {
      throw new SkillCatalogSaveError("invalid-draft", "不能将用户技能保存为 system: 命名空间");
    }
    const rawName = parsedName.namespace === "user"
      ? draft.name.trim().slice("user:".length)
      : draft.name;

    const name = scrubSecrets(rawName);
    const description = scrubSecrets(draft.description);
    const body = scrubSecrets(draft.body);
    const normalizedName = name.scrubbed.trim();
    const normalizedDescription = description.scrubbed.trim();
    const normalizedBody = body.scrubbed.trim();
    const id = skillNameToId(normalizedName);
    if (!id || !normalizedDescription || !normalizedBody) {
      throw new Error("Skill name, description and body must remain non-empty");
    }

    let resourceRedactions = 0;
    const scrubbedResources = draft.resources?.map((res) => {
      const normalizedPath = normalizeSkillPackagePath(res.path);
      if (normalizedPath === SKILL_PACKAGE_ROOT_PATH) {
        throw new SkillCatalogSaveError("invalid-draft", "resources 中不得重复包含根文件 SKILL.md");
      }
      const scrubbed = scrubSecrets(res.content);
      resourceRedactions += scrubbed.redactions.length;
      return {
        path: normalizedPath,
        content: scrubbed.scrubbed,
        kind: "resource" as const,
        ...(res.mediaType !== undefined ? { mediaType: res.mediaType } : {}),
        ...(res.summary !== undefined ? { summary: res.summary } : {}),
      };
    });

    const frontmatter = parseFrontmatter(normalizedBody);
    const visibilityFromFrontmatter = parseSkillVisibilityFromFrontmatter(frontmatter.data, DEFAULT_SKILL_VISIBILITY);

    return {
      id,
      normalizedName,
      normalizedDescription,
      normalizedBody,
      scrubbedResources,
      scrubbedCount: name.redactions.length + description.redactions.length + body.redactions.length + resourceRedactions,
      visibilityFromFrontmatter,
    };
  }

  async #assertBaselineMatches(draft: SkillCatalogSaveDraft, entry: SkillCatalogEntryV2 | null): Promise<void> {
    if (!entry) {
      if (draft.expectedRevision !== undefined || draft.expectedVersion !== undefined) {
        throw new SkillCatalogSaveError("revision-conflict", "目标技能不存在，传入的写回基准已失效（revision-conflict）");
      }
      return;
    }
    if (draft.forceOverwrite === true) {
      if (draft.expectedRevision !== undefined && entry.revision !== draft.expectedRevision) {
        throw new SkillCatalogSaveError("revision-conflict", `技能修订已变更为 ${entry.revision}（预期 ${draft.expectedRevision}）`);
      }
      return;
    }
    if (draft.expectedRevision === undefined && draft.expectedVersion === undefined) {
      throw new SkillCatalogSaveError("revision-conflict", `技能 ${entry.id} 已存在，更新前须先调用 skill_read 获取写回基准，或在确认卡片中显式选择覆盖`);
    }
    if (draft.expectedRevision !== undefined && entry.revision !== draft.expectedRevision) {
      throw new SkillCatalogSaveError("revision-conflict", `技能修订已变更为 ${entry.revision}（预期 ${draft.expectedRevision}）`);
    }
    if (draft.expectedVersion !== undefined) {
      const currentVersion = await this.#resolvePackageVersion(entry);
      if (currentVersion === null || currentVersion !== draft.expectedVersion) {
        throw new SkillCatalogSaveError("revision-conflict", `技能包版本已变更为 ${currentVersion ?? "unknown"}（预期 ${draft.expectedVersion}）`);
      }
    }
  }

  async #resolvePackageVersion(entry: SkillCatalogEntryV2): Promise<string | null> {
    if (entry.packageRef && this.correctness.readBytes) {
      return decodeSkillPackageArchive(await this.correctness.readBytes(entry.packageRef)).packageVersion;
    }
    if (this.correctness.readContent) {
      const rootDoc = await this.correctness.readContent(entry.contentRef);
      return encodeSkillPackageArchive([{ path: SKILL_PACKAGE_ROOT_PATH, content: rootDoc, kind: "root" }]).packageVersion;
    }
    return null;
  }

  async #readCurrent(
    skillId: string,
    currentRequestIdentity?: string,
  ): Promise<{ readonly entry: SkillCatalogEntryV2 | null; readonly replayRecord?: SkillCatalogSaveOverlayRecord }> {
    const rawEntry = this.correctness.readCatalogEntryV2
      ? await this.correctness.readCatalogEntryV2(skillId)
      : await this.correctness.readCatalogEntry(skillId);
    let entry: SkillCatalogEntryV2 | null = rawEntry ? normalizeEntryToV2(rawEntry) : null;

    const overlay = await this.correctness.readOverlay();
    const replayRecords = currentRequestIdentity === undefined
      ? []
      : overlay.filter((record) => record.requestIdentity === currentRequestIdentity);
    if (replayRecords.length > 1) {
      throw new Error("Skill save overlay contains a duplicate operation identity");
    }
    const replayRecordSeq = replayRecords[0]?.recordSeq;
    for (const record of overlay) {
      if (replayRecordSeq !== undefined && record.recordSeq >= replayRecordSeq) continue;
      entry = applyOverlayMutation(skillId, entry, record, this.correctness.assignmentIssuedAt());
    }
    return { entry, ...(replayRecords[0] === undefined ? {} : { replayRecord: replayRecords[0] }) };
  }
}

export function isSkillCatalogSaveMutation(
  mutation: SkillCatalogSaveOverlayMutation,
): mutation is SkillCatalogSaveMutation {
  return (
    mutation.kind === "skill-create" ||
    mutation.kind === "skill-update" ||
    mutation.kind === "skill-create-v2" ||
    mutation.kind === "skill-update-v2"
  );
}

export function isV2SkillSaveMutation(
  mutation: SkillCatalogSaveMutation,
): mutation is Extract<
  SkillCatalogSaveMutation,
  { readonly kind: "skill-create-v2" | "skill-update-v2" }
> {
  return mutation.kind === "skill-create-v2" || mutation.kind === "skill-update-v2";
}

export function sameSkillSaveDraft(
  replay: SkillCatalogSaveMutation,
  candidate: SkillCatalogSaveMutation,
): boolean {
  if (replay.mode !== candidate.mode) {
    return false;
  }
  const replayIsV2 = isV2SkillSaveMutation(replay);
  const candidateIsV2 = isV2SkillSaveMutation(candidate);
  if (replayIsV2 !== candidateIsV2) {
    return false;
  }
  const compatibleKind =
    replay.kind === candidate.kind ||
    (replay.kind === "skill-create" && candidate.kind === "skill-update") ||
    (replay.kind === "skill-create-v2" && candidate.kind === "skill-update-v2");
  if (!compatibleKind) {
    return false;
  }
  const sameBase =
    replay.record.name === candidate.record.name &&
    replay.record.description === candidate.record.description &&
    replay.record.content.digest === candidate.record.content.digest &&
    replay.record.content.bytes === candidate.record.content.bytes;
  if (!sameBase) return false;
  if (replayIsV2 && isV2SkillSaveMutation(candidate)) {
    return (
      replay.record.visibility.modelAutoIndex === candidate.record.visibility.modelAutoIndex &&
      replay.record.visibility.userSlashCommand === candidate.record.visibility.userSlashCommand &&
      replay.record.packageRef?.digest === candidate.record.packageRef?.digest &&
      replay.record.packageRef?.bytes === candidate.record.packageRef?.bytes
    );
  }
  return true;
}
