import {
  canonicalize,
  createSignedEvidenceRequest,
  evidenceRequestDigest,
  protocolDigest,
  validateCapabilityDescriptor,
  validateEvidenceBundle,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  extractText,
  isObjectiveEvidenceKind,
  type AdvancementEvidenceOutcome,
  type AdvancementSession,
  type ConfirmedRubricSnapshot,
  type EvidenceKind,
  type EvidenceLocator,
  type Message,
  type ReviewEvidence,
  type RunRecordInput,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  CapabilityDescriptor,
  EvidenceClientPort,
  EvidenceExecutionResult,
  ImmediateRootResourceLease,
  ResourceLease,
  ResourceReservationPort,
} from "@zhixing/core/contracts";
import type { AdvancementSessionStore } from "./session-store.js";

const MAX_STALE_RETRIES = 2;

export interface AdvancementEvidenceTarget {
  readonly ownerEpoch: number;
  readonly executorId: string;
  readonly workspace?: {
    readonly deviceId: string;
    readonly bindingRef: string;
    readonly workspaceBindingRevision: number;
  };
  /** 由 accepted run 的冻结 manifest 解析，descriptor 仍在本层验签。 */
  readonly descriptor: CapabilityDescriptor;
}

export interface AdvancementEvidenceCoordinatorOptions {
  readonly store: AdvancementSessionStore;
  readonly resources: ResourceReservationPort;
  readonly resolveTarget: (
    conversationId: string,
    runId: string,
  ) => Promise<AdvancementEvidenceTarget | undefined>;
  readonly clientFor: (executorId: string) => EvidenceClientPort | undefined;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly now?: () => string;
}

export interface AdvancementEvidenceReviewInput {
  readonly session: AdvancementSession;
  readonly runId: string;
  readonly reviewId: string;
  readonly runRecord: RunRecordInput;
  readonly rootLease: ImmediateRootResourceLease;
  readonly target?: AdvancementEvidenceTarget;
  readonly abort: AbortSignal;
}

export interface AdvancementEvidenceReviewResult {
  readonly canonicalEvidence: readonly ReviewEvidence[];
  /** review 结论落盘时与 evidence settlement 同一原子提交。 */
  readonly requestId?: string;
}

export class AdvancementEvidenceDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvancementEvidenceDeferredError";
  }
}

/** owner 侧唯一取证协调器：耐久请求先于发送，验真结果先于裁判采信。 */
export class AdvancementEvidenceCoordinator {
  readonly #options: AdvancementEvidenceCoordinatorOptions;
  readonly #now: () => string;

  constructor(options: AdvancementEvidenceCoordinatorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async resolveTarget(
    conversationId: string,
    runId: string,
  ): Promise<AdvancementEvidenceTarget | undefined> {
    const target = await this.#options.resolveTarget(conversationId, runId);
    if (!target) return undefined;
    const descriptor = validateCapabilityDescriptor(
      target.descriptor,
      this.#options.verifier,
    );
    if (descriptor.executorId !== target.executorId) {
      throw new TypeError("Evidence target descriptor is bound to another executor");
    }
    return { ...target, descriptor };
  }

  async collect(
    input: AdvancementEvidenceReviewInput,
  ): Promise<AdvancementEvidenceReviewResult> {
    const baseline = conversationEvidence(input.runRecord, input.session.confirmedRubric);
    const rubric = input.session.confirmedRubric;
    const target = input.target;
    const workspace = target?.workspace;
    if (!rubric || !target || !workspace) {
      return { canonicalEvidence: baseline };
    }
    const { items, mappings } = requestItems(rubric, input.runRecord.messages);
    if (items.length === 0) return { canonicalEvidence: baseline };

    const descriptorWorkspace = target.descriptor.workspaces.find(
      (candidate) => candidate.bindingRef === workspace.bindingRef,
    );
    if (
      !descriptorWorkspace ||
      descriptorWorkspace.workspaceBindingRevision !==
        workspace.workspaceBindingRevision ||
      items.some((item) => !target.descriptor.evidenceCapabilities.includes(item.kind))
    ) {
      return { canonicalEvidence: baseline };
    }
    const client = this.#options.clientFor(target.executorId);
    if (!client) {
      throw new AdvancementEvidenceDeferredError("目标设备暂时离线，等待恢复后继续验收。");
    }

    let lastRequestId: string | undefined;
    for (let offset = 0; offset <= MAX_STALE_RETRIES; offset += 1) {
      input.abort.throwIfAborted();
      const attempt = input.rootLease.workload.attempt + offset;
      const requestId = evidenceRequestId(input.reviewId, attempt);
      lastRequestId = requestId;
      const existing = input.session.evidence?.pending.find(
        (pending) => pending.requestId === requestId,
      );
      let request = existing?.request;
      if (
        !request ||
        request.lease.parentDigest !== input.rootLease.digest ||
        Date.parse(request.expiry) <= Date.parse(this.#now())
      ) {
        if (existing) {
          await this.#options.store.settleEvidence(
            input.session.conversationId,
            input.session.id,
            existing.requestId,
            "deferred",
          );
        }
        const child = await this.#options.resources.acquireChild(
          input.rootLease,
          { kind: "evidence", id: requestId, attempt },
          { maxCalls: 1 },
          evidenceContext(requestId),
        );
        request = createEvidenceRequest({
          requestId,
          reviewId: input.reviewId,
          runId: input.runId,
          conversationId: input.session.conversationId,
          target: { ...target, workspace },
          items,
          lease: child,
          now: this.#now(),
          verifier: this.#options.verifier,
          signer: this.#options.signer,
        });
        await this.#options.store.appendEvidenceRequest(
          input.session.conversationId,
          input.session.id,
          {
            requestId,
            reviewId: input.reviewId,
            attempt,
            request,
            itemRequirements: mappings,
            requestDigest: evidenceRequestDigest(request),
          },
        );
      }

      let outcome: AdvancementEvidenceOutcome;
      try {
        outcome = existing?.outcome ?? await this.#dispatch(request, client, input.abort);
      } catch (error) {
        await this.#options.store.settleEvidence(
          input.session.conversationId,
          input.session.id,
          requestId,
          "deferred",
        );
        throw error;
      }
      if (!existing?.outcome) {
        await this.#options.store.appendEvidenceResult(
          input.session.conversationId,
          input.session.id,
          requestId,
          outcome,
        );
      }
      if (outcome.kind === "typed-stale") {
        await this.#options.store.settleEvidence(
          input.session.conversationId,
          input.session.id,
          requestId,
          "deferred",
        );
        continue;
      }
      if (outcome.kind === "capability-gap") {
        return { canonicalEvidence: baseline, requestId };
      }
      return {
        canonicalEvidence: [
          ...baseline,
          ...canonicalBundleEvidence(request, mappings, outcome.bundle),
        ],
        requestId,
      };
    }
    throw new AdvancementEvidenceDeferredError(
      `取证期间工作区持续变化（最后请求 ${lastRequestId ?? "未知"}），等待稳定后重试。`,
    );
  }

  async #dispatch(
    request: Parameters<EvidenceClientPort["collect"]>[0],
    client: EvidenceClientPort,
    abort: AbortSignal,
  ): Promise<AdvancementEvidenceOutcome> {
    const ctx = evidenceContext(request.requestId);
    const usage = { usageId: `evidence-call:${request.requestId}`, calls: 1 };
    let reserved = false;
    let attempted = false;
    try {
      await this.#options.resources.reserveUsage(request.lease, usage, ctx);
      reserved = true;
      attempted = true;
      const result = await client.collect(request, abort);
      await this.#options.resources.consume(request.lease, usage, ctx);
      return normalizeExecutionResult(request, result, this.#options.verifier);
    } catch (error) {
      if (attempted && reserved) {
        await this.#options.resources.consume(request.lease, usage, ctx).catch(() => {});
      }
      throw error;
    } finally {
      await finishLease(this.#options.resources, request.lease, ctx);
    }
  }
}

function createEvidenceRequest(input: {
  readonly requestId: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly target: AdvancementEvidenceTarget & { workspace: NonNullable<AdvancementEvidenceTarget["workspace"]> };
  readonly items: Array<{ kind: EvidenceKind; locator: EvidenceLocator }>;
  readonly lease: ResourceLease;
  readonly now: string;
  readonly verifier: ProtocolSignatureVerifier;
  readonly signer: ProtocolSigner;
}) {
  const expiryMs = Math.min(Date.parse(input.lease.expiry), Date.parse(input.now) + 60_000);
  if (expiryMs <= Date.parse(input.now)) {
    throw new AdvancementEvidenceDeferredError("取证资源租约已过期，等待下一轮重驱。");
  }
  return createSignedEvidenceRequest(
    {
      v: 1,
      requestId: input.requestId,
      reviewId: input.reviewId,
      runId: input.runId,
      conversationId: input.conversationId,
      ownerEpoch: input.target.ownerEpoch,
      executorId: input.target.executorId,
      workspace: {
        bindingRef: input.target.workspace.bindingRef,
        workspaceBindingRevision: input.target.workspace.workspaceBindingRevision,
      },
      items: input.items,
      lease: input.lease,
      issuedAt: input.now,
      expiry: new Date(expiryMs).toISOString(),
    },
    input.verifier,
    input.signer,
  );
}

function normalizeExecutionResult(
  request: Parameters<EvidenceClientPort["collect"]>[0],
  result: EvidenceExecutionResult,
  verifier: ProtocolSignatureVerifier,
): AdvancementEvidenceOutcome {
  if (result.kind === "capability-gap") return result;
  const bundle = validateEvidenceBundle(result.bundle, verifier);
  if (
    bundle.requestId !== request.requestId ||
    bundle.requestDigest !== evidenceRequestDigest(request) ||
    bundle.executorId !== request.executorId
  ) {
    throw new TypeError("Evidence bundle is bound to another request");
  }
  return bundle.observation.consistent
    ? { kind: "bundle", bundle }
    : { kind: "typed-stale" };
}

function requestItems(
  rubric: ConfirmedRubricSnapshot,
  messages: readonly Message[],
): {
  items: Array<{ kind: EvidenceKind; locator: EvidenceLocator }>;
  mappings: Array<{ itemIndex: number; requirementIds: string[] }>;
} {
  const items: Array<{ kind: EvidenceKind; locator: EvidenceLocator }> = [];
  const mappings: Array<{ itemIndex: number; requirementIds: string[] }> = [];
  const byIdentity = new Map<string, number>();
  for (const requirement of rubric.content.evidenceRequirements ?? []) {
    if (!isObjectiveEvidenceKind(requirement.kind)) continue;
    if (!(["file-diff", "log", "artifact"] as const).includes(
      requirement.kind as "file-diff" | "log" | "artifact",
    )) continue;
    const locator = requirement.locator ?? (
      requirement.kind === "file-diff"
        ? touchedLocator(messages)
        : {}
    );
    const identity = canonicalize([requirement.kind, locator]);
    const prior = byIdentity.get(identity);
    if (prior !== undefined) {
      mappings[prior]!.requirementIds.push(requirement.id);
      continue;
    }
    const itemIndex = items.length;
    byIdentity.set(identity, itemIndex);
    items.push({ kind: requirement.kind, locator });
    mappings.push({ itemIndex, requirementIds: [requirement.id] });
  }
  return { items, mappings };
}

function canonicalBundleEvidence(
  request: Parameters<EvidenceClientPort["collect"]>[0],
  mappings: readonly { itemIndex: number; requirementIds: readonly string[] }[],
  bundle: Extract<AdvancementEvidenceOutcome, { kind: "bundle" }>["bundle"],
): ReviewEvidence[] {
  const requestedIndex = new Map(
    request.items.map((item, index) => [canonicalize([item.kind, item.locator]), index]),
  );
  const evidence: ReviewEvidence[] = [];
  for (const item of bundle.items) {
    const itemIndex = requestedIndex.get(canonicalize([item.kind, item.locator]));
    if (itemIndex === undefined) {
      throw new TypeError("Evidence bundle contains an unrequested item");
    }
    const mapping = mappings.find((candidate) => candidate.itemIndex === itemIndex);
    if (!mapping) throw new TypeError("Evidence item has no durable requirement mapping");
    for (const requirementId of mapping.requirementIds) {
      evidence.push({
        id: `evidence:${request.requestId}:${itemIndex}:${requirementId}`,
        kind: item.kind,
        requirementId,
        summary: item.summary,
        source: "independent",
        passed: true,
      });
    }
  }
  return evidence;
}

function conversationEvidence(
  runRecord: RunRecordInput,
  rubric: ConfirmedRubricSnapshot | undefined,
): ReviewEvidence[] {
  const evidence: ReviewEvidence[] = [];
  const summary = [...runRecord.messages].reverse().map(extractText).find((text) => text.trim());
  if (summary) {
    evidence.push({
      id: "run-final-response",
      kind: "conversation-fact",
      summary: `本轮执行结果：${summary.slice(0, 1_200)}`,
      source: "execution-report",
    });
  }
  for (const requirement of rubric?.content.evidenceRequirements ?? []) {
    if (requirement.kind !== "conversation-fact" && requirement.kind !== "none") continue;
    evidence.push({
      id: `conversation-requirement:${requirement.id}`,
      kind: requirement.kind,
      requirementId: requirement.id,
      summary: requirement.description,
      source: "execution-report",
    });
  }
  return evidence;
}

function touchedLocator(messages: readonly Message[]): EvidenceLocator {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use" || !["write", "edit"].includes(block.name.toLowerCase())) {
        continue;
      }
      const value = block.input as Record<string, unknown>;
      for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
        const candidate = value[key];
        if (
          typeof candidate === "string" &&
          isContractRelativePath(candidate.trim())
        ) {
          paths.add(candidate.trim().replaceAll("\\", "/"));
        }
      }
    }
  }
  return paths.size > 0 ? { paths: [...paths] } : {};
}

function isContractRelativePath(candidate: string): boolean {
  if (!candidate || candidate.startsWith("/") || /^[a-z]:[\\/]/iu.test(candidate)) {
    return false;
  }
  const segments = candidate.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function evidenceRequestId(reviewId: string, attempt: number): string {
  return `evidence:${protocolDigest("AdvancementEvidenceRequestId", 1, {
    reviewId,
    attempt,
  }).slice("sha256:".length)}`;
}

function evidenceContext(requestId: string): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "advancement-evidence" },
    requestId: `advancement-evidence:${requestId}`,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

async function finishLease(
  resources: ResourceReservationPort,
  lease: ResourceLease,
  ctx: AuthorityCallContext,
): Promise<void> {
  try {
    await resources.settle(lease, ctx);
    await resources.release(lease, ctx);
  } catch {
    await resources.reclaim?.(lease).catch(() => {});
  }
}
