import {
  SKILL_PACKAGE_ARCHIVE_VERSION,
  normalizeSkillPackagePath,
  truncateUtf8ToBytes,
  type SkillPackageArchiveHeader,
  type SkillPackageMemberKind,
} from "./archive.js";
import { skillNameToId } from "./id.js";
import {
  DEFAULT_SKILL_VISIBILITY,
  type SkillCatalogEntry,
  type SkillCatalogEntryV2,
} from "./types.js";
import type { SkillCatalogSaveOverlayRecord } from "./catalog-save-service.js";

export const SKILL_READ_MAX_RESPONSE_BYTES = 12_288;

export type SkillPackageReadErrorCode =
  | "skill-disabled"
  | "not-found"
  | "missing-expected-version"
  | "workspace-required"
  | "invalid-resource"
  | "invalid-cursor";

export class SkillPackageReadError extends Error {
  constructor(
    readonly code: SkillPackageReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillPackageReadError";
  }
}

export interface SkillPackageNavigationItem {
  readonly resource: string;
  readonly kind: SkillPackageMemberKind;
  readonly mediaType: string;
  readonly bytes: number;
  readonly summary: string;
}

export interface SkillPackageReadSuccessOutcome {
  readonly id: string;
  readonly name: string;
  readonly resource: string;
  readonly packageVersion: string;
  readonly revision?: number;
  readonly readTemplate: { readonly id: string; readonly expectedVersion: string };
  readonly writeTemplate?: {
    readonly expectedVersion: string;
    readonly expectedRevision: number;
  };
  readonly content: string;
  readonly partialBlock?: boolean;
  readonly navigation: readonly SkillPackageNavigationItem[];
  readonly referencedResources: readonly string[];
  readonly nextCursor?: string;
  readonly eof: boolean;
}

export interface SkillPackageChangedResource {
  readonly resource: string;
  readonly change: "added" | "modified" | "removed";
}

export type SkillPackageVersionMismatchOutcome =
  | {
      readonly error: "version-mismatch";
      readonly diffStatus: "complete";
      readonly currentPackageVersion: string;
      readonly changedResources: readonly SkillPackageChangedResource[];
    }
  | {
      readonly error: "version-mismatch";
      readonly diffStatus: "unavailable";
      readonly currentPackageVersion: string;
    };

export interface ParsedSkillReadCursor {
  readonly v: 1;
  readonly id: string;
  readonly pv: string;
  readonly r: string;
  readonly t: number;
  readonly rf?: number;
  readonly n: number;
}

export function foldSkillCatalogEntry(
  skillId: string,
  initial: SkillCatalogEntry | SkillCatalogEntryV2 | null,
  overlay: readonly SkillCatalogSaveOverlayRecord[],
  issuedAt: string,
): SkillCatalogEntryV2 | null {
  let entry = initial ? normalizeEntryToV2(initial) : null;
  for (const record of overlay) {
    entry = applyOverlayMutation(skillId, entry, record, issuedAt);
  }
  return entry;
}

export function normalizeEntryToV2(
  raw: SkillCatalogEntry | SkillCatalogEntryV2,
): SkillCatalogEntryV2 {
  const v2 = raw as Partial<SkillCatalogEntryV2>;
  return {
    ...raw,
    visibility: v2.visibility
      ? {
          modelAutoIndex: v2.visibility.modelAutoIndex,
          userSlashCommand: v2.visibility.userSlashCommand,
        }
      : { ...DEFAULT_SKILL_VISIBILITY },
    ...(v2.packageRef !== undefined ? { packageRef: { ...v2.packageRef } } : {}),
  };
}

export function applyOverlayMutation(
  skillId: string,
  entry: SkillCatalogEntryV2 | null,
  record: SkillCatalogSaveOverlayRecord,
  issuedAt: string,
): SkillCatalogEntryV2 | null {
  const mutation = record.mutation;
  const mutationId = skillNameToId(mutation.record.name);
  if (mutationId !== skillId) return entry;

  if (
    mutation.kind === "skill-create-v2" ||
    mutation.kind === "skill-admit-v2" ||
    mutation.kind === "skill-update-v2"
  ) {
    return {
      id: mutationId,
      name: mutation.record.name,
      description: mutation.record.description,
      source: mutation.kind === "skill-admit-v2" ? "linked" : "own",
      mode: mutation.mode,
      pinned: entry?.pinned ?? false,
      disabled: false,
      createdAt: entry?.createdAt ?? issuedAt,
      usage: entry?.usage ?? null,
      contentRef: { ...mutation.record.content },
      revision: entry ? entry.revision + 1 : 1,
      digest: record.mutationDigest,
      visibility: { ...mutation.record.visibility },
      ...(mutation.record.packageRef !== undefined
        ? { packageRef: { ...mutation.record.packageRef } }
        : {}),
    };
  }

  return {
    id: mutationId,
    name: mutation.record.name,
    description: mutation.record.description,
    source: mutation.kind === "skill-admit" ? "linked" : "own",
    mode: mutation.mode,
    pinned: entry?.pinned ?? false,
    disabled: false,
    createdAt: entry?.createdAt ?? issuedAt,
    usage: entry?.usage ?? null,
    contentRef: { ...mutation.record.content },
    revision: entry ? entry.revision + 1 : 1,
    digest: record.mutationDigest,
    visibility: entry?.visibility
      ? { ...entry.visibility }
      : { ...DEFAULT_SKILL_VISIBILITY },
  };
}

export function normalizeResourceOrThrow(raw: string): string {
  try {
    return normalizeSkillPackagePath(raw);
  } catch (error) {
    throw new SkillPackageReadError(
      "invalid-resource",
      error instanceof Error ? error.message : "Invalid resource path",
    );
  }
}

export function encodeSkillReadCursor(cursor: ParsedSkillReadCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSkillReadCursor(raw: string): ParsedSkillReadCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ParsedSkillReadCursor>;
    if (
      parsed.v !== SKILL_PACKAGE_ARCHIVE_VERSION ||
      typeof parsed.id !== "string" ||
      typeof parsed.pv !== "string" ||
      typeof parsed.r !== "string" ||
      !Number.isSafeInteger(parsed.t) ||
      (parsed.rf !== undefined && (!Number.isSafeInteger(parsed.rf) || parsed.rf < 0)) ||
      !Number.isSafeInteger(parsed.n)
    ) {
      throw new Error("bad cursor fields");
    }
    return {
      v: 1,
      id: parsed.id,
      pv: parsed.pv,
      r: normalizeSkillPackagePath(parsed.r),
      t: parsed.t!,
      ...(parsed.rf !== undefined ? { rf: parsed.rf } : {}),
      n: parsed.n!,
    };
  } catch {
    throw new SkillPackageReadError("invalid-cursor", "Invalid skill_read pagination cursor");
  }
}

export function computeHeaderDiff(
  previous: SkillPackageArchiveHeader,
  current: SkillPackageArchiveHeader,
): SkillPackageChangedResource[] {
  const prevByPath = new Map(previous.members.map((m) => [m.path, m]));
  const currByPath = new Map(current.members.map((m) => [m.path, m]));
  const allPaths = [...new Set([...prevByPath.keys(), ...currByPath.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const diffs: SkillPackageChangedResource[] = [];
  for (const memberPath of allPaths) {
    const prev = prevByPath.get(memberPath);
    const curr = currByPath.get(memberPath);
    if (!prev && curr) {
      diffs.push({ resource: memberPath, change: "added" });
    } else if (prev && !curr) {
      diffs.push({ resource: memberPath, change: "removed" });
    } else if (prev && curr && (prev.sha256 !== curr.sha256 || prev.bytes !== curr.bytes)) {
      diffs.push({ resource: memberPath, change: "modified" });
    }
  }
  return diffs;
}

export function packSkillReadPage(
  base: Omit<
    SkillPackageReadSuccessOutcome,
    "content" | "navigation" | "referencedResources" | "nextCursor" | "eof" | "partialBlock"
  >,
  memberBytes: Buffer,
  textOffset: number,
  allRefs: readonly string[],
  refOffset: number,
  allNav: readonly SkillPackageNavigationItem[],
  navOffset: number,
  qualifiedId: string,
  packageVersion: string,
  targetPath: string,
): SkillPackageReadSuccessOutcome {
  // 按最坏游标长度预留字节（含 t/rf/n 最大偏移占位），保证最终替换真实游标后永不超限
  const worstCaseCursor = encodeSkillReadCursor({
    v: 1,
    id: qualifiedId,
    pv: packageVersion,
    r: targetPath,
    t: Math.max(memberBytes.byteLength, 999_999),
    rf: Math.max(allRefs.length, 999),
    n: Math.max(allNav.length, 999),
  });

  const measureWith = (
    content: string,
    referencedResources: readonly string[],
    navigation: readonly SkillPackageNavigationItem[],
    eof: boolean,
    partialBlock: boolean | undefined,
    cursorPlaceholder: string | undefined,
  ): number => {
    const obj: SkillPackageReadSuccessOutcome = {
      ...base,
      content,
      ...(partialBlock ? { partialBlock: true } : {}),
      navigation,
      referencedResources,
      ...(cursorPlaceholder ? { nextCursor: cursorPlaceholder } : {}),
      eof,
    };
    return Buffer.byteLength(JSON.stringify(obj), "utf8");
  };

  const remainingTextBytes = memberBytes.byteLength - textOffset;
  let chosenContent = "";
  let nextTextOffset = textOffset;
  let partialBlock: boolean | undefined;

  if (remainingTextBytes > 0) {
    const rawRemaining = memberBytes.subarray(textOffset).toString("utf8");
    const trailingItemsEmpty = refOffset >= allRefs.length && navOffset >= allNav.length;
    if (
      measureWith(
        rawRemaining,
        [],
        [],
        trailingItemsEmpty,
        undefined,
        trailingItemsEmpty ? undefined : worstCaseCursor,
      ) <= SKILL_READ_MAX_RESPONSE_BYTES
    ) {
      chosenContent = rawRemaining;
      nextTextOffset = memberBytes.byteLength;
    } else {
      // 二分法按码点安全截取能放进 12,288 B（预留 worstCaseCursor 与 partialBlock 字段）的最大文本切片
      const maxSliceUtf8 = Math.min(remainingTextBytes, SKILL_READ_MAX_RESPONSE_BYTES);
      let lo = 1;
      let hi = maxSliceUtf8;
      let bestText = "";
      let bestBytes = 0;

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const safeText = truncateUtf8ToBytes(rawRemaining, mid);
        const safeByteLen = Buffer.byteLength(safeText, "utf8");
        if (
          safeByteLen > 0 &&
          measureWith(safeText, [], [], false, true, worstCaseCursor) <=
            SKILL_READ_MAX_RESPONSE_BYTES
        ) {
          bestText = safeText;
          bestBytes = safeByteLen;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (bestBytes === 0) {
        throw new SkillPackageReadError(
          "invalid-cursor",
          "Response metadata leaves zero budget for skill content page",
        );
      }

      // 若切片内存在换行符，优先在最后一个换行处对齐行边界；若单行本身超限，保留切分点并标 partialBlock: true
      const lastNewline = bestText.lastIndexOf("\n");
      if (lastNewline >= 0) {
        const lineAligned = bestText.slice(0, lastNewline + 1);
        const alignedBytes = Buffer.byteLength(lineAligned, "utf8");
        if (alignedBytes > 0) {
          chosenContent = lineAligned;
          nextTextOffset = textOffset + alignedBytes;
        } else {
          chosenContent = bestText;
          nextTextOffset = textOffset + bestBytes;
          partialBlock = true;
        }
      } else {
        chosenContent = bestText;
        nextTextOffset = textOffset + bestBytes;
        partialBlock = true;
      }
    }
  }

  const textDone = nextTextOffset >= memberBytes.byteLength;
  const referencedResources: string[] = [];
  let nextRefOffset = refOffset;

  if (textDone) {
    for (let i = refOffset; i < allRefs.length; i += 1) {
      const candidateRef = allRefs[i]!;
      const isFinalItem = i === allRefs.length - 1 && navOffset >= allNav.length;
      const testRefs = [...referencedResources, candidateRef];
      const fits =
        measureWith(
          chosenContent,
          testRefs,
          [],
          isFinalItem,
          partialBlock,
          isFinalItem ? undefined : worstCaseCursor,
        ) <= SKILL_READ_MAX_RESPONSE_BYTES;
      if (!fits) break;
      referencedResources.push(candidateRef);
      nextRefOffset = i + 1;
    }
  }

  const refsDone = textDone && nextRefOffset >= allRefs.length;
  const navigation: SkillPackageNavigationItem[] = [];
  let nextNavOffset = navOffset;

  if (refsDone) {
    for (let i = navOffset; i < allNav.length; i += 1) {
      const candidateItem = allNav[i]!;
      const willBeLast = i === allNav.length - 1;
      const testNav = [...navigation, candidateItem];
      const fits =
        measureWith(
          chosenContent,
          referencedResources,
          testNav,
          willBeLast,
          partialBlock,
          willBeLast ? undefined : worstCaseCursor,
        ) <= SKILL_READ_MAX_RESPONSE_BYTES;
      if (!fits) break;
      navigation.push(candidateItem);
      nextNavOffset = i + 1;
    }
  }

  const eof = refsDone && nextNavOffset >= allNav.length;
  const finalCursor = eof
    ? undefined
    : encodeSkillReadCursor({
        v: 1,
        id: qualifiedId,
        pv: packageVersion,
        r: targetPath,
        t: nextTextOffset,
        rf: nextRefOffset,
        n: nextNavOffset,
      });

  if (
    !eof &&
    nextTextOffset === textOffset &&
    nextRefOffset === refOffset &&
    nextNavOffset === navOffset
  ) {
    throw new SkillPackageReadError(
      "invalid-cursor",
      "Unable to make forward progress within 12,288 B page budget",
    );
  }

  const response: SkillPackageReadSuccessOutcome = {
    ...base,
    content: chosenContent,
    ...(partialBlock ? { partialBlock: true } : {}),
    navigation,
    referencedResources,
    ...(finalCursor ? { nextCursor: finalCursor } : {}),
    eof,
  };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > SKILL_READ_MAX_RESPONSE_BYTES) {
    throw new Error("Skill read response exceeded strict 12,288 UTF-8 byte budget");
  }
  return response;
}
