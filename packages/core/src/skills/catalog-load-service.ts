import type { ArtifactRef } from "../contracts/index.js";
import { parseFrontmatter } from "../frontmatter.js";
import {
  SKILL_PACKAGE_HEADER_PREFIX_BYTES,
  SKILL_PACKAGE_ROOT_PATH,
  decodeSkillPackageArchive,
  encodeSkillPackageArchive,
  parseSkillPackageHeaderSlice,
  verifySkillPackageMemberSlice,
  type SkillPackageArchiveHeader,
  type SkillPackageMemberManifest,
} from "./archive.js";
import { getBuiltinSkill } from "./builtin.js";
import { formatQualifiedSkillId, parseQualifiedSkillId } from "./id.js";
import {
  SKILL_READ_MAX_RESPONSE_BYTES,
  SkillPackageReadError,
  computeHeaderDiff,
  decodeSkillReadCursor,
  foldSkillCatalogEntry,
  normalizeResourceOrThrow,
  packSkillReadPage,
  type SkillPackageNavigationItem,
  type SkillPackageReadSuccessOutcome,
  type SkillPackageVersionMismatchOutcome,
} from "./package-pagination.js";
import type { SkillCatalogSaveOverlayRecord } from "./catalog-save-service.js";
import type { SkillCatalogEntry, SkillCatalogEntryV2 } from "./types.js";

/** Skill-owned request for loading executable instructions within one tool operation. */
export interface SkillCatalogLoadRequest {
  readonly id: string;
  readonly operationId?: string;
}

/** Stable projection consumed by load_skill; storage and assignment details stay private. */
export interface SkillCatalogLoadOutcome {
  readonly id: string;
  readonly name: string;
  readonly body: string;
}

export interface SkillPackageReadRequest {
  readonly id: string;
  readonly resource?: string;
  readonly expectedVersion?: string;
  readonly cursor?: string;
  readonly operationId?: string;
}

export type SkillPackageReadOutcome =
  | SkillPackageReadSuccessOutcome
  | SkillPackageVersionMismatchOutcome;

export interface SkillMaterializeReadRequest {
  readonly id: string;
  readonly resource: string;
  readonly expectedVersion: string;
}

export interface SkillMaterializeReadSuccessOutcome {
  readonly id: string;
  readonly resource: string;
  readonly packageVersion: string;
  readonly content: string;
}

export type SkillMaterializeReadOutcome =
  | SkillMaterializeReadSuccessOutcome
  | SkillPackageVersionMismatchOutcome;

/** The only application entry for load_skill / skill_read and its durable usage hit. */
export interface SkillCatalogLoadApplication {
  load(request: SkillCatalogLoadRequest): Promise<SkillCatalogLoadOutcome>;
  readPackage?(request: SkillPackageReadRequest): Promise<SkillPackageReadOutcome>;
  readMaterializeResource?(
    request: SkillMaterializeReadRequest,
  ): Promise<SkillMaterializeReadOutcome>;
}

export interface SkillCatalogUsageMutation {
  readonly kind: "skill-usage";
  readonly record: {
    readonly skillId: string;
    readonly occurredAt: string;
    readonly hitDelta: 1;
  };
}

/** Explicit execution scope; missing assignment context remains an adapter error. */
export type SkillCatalogLoadScope =
  | {
      readonly kind: "assignment";
      readonly entry: SkillCatalogEntry | SkillCatalogEntryV2 | null;
      readonly overlay: readonly SkillCatalogSaveOverlayRecord[];
      readonly issuedAt: string;
    }
  | {
      /** Production runtime without ArtifactStore: immutable builtins only. */
      readonly kind: "builtin-only";
    };

/**
 * Path-free Correctness adapter for Skill loading & v2 package pagination. The Skill application
 * owns user-over-builtin/qualified-namespace selection, disabled gating, overlay folding,
 * 12 KiB dual-offset pagination and usage identity.
 */
export interface SkillCatalogLoadCorrectnessPort {
  readScope(skillId: string): Promise<SkillCatalogLoadScope>;
  readContent(content: ArtifactRef): Promise<string>;
  readBytes?(ref: ArtifactRef): Promise<Uint8Array>;
  readByteRange?(ref: ArtifactRef, offset: number, length: number): Promise<Uint8Array>;
  hasAuthorizedWorkspace?(): boolean;
  readPackageHeaderByVersion?(
    skillId: string,
    packageVersion: string,
  ): Promise<SkillPackageArchiveHeader | null>;
  stageUsage(operationId: string, mutation: SkillCatalogUsageMutation): Promise<void>;
}

const ARCHIVE_HEADER_INITIAL_SLICE_BYTES = 16_384;
const ARCHIVE_HEADER_MAGIC_BYTES = 8;

interface ResolvedPackageTarget {
  readonly kind: "user" | "system";
  readonly localId: string;
  readonly qualifiedId: string;
  readonly cacheKey: string;
  readonly name: string;
  readonly revision?: number;
  readonly issuedAt?: string;
  readonly header: SkillPackageArchiveHeader;
  readonly packageVersion: string;
  readonly readMemberText: (meta: SkillPackageMemberManifest) => Promise<string>;
}

/** Skill-owned load / readPackage and usage application over assignment-scoped adapters. */
export class SkillCatalogLoadApplicationService
  implements SkillCatalogLoadApplication
{
  readonly #knownHeaders = new Map<string, SkillPackageArchiveHeader>();
  readonly #archiveHeaders = new Map<
    string,
    {
      readonly header: SkillPackageArchiveHeader;
      readonly dataOffset: number;
      readonly packageVersion: string;
    }
  >();

  constructor(private readonly correctness: SkillCatalogLoadCorrectnessPort) {}

  async load(request: SkillCatalogLoadRequest): Promise<SkillCatalogLoadOutcome> {
    const rawId = typeof request?.id === "string" ? request.id.trim() : "";
    if (!rawId) throw new Error("Skill id must be non-empty");
    const parsedId = parseQualifiedSkillId(rawId);
    const id = parsedId.localId;
    if (!id) throw new Error("Skill id must be non-empty");

    const builtin = getBuiltinSkill(id);
    if (parsedId.namespace === "system") {
      if (!builtin) throw new Error(`Skill not found: ${rawId}`);
      return { id: builtin.id, name: builtin.name, body: builtin.body };
    }

    const scope = await this.correctness.readScope(id);
    if (scope.kind === "builtin-only") {
      if (!builtin || parsedId.namespace === "user") {
        throw new Error("User skills require an active artifact-backed assignment");
      }
      return { id: builtin.id, name: builtin.name, body: builtin.body };
    }

    const entry = foldSkillCatalogEntry(
      id,
      scope.entry,
      scope.overlay,
      scope.issuedAt,
    );
    if (!entry) {
      if (!builtin || parsedId.namespace === "user") {
        throw new Error(`Skill not found: ${rawId}`);
      }
      return { id: builtin.id, name: builtin.name, body: builtin.body };
    }
    if (entry.disabled) {
      throw new SkillPackageReadError("skill-disabled", `Skill "${entry.id}" is disabled`);
    }

    const document = await this.correctness.readContent(entry.contentRef);
    const parsed = parseFrontmatter(document);
    if (!request.operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }
    await this.correctness.stageUsage(`${request.operationId}:usage`, {
      kind: "skill-usage",
      record: {
        skillId: entry.id,
        occurredAt: scope.issuedAt,
        hitDelta: 1,
      },
    });
    return { id: entry.id, name: entry.name, body: parsed.content };
  }

  async readPackage(request: SkillPackageReadRequest): Promise<SkillPackageReadOutcome> {
    const rawId = typeof request?.id === "string" ? request.id.trim() : "";
    const parsedId = parseQualifiedSkillId(rawId);
    if (!parsedId.localId) {
      throw new SkillPackageReadError("not-found", "Skill id must be non-empty");
    }

    const cursorData =
      request.cursor !== undefined ? decodeSkillReadCursor(request.cursor) : undefined;
    if (cursorData && cursorData.id !== "" && parseQualifiedSkillId(cursorData.id).localId !== parsedId.localId) {
      throw new SkillPackageReadError("invalid-cursor", "Cursor does not match requested skill id");
    }

    const resolved = await this.#resolvePackageTarget(parsedId.namespace, parsedId.localId, rawId);
    this.#rememberHeader(resolved.cacheKey, resolved.packageVersion, resolved.header);

    const requestedVersion = cursorData?.pv ?? request.expectedVersion;
    const requestedResource = cursorData
      ? cursorData.r
      : request.resource !== undefined
        ? normalizeResourceOrThrow(request.resource)
        : undefined;

    // 读取子资源（含非根目录续读）必须提供 expectedVersion（"latest" 例外）
    if (
      !cursorData &&
      requestedResource !== undefined &&
      requestedVersion === undefined
    ) {
      throw new SkillPackageReadError(
        "missing-expected-version",
        "读取技能包附属资源必须提供 expectedVersion（或显式传 \"latest\"）",
      );
    }

    // 先检查版本一致，再判定目标资源是否存在（0 次成员正文读取）
    if (
      requestedVersion !== undefined &&
      requestedVersion !== "latest" &&
      requestedVersion !== resolved.packageVersion
    ) {
      return this.#buildVersionMismatch(
        resolved.cacheKey,
        resolved.localId,
        requestedVersion,
        resolved.packageVersion,
        resolved.header,
      );
    }

    const targetPath = requestedResource ?? SKILL_PACKAGE_ROOT_PATH;
    const memberMeta = resolved.header.members.find((m) => m.path === targetPath);
    if (!memberMeta) {
      throw new SkillPackageReadError(
        "not-found",
        `Skill package resource not found: ${targetPath}`,
      );
    }

    const memberText = await resolved.readMemberText(memberMeta);
    const textOffset = cursorData?.t ?? 0;
    const refOffset = cursorData?.rf ?? 0;
    const navOffset = cursorData?.n ?? 0;
    const memberBytes = Buffer.from(memberText, "utf8");
    if (textOffset < 0 || textOffset > memberBytes.byteLength) {
      throw new SkillPackageReadError("invalid-cursor", "Cursor text offset out of bounds");
    }

    const allNav: SkillPackageNavigationItem[] = resolved.header.members.map((m) => ({
      resource: m.path,
      kind: m.kind,
      mediaType: m.mediaType,
      bytes: m.bytes,
      summary: m.summary,
    }));
    if (navOffset < 0 || navOffset > allNav.length) {
      throw new SkillPackageReadError("invalid-cursor", "Cursor navigation offset out of bounds");
    }

    const allPaths = resolved.header.members.map((m) => m.path);
    const allReferenced = allPaths.filter(
      (candidatePath) => candidatePath !== targetPath && memberText.includes(candidatePath),
    );
    if (refOffset < 0 || refOffset > allReferenced.length) {
      throw new SkillPackageReadError("invalid-cursor", "Cursor reference offset out of bounds");
    }

    const isRootOpening = targetPath === SKILL_PACKAGE_ROOT_PATH && !cursorData;
    const isFirstPageOfRoot = isRootOpening && textOffset === 0 && refOffset === 0 && navOffset === 0;
    const readTemplate = { id: resolved.qualifiedId, expectedVersion: resolved.packageVersion };
    const writeTemplate =
      resolved.kind === "user" && resolved.revision !== undefined
        ? { expectedVersion: resolved.packageVersion, expectedRevision: resolved.revision }
        : undefined;

    const baseResponse: Omit<
      SkillPackageReadSuccessOutcome,
      "content" | "navigation" | "referencedResources" | "nextCursor" | "eof" | "partialBlock"
    > = {
      id: resolved.qualifiedId,
      name: resolved.name,
      resource: targetPath,
      packageVersion: resolved.packageVersion,
      ...(resolved.revision !== undefined ? { revision: resolved.revision } : {}),
      readTemplate,
      ...(writeTemplate && isFirstPageOfRoot ? { writeTemplate } : {}),
    };

    const packed = packSkillReadPage(
      baseResponse,
      memberBytes,
      textOffset,
      allReferenced,
      refOffset,
      allNav,
      navOffset,
      resolved.qualifiedId,
      resolved.packageVersion,
      targetPath,
    );

    // 仅顶层耐久指派首次成功读 user 根入口幂等记 1 次 usage；builtin-only 与系统包零写入。
    if (
      resolved.kind === "user" &&
      resolved.issuedAt !== undefined &&
      isRootOpening &&
      request.operationId
    ) {
      await this.correctness.stageUsage(`${request.operationId}:usage`, {
        kind: "skill-usage",
        record: {
          skillId: resolved.localId,
          occurredAt: resolved.issuedAt,
          hitDelta: 1,
        },
      });
    }

    return packed;
  }

  async readMaterializeResource(
    request: SkillMaterializeReadRequest,
  ): Promise<SkillMaterializeReadOutcome> {
    if (
      this.correctness.hasAuthorizedWorkspace &&
      !this.correctness.hasAuthorizedWorkspace()
    ) {
      throw new SkillPackageReadError(
        "workspace-required",
        "skill_materialize 仅允许在具备已授权工作区的会话中执行",
      );
    }

    const rawId = typeof request?.id === "string" ? request.id.trim() : "";
    const parsedId = parseQualifiedSkillId(rawId);
    if (!parsedId.localId) {
      throw new SkillPackageReadError("not-found", "Skill id must be non-empty");
    }

    const expectedVersion =
      typeof request?.expectedVersion === "string" ? request.expectedVersion.trim() : "";
    if (!expectedVersion || expectedVersion === "latest") {
      throw new SkillPackageReadError(
        "missing-expected-version",
        "导出技能文件必须传入明确的非 latest expectedVersion",
      );
    }

    const targetPath = normalizeResourceOrThrow(request.resource);
    const resolved = await this.#resolvePackageTarget(
      parsedId.namespace,
      parsedId.localId,
      rawId,
    );
    this.#rememberHeader(resolved.cacheKey, resolved.packageVersion, resolved.header);

    if (expectedVersion !== resolved.packageVersion) {
      return this.#buildVersionMismatch(
        resolved.cacheKey,
        resolved.localId,
        expectedVersion,
        resolved.packageVersion,
        resolved.header,
      );
    }

    const memberMeta = resolved.header.members.find((m) => m.path === targetPath);
    if (!memberMeta) {
      throw new SkillPackageReadError(
        "not-found",
        `Skill package resource not found: ${targetPath}`,
      );
    }

    return {
      id: resolved.qualifiedId,
      resource: targetPath,
      packageVersion: resolved.packageVersion,
      content: await resolved.readMemberText(memberMeta),
    };
  }

  #rememberArchiveHeader(
    digest: string,
    entry: {
      readonly header: SkillPackageArchiveHeader;
      readonly dataOffset: number;
      readonly packageVersion: string;
    },
  ): void {
    if (this.#archiveHeaders.has(digest)) {
      this.#archiveHeaders.delete(digest);
    } else if (this.#archiveHeaders.size >= 256) {
      const oldest = this.#archiveHeaders.keys().next().value;
      if (oldest !== undefined) this.#archiveHeaders.delete(oldest);
    }
    this.#archiveHeaders.set(digest, entry);
  }

  async #readArchiveHeaderViaRange(ref: ArtifactRef): Promise<{
    readonly header: SkillPackageArchiveHeader;
    readonly dataOffset: number;
    readonly packageVersion: string;
  }> {
    const cached = this.#archiveHeaders.get(ref.digest);
    if (cached) {
      this.#rememberArchiveHeader(ref.digest, cached);
      return cached;
    }
    const readRange = this.correctness.readByteRange!;
    const initialLen = Math.min(ref.bytes, ARCHIVE_HEADER_INITIAL_SLICE_BYTES);
    const firstSlice = await readRange(ref, 0, initialLen);
    if (firstSlice.byteLength < SKILL_PACKAGE_HEADER_PREFIX_BYTES) {
      return parseSkillPackageHeaderSlice(firstSlice, ref.bytes);
    }
    const headerLen = Buffer.from(
      firstSlice.buffer,
      firstSlice.byteOffset,
      firstSlice.byteLength,
    ).readUInt32BE(ARCHIVE_HEADER_MAGIC_BYTES);
    const dataOffset = SKILL_PACKAGE_HEADER_PREFIX_BYTES + headerLen;
    const headerSlice =
      dataOffset <= firstSlice.byteLength || dataOffset > ref.bytes
        ? firstSlice
        : await readRange(ref, 0, dataOffset);
    const parsed = parseSkillPackageHeaderSlice(headerSlice, ref.bytes);
    this.#rememberArchiveHeader(ref.digest, parsed);
    return parsed;
  }

  #rememberHeader(
    cacheKey: string,
    packageVersion: string,
    header: SkillPackageArchiveHeader,
  ): void {
    const key = `${cacheKey}:${packageVersion}`;
    if (!this.#knownHeaders.has(key)) {
      if (this.#knownHeaders.size >= 256) {
        const oldest = this.#knownHeaders.keys().next().value;
        if (oldest !== undefined) this.#knownHeaders.delete(oldest);
      }
      this.#knownHeaders.set(key, header);
    }
  }

  async #buildVersionMismatch(
    cacheKey: string,
    localId: string,
    expectedVersion: string,
    currentPackageVersion: string,
    currentHeader: SkillPackageArchiveHeader,
  ): Promise<SkillPackageVersionMismatchOutcome> {
    const cached =
      this.#knownHeaders.get(`${cacheKey}:${expectedVersion}`) ??
      (await this.correctness.readPackageHeaderByVersion?.(localId, expectedVersion)) ??
      null;
    if (cached) {
      const changedResources = computeHeaderDiff(cached, currentHeader);
      const completePayload: SkillPackageVersionMismatchOutcome = {
        error: "version-mismatch",
        diffStatus: "complete",
        currentPackageVersion,
        changedResources,
      };
      if (Buffer.byteLength(JSON.stringify(completePayload), "utf8") <= SKILL_READ_MAX_RESPONSE_BYTES) {
        return completePayload;
      }
    }
    return {
      error: "version-mismatch",
      diffStatus: "unavailable",
      currentPackageVersion,
    };
  }

  #fromDecodedBuiltin(builtin: NonNullable<ReturnType<typeof getBuiltinSkill>>): {
    readonly header: SkillPackageArchiveHeader;
    readonly packageVersion: string;
    readonly readMemberText: (meta: SkillPackageMemberManifest) => Promise<string>;
  } {
    const decoded = decodeSkillPackageArchive(builtin.archive.bytes);
    return {
      header: decoded.header,
      packageVersion: decoded.packageVersion,
      readMemberText: async (meta) => decoded.byPath.get(meta.path)!.text,
    };
  }

  async #resolvePackageTarget(
    namespace: "system" | "user" | undefined,
    localId: string,
    rawId: string,
  ): Promise<ResolvedPackageTarget> {
    const builtin = getBuiltinSkill(localId);
    if (namespace === "system") {
      if (!builtin) {
        throw new SkillPackageReadError("not-found", `System skill not found: ${rawId}`);
      }
      return {
        kind: "system",
        localId: builtin.id,
        qualifiedId: formatQualifiedSkillId("system", builtin.id),
        cacheKey: `system:${builtin.id}`,
        name: builtin.name,
        ...this.#fromDecodedBuiltin(builtin),
      };
    }

    const scope = await this.correctness.readScope(localId);
    if (scope.kind === "builtin-only") {
      if (namespace === "user" || !builtin) {
        throw new SkillPackageReadError(
          "not-found",
          "User skills require an active artifact-backed assignment",
        );
      }
      return {
        kind: "system",
        localId: builtin.id,
        qualifiedId: formatQualifiedSkillId("system", builtin.id),
        cacheKey: `system:${builtin.id}`,
        name: builtin.name,
        ...this.#fromDecodedBuiltin(builtin),
      };
    }

    const entry = foldSkillCatalogEntry(
      localId,
      scope.entry,
      scope.overlay,
      scope.issuedAt,
    );
    if (!entry) {
      if (namespace === "user" || !builtin) {
        throw new SkillPackageReadError("not-found", `Skill not found: ${rawId}`);
      }
      return {
        kind: "system",
        localId: builtin.id,
        qualifiedId: formatQualifiedSkillId("system", builtin.id),
        cacheKey: `system:${builtin.id}`,
        name: builtin.name,
        ...this.#fromDecodedBuiltin(builtin),
      };
    }

    if (entry.disabled) {
      throw new SkillPackageReadError("skill-disabled", `Skill "${entry.id}" is disabled`);
    }

    let pkgReader: {
      readonly header: SkillPackageArchiveHeader;
      readonly packageVersion: string;
      readonly readMemberText: (meta: SkillPackageMemberManifest) => Promise<string>;
    };
    if (entry.packageRef && this.correctness.readByteRange) {
      const pkgRef = entry.packageRef;
      const readRange = this.correctness.readByteRange;
      const parsedHeader = await this.#readArchiveHeaderViaRange(pkgRef);
      pkgReader = {
        header: parsedHeader.header,
        packageVersion: parsedHeader.packageVersion,
        readMemberText: async (meta) => {
          const slice = await readRange(pkgRef, parsedHeader.dataOffset + meta.offset, meta.bytes);
          return verifySkillPackageMemberSlice(meta, slice);
        },
      };
    } else if (entry.packageRef && this.correctness.readBytes) {
      const decoded = decodeSkillPackageArchive(await this.correctness.readBytes(entry.packageRef));
      pkgReader = {
        header: decoded.header,
        packageVersion: decoded.packageVersion,
        readMemberText: async (meta) => decoded.byPath.get(meta.path)!.text,
      };
    } else {
      const document = await this.correctness.readContent(entry.contentRef);
      const encoded = encodeSkillPackageArchive([
        { path: SKILL_PACKAGE_ROOT_PATH, content: document, kind: "root" },
      ]);
      const decoded = decodeSkillPackageArchive(encoded.bytes);
      pkgReader = {
        header: decoded.header,
        packageVersion: decoded.packageVersion,
        readMemberText: async (meta) => decoded.byPath.get(meta.path)!.text,
      };
    }

    return {
      kind: "user",
      localId: entry.id,
      qualifiedId: formatQualifiedSkillId("user", entry.id),
      cacheKey: `user:${entry.id}`,
      name: entry.name,
      revision: entry.revision,
      issuedAt: scope.issuedAt,
      ...pkgReader,
    };
  }
}
