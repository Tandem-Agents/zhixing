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
  WorksceneMigrationMutation,
  WorksceneWriteMutation,
} from "../contracts/index.js";
import { defineDurableRuntimeContract } from "../contracts/durable-contract.js";
import type { AuthorityCommitLog } from "../authority/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
  canonicalize,
} from "../protocol/index.js";
import {
  runInMaintenanceContext,
  storageMaintenanceObligation,
  StorageMaintenanceTaskRunner,
  type StorageMaintenanceGovernorPort,
} from "../resources/index.js";
import {
  AnchorWorksceneRegistry,
  WorksceneConflictError,
} from "./authority-registry.js";
import { IncrementalWorksceneActivityProjection } from "./activity-projection.js";

export interface AnchorWorksceneGlobalStateAdapterOptions {
  readonly log: AuthorityCommitLog;
  readonly anchorEpoch: number;
  readonly removeScene: (
    sceneId: string,
    conversationIds: readonly string[],
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
  ) => Promise<void>;
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #clock: () => string;
  readonly #deletionPageSize: number;
  #recovery: Promise<void> | undefined;

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

  async initializeStagedPublishing(): Promise<void> {
    await this.#registry.initialize();
  }

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isWorksceneWrite(mutation);
  }

  prepareStagedMutations(input: {
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: GlobalStagedMutation;
    }>;
  }): {
    readonly records: readonly LogicalRecord[];
    readonly outcomes: ReturnType<AnchorWorksceneRegistry["planStaged"]>["outcomes"];
  } {
    return this.#registry.planStaged(
      input.records.map((record) => {
        if (!isWorksceneWrite(record.mutation)) {
          throw new TypeError("Workscene planner received another mutation domain");
        }
        return { ...record, mutation: record.mutation };
      }),
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
      throw new Error("Committed workscene result is unavailable or changed");
    }
    if (replay.kind === "workscene-deleted") {
      await runInMaintenanceContext("foreground", () =>
        this.#projectDeletion(replay.sceneId, replay.revision),
      );
    }
  }

  async refreshStagedMutations(): Promise<void> {
    await this.#registry.refreshCommitted();
    await this.recoverPendingDeletions();
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
    if (isWorksceneMigration(mutation)) {
      if (context.principal.kind !== "host") {
        throw new TypeError("Only the host migration owner may import workscenes");
      }
      await this.#registry.applyMigration(mutation, {
        requestId: context.requestId,
      });
      return { revision: 0 };
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
      );
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

  stop(): void {
    this.#maintenanceRunner.stop();
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
      async () => {
        const conversationIds = (await this.#activity.contributions(sceneId))
          .filter((contribution) => !contribution.deleted)
          .map((contribution) => contribution.conversationId);
        await this.#removeScene(sceneId, conversationIds);
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
    void this.recoverPendingDeletions().catch(() => {});
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
    ...["established", "control-applied", "legacy-import-open", "legacy-import-activated", "legacy-import-abandoned", "deletion-projected"]
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

function isWorksceneMigration(
  mutation: GlobalControlMutation | GlobalStagedMutation,
): mutation is WorksceneMigrationMutation {
  return (
    mutation.kind === "workscene-import-legacy" ||
    mutation.kind === "workscene-activate-device-registry" ||
    mutation.kind === "workscene-abandon-legacy-import"
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
