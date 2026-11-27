import type { ArtifactRef } from "../contracts/index.js";
import { parseFrontmatter } from "../frontmatter.js";
import {
  ADMISSION_MAX_MEMBER_BYTES,
  ADMISSION_MAX_TOTAL_BYTES,
  ADMISSION_TOKEN_TTL_MS,
  assessSkillPackage,
  type AdmissionLlm,
  type AdmissionVerdict,
} from "./admission.js";
import {
  SKILL_PACKAGE_ROOT_PATH,
  assertValidSkillPackageText,
  encodeSkillPackageArchive,
  normalizeSkillPackagePath,
} from "./archive.js";
import { scanHighConfidenceSecrets, type ContentThreat } from "./content-scan.js";
import { skillNameToId } from "./id.js";
import type {
  SkillCatalogSaveRecord,
  SkillCatalogSaveRecordV2,
} from "./catalog-save-service.js";
import {
  DEFAULT_SKILL_VISIBILITY,
  parseSkillVisibilityFromFrontmatter,
  type SkillMode,
} from "./types.js";

/** Skill-owned request for the skill_admit / admit_skill lifecycle. */
export interface SkillCatalogAdmissionRequest {
  readonly source?: {
    readonly kind: "local-path";
    readonly path: string;
  };
  readonly admissionToken?: string;
  readonly mode: SkillMode;
  readonly toolName?: "skill_admit" | "admit_skill";
  readonly operationId?: string;
  readonly authorizeMemberRead?: (realMemberPath: string) => Promise<void>;
}

export interface SkillAdmissionAuthorizationDecision {
  readonly reviewerAuthorized: boolean;
  readonly callerReceiptContentAuthorized: boolean;
  readonly publishAuthorized: boolean;
}

export interface SkillAdmissionReviewReport {
  readonly candidateDigest: string;
  readonly admissionToken?: string;
  readonly verdict: AdmissionVerdict;
  readonly threats: readonly ContentThreat[];
}

export type SkillCatalogAdmissionOutcome =
  | { readonly kind: "missing-input" }
  | { readonly kind: "missing-name" }
  | {
      readonly kind: "forbidden";
      readonly code: "unattended-skill-mutation-forbidden";
      readonly reason: string;
    }
  | {
      readonly kind: "blocked-secret";
      readonly categories: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: "review-declined";
      readonly reason: string;
    }
  | {
      readonly kind: "publish-not-authorized";
      readonly verdict: "safe" | "needs-confirm";
      readonly reason: string;
      readonly admissionToken?: string;
    }
  | {
      readonly kind: "escalated";
      readonly reason: string;
      readonly threats: readonly ContentThreat[];
    }
  | {
      readonly kind: "needs-confirm";
      readonly admissionToken: string;
      readonly reason: string;
      readonly threats: readonly ContentThreat[];
    }
  | { readonly kind: "confirmation-expired" }
  | { readonly kind: "candidate-changed" }
  | {
      readonly kind: "admitted";
      readonly id: string;
      readonly name: string;
    };

export interface SkillCatalogAdmissionApplication {
  admit(request: SkillCatalogAdmissionRequest): Promise<SkillCatalogAdmissionOutcome>;
}

/** Opaque, path-free snapshot owned by the Infrastructure adapter. */
export interface SkillCatalogAdmissionCandidate {
  readonly candidateId: string;
  readonly document: string;
  readonly digest: string;
  readonly members?: readonly {
    readonly path: string;
    readonly content: string;
    readonly bytes?: number;
  }[];
  readonly totalBytes?: number;
}

export interface SkillCatalogAdmissionMutation {
  readonly kind: "skill-admit";
  readonly record: SkillCatalogSaveRecord;
  readonly mode: SkillMode;
}

export interface SkillCatalogAdmissionMutationV2 {
  readonly kind: "skill-admit-v2";
  readonly record: SkillCatalogSaveRecordV2;
  readonly mode: SkillMode;
}

/**
 * Path-free adapter for candidate storage, independent review, CAS and the
 * assignment mutation ledger. The Skill application owns every admission rule.
 */
export interface SkillCatalogAdmissionCorrectnessPort {
  acquireLocalCandidate(
    sourcePath: string,
    options?: { readonly authorizeMemberRead?: (realPath: string) => Promise<void> },
  ): Promise<SkillCatalogAdmissionCandidate>;
  readCandidate(candidateId: string): Promise<SkillCatalogAdmissionCandidate>;
  discardCandidate(candidateId: string): Promise<void>;
  sweepStaleCandidates(maxAgeMs: number): Promise<number>;
  putContent(document: string): Promise<ArtifactRef>;
  putBytes?(bytes: Uint8Array): Promise<ArtifactRef>;
  stage(operationId: string, mutation: SkillCatalogAdmissionMutation): Promise<void>;
  stageV2?(operationId: string, mutation: SkillCatalogAdmissionMutationV2): Promise<void>;
  allowGlobalSkillMutation?(): boolean;
  authorizeCandidateHandling?(input: {
    readonly candidateDigest: string;
    readonly memberPaths: readonly string[];
    readonly totalBytes: number;
    readonly toolName?: "skill_admit" | "admit_skill";
  }): Promise<SkillAdmissionAuthorizationDecision>;
  verifyNeedsConfirmReportApproval?(input: {
    readonly admissionToken: string;
    readonly candidateDigest: string;
    readonly toolName?: "skill_admit" | "admit_skill";
  }): Promise<boolean>;
  onReviewReport?(report: SkillAdmissionReviewReport): Promise<void> | void;
  admissionLlm: AdmissionLlm;
  now(): number;
  newToken(): string;
}

interface PendingSkillAdmission {
  readonly candidateId: string;
  readonly digest: string;
  readonly threats: readonly ContentThreat[];
  readonly reason: string;
  readonly mode: SkillMode;
  readonly expiresAt: number;
}

const REDACTED_NEEDS_CONFIRM_REASON =
  "需要本人在宿主确认表面审阅完整审查报告并明确批准发布（调用方未获候选原文回执授权）";
const REDACTED_ESCALATED_REASON =
  "外部技能安全审查未通过，已阻断入库（详情已转宿主确认表面，调用方未获候选原文回执授权）";

/** Skill-owned two-stage admission state machine over path-free adapters. */
export class SkillCatalogAdmissionApplicationService
  implements SkillCatalogAdmissionApplication
{
  readonly #pending = new Map<string, PendingSkillAdmission>();

  constructor(private readonly correctness: SkillCatalogAdmissionCorrectnessPort) {}

  async admit(
    request: SkillCatalogAdmissionRequest,
  ): Promise<SkillCatalogAdmissionOutcome> {
    if (this.correctness.allowGlobalSkillMutation?.() === false) {
      return {
        kind: "forbidden",
        code: "unattended-skill-mutation-forbidden",
        reason: "无值守运行禁止向全局技能库准入外部技能",
      };
    }

    await this.correctness.sweepStaleCandidates(ADMISSION_TOKEN_TTL_MS).catch(() => {});
    const now = this.correctness.now();
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt <= now) await this.#dropPending(token);
    }

    const token = request.admissionToken?.trim() ?? "";
    if (token) return this.#confirm(token, request.operationId, request.toolName);

    const sourcePath = request.source?.kind === "local-path"
      ? request.source.path.trim()
      : "";
    if (!sourcePath) return { kind: "missing-input" };
    if (request.mode !== "main" && request.mode !== "work") {
      throw new Error("Skill admission mode is invalid");
    }
    return this.#reviewLocal(
      sourcePath,
      request.mode,
      request.operationId,
      request.authorizeMemberRead,
      request.toolName,
    );
  }

  async #reviewLocal(
    sourcePath: string,
    mode: SkillMode,
    operationId: string | undefined,
    authorizeMemberRead?: (realMemberPath: string) => Promise<void>,
    toolName?: "skill_admit" | "admit_skill",
  ): Promise<SkillCatalogAdmissionOutcome> {
    let candidate: SkillCatalogAdmissionCandidate | undefined;
    try {
      candidate = await this.correctness.acquireLocalCandidate(
        sourcePath,
        authorizeMemberRead ? { authorizeMemberRead } : undefined,
      );
      const members = resolveAndValidateCandidateMembers(candidate);

      // 本地前置高置信凭据与敏感文件名硬阻断（在向任何模型或回执表面暴露之前止步）
      const secretCheck = scanHighConfidenceSecrets(members);
      if (secretCheck.blocked) {
        await this.correctness.discardCandidate(candidate.candidateId);
        return {
          kind: "blocked-secret",
          categories: secretCheck.categories,
          reason: `本地凭据硬阻断命中敏感凭据类型: ${secretCheck.categories.join(", ")}`,
        };
      }

      const { data } = parseFrontmatter(candidate.document);
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!name) {
        await this.correctness.discardCandidate(candidate.candidateId);
        return { kind: "missing-name" };
      }

      const memberPaths = members.map((m) => m.path);
      const totalBytes =
        candidate.totalBytes ??
        members.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8"), 0);

      // 三向授权核验（缺省端口或明确拒绝审阅时一律 fail-closed，0 模型调用）
      const auth = this.correctness.authorizeCandidateHandling
        ? await this.correctness.authorizeCandidateHandling({
            candidateDigest: candidate.digest,
            memberPaths,
            totalBytes,
            ...(toolName ? { toolName } : {}),
          })
        : {
            reviewerAuthorized: false,
            callerReceiptContentAuthorized: false,
            publishAuthorized: false,
          };

      if (!auth.reviewerAuthorized) {
        await this.correctness.discardCandidate(candidate.candidateId);
        return {
          kind: "review-declined",
          reason: "尚未获得向安全裁判送审该候选包的授权，已清退暂存",
        };
      }

      // 整包全部可读成员送交 AdmissionLlm（绝不只送根文档）
      const assessment = await assessSkillPackage(
        { llm: this.correctness.admissionLlm },
        { name, members },
      );

      if (assessment.verdict.decision === "escalate") {
        await this.correctness.onReviewReport?.({
          candidateDigest: candidate.digest,
          verdict: assessment.verdict,
          threats: assessment.threats,
        });
        await this.correctness.discardCandidate(candidate.candidateId);
        return auth.callerReceiptContentAuthorized
          ? {
              kind: "escalated",
              reason: assessment.verdict.reason,
              threats: assessment.threats,
            }
          : {
              kind: "escalated",
              reason: REDACTED_ESCALATED_REASON,
              threats: [],
            };
      }

      if (assessment.verdict.decision === "safe") {
        if (!auth.publishAuthorized) {
          await this.correctness.discardCandidate(candidate.candidateId);
          return {
            kind: "publish-not-authorized",
            verdict: "safe",
            reason: "候选包通过安全审查，但本人未授权发布入常规技能库，已清退暂存",
          };
        }
        const admitted = await this.#stageCandidate(candidate, members, mode, operationId);
        await this.correctness.discardCandidate(candidate.candidateId);
        return admitted;
      }

      const token = this.correctness.newToken();
      if (!token || this.#pending.has(token)) {
        throw new Error("Skill admission token generator returned a duplicate token");
      }
      this.#pending.set(token, {
        candidateId: candidate.candidateId,
        digest: candidate.digest,
        threats: assessment.threats,
        reason: assessment.verdict.reason,
        mode,
        expiresAt: this.correctness.now() + ADMISSION_TOKEN_TTL_MS,
      });
      await this.correctness.onReviewReport?.({
        candidateDigest: candidate.digest,
        admissionToken: token,
        verdict: assessment.verdict,
        threats: assessment.threats,
      });
      candidate = undefined;

      return auth.callerReceiptContentAuthorized
        ? {
            kind: "needs-confirm",
            admissionToken: token,
            reason: assessment.verdict.reason,
            threats: assessment.threats,
          }
        : {
            kind: "needs-confirm",
            admissionToken: token,
            reason: REDACTED_NEEDS_CONFIRM_REASON,
            threats: [],
          };
    } catch (error) {
      if (candidate) {
        await this.correctness.discardCandidate(candidate.candidateId).catch(() => {});
      }
      throw error;
    }
  }

  async #confirm(
    token: string,
    operationId: string | undefined,
    toolName?: "skill_admit" | "admit_skill",
  ): Promise<SkillCatalogAdmissionOutcome> {
    const pending = this.#pending.get(token);
    if (!pending || pending.expiresAt <= this.correctness.now()) {
      await this.#dropPending(token);
      return { kind: "confirmation-expired" };
    }
    try {
      const candidate = await this.correctness.readCandidate(pending.candidateId);
      if (candidate.digest !== pending.digest) {
        await this.#dropPending(token);
        return { kind: "candidate-changed" };
      }

      const members = resolveAndValidateCandidateMembers(candidate);
      const reportApproved = this.correctness.verifyNeedsConfirmReportApproval
        ? await this.correctness.verifyNeedsConfirmReportApproval({
            admissionToken: token,
            candidateDigest: candidate.digest,
            ...(toolName ? { toolName } : {}),
          })
        : false;
      if (!reportApproved) {
        await this.#dropPending(token);
        return {
          kind: "publish-not-authorized",
          verdict: "needs-confirm",
          admissionToken: token,
          reason: "缺少本人针对审查报告的发布批准授权，禁止仅凭 admissionToken 入库",
        };
      }

      const admitted = await this.#stageCandidate(
        candidate,
        members,
        pending.mode,
        operationId,
      );
      await this.#dropPending(token);
      return admitted;
    } catch (error) {
      await this.#dropPending(token);
      throw error;
    }
  }

  async #stageCandidate(
    candidate: SkillCatalogAdmissionCandidate,
    members: readonly { readonly path: string; readonly content: string }[],
    mode: SkillMode,
    operationId: string | undefined,
  ): Promise<Extract<SkillCatalogAdmissionOutcome, { kind: "admitted" }>> {
    const parsed = parseFrontmatter(candidate.document);
    const name = typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
    const description = typeof parsed.data.description === "string"
      ? parsed.data.description.trim()
      : "";
    const id = skillNameToId(name);
    if (!id || !description) {
      throw new Error("Skill frontmatter requires name and description");
    }
    const content = await this.correctness.putContent(candidate.document);
    if (!operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }

    const visibility = parseSkillVisibilityFromFrontmatter(
      parsed.data,
      DEFAULT_SKILL_VISIBILITY,
    );
    const hasSubMembers = members.some((m) => m.path !== SKILL_PACKAGE_ROOT_PATH);

    if (
      this.correctness.stageV2 &&
      (hasSubMembers || !visibility.modelAutoIndex || !visibility.userSlashCommand)
    ) {
      let packageRef: ArtifactRef | undefined;
      if (hasSubMembers) {
        if (!this.correctness.putBytes) {
          throw new Error("Multi-member skill admission requires binary artifact storage");
        }
        const encoded = encodeSkillPackageArchive(
          members.map((m) => ({
            path: m.path,
            content: m.content,
            kind: m.path === SKILL_PACKAGE_ROOT_PATH ? ("root" as const) : ("resource" as const),
          })),
        );
        packageRef = await this.correctness.putBytes(encoded.bytes);
      }
      await this.correctness.stageV2(`${operationId}:admit`, {
        kind: "skill-admit-v2",
        record: {
          name,
          description,
          content,
          visibility,
          ...(packageRef ? { packageRef } : {}),
        },
        mode,
      });
    } else {
      if (hasSubMembers) {
        throw new Error("Multi-member skill admission requires v2 staging support");
      }
      await this.correctness.stage(`${operationId}:admit`, {
        kind: "skill-admit",
        record: { name, description, content },
        mode,
      });
    }

    return { kind: "admitted", id, name };
  }

  async #dropPending(token: string): Promise<void> {
    const pending = this.#pending.get(token);
    this.#pending.delete(token);
    if (pending) {
      await this.correctness.discardCandidate(pending.candidateId).catch(() => {});
    }
  }
}

export function resolveAndValidateCandidateMembers(
  candidate: SkillCatalogAdmissionCandidate,
): Array<{ readonly path: string; readonly content: string }> {
  const rawMembers =
    candidate.members && candidate.members.length > 0
      ? candidate.members
      : [{ path: SKILL_PACKAGE_ROOT_PATH, content: candidate.document }];
  let totalBytes = 0;
  const validated: Array<{ readonly path: string; readonly content: string }> = [];
  for (const m of rawMembers) {
    const normalizedPath = normalizeSkillPackagePath(m.path);
    const bytes = Buffer.from(m.content, "utf8");
    if (bytes.byteLength > ADMISSION_MAX_MEMBER_BYTES) {
      throw new Error(
        `成员 ${normalizedPath} (${bytes.byteLength} B) 超过单文件准入上限 ${ADMISSION_MAX_MEMBER_BYTES} B`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > ADMISSION_MAX_TOTAL_BYTES) {
      throw new Error(
        `外部技能包可读文本总量 (${totalBytes} B) 超过准入上限 ${ADMISSION_MAX_TOTAL_BYTES} B`,
      );
    }
    assertValidSkillPackageText(bytes, normalizedPath);
    validated.push({ path: normalizedPath, content: m.content });
  }
  return validated;
}
