import { Buffer } from "node:buffer";
import type {
  ArtifactStore,
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  RebuildableDurableProjectionIndex,
} from "@zhixing/core/authority";
import type {
  AuthorityError,
  GlobalStagedMutation,
  JsonValue,
  MutationBatch,
  PublishRecord,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  CommittedMutationMaterializationError,
  mutationBatchArtifact,
  validateJobMutationBatch,
  validatePublishDecisionForBatch,
  validatePublishDecisionRecord,
} from "@zhixing/core/protocol";
import type { JobCommitParticipant } from "./job-assignment.js";
import type { GlobalMutationCommitCoordinator } from "./global-mutation-commit-coordinator.js";

const JOB_PUBLISH_PENDING_PROJECTION_ID = "job-publish-pending-v1";
const PENDING_PREFIX = "pending:";
const ASSIGNMENT_PREFIX = "assignment:";

type PublishDecision = Extract<PublishRecord, { readonly t: "publish-decision" }>;
type PublishProgress = Extract<PublishRecord, { readonly t: "publish-progress" }>;
type PublishOutcome = PublishDecision["outcomes"][number]["outcome"];

interface PendingJobPublish {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly decision: PublishDecision;
  readonly upToSeq: number;
}

export interface SchedulerJobCommitParticipantOptions {
  readonly coordinator: GlobalMutationCommitCoordinator;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly retryDelayMs?: number;
  readonly pendingPageSize?: number;
  readonly onFatal?: (error: Error) => void;
}

interface DrainResult {
  readonly needsRetry: boolean;
}

class PendingJobPublishCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PendingJobPublishCorruptionError";
  }
}

/** Owns exact-prefix planning and durable redrive of job-derived side effects. */
export class SchedulerJobCommitParticipant implements JobCommitParticipant {
  readonly #coordinator: GlobalMutationCommitCoordinator;
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #pending: RebuildableDurableProjectionIndex;
  readonly #running = new Map<string, Promise<void>>();
  readonly #retryDelayMs: number;
  readonly #pendingPageSize: number;
  readonly #onFatal: ((error: Error) => void) | undefined;
  readonly #wakeWaiters = new Set<() => void>();
  #wakeVersion = 0;
  #started = false;
  #stopping = false;
  #loop: Promise<void> | undefined;
  #fatal: Error | undefined;

  constructor(options: SchedulerJobCommitParticipantOptions) {
    this.#coordinator = options.coordinator;
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#retryDelayMs = positiveRetryDelay(options.retryDelayMs ?? 1_000);
    this.#pendingPageSize = positiveSafeInteger(
      options.pendingPageSize ?? 64,
      "Job publish pending page size",
    );
    this.#onFatal = options.onFatal;
    this.#pending = options.log.durableProjection({
      projectionId: JOB_PUBLISH_PENDING_PROJECTION_ID,
      reducerVersion: 1,
      reduce: reduceJobPublishPending,
    });
  }

  get readProjectionIds(): readonly string[] {
    return this.#coordinator.readProjectionIds;
  }

  async prepare(input: Parameters<JobCommitParticipant["prepare"]>[0]) {
    const outcomes = new Map<number, PublishOutcome>();
    const records: Array<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: GlobalStagedMutation;
    }> = [];
    for (const record of input.mutationBatch.records) {
      if (record.domain === "global" && record.mutation.kind === "delivery-enqueue") continue;
      if (record.domain !== "global") {
        outcomes.set(record.seq, conflict(
          "capability-gap",
          "This job owner does not publish the staged global mutation domain",
        ));
        continue;
      }
      records.push({
        seq: record.seq,
        requestId: record.requestId,
        mutation: record.mutation as GlobalStagedMutation,
      });
    }
    const prepared = await this.#coordinator.prepare({
      assignmentId: input.bundle.assignmentId,
      records,
      context: input.authorityContext,
      source: {},
      sourceTaskId: input.occurrence.taskId,
    });
    for (const [seq, outcome] of prepared.outcomes) outcomes.set(seq, outcome);
    return { accepted: true as const, records: prepared.records, outcomes };
  }

  async applyGranted(input: {
    readonly assignmentId: string;
    readonly seq: number;
    readonly mutationBatch: MutationBatch;
    readonly outcome: Extract<PublishOutcome, { readonly t: "granted" }>;
  }): Promise<void> {
    const record = input.mutationBatch.records.find((candidate) => candidate.seq === input.seq);
    if (!record || record.domain !== "global" || record.mutation.kind === "delivery-enqueue") return;
    await this.#coordinator.apply({
      assignmentId: input.assignmentId,
      seq: record.seq,
      requestId: record.requestId,
      mutation: record.mutation as GlobalStagedMutation,
      targetRevision: input.outcome.targetRevision,
      ...(input.outcome.appliedResult ? { appliedResult: input.outcome.appliedResult } : {}),
    });
  }

  async resumePendingPublishing(taskId?: string): Promise<void> {
    await this.#log.transactDurableProjection(
      JOB_PUBLISH_PENDING_PROJECTION_ID,
      () => ({ kind: "return", value: undefined }),
    );
    const prefix = taskId ? `${PENDING_PREFIX}${taskId}:` : PENDING_PREFIX;
    let afterKey: string | undefined;
    let hasMore: boolean;
    do {
      const page = await this.#pending.scan(
        afterKey === undefined
          ? { gte: prefix, lt: `${prefix}\uffff` }
          : { gt: afterKey, lt: `${prefix}\uffff` },
        this.#pendingPageSize,
      );
      for (const entry of page.entries) {
        const pending = readPending(entry.value);
        await this.#resumeOne(pending);
      }
      afterKey = page.entries.at(-1)?.key;
      hasMore = page.continuation !== undefined && afterKey !== undefined;
    } while (hasMore);
  }

  wakePendingPublishing(taskId: string): void {
    if (!taskId) throw new TypeError("Job publish wake requires a task id");
    if (!this.#started || this.#stopping) return;
    this.#wakeVersion += 1;
    this.#releaseWakeWaiters();
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#fatal) throw this.#fatal;
    this.#started = true;
    this.#stopping = false;
    const observedWake = this.#wakeVersion;
    let initial: DrainResult;
    try {
      initial = await this.#drainCycle();
    } catch (error) {
      const fatal = this.#fail(error);
      this.#started = false;
      throw fatal;
    }
    this.#loop = this.#runDrainLoop(initial.needsRetry, observedWake);
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#loop) {
      if (this.#fatal) throw this.#fatal;
      return;
    }
    this.#stopping = true;
    this.#releaseWakeWaiters();
    await this.#loop;
    this.#loop = undefined;
    this.#started = false;
    this.#stopping = false;
    if (this.#fatal) throw this.#fatal;
  }

  async #runDrainLoop(
    initialNeedsRetry: boolean,
    initialWakeVersion: number,
  ): Promise<void> {
    let needsRetry = initialNeedsRetry;
    let observedWake = initialWakeVersion;
    while (!this.#stopping) {
      if (this.#wakeVersion === observedWake) {
        await this.#waitForWake(
          needsRetry ? this.#retryDelayMs : undefined,
          observedWake,
        );
      }
      if (this.#stopping) break;
      observedWake = this.#wakeVersion;
      try {
        needsRetry = (await this.#drainCycle()).needsRetry;
      } catch (error) {
        this.#fail(error);
        break;
      }
    }
  }

  async #drainCycle(): Promise<DrainResult> {
    await this.#log.transactDurableProjection(
      JOB_PUBLISH_PENDING_PROJECTION_ID,
      () => ({ kind: "return", value: undefined }),
    );
    let afterKey: string | undefined;
    let hasMore: boolean;
    let needsRetry = false;
    do {
      const page = await this.#pending.scan(
        afterKey === undefined
          ? { gte: PENDING_PREFIX, lt: `${PENDING_PREFIX}\uffff` }
          : { gt: afterKey, lt: `${PENDING_PREFIX}\uffff` },
        this.#pendingPageSize,
      );
      for (const entry of page.entries) {
        let pending: PendingJobPublish;
        try {
          pending = readPending(entry.value);
        } catch (error) {
          throw pendingCorruption("Job publish pending index is invalid", error);
        }
        try {
          await this.#resumeOne(pending);
        } catch (error) {
          if (error instanceof PendingJobPublishCorruptionError) throw error;
          if (
            error instanceof CommittedMutationMaterializationError ||
            error instanceof TypeError
          ) {
            throw pendingCorruption(
              "Job publish materialization contract is invalid",
              error,
            );
          }
          needsRetry = true;
        }
      }
      afterKey = page.entries.at(-1)?.key;
      hasMore = page.continuation !== undefined && afterKey !== undefined;
    } while (hasMore && !this.#stopping);
    return { needsRetry };
  }

  async #waitForWake(
    delayMs: number | undefined,
    observedWake: number,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        if (timer) clearTimeout(timer);
        this.#wakeWaiters.delete(release);
        resolve();
      };
      this.#wakeWaiters.add(release);
      if (delayMs !== undefined) timer = setTimeout(release, delayMs);
      if (this.#stopping || this.#wakeVersion !== observedWake) release();
    });
  }

  #releaseWakeWaiters(): void {
    for (const release of [...this.#wakeWaiters]) release();
  }

  #fail(error: unknown): Error {
    const fatal = error instanceof Error ? error : new Error(String(error));
    if (!this.#fatal) {
      this.#fatal = fatal;
      this.#onFatal?.(fatal);
    }
    return this.#fatal;
  }

  #resumeOne(pending: PendingJobPublish): Promise<void> {
    const identity = canonicalize([pending.taskId, pending.assignmentId]);
    const running = this.#running.get(identity);
    if (running) return running;
    const operation = this.#redriveOne(pending).finally(() => {
      if (this.#running.get(identity) === operation) this.#running.delete(identity);
    });
    this.#running.set(identity, operation);
    return operation;
  }

  async #redriveOne(pending: PendingJobPublish): Promise<void> {
    let batch: MutationBatch;
    let decision: PublishDecision;
    try {
      const bytes = await this.#artifacts.get(pending.decision.batch.ref);
      const text = Buffer.from(bytes).toString("utf8");
      batch = validateJobMutationBatch(JSON.parse(text) as MutationBatch);
      if (
        canonicalize(mutationBatchArtifact(batch).ref) !==
          canonicalize(pending.decision.batch.ref) ||
        canonicalize(batch) !== text
      ) {
        throw new Error("Pending job publish batch does not bind its artifact");
      }
      decision = validatePublishDecisionForBatch(pending.decision, batch);
    } catch (error) {
      throw pendingCorruption(
        "Pending job publish authority facts are corrupt",
        error,
      );
    }
    const finalSeq = decision.outcomes.at(-1)?.seq ?? 0;
    let upToSeq = pending.upToSeq;
    for (const item of decision.outcomes) {
      if (item.seq <= upToSeq) continue;
      if (item.outcome.t === "granted") {
        await this.applyGranted({
          assignmentId: pending.assignmentId,
          seq: item.seq,
          mutationBatch: batch,
          outcome: item.outcome,
        });
      }
      upToSeq = item.seq;
      await this.#appendProgress({
        t: "publish-progress",
        assignmentId: pending.assignmentId,
        domain: "global",
        upToSeq,
        state: upToSeq === finalSeq ? "settled" : "pending",
      });
    }
  }

  async #appendProgress(progress: PublishProgress): Promise<void> {
    await this.#log.transactDurableProjection(
      JOB_PUBLISH_PENDING_PROJECTION_ID,
      async (projection) => {
        const taskId = readAssignmentTask(
          await projection.get(`${ASSIGNMENT_PREFIX}${progress.assignmentId}`),
        );
        if (!taskId) return { kind: "return", value: undefined };
        const current = readPending(
          await projection.get(pendingKey(taskId, progress.assignmentId)),
          true,
        );
        if (!current || current.upToSeq >= progress.upToSeq) {
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [{ stream: "publish", body: progress }],
          value: undefined,
        };
      },
    );
  }
}

async function reduceJobPublishPending(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const get = async (key: string) => overlay.has(key) ? overlay.get(key) : current.get(key);
  const put = (key: string, value: JsonValue) => {
    overlay.set(key, value);
    mutations.push({ kind: "put" as const, key, value });
  };
  const tombstone = (key: string) => {
    overlay.set(key, undefined);
    mutations.push({ kind: "tombstone" as const, key });
  };
  const committed = envelope.entries.flatMap((entry) => {
    const body = entry.body;
    if (
      !entry.stream.startsWith("job:") ||
      !isPlainRecord(body) ||
      body.t !== "committed" ||
      typeof body.assignmentId !== "string"
    ) return [];
    return [{ taskId: entry.stream.slice("job:".length), assignmentId: body.assignmentId }];
  });
  for (const item of committed) {
    put(`${ASSIGNMENT_PREFIX}${item.assignmentId}`, item.taskId);
  }
  const pendingAssignments = new Set(
    envelope.entries.flatMap((entry) => {
      if (entry.stream !== "publish" || !isPlainRecord(entry.body)) return [];
      if (
        entry.body.t !== "publish-progress" ||
        entry.body.domain !== "global" ||
        entry.body.state !== "pending" ||
        typeof entry.body.assignmentId !== "string"
      ) return [];
      return [entry.body.assignmentId];
    }),
  );
  for (const entry of envelope.entries) {
    if (entry.stream !== "publish" || !isPlainRecord(entry.body)) continue;
    if (entry.body.t === "publish-decision") {
      const decision = validatePublishDecisionRecord(entry.body);
      if (!pendingAssignments.has(decision.assignmentId)) continue;
      const taskId = committed.find((item) => item.assignmentId === decision.assignmentId)?.taskId ??
        readAssignmentTask(await get(`${ASSIGNMENT_PREFIX}${decision.assignmentId}`));
      if (!taskId) continue;
      put(pendingKey(taskId, decision.assignmentId), {
        taskId,
        assignmentId: decision.assignmentId,
        decision: decision as unknown as JsonValue,
        upToSeq: 0,
      });
      continue;
    }
    if (entry.body.t === "publish-progress" && entry.body.domain === "global") {
      const progress = readProgress(entry.body);
      const taskId = readAssignmentTask(
        await get(`${ASSIGNMENT_PREFIX}${progress.assignmentId}`),
      );
      if (!taskId) continue;
      const key = pendingKey(taskId, progress.assignmentId);
      const pending = readPending(await get(key), true);
      if (!pending || progress.upToSeq < pending.upToSeq) continue;
      if (progress.state === "settled") {
        tombstone(key);
        tombstone(`${ASSIGNMENT_PREFIX}${progress.assignmentId}`);
      } else {
        put(key, { ...pending, upToSeq: progress.upToSeq } as unknown as JsonValue);
      }
    }
  }
  return mutations;
}

function readPending(value: JsonValue | undefined): PendingJobPublish;
function readPending(
  value: JsonValue | undefined,
  optional: true,
): PendingJobPublish | undefined;
function readPending(
  value: JsonValue | undefined,
  optional = false,
): PendingJobPublish | undefined {
  if (value === undefined && optional) return undefined;
  if (
    !isPlainRecord(value) ||
    typeof value.taskId !== "string" ||
    typeof value.assignmentId !== "string" ||
    !Number.isSafeInteger(value.upToSeq)
  ) throw new Error("Job publish pending entry is invalid");
  return {
    taskId: value.taskId,
    assignmentId: value.assignmentId,
    decision: validatePublishDecisionRecord(value.decision),
    upToSeq: Number(value.upToSeq),
  };
}

function readProgress(value: Record<string, JsonValue>): PublishProgress {
  if (
    value.t !== "publish-progress" ||
    typeof value.assignmentId !== "string" ||
    value.domain !== "global" ||
    !Number.isSafeInteger(value.upToSeq) ||
    (value.state !== "pending" && value.state !== "settled")
  ) throw new Error("Job publish progress is invalid");
  return value as unknown as PublishProgress;
}

function readAssignmentTask(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Job publish assignment index is invalid");
  }
  return value;
}

function pendingKey(taskId: string, assignmentId: string): string {
  return `${PENDING_PREFIX}${taskId}:${assignmentId}`;
}

function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conflict(code: AuthorityError["code"], message: string): PublishOutcome {
  return { t: "conflicted", error: { code, message, retryable: false } };
}

function pendingCorruption(
  message: string,
  cause: unknown,
): PendingJobPublishCorruptionError {
  return new PendingJobPublishCorruptionError(message, { cause });
}

function positiveRetryDelay(value: number): number {
  return positiveSafeInteger(value, "Job publish retry delay");
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}
