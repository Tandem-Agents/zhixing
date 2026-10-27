import type {
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalControlMutation,
  GlobalControlMutationResult,
  GlobalQuery,
  GlobalReadResult,
  GlobalStagedMutation,
  GlobalStagedMutationResult,
  GlobalStagedCallContext,
  LogicalRecord,
  GlobalStatePort,
  WorksceneAppliedResult,
  WorksceneWriteMutation,
} from "../contracts/index.js";
import { defineDurableRuntimeContract } from "../contracts/durable-contract.js";
import type {
  AuthorityCommitLog,
  DurableProjectionReadContext,
} from "../authority/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
  canonicalize,
  CommittedMutationMaterializationError,
} from "../protocol/index.js";
import {
  maintenanceRetryDelayMs,
  runInMaintenanceContext,
  StorageMaintenanceCancelledError,
  storageMaintenanceObligation,
  StorageMaintenanceTaskRunner,
  type StorageMaintenanceGovernorPort,
} from "../resources/index.js";
import {
  AnchorWorksceneRegistry,
  WORKSCENE_AUTHORITY_PROJECTION_ID,
  WorksceneConflictError,
} from "./authority-registry.js";
import { IncrementalWorksceneActivityProjection } from "./activity-projection.js";

export interface AnchorWorksceneGlobalStateAdapterOptions {
  readonly log: AuthorityCommitLog;
  readonly anchorEpoch: number;
  /** 移除场景内的一批会话；final 为该场景的最后一步，会话都已移除之后移除场景目录。 */
  readonly removeScene: (
    sceneId: string,
    conversationIds: readonly string[],
    final: boolean,
  ) => Promise<void>;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly maintenanceRunner?: StorageMaintenanceTaskRunner;
  readonly clock?: () => string;
  readonly sceneIdFactory?: () => string;
  readonly deletionPageSize?: number;
}

/**
 * The only adapter allowed to reach the anchor workscene registry.
 *
 * It owns authority admission, activity projection merge and pending deletion
 * recovery. Callers see only GlobalStatePort and cannot accidentally create a
 * second workscene read/write surface.
 */
export class AnchorWorksceneGlobalStateAdapter implements GlobalStatePort {
  readonly #registry: AnchorWorksceneRegistry;
  readonly #anchorEpoch: number;
  readonly #activity: IncrementalWorksceneActivityProjection;
  readonly #removeScene: (
    sceneId: string,
    conversationIds: readonly string[],
    final: boolean,
  ) => Promise<void>;
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #clock: () => string;
  readonly #deletionPageSize: number;
  #recovery: Promise<void> | undefined;
  #recoveryRetry: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: AnchorWorksceneGlobalStateAdapterOptions) {
    if (!Number.isSafeInteger(options.anchorEpoch) || options.anchorEpoch <= 0) {
      throw new TypeError("Workscene anchor epoch must be a positive safe integer");
    }
    this.#anchorEpoch = options.anchorEpoch;
    this.#registry = new AnchorWorksceneRegistry({
      log: options.log,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.sceneIdFactory
        ? { sceneIdFactory: options.sceneIdFactory }
        : {}),
    });
    this.#activity = new IncrementalWorksceneActivityProjection({
      log: options.log,
    });
    this.#removeScene = options.removeScene;
    this.#maintenanceRunner =
      options.maintenanceRunner ??
      new StorageMaintenanceTaskRunner(options.storageMaintenance);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#deletionPageSize = options.deletionPageSize ?? 64;
    if (
      !Number.isSafeInteger(this.#deletionPageSize) ||
      this.#deletionPageSize < 1 ||
      this.#deletionPageSize > 256
    ) {
      throw new TypeError("Workscene deletion page size is invalid");
    }
  }

  readonly stagedProjectionId = WORKSCENE_AUTHORITY_PROJECTION_ID;

  async initializeStagedPublishing(): Promise<void> {
    await this.#registry.initialize();
  }

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isWorksceneWrite(mutation);
  }

  async prepareStagedMutations(input: {
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: GlobalStagedMutation;
    }>;
    readonly authorityProjection: DurableProjectionReadContext;
    readonly at: string;
  }): Promise<{
    readonly records: readonly LogicalRecord[];
    readonly outcomes: Awaited<ReturnType<AnchorWorksceneRegistry["planStagedAtProjection"]>>["outcomes"];
  }> {
    return this.#registry.planStagedAtProjection(
      input.records.map((record) => {
        if (!isWorksceneWrite(record.mutation)) {
          throw new TypeError("Workscene planner received another mutation domain");
        }
        return { ...record, mutation: record.mutation };
      }),
      input.authorityProjection,
      input.at,
    );
  }

  async applyStagedMutation(input: {
    readonly requestId: string;
    readonly targetRevision: number;
    readonly appliedResult?: WorksceneAppliedResult;
  }): Promise<void> {
    if (!input.appliedResult) {
      throw new TypeError("Committed workscene mutation omitted its applied result");
    }
    await this.#registry.refreshCommitted();
    const replay = await this.#registry.replay(input.requestId);
    if (
      !replay ||
      replay.revision !== input.targetRevision ||
      canonicalize(replay) !== canonicalize(input.appliedResult)
    ) {
      throw new CommittedMutationMaterializationError(
        "Committed workscene result is unavailable or changed",
      );
    }
    if (replay.kind === "workscene-deleted") {
      await runInMaintenanceContext("foreground", () =>
        this.#projectDeletion(replay.sceneId, replay.revision),
      );
    }
  }

  async refreshStagedMutations(): Promise<void> {
    await this.#registry.refreshCommitted();
    // 已提交的删除由后台按页续做：删除事实已经使场景从目录与会话准入中消失，刷新不等清理排空。
    this.startPendingDeletionRecovery();
  }

  /**
   * 安装待删场景的后台续做。启动与刷新都不等全部积压清理完：场景级 tombstone 已在删除事实的同一
   * 事务里写入，物理清理按场景、按页在维护档续做；遇容量背压延后重试，停止之后不再续做。
   */
  startPendingDeletionRecovery(): void {
    if (this.#stopped) return;
    void this.recoverPendingDeletions().catch((error: unknown) => {
      const retryAfterMs = maintenanceRetryDelayMs(error);
      if (this.#stopped || retryAfterMs === undefined) return;
      this.#recoveryRetry = setTimeout(() => {
        this.#recoveryRetry = undefined;
        this.startPendingDeletionRecovery();
      }, Math.max(25, retryAfterMs));
      this.#recoveryRetry.unref?.();
    });
  }

  async read(
    query: GlobalQuery,
    context: GlobalReadCallContext,
  ): Promise<GlobalReadResult> {
    this.#admit(context, "global.read");
    this.#triggerRecovery();
    switch (query.kind) {
      case "workscene-list": {
        const scenes = await this.#registry.list();
        const projected = await Promise.all(
          scenes.map((scene) => this.#mergeActivity(scene)),
        );
        return {
          kind: "workscene-list",
          scenes: projected.sort(
            (left, right) =>
              Date.parse(right.lastActiveAt) -
                Date.parse(left.lastActiveAt) ||
              left.id.localeCompare(right.id, "en-US"),
          ),
        };
      }
      case "workscene-get": {
        const scene = await this.#registry.get(query.sceneId);
        return {
          kind: "workscene-get",
          scene: scene ? await this.#mergeActivity(scene) : null,
        };
      }
      default:
        throw new TypeError(
          "This global state adapter only owns the workscene domain",
        );
    }
  }

  mutate<M extends GlobalControlMutation>(
    mutation: M,
    context: GlobalControlCallContext,
  ): Promise<GlobalControlMutationResult<M>>;
  mutate<M extends GlobalStagedMutation>(
    mutation: M,
    context: GlobalStagedCallContext,
  ): Promise<GlobalStagedMutationResult<M>>;
  async mutate(
    mutation: GlobalControlMutation | GlobalStagedMutation,
    context: GlobalControlCallContext | GlobalStagedCallContext,
  ): Promise<
    | GlobalControlMutationResult<GlobalControlMutation>
    | GlobalStagedMutationResult<GlobalStagedMutation>
  > {
    this.#admit(context, "global.mutate");
    if (context.principal.kind === "assignment") {
      throw new AuthorityMethodForbiddenError(
        "Assignment workscene mutations must be staged by the assignment owner",
      );
    }
    if (!isWorksceneWrite(mutation)) {
      throw new TypeError(
        "This global state adapter only owns the workscene domain",
      );
    }
    if (
      "expectedRevision" in mutation &&
      context.expectedRevision !== undefined &&
      context.expectedRevision !== mutation.expectedRevision
    ) {
      throw new WorksceneConflictError(
        "Workscene context and mutation revisions disagree",
      );
    }
    const result = await this.#registry.apply(mutation, {
      requestId: context.requestId,
    });
    if (result.kind === "workscene-deleted") {
      await runInMaintenanceContext("foreground", () =>
        this.#projectDeletion(result.sceneId, result.revision),
      ).catch(() => this.#triggerRecovery());
    }
    return result as WorksceneAppliedResult;
  }

  async recoverPendingDeletions(): Promise<void> {
    if (this.#recovery) return this.#recovery;
    const recovery = runInMaintenanceContext("recovery", async () => {
      let after:
        | { readonly deletionRevision: number; readonly sceneId: string }
        | undefined;
      do {
        const page = await this.#registry.pendingDeletionPage({
          ...(after ? { after } : {}),
          limit: this.#deletionPageSize,
        });
        for (const pending of page.items) {
          if (this.#stopped) throw new StorageMaintenanceCancelledError();
          await this.#projectDeletion(
            pending.sceneId,
            pending.deletionRevision,
          );
        }
        after = page.next;
      } while (after);
    });
    this.#recovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.#recovery === recovery) this.#recovery = undefined;
    }
  }

  /**
   * Reads the durable result bound to an idempotency key.
   *
   * This is intentionally kept on the anchor adapter rather than exposed as a
   * second registry surface. Product adapters use it only to finish a response
   * whose authoritative mutation committed before the original call returned.
   */
  async replayMutation(requestId: string): Promise<WorksceneAppliedResult | null> {
    requireIdentifier(requestId, "Workscene requestId");
    return this.#registry.replay(requestId);
  }

  async stop(): Promise<void> {
    // 停止不等积压排空：维护 runner 停止后，进行中的场景在页边界中止，未完成的留给下次续做。
    this.#stopped = true;
    if (this.#recoveryRetry) clearTimeout(this.#recoveryRetry);
    this.#recoveryRetry = undefined;
    const recovery = this.#recovery;
    await this.#activity.stop();
    await this.#maintenanceRunner.stop();
    await recovery?.catch(() => undefined);
  }

  async #projectDeletion(
    sceneId: string,
    deletionRevision: number,
  ): Promise<void> {
    const request = storageMaintenanceObligation(
      "workscene-cleanup",
      sceneId,
      { deletionRevision },
      {
        owner: "anchor-workscene-owner",
        obligation: "committed",
      },
    );
    await this.#maintenanceRunner.run(
      request,
      new AbortController().signal,
      async (signal) => {
        // 场景内按贡献页分批移除：每页的会话墓碑耐久之后才读下一页，崩溃或停止后按“未删除”
        // 过滤接续；全部移除之后才移除场景目录并确认删除已投影。
        let after: string | undefined;
        do {
          if (signal.aborted) throw new StorageMaintenanceCancelledError();
          const page = await this.#activity.contributionPage(sceneId, after);
          const conversationIds = page.entries
            .filter((contribution) => !contribution.deleted)
            .map((contribution) => contribution.conversationId);
          if (conversationIds.length > 0) await this.#removeScene(sceneId, conversationIds, false);
          after = page.next;
        } while (after !== undefined);
        if (signal.aborted) throw new StorageMaintenanceCancelledError();
        await this.#removeScene(sceneId, [], true);
        await this.#registry.confirmDeletionProjected(
          sceneId,
          deletionRevision,
        );
      },
    );
  }

  #mergeActivity(
    scene: Awaited<ReturnType<AnchorWorksceneRegistry["get"]>> extends infer T
      ? Exclude<T, null>
      : never,
  ) {
    const projected = this.#activity.peek(scene.id);
    return projected && Date.parse(projected) > Date.parse(scene.lastActiveAt)
      ? { ...scene, lastActiveAt: projected }
      : scene;
  }

  #triggerRecovery(): void {
    this.startPendingDeletionRecovery();
  }

  #admit(
    context:
      | GlobalReadCallContext
      | GlobalControlCallContext
      | GlobalStagedCallContext,
    method: "global.read" | "global.mutate",
  ): void {
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
    if (
      context.authority.domain !== "global" ||
      context.authority.anchorEpoch !== this.#anchorEpoch
    ) {
      throw new TypeError("Global workscene authority fence is stale or invalid");
    }
    requireIdentifier(context.requestId, "Global workscene requestId");
    const deadline = Date.parse(context.deadlineAt);
    if (!Number.isFinite(deadline) || deadline < Date.parse(this.#clock())) {
      throw new TypeError("Global workscene request deadline has expired");
    }
  }
}

export const WORKSCENE_REGISTRY_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "workscene-registry",
  producer: "AnchorWorksceneGlobalStateAdapter",
  recoveryOwner: "anchor-workscene-owner",
  resourceIdentity: "workscene:<sceneId>",
  recoveryClass: "authority-replay",
  cases: [
    ...["established", "control-applied", "deletion-projected"]
      .map((key) => ({ kind: "variant" as const, key })),
    { kind: "rejection", key: "principal-method", reasonCode: "AUTHORITY_METHOD_FORBIDDEN" },
    { kind: "rejection", key: "request-conflict", reasonCode: "WORKSCENE_CONFLICT" },
    { kind: "rejection", key: "revision-conflict", reasonCode: "WORKSCENE_REVISION_CONFLICT" },
    { kind: "rejection", key: "deletion-pending", reasonCode: "WORKSCENE_CONFLICT" },
    ...["unknown-record", "non-contiguous-revision", "broken-deletion-confirmation"]
      .map((key) => ({ kind: "corruption" as const, key, reasonCode: "AUTHORITY_RECORD_INVALID" })),
  ],
} as const);

function isWorksceneWrite(
  mutation: GlobalControlMutation | GlobalStagedMutation,
): mutation is WorksceneWriteMutation {
  return (
    mutation.kind === "workscene-create" ||
    mutation.kind === "workscene-rename" ||
    mutation.kind === "workscene-set-workdir" ||
    mutation.kind === "workscene-delete"
  );
}

function requireIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}
