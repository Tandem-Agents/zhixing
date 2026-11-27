import { createHash } from "node:crypto";
import { parseFrontmatter } from "../frontmatter.js";
import { canonicalize, protocolDigest } from "../protocol/canonical.js";

export const SKILL_PACKAGE_ARCHIVE_VERSION = 1 as const;
export const SKILL_PACKAGE_ARCHIVE_MAGIC = "ZXSKPK1\n";
export const SKILL_PACKAGE_ROOT_PATH = "SKILL.md";
export const SKILL_PACKAGE_MAX_MEMBERS = 64;
export const SKILL_PACKAGE_MAX_MEMBER_BYTES = 524_288;
export const SKILL_PACKAGE_MAX_TOTAL_BYTES = 2_097_152;
export const SKILL_PACKAGE_MAX_DEPTH = 6;
export const SKILL_PACKAGE_MAX_PATH_BYTES = 256;
export const SKILL_PACKAGE_MAX_SUMMARY_BYTES = 160;

const HEADER_MAGIC_BYTES = Buffer.from(SKILL_PACKAGE_ARCHIVE_MAGIC, "ascii");
export const SKILL_PACKAGE_HEADER_PREFIX_BYTES = HEADER_MAGIC_BYTES.byteLength + 4;
const HEADER_PREFIX_BYTES = SKILL_PACKAGE_HEADER_PREFIX_BYTES;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export type SkillPackageMemberKind = "root" | "resource";

export type SkillPackageArchiveErrorCode =
  | "invalid-path"
  | "duplicate-path"
  | "missing-root"
  | "too-many-members"
  | "member-too-large"
  | "archive-too-large"
  | "invalid-utf8"
  | "nul-byte"
  | "invalid-summary"
  | "corrupt-archive"
  | "range-mismatch";

export class SkillPackageArchiveError extends Error {
  constructor(
    readonly code: SkillPackageArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillPackageArchiveError";
  }
}

export interface SkillPackageMemberInput {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly kind?: SkillPackageMemberKind;
  readonly mediaType?: string;
  readonly summary?: string;
}

export interface SkillPackageMemberManifest {
  readonly path: string;
  readonly kind: SkillPackageMemberKind;
  readonly mediaType: string;
  readonly offset: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly summary: string;
}

export interface SkillPackageArchiveHeader {
  readonly v: typeof SKILL_PACKAGE_ARCHIVE_VERSION;
  readonly members: readonly SkillPackageMemberManifest[];
}

export interface EncodedSkillPackageArchive {
  readonly bytes: Uint8Array;
  readonly header: SkillPackageArchiveHeader;
  readonly dataOffset: number;
  readonly packageVersion: string;
}

export interface DecodedSkillPackageMember {
  readonly meta: SkillPackageMemberManifest;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface DecodedSkillPackageArchive {
  readonly header: SkillPackageArchiveHeader;
  readonly dataOffset: number;
  readonly packageVersion: string;
  readonly members: readonly DecodedSkillPackageMember[];
  readonly byPath: ReadonlyMap<string, DecodedSkillPackageMember>;
}

/**
 * 规范化包内相对路径：POSIX `/`，拒绝对路径、反斜杠、盘符、URL 协议头、
 * `.` / `..`、空段、控制符、深度 `> 6` 与 UTF-8 字节 `> 256`。
 */
export function normalizeSkillPackagePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new SkillPackageArchiveError("invalid-path", "Skill package path must be non-empty");
  }
  if (/[\x00-\x1f\x7f]/.test(rawPath)) {
    throw new SkillPackageArchiveError("invalid-path", "Skill package path contains control characters");
  }
  if (
    rawPath.includes("\\") ||
    rawPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(rawPath) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath)
  ) {
    throw new SkillPackageArchiveError("invalid-path", `Unsafe skill package path: ${rawPath}`);
  }
  const segments = rawPath.split("/");
  if (segments.length > SKILL_PACKAGE_MAX_DEPTH) {
    throw new SkillPackageArchiveError(
      "invalid-path",
      `Skill package path exceeds depth ${SKILL_PACKAGE_MAX_DEPTH}: ${rawPath}`,
    );
  }
  for (const seg of segments) {
    if (seg.length === 0 || seg === "." || seg === "..") {
      throw new SkillPackageArchiveError("invalid-path", `Invalid skill package path segment: ${rawPath}`);
    }
  }
  const normalized = segments.join("/");
  if (Buffer.byteLength(normalized, "utf8") > SKILL_PACKAGE_MAX_PATH_BYTES) {
    throw new SkillPackageArchiveError(
      "invalid-path",
      `Skill package path exceeds ${SKILL_PACKAGE_MAX_PATH_BYTES} UTF-8 bytes`,
    );
  }
  return normalized;
}

/** 严格校验成员纯文本 UTF-8 且不含任何 0x00 NUL 字节。 */
export function assertValidSkillPackageText(bytes: Uint8Array, pathLabel: string): string {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0) {
      throw new SkillPackageArchiveError("nul-byte", `Binary NUL byte in member: ${pathLabel}`);
    }
  }
  try {
    return UTF8_FATAL_DECODER.decode(bytes);
  } catch {
    throw new SkillPackageArchiveError("invalid-utf8", `Invalid UTF-8 text in member: ${pathLabel}`);
  }
}

/** 按 UTF-8 码点边界安全截断文本，确保 `Buffer.byteLength(out, "utf8") <= maxBytes`。 */
export function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = 0;
  let used = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (used + chBytes > maxBytes) break;
    used += chBytes;
    end += ch.length;
  }
  return text.slice(0, end);
}

export function inferSkillMemberMediaType(memberPath: string): string {
  const lower = memberPath.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "text/typescript";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".sh")) return "text/x-shellscript";
  return "text/plain";
}

function deriveMemberSummary(memberPath: string, text: string, explicit?: string): string {
  if (explicit !== undefined) {
    const trimmed = explicit.replace(/[\r\n]+/g, " ").trim();
    if (Buffer.byteLength(trimmed, "utf8") > SKILL_PACKAGE_MAX_SUMMARY_BYTES) {
      return truncateUtf8ToBytes(trimmed, SKILL_PACKAGE_MAX_SUMMARY_BYTES);
    }
    return trimmed;
  }
  const source = memberPath === SKILL_PACKAGE_ROOT_PATH ? parseFrontmatter(text).content : text;
  for (const line of source.split(/\r?\n/)) {
    const cleaned = line.replace(/^#+\s*/, "").trim();
    if (cleaned.length > 0) {
      return truncateUtf8ToBytes(cleaned, SKILL_PACKAGE_MAX_SUMMARY_BYTES);
    }
  }
  return "";
}

export function computeSkillPackageVersion(header: SkillPackageArchiveHeader): string {
  const manifestForDigest = header.members.map((member) => ({
    path: member.path,
    kind: member.kind,
    mediaType: member.mediaType,
    bytes: member.bytes,
    sha256: member.sha256,
    summary: member.summary,
  }));
  return protocolDigest("SkillPackageArchive", SKILL_PACKAGE_ARCHIVE_VERSION, {
    v: SKILL_PACKAGE_ARCHIVE_VERSION,
    members: manifestForDigest,
  });
}

/** 构造确定性无压缩 `SkillPackageArchive v1` 二进制包，严格执行全部尺寸与纯文本预算。 */
export function encodeSkillPackageArchive(
  members: readonly SkillPackageMemberInput[],
): EncodedSkillPackageArchive {
  if (!Array.isArray(members) || members.length === 0) {
    throw new SkillPackageArchiveError("missing-root", "Skill package must contain SKILL.md");
  }
  if (members.length > SKILL_PACKAGE_MAX_MEMBERS) {
    throw new SkillPackageArchiveError(
      "too-many-members",
      `Skill package member count ${members.length} exceeds limit ${SKILL_PACKAGE_MAX_MEMBERS}`,
    );
  }

  const normalizedInputs: Array<{
    readonly path: string;
    readonly bytes: Buffer;
    readonly text: string;
    readonly kind: SkillPackageMemberKind;
    readonly mediaType: string;
    readonly sha256: string;
    readonly summary: string;
  }> = [];
  const seenCaseFolded = new Map<string, string>();

  for (const member of members) {
    const normalizedPath = normalizeSkillPackagePath(member.path);
    const foldKey = normalizedPath.toLowerCase();
    const collision = seenCaseFolded.get(foldKey);
    if (collision !== undefined) {
      throw new SkillPackageArchiveError(
        "duplicate-path",
        `Duplicate or case-colliding skill package member: ${normalizedPath} vs ${collision}`,
      );
    }
    seenCaseFolded.set(foldKey, normalizedPath);

    const rawBytes =
      typeof member.content === "string"
        ? Buffer.from(member.content, "utf8")
        : Buffer.from(member.content);
    if (rawBytes.byteLength > SKILL_PACKAGE_MAX_MEMBER_BYTES) {
      throw new SkillPackageArchiveError(
        "member-too-large",
        `Skill package member ${normalizedPath} (${rawBytes.byteLength} B) exceeds ${SKILL_PACKAGE_MAX_MEMBER_BYTES} B`,
      );
    }
    const text = assertValidSkillPackageText(rawBytes, normalizedPath);
    const kind: SkillPackageMemberKind =
      member.kind ?? (normalizedPath === SKILL_PACKAGE_ROOT_PATH ? "root" : "resource");
    if (normalizedPath === SKILL_PACKAGE_ROOT_PATH && kind !== "root") {
      throw new SkillPackageArchiveError("invalid-path", "SKILL.md must have kind 'root'");
    }
    const mediaType = member.mediaType ?? inferSkillMemberMediaType(normalizedPath);
    const sha256 = createHash("sha256").update(rawBytes).digest("hex");
    const summary = deriveMemberSummary(normalizedPath, text, member.summary);
    if (Buffer.byteLength(summary, "utf8") > SKILL_PACKAGE_MAX_SUMMARY_BYTES) {
      throw new SkillPackageArchiveError(
        "invalid-summary",
        `Summary for ${normalizedPath} exceeds ${SKILL_PACKAGE_MAX_SUMMARY_BYTES} bytes`,
      );
    }
    normalizedInputs.push({
      path: normalizedPath,
      bytes: rawBytes,
      text,
      kind,
      mediaType,
      sha256,
      summary,
    });
  }

  if (!normalizedInputs.some((m) => m.path === SKILL_PACKAGE_ROOT_PATH)) {
    throw new SkillPackageArchiveError("missing-root", "Skill package must include root SKILL.md");
  }

  normalizedInputs.sort((a, b) => {
    if (a.path === SKILL_PACKAGE_ROOT_PATH) return -1;
    if (b.path === SKILL_PACKAGE_ROOT_PATH) return 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  let offset = 0;
  const manifest: SkillPackageMemberManifest[] = normalizedInputs.map((item) => {
    const entry: SkillPackageMemberManifest = {
      path: item.path,
      kind: item.kind,
      mediaType: item.mediaType,
      offset,
      bytes: item.bytes.byteLength,
      sha256: item.sha256,
      summary: item.summary,
    };
    offset += item.bytes.byteLength;
    return entry;
  });

  const header: SkillPackageArchiveHeader = {
    v: SKILL_PACKAGE_ARCHIVE_VERSION,
    members: manifest,
  };
  const headerBuffer = Buffer.from(canonicalize(header), "utf8");
  const dataOffset = HEADER_PREFIX_BYTES + headerBuffer.byteLength;
  const totalBytes = dataOffset + offset;
  if (totalBytes > SKILL_PACKAGE_MAX_TOTAL_BYTES) {
    throw new SkillPackageArchiveError(
      "archive-too-large",
      `Skill package encoded size ${totalBytes} B exceeds ${SKILL_PACKAGE_MAX_TOTAL_BYTES} B`,
    );
  }

  const out = Buffer.allocUnsafe(totalBytes);
  HEADER_MAGIC_BYTES.copy(out, 0);
  out.writeUInt32BE(headerBuffer.byteLength, HEADER_MAGIC_BYTES.byteLength);
  headerBuffer.copy(out, HEADER_PREFIX_BYTES);
  let cursor = dataOffset;
  for (const item of normalizedInputs) {
    item.bytes.copy(out, cursor);
    cursor += item.bytes.byteLength;
  }

  return {
    bytes: out,
    header,
    dataOffset,
    packageVersion: computeSkillPackageVersion(header),
  };
}

/** 仅解析并校验归档头部清单与整包字节长度不变量（无需将全部成员负载读入内存）。 */
export function parseSkillPackageHeaderSlice(
  headerSlice: Uint8Array,
  totalArchiveBytes: number,
): {
  readonly header: SkillPackageArchiveHeader;
  readonly dataOffset: number;
  readonly packageVersion: string;
} {
  if (!Number.isSafeInteger(totalArchiveBytes) || totalArchiveBytes < HEADER_PREFIX_BYTES) {
    throw new SkillPackageArchiveError("corrupt-archive", "Skill package archive too small");
  }
  if (totalArchiveBytes > SKILL_PACKAGE_MAX_TOTAL_BYTES) {
    throw new SkillPackageArchiveError(
      "archive-too-large",
      `Skill package size ${totalArchiveBytes} B exceeds ${SKILL_PACKAGE_MAX_TOTAL_BYTES} B`,
    );
  }
  if (headerSlice.byteLength < HEADER_PREFIX_BYTES) {
    throw new SkillPackageArchiveError("corrupt-archive", "Skill package archive header slice too small");
  }
  const buf = Buffer.from(headerSlice.buffer, headerSlice.byteOffset, headerSlice.byteLength);
  if (!buf.subarray(0, HEADER_MAGIC_BYTES.byteLength).equals(HEADER_MAGIC_BYTES)) {
    throw new SkillPackageArchiveError("corrupt-archive", "Invalid skill package magic header");
  }
  const headerLen = buf.readUInt32BE(HEADER_MAGIC_BYTES.byteLength);
  const dataOffset = HEADER_PREFIX_BYTES + headerLen;
  if (headerLen === 0 || dataOffset > totalArchiveBytes || dataOffset > buf.byteLength) {
    throw new SkillPackageArchiveError("corrupt-archive", "Invalid skill package header length");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_FATAL_DECODER.decode(buf.subarray(HEADER_PREFIX_BYTES, dataOffset)));
  } catch {
    throw new SkillPackageArchiveError("corrupt-archive", "Invalid skill package header JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillPackageArchiveError("corrupt-archive", "Skill package header must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== SKILL_PACKAGE_ARCHIVE_VERSION || !Array.isArray(obj.members)) {
    throw new SkillPackageArchiveError("corrupt-archive", "Unsupported skill package archive version");
  }
  if (obj.members.length === 0 || obj.members.length > SKILL_PACKAGE_MAX_MEMBERS) {
    throw new SkillPackageArchiveError("too-many-members", "Skill package member count out of range");
  }

  let expectedOffset = 0;
  let hasRoot = false;
  const seenFolded = new Set<string>();
  const validatedMembers: SkillPackageMemberManifest[] = [];

  for (const rawMember of obj.members) {
    if (!rawMember || typeof rawMember !== "object" || Array.isArray(rawMember)) {
      throw new SkillPackageArchiveError("corrupt-archive", "Invalid skill package member descriptor");
    }
    const m = rawMember as Record<string, unknown>;
    const normalizedPath = normalizeSkillPackagePath(String(m.path ?? ""));
    const fold = normalizedPath.toLowerCase();
    if (seenFolded.has(fold)) {
      throw new SkillPackageArchiveError("duplicate-path", `Duplicate skill member path: ${normalizedPath}`);
    }
    seenFolded.add(fold);
    if (normalizedPath === SKILL_PACKAGE_ROOT_PATH) hasRoot = true;

    const kind = m.kind;
    if (kind !== "root" && kind !== "resource") {
      throw new SkillPackageArchiveError("corrupt-archive", "Invalid skill member kind");
    }
    const mediaType = m.mediaType;
    const offset = m.offset;
    const bytes = m.bytes;
    const sha256 = m.sha256;
    const summary = m.summary;
    if (
      typeof mediaType !== "string" ||
      mediaType.length === 0 ||
      !Number.isSafeInteger(offset) ||
      (offset as number) !== expectedOffset ||
      !Number.isSafeInteger(bytes) ||
      (bytes as number) < 0 ||
      (bytes as number) > SKILL_PACKAGE_MAX_MEMBER_BYTES ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      typeof summary !== "string" ||
      Buffer.byteLength(summary, "utf8") > SKILL_PACKAGE_MAX_SUMMARY_BYTES
    ) {
      throw new SkillPackageArchiveError("corrupt-archive", `Invalid skill member metadata: ${normalizedPath}`);
    }
    expectedOffset += bytes as number;
    validatedMembers.push({
      path: normalizedPath,
      kind,
      mediaType,
      offset: offset as number,
      bytes: bytes as number,
      sha256,
      summary,
    });
  }

  if (!hasRoot) {
    throw new SkillPackageArchiveError("missing-root", "Skill package archive missing SKILL.md");
  }
  if (dataOffset + expectedOffset !== totalArchiveBytes) {
    throw new SkillPackageArchiveError(
      "range-mismatch",
      "Skill package archive payload byte length mismatch",
    );
  }
  const header: SkillPackageArchiveHeader = {
    v: SKILL_PACKAGE_ARCHIVE_VERSION,
    members: validatedMembers,
  };
  return {
    header,
    dataOffset,
    packageVersion: computeSkillPackageVersion(header),
  };
}

/** 仅解析并校验归档头部清单与预算；可用于按区间分段读取前的元信息探测。 */
export function readSkillPackageHeader(archiveBytes: Uint8Array): {
  readonly header: SkillPackageArchiveHeader;
  readonly dataOffset: number;
  readonly packageVersion: string;
} {
  return parseSkillPackageHeaderSlice(archiveBytes, archiveBytes.byteLength);
}

/** 校验区间切片字节长度、SHA-256 与 UTF-8/零 NUL 约束（供 ArtifactStore.readRange 区间复核复用）。 */
export function verifySkillPackageMemberSlice(
  meta: SkillPackageMemberManifest,
  sliceBytes: Uint8Array,
): string {
  if (sliceBytes.byteLength !== meta.bytes) {
    throw new SkillPackageArchiveError(
      "range-mismatch",
      `Member slice size mismatch for ${meta.path}: expected ${meta.bytes}, got ${sliceBytes.byteLength}`,
    );
  }
  const actualSha = createHash("sha256").update(sliceBytes).digest("hex");
  if (actualSha !== meta.sha256) {
    throw new SkillPackageArchiveError(
      "range-mismatch",
      `Member sha256 mismatch for ${meta.path}`,
    );
  }
  return assertValidSkillPackageText(sliceBytes, meta.path);
}

/** 解码整包归档并逐成员校验区间边界、SHA-256、UTF-8 与零 NUL。 */
export function decodeSkillPackageArchive(archiveBytes: Uint8Array): DecodedSkillPackageArchive {
  const { header, dataOffset, packageVersion } = readSkillPackageHeader(archiveBytes);
  const expectedTotalPayload = header.members.reduce((sum, m) => sum + m.bytes, 0);
  if (dataOffset + expectedTotalPayload !== archiveBytes.byteLength) {
    throw new SkillPackageArchiveError(
      "range-mismatch",
      "Skill package archive payload byte length mismatch",
    );
  }
  const members: DecodedSkillPackageMember[] = [];
  const byPath = new Map<string, DecodedSkillPackageMember>();
  for (const meta of header.members) {
    const start = dataOffset + meta.offset;
    const end = start + meta.bytes;
    const slice = archiveBytes.subarray(start, end);
    const text = verifySkillPackageMemberSlice(meta, slice);
    const decoded: DecodedSkillPackageMember = { meta, bytes: slice, text };
    members.push(decoded);
    byPath.set(meta.path, decoded);
  }
  return {
    header,
    dataOffset,
    packageVersion,
    members,
    byPath,
  };
}
