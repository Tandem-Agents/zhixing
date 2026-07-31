export type S7RecoveryClass =
  | "authority-replay"
  | "derived-rebuild"
  | "committed-forward-recovery";

export interface S7DurableContractEntry {
  readonly recordFamily:
    | "workscene-registry"
    | "workspace-binding"
    | "workspace-binding-root"
    | "workspace-probe"
    | "session-activity"
    | "legacy-workscene-migration"
    | "workscene-activity-projection";
  readonly producer: string;
  readonly recoveryOwner: string;
  readonly resourceIdentity: string;
  readonly recoveryClass: S7RecoveryClass;
  readonly variants: readonly string[];
  readonly rejectionBranches: readonly string[];
  readonly corruptionVectors: readonly string[];
  readonly executableEvidence: {
    readonly producerModule: string;
    readonly producerSymbol: string;
    readonly recoveryModule: string;
    readonly recoverySymbol: string;
    readonly behaviorTestModule: string;
    readonly behaviorTest: string;
  };
}

/**
 * Finite durable-state ledger for the environment/workscene unit.
 *
 * It is intentionally data, not prose: conformance tests use it as the closed
 * inventory of production points, recovery owners and corruption behavior.
 */
export const S7_DURABLE_CONTRACT_LEDGER = [
  {
    recordFamily: "workscene-registry",
    producer: "AnchorWorksceneGlobalStateAdapter",
    recoveryOwner: "anchor-workscene-owner",
    resourceIdentity: "workscene:<sceneId>",
    recoveryClass: "authority-replay",
    variants: [
      "established",
      "control-applied",
      "legacy-import-open",
      "legacy-import-activated",
      "legacy-import-abandoned",
      "deletion-projected",
    ],
    rejectionBranches: [
      "principal-method",
      "request-conflict",
      "revision-conflict",
      "deletion-pending",
    ],
    corruptionVectors: [
      "unknown-record",
      "non-contiguous-revision",
      "broken-deletion-confirmation",
    ],
    executableEvidence: {
      producerModule: "packages/core/src/workscene/global-state-adapter.ts",
      producerSymbol: "AnchorWorksceneGlobalStateAdapter",
      recoveryModule: "packages/core/src/workscene/global-state-adapter.ts",
      recoverySymbol: "recoverPendingDeletions",
      behaviorTestModule:
        "packages/core/src/workscene/global-state-adapter.test.ts",
      behaviorTest:
        "redrives the committed deletion until cleanup and confirmation converge",
    },
  },
  {
    recordFamily: "workspace-binding",
    producer: "WorkspaceBindingService",
    recoveryOwner: "workspace-binding-recovery-owner",
    resourceIdentity: "workspace-binding:<deviceId>",
    recoveryClass: "authority-replay",
    variants: [
      "directory-established",
      "catalog-reset",
      "binding-created",
      "binding-updated",
      "binding-removed",
      "request-recorded",
      "legacy-binding-staged",
      "legacy-migration-activated",
      "legacy-migration-abandoned",
    ],
    rejectionBranches: [
      "control-lease",
      "name-conflict",
      "revision-conflict",
      "tombstoned-reference",
    ],
    corruptionVectors: [
      "missing-establishment",
      "invalid-record",
      "broken-log-tail",
    ],
    executableEvidence: {
      producerModule: "packages/core/src/environment/workspace-bindings.ts",
      producerSymbol: "WorkspaceBindingService",
      recoveryModule: "packages/core/src/environment/workspace-bindings.ts",
      recoverySymbol: "initialize",
      behaviorTestModule:
        "packages/core/src/environment/workspace-bindings.test.ts",
      behaviorTest:
        "rebuilds its projection after restart and publishes path-free capability",
    },
  },
  {
    recordFamily: "workspace-binding-root",
    producer: "WorkspaceBindingCatalog",
    recoveryOwner: "workspace-binding-recovery-owner",
    resourceIdentity: "workspace-catalog-reset:<device-root>",
    recoveryClass: "committed-forward-recovery",
    variants: ["healthy", "degraded", "pending-reset"],
    rejectionBranches: [
      "healthy-reset",
      "confirmation-mismatch",
      "generation-conflict",
      "reservation-conflict",
    ],
    corruptionVectors: [
      "malformed-manifest",
      "missing-active-log",
      "invalid-reset-genesis",
      "broken-generation-link",
    ],
    executableEvidence: {
      producerModule:
        "packages/core/src/environment/workspace-binding-catalog.ts",
      producerSymbol: "WorkspaceBindingCatalog",
      recoveryModule:
        "packages/core/src/environment/workspace-binding-catalog.ts",
      recoverySymbol: "recover",
      behaviorTestModule:
        "packages/core/src/environment/workspace-binding-catalog.test.ts",
      behaviorTest:
        "recovers a pending committed reset after restart without the original lease",
    },
  },
  {
    recordFamily: "workspace-probe",
    producer: "WorkspaceProbeHandler",
    recoveryOwner: "workspace-probe-owner",
    resourceIdentity: "workspace-probe:<requestId>",
    recoveryClass: "authority-replay",
    variants: ["log-established", "started", "completed", "retired"],
    rejectionBranches: [
      "grant-binding",
      "lease-binding",
      "request-conflict",
      "expired-fresh-request",
    ],
    corruptionVectors: [
      "invalid-result",
      "request-result-mismatch",
      "broken-replay-index",
    ],
    executableEvidence: {
      producerModule: "packages/core/src/environment/workspace-probe.ts",
      producerSymbol: "WorkspaceProbeHandler",
      recoveryModule: "packages/core/src/environment/workspace-probe.ts",
      recoverySymbol: "startRetentionMaintenance",
      behaviorTestModule:
        "packages/core/src/environment/workspace-probe.test.ts",
      behaviorTest:
        "rebuilds durable replay state and permits exact replay after expiry",
    },
  },
  {
    recordFamily: "session-activity",
    producer: "ConversationRunJournal",
    recoveryOwner: "anchor-workscene-owner",
    resourceIdentity: "session-activity:<conversationId>",
    recoveryClass: "authority-replay",
    variants: ["upsert", "delete"],
    rejectionBranches: [
      "conversation-scene-mismatch",
      "non-monotonic-revision",
      "external-construction",
    ],
    corruptionVectors: ["wrong-stream", "invalid-time", "identity-rebinding"],
    executableEvidence: {
      producerModule: "packages/owner-kernel/src/conversation-assignment.ts",
      producerSymbol: "touchWorksceneSession",
      recoveryModule: "packages/core/src/workscene/activity-projection.ts",
      recoverySymbol: "IncrementalWorksceneActivityProjection",
      behaviorTestModule:
        "packages/owner-kernel/src/__tests__/control-admission.test.ts",
      behaviorTest:
        "commits metadata and activity atomically and replays exact owner requests",
    },
  },
  {
    recordFamily: "legacy-workscene-migration",
    producer: "migrateLegacyWorkscenes",
    recoveryOwner: "workscene-migration-owner",
    resourceIdentity: "legacy-workscene-migration:<migrationId>",
    recoveryClass: "committed-forward-recovery",
    variants: ["open", "activated", "abandoned"],
    rejectionBranches: [
      "source-changed",
      "terminal-revival",
      "import-set-mismatch",
      "post-cutover-write",
    ],
    corruptionVectors: [
      "malformed-report",
      "broken-terminal",
      "source-pages-mismatch",
      "cutover-marker-mismatch",
    ],
    executableEvidence: {
      producerModule: "packages/cli/src/serve/workscene-legacy-migration.ts",
      producerSymbol: "migrateLegacyWorkscenes",
      recoveryModule: "packages/cli/src/serve/workscene-legacy-migration.ts",
      recoverySymbol: "migrateLegacyWorkscenes",
      behaviorTestModule:
        "packages/cli/src/serve/__tests__/workscene-legacy-migration.test.ts",
      behaviorTest:
        "holds the legacy write fence through source recheck and makes the old write surface read-only",
    },
  },
  {
    recordFamily: "workscene-activity-projection",
    producer: "IncrementalWorksceneActivityProjection",
    recoveryOwner: "anchor-workscene-owner",
    resourceIdentity: "workscene-session-activity-v2",
    recoveryClass: "derived-rebuild",
    variants: ["put", "tombstone"],
    rejectionBranches: [
      "stale-contribution",
      "wrong-scene",
      "wrong-conversation",
    ],
    corruptionVectors: [
      "invalid-contribution",
      "invalid-aggregate",
      "checkpoint-mismatch",
    ],
    executableEvidence: {
      producerModule: "packages/core/src/workscene/activity-projection.ts",
      producerSymbol: "IncrementalWorksceneActivityProjection",
      recoveryModule: "packages/core/src/workscene/activity-projection.ts",
      recoverySymbol: "rebuild",
      behaviorTestModule:
        "packages/core/src/workscene/global-state-adapter.test.ts",
      behaviorTest:
        "keeps one contribution per conversation and recomputes the scene maximum",
    },
  },
] as const satisfies readonly S7DurableContractEntry[];
