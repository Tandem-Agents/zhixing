import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  stageLocalSkillPackage,
  writeVerifiedSkillPackageToDirectory,
  type AdmissionLlm,
} from "@zhixing-ai/core/skills/admission";
import type { IConfirmationBroker } from "@zhixing-ai/core/confirmation";
import { getTempRoot } from "@zhixing-ai/core/paths";
import {
  SkillCatalogAdmissionApplicationService,
  SkillCatalogLoadApplicationService,
  SkillCatalogSaveApplicationService,
  projectV1SkillEntryToV2,
  type SkillAdmissionAuthorizationDecision,
  type SkillAdmissionReviewReport,
  type SkillCatalogAdmissionApplication,
  type SkillCatalogAdmissionCandidate,
  type SkillCatalogAdmissionCorrectnessPort,
  type SkillCatalogAdmissionMutation,
  type SkillCatalogAdmissionMutationV2,
  type SkillCatalogEntryV2,
  type SkillCatalogLoadApplication,
  type SkillCatalogLoadCorrectnessPort,
  type SkillCatalogSaveApplication,
  type SkillCatalogSaveCorrectnessPort,
  type SkillCatalogSaveMutation,
  type SkillCatalogSaveOverlayRecord,
} from "@zhixing-ai/core/skills/catalog";
import type { ArtifactStore } from "@zhixing-ai/core/authority";
import type { AssignmentGlobalQueryPort } from "@zhixing-ai/core/contracts";
import { assignmentMutationRequestId } from "@zhixing-ai/core/protocol";
import { runContextStorage } from "@zhixing-ai/orchestrator/runtime";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const ALLOWED_ADMISSION_DECISION_KINDS = new Set([
  "allow-once",
  "allow-session",
  "allow-context",
  "allow-global",
]);

export interface AssignmentSkillPorts {
  readonly loadApplication: SkillCatalogLoadApplication;
  readonly saveApplication: SkillCatalogSaveApplication;
  readonly admissionApplication: SkillCatalogAdmissionApplication;
}

export interface SkillAdmissionRefereeBinding {
  readonly role: "main";
  readonly providerId: string;
  readonly model: string;
}

const DEFAULT_TEST_REFEREE: SkillAdmissionRefereeBinding = Object.freeze({
  role: "main",
  providerId: "local-test-provider",
  model: "main",
});

function resolveRefereeBinding(
  raw: SkillAdmissionRefereeBinding | null | undefined,
): SkillAdmissionRefereeBinding | null {
  if (raw === undefined) return DEFAULT_TEST_REFEREE;
  if (
    raw === null ||
    typeof raw.providerId !== "string" ||
    !raw.providerId.trim() ||
    typeof raw.model !== "string" ||
    !raw.model.trim()
  ) {
    return null;
  }
  return Object.freeze({
    role: "main",
    providerId: raw.providerId.trim(),
    model: raw.model.trim(),
  });
}

export function createAssignmentSkillPorts(
  artifacts: ArtifactStore,
  options: {
    readonly admissionLlm: AdmissionLlm;
    readonly clock?: () => number;
    readonly randomToken?: () => string;
    readonly getConfirmationBroker?: () => IConfirmationBroker | undefined;
    readonly referee?: SkillAdmissionRefereeBinding | null;
  },
): AssignmentSkillPorts {
  const admissionCorrectness = new AssignmentSkillAdmissionCorrectnessPort(
    artifacts,
    options,
  );
  const saveApplication = new SkillCatalogSaveApplicationService(
    createSkillCatalogSaveCorrectnessPort(artifacts),
  );
  return {
    loadApplication: new SkillCatalogLoadApplicationService(
      createSkillCatalogLoadCorrectnessPort(artifacts),
    ),
    saveApplication,
    admissionApplication: new SkillCatalogAdmissionApplicationService(
      admissionCorrectness,
    ),
  };
}

async function readSkillEntryWithV2Fallback(
  globalQuery: AssignmentGlobalQueryPort,
  skillId: string,
): Promise<SkillCatalogEntryV2 | null> {
  try {
    const v2 = await globalQuery.read({ kind: "skill-get-v2", skillId });
    if (v2.kind === "skill-get-v2") return v2.entry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/(?:Global query kind is invalid|(?:Unsupported|Unexpected)(?:\s+global|\s+execution asset)?\s+query|service-failed)/iu.test(
        message,
      )
    ) {
      throw error;
    }
    // Older v1 anchors only implement "skill-get"; fall through gracefully.
  }
  const v1 = await globalQuery.read({ kind: "skill-get", skillId });
  if (v1.kind !== "skill-get") {
    throw new Error("Skill query returned another result type");
  }
  if (!v1.entry) return null;
  return projectV1SkillEntryToV2(v1.entry);
}

function collectSkillSaveOverlay(
  records: readonly {
    readonly domain: string;
    readonly recordSeq: number;
    readonly requestId: string;
    readonly mutationDigest: string;
    readonly mutation: { readonly kind: string };
  }[],
): SkillCatalogSaveOverlayRecord[] {
  const overlay: SkillCatalogSaveOverlayRecord[] = [];
  for (const record of records) {
    if (record.domain !== "global") continue;
    const kind = record.mutation.kind;
    if (
      kind !== "skill-create" &&
      kind !== "skill-admit" &&
      kind !== "skill-update" &&
      kind !== "skill-create-v2" &&
      kind !== "skill-admit-v2" &&
      kind !== "skill-update-v2"
    ) {
      continue;
    }
    overlay.push({
      recordSeq: record.recordSeq,
      requestIdentity: record.requestId,
      mutation: record.mutation as SkillCatalogSaveOverlayRecord["mutation"],
      mutationDigest: record.mutationDigest,
    });
  }
  return overlay;
}

function createSkillCatalogLoadCorrectnessPort(
  artifacts: ArtifactStore,
): SkillCatalogLoadCorrectnessPort {
  return {
    async readScope(skillId) {
      const store = runContextStorage.getStore();
      if (store?.runtimeKind === "ephemeral" && (!store.globalQuery || !store.assignmentMutations)) {
        return { kind: "builtin-only" };
      }
      const run = requireRunSkillContext();
      const entry = await readSkillEntryWithV2Fallback(run.globalQuery, skillId);
      const overlay = collectSkillSaveOverlay(await run.assignmentMutations.readOverlay());
      return {
        kind: "assignment",
        entry,
        overlay,
        issuedAt: requireAssignmentTime(),
      };
    },
    readContent: async (content) => decoder.decode(await artifacts.get(content)),
    readBytes: (ref) => artifacts.get(ref),
    readByteRange: (ref, offset, length) => artifacts.readRange(ref, offset, length),
    hasAuthorizedWorkspace: () => runContextStorage.getStore()?.hasAuthorizedWorkspace === true,
    async stageUsage(operationId, mutation) {
      await requireRunSkillContext().assignmentMutations.stage({
        domain: "global",
        operationId,
        mutation,
      });
    },
  };
}

function createSkillCatalogSaveCorrectnessPort(
  artifacts: ArtifactStore,
): SkillCatalogSaveCorrectnessPort {
  return {
    allowGlobalSkillMutation: () =>
      runContextStorage.getStore()?.runtimeKind !== "ephemeral",
    async readCatalogEntry(skillId) {
      const result = await requireRunSkillContext().globalQuery.read({
        kind: "skill-get",
        skillId,
      });
      if (result.kind !== "skill-get") {
        throw new Error("Skill query returned another result type");
      }
      return result.entry;
    },
    async readCatalogEntryV2(skillId) {
      return await readSkillEntryWithV2Fallback(
        requireRunSkillContext().globalQuery,
        skillId,
      );
    },
    async readOverlay() {
      return collectSkillSaveOverlay(
        await requireRunSkillContext().assignmentMutations.readOverlay(),
      );
    },
    requestIdentityFor(operationId) {
      const mutations = requireRunSkillContext().assignmentMutations;
      return assignmentMutationRequestId({
        assignmentId: mutations.assignmentId,
        domain: "global",
        operationId,
      });
    },
    putContent: (document) => artifacts.put(encoder.encode(document)),
    putBytes: (bytes) => artifacts.put(bytes),
    readContent: async (ref) => decoder.decode(await artifacts.get(ref)),
    readBytes: (ref) => artifacts.get(ref),
    async stage(
      operationId,
      mutation: Extract<SkillCatalogSaveMutation, { readonly kind: "skill-create" | "skill-update" }>,
    ) {
      await requireRunSkillContext().assignmentMutations.stage({
        domain: "global",
        operationId,
        mutation,
      });
    },
    async stageV2(
      operationId,
      mutation: Extract<SkillCatalogSaveMutation, { readonly kind: "skill-create-v2" | "skill-update-v2" }>,
    ) {
      await requireRunSkillContext().assignmentMutations.stage({
        domain: "global",
        operationId,
        mutation,
      });
    },
    assignmentIssuedAt: requireAssignmentTime,
  };
}

function requireRunSkillContext() {
  const run = runContextStorage.getStore();
  if (!run?.globalQuery || !run.assignmentMutations) {
    throw new Error("Skill access requires an active durable assignment");
  }
  return {
    globalQuery: run.globalQuery,
    assignmentMutations: run.assignmentMutations,
  };
}

function requireAssignmentTime(): string {
  const at = runContextStorage.getStore()?.assignmentIssuedAt;
  if (!at) throw new Error("Skill mutation requires a durable assignment time");
  return at;
}

class AssignmentSkillAdmissionCorrectnessPort
  implements SkillCatalogAdmissionCorrectnessPort
{
  readonly #root = path.join(getTempRoot(), "zhixing-skill-admission");
  readonly #candidates = new Map<string, string>();
  readonly #reports = new Map<string, SkillAdmissionReviewReport>();
  readonly #referee: SkillAdmissionRefereeBinding | null;

  readonly admissionLlm: AdmissionLlm;

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly options: {
      readonly admissionLlm: AdmissionLlm;
      readonly clock?: () => number;
      readonly randomToken?: () => string;
      readonly getConfirmationBroker?: () => IConfirmationBroker | undefined;
      readonly referee?: SkillAdmissionRefereeBinding | null;
    },
  ) {
    this.admissionLlm = options.admissionLlm;
    this.#referee = resolveRefereeBinding(options.referee);
  }

  allowGlobalSkillMutation(): boolean {
    return runContextStorage.getStore()?.runtimeKind !== "ephemeral";
  }

  async authorizeCandidateHandling(input: {
    readonly candidateDigest: string;
    readonly memberPaths: readonly string[];
    readonly totalBytes: number;
    readonly toolName?: "skill_admit" | "admit_skill";
  }): Promise<SkillAdmissionAuthorizationDecision> {
    const broker = this.options.getConfirmationBroker?.();
    const referee = this.#referee;
    if (!broker || !referee) {
      return {
        reviewerAuthorized: false,
        callerReceiptContentAuthorized: false,
        publishAuthorized: false,
      };
    }
    const now = this.now();
    const run = runContextStorage.getStore();
    const refereeLabel = `${referee.providerId}/${referee.model} (role=${referee.role})`;
    const decision = await broker.requestConfirmation({
      id: `skill-admit-auth:${randomUUID()}`,
      tool: input.toolName ?? "skill_admit",
      toolInput: {
        phase: "authorize-candidate",
        candidateDigest: input.candidateDigest,
        memberPaths: [...input.memberPaths],
        totalBytes: input.totalBytes,
        referee: {
          role: referee.role,
          providerId: referee.providerId,
          model: referee.model,
        },
      },
      workingDirectory: "",
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt: now,
      expiresAt: now + 5 * 60_000,
      ...(run?.turnOrigin ? { turnOrigin: run.turnOrigin } : {}),
      display: {
        title: "外部技能审查与准入授权",
        cwd: "",
        stewardReason: `允许将候选技能全部可读成员送交安全裁判 ${refereeLabel} 审查`,
        body: {
          kind: "generic",
          summary: `候选摘要 ${input.candidateDigest.slice(0, 16)}...（${input.memberPaths.length} 个成员，${input.totalBytes} B）`,
          details: {
            referee: refereeLabel,
            candidateDigest: input.candidateDigest,
            memberCount: String(input.memberPaths.length),
            totalBytes: String(input.totalBytes),
            members: input.memberPaths.slice(0, 10).join(", "),
          },
        },
      },
      options: [
        {
          kind: "allow-once",
          label: "送审并在安全通过后发布入库",
          hotkey: "y",
          note: "review-and-publish",
        },
        {
          kind: "allow-once",
          label: "只送审，不发布（不在当前会话回显候选内容、不自动入库）",
          hotkey: "r",
          note: "review-only",
        },
        { kind: "deny", label: "拒绝送审", hotkey: "n" },
      ],
    });
    if (decision.kind === "allow-once" && decision.note === "review-only") {
      return {
        reviewerAuthorized: true,
        callerReceiptContentAuthorized: false,
        publishAuthorized: false,
      };
    }
    if (decision.kind === "allow-once" && decision.note === "review-and-publish") {
      return {
        reviewerAuthorized: true,
        callerReceiptContentAuthorized: true,
        publishAuthorized: true,
      };
    }
    // 双授权目的卡必须依赖明确用途选择：旧终端退化的裸 allow-once、未知 note、
    // 非回环无选项表面的泛化允许或持久 allow-* 一律 fail-closed（零送审外发、零回显、零发布）。
    return {
      reviewerAuthorized: false,
      callerReceiptContentAuthorized: false,
      publishAuthorized: false,
    };
  }

  onReviewReport(report: SkillAdmissionReviewReport): void {
    const key = report.admissionToken
      ? `${report.candidateDigest}:${report.admissionToken}`
      : report.candidateDigest;
    if (this.#reports.size >= 64) {
      const oldest = this.#reports.keys().next().value;
      if (oldest !== undefined) this.#reports.delete(oldest);
    }
    this.#reports.set(key, report);
  }

  async verifyNeedsConfirmReportApproval(input: {
    readonly admissionToken: string;
    readonly candidateDigest: string;
    readonly toolName?: "skill_admit" | "admit_skill";
  }): Promise<boolean> {
    const broker = this.options.getConfirmationBroker?.();
    const referee = this.#referee;
    if (!broker || !referee) return false;
    const report =
      this.#reports.get(`${input.candidateDigest}:${input.admissionToken}`) ??
      this.#reports.get(input.candidateDigest);
    const now = this.now();
    const run = runContextStorage.getStore();
    const refereeLabel = `${referee.providerId}/${referee.model} (role=${referee.role})`;
    const threatLines = report?.threats.length
      ? report.threats.map((item) => `${item.category}/${item.rule}: ${item.excerpt}`).join("; ")
      : "无额外静态信号";
    const decision = await broker.requestConfirmation({
      id: `skill-admit-publish:${randomUUID()}`,
      tool: input.toolName ?? "skill_admit",
      toolInput: {
        phase: "confirm-needs-confirm-publish",
        candidateDigest: input.candidateDigest,
        admissionToken: input.admissionToken,
        referee: {
          role: referee.role,
          providerId: referee.providerId,
          model: referee.model,
        },
      },
      workingDirectory: "",
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt: now,
      expiresAt: now + 5 * 60_000,
      ...(run?.turnOrigin ? { turnOrigin: run.turnOrigin } : {}),
      display: {
        title: "外部技能审查报告发布批准",
        cwd: "",
        stewardReason: "请核对独立安全裁判完整报告后，本人决定是否将该候选发布入库",
        body: {
          kind: "generic",
          summary: `需要本人批准发布（摘要 ${input.candidateDigest.slice(0, 16)}...）`,
          details: {
            referee: refereeLabel,
            candidateDigest: input.candidateDigest,
            admissionToken: input.admissionToken,
            verdict: report?.verdict.decision ?? "needs-confirm",
            reason: report?.verdict.reason ?? "独立安全裁判要求本人审阅确认",
            threats: threatLines,
          },
        },
      },
      options: [
        { kind: "allow-once", label: "批准发布此已审查候选", hotkey: "y" },
        { kind: "deny", label: "拒绝发布并丢弃暂存", hotkey: "n" },
      ],
    });
    return ALLOWED_ADMISSION_DECISION_KINDS.has(decision.kind);
  }

  async acquireLocalCandidate(
    sourcePath: string,
    options?: { readonly authorizeMemberRead?: (realPath: string) => Promise<void> },
  ): Promise<SkillCatalogAdmissionCandidate> {
    const staged = await stageLocalSkillPackage(sourcePath, {
      ...(options?.authorizeMemberRead ? { authorizeMemberRead: options.authorizeMemberRead } : {}),
    });
    await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
    const dir = path.join(this.#root, `candidate-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const candidateId = randomUUID();
    this.#candidates.set(candidateId, dir);
    try {
      await writeVerifiedSkillPackageToDirectory(staged, dir);
      return {
        candidateId,
        document: staged.document,
        digest: bindCandidateDigest(staged.document, staged.digest),
        members: staged.members,
        totalBytes: staged.totalBytes,
      };
    } catch (error) {
      await this.discardCandidate(candidateId).catch(() => {});
      throw error;
    }
  }

  async readCandidate(candidateId: string): Promise<SkillCatalogAdmissionCandidate> {
    const dir = this.#requireCandidate(candidateId);
    const staged = await stageLocalSkillPackage(dir);
    return {
      candidateId,
      document: staged.document,
      digest: bindCandidateDigest(staged.document, staged.digest),
      members: staged.members,
      totalBytes: staged.totalBytes,
    };
  }

  async discardCandidate(candidateId: string): Promise<void> {
    const dir = this.#requireCandidate(candidateId);
    this.#candidates.delete(candidateId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async sweepStaleCandidates(maxAgeMs: number): Promise<number> {
    await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
    let removed = 0;
    for (const name of await fs.readdir(this.#root)) {
      const dir = path.join(this.#root, name);
      if (!name.startsWith("candidate-")) continue;
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory() || this.now() - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      for (const [candidateId, candidateDir] of this.#candidates) {
        if (candidateDir === dir) this.#candidates.delete(candidateId);
      }
      removed += 1;
    }
    return removed;
  }

  putContent(document: string) {
    return this.artifacts.put(encoder.encode(document));
  }

  putBytes(bytes: Uint8Array) {
    return this.artifacts.put(bytes);
  }

  async stage(
    operationId: string,
    mutation: SkillCatalogAdmissionMutation,
  ): Promise<void> {
    if (!operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }
    await requireRunSkillContext().assignmentMutations.stage({
      domain: "global",
      operationId,
      mutation,
    });
  }

  async stageV2(
    operationId: string,
    mutation: SkillCatalogAdmissionMutationV2,
  ): Promise<void> {
    if (!operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }
    await requireRunSkillContext().assignmentMutations.stage({
      domain: "global",
      operationId,
      mutation,
    });
  }

  now(): number {
    return this.options.clock?.() ?? Date.now();
  }

  newToken(): string {
    return this.options.randomToken?.() ?? randomUUID();
  }

  #requireCandidate(candidateId: string): string {
    const dir = this.#candidates.get(candidateId);
    if (!dir) throw new Error("Skill admission candidate is unknown");
    const relative = path.relative(this.#root, path.resolve(dir));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Skill staging directory is outside the admission workspace");
    }
    return dir;
  }
}

/** Explicit no-Authority product binding: builtin reads only, all user writes fail closed. */
export function createBuiltinOnlyAssignmentSkillPorts(): AssignmentSkillPorts {
  const unavailable = async (): Promise<never> => {
    throw new Error("User skills require an active artifact-backed assignment");
  };
  return {
    loadApplication: new SkillCatalogLoadApplicationService({
      hasAuthorizedWorkspace: () =>
        runContextStorage.getStore()?.hasAuthorizedWorkspace === true,
      async readScope() {
        return { kind: "builtin-only" };
      },
      async readContent() {
        return unavailable();
      },
      async stageUsage() {
        return unavailable();
      },
    }),
    saveApplication: { save: unavailable },
    admissionApplication: { admit: unavailable },
  };
}

function bindCandidateDigest(document: string, treeDigest: string): string {
  return createHash("sha256")
    .update(JSON.stringify([document, treeDigest]), "utf8")
    .digest("hex");
}
