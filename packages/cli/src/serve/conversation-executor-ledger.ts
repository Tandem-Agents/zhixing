import type {
  AuthorityError,
  ExecutionManifest,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import type { ExecutorCapabilitySnapshot } from "@zhixing/core/protocol";
import type {
  ConversationAssignmentLedger,
} from "@zhixing/executor";
import type { ConversationOwnerRuntimeStack } from "./conversation-owner-runtime.js";
import { createOwnerControlAuthorizer } from "./owner-control-authorizer.js";

/** The production cutover is shared by every local executor composition root. */
export const ASSIGNMENT_RECORD_V2_WRITES_ENABLED = true;

export interface ConversationAssignmentLedgerConstructor {
  new(options: ConstructorParameters<typeof ConversationAssignmentLedger>[0]):
    ConversationAssignmentLedger;
}

export interface ConversationExecutorLedgerOptions {
  readonly Constructor: ConversationAssignmentLedgerConstructor;
  readonly authority: Omit<
    Pick<
      ConversationOwnerRuntimeStack,
      | "executorLog"
      | "artifacts"
      | "executorId"
      | "signer"
      | "verifier"
      | "executorCapabilities"
      | "permissionSnapshotFor"
      | "assignmentResources"
      | "preflightLocalConversationEnvironment"
      | "validateLocalConversationManifest"
    >,
    "executorLog" | "assignmentResources"
  > & {
    readonly executorLog: NonNullable<ConversationOwnerRuntimeStack["executorLog"]>;
    readonly assignmentResources: NonNullable<
      ConversationOwnerRuntimeStack["assignmentResources"]
    >;
  };
  readonly clock?: () => string;
  readonly usageFinal: (
    assignmentId: string,
  ) => Promise<{ readonly reportDigest: string; readonly upToUsageSeq: number }>;
  readonly runtimeBindingGuard?: (input: {
    readonly assignmentId: string;
    readonly manifest: ExecutionManifest<"conversation">;
  }) => AuthorityError | undefined | Promise<AuthorityError | undefined>;
  readonly maxPendingInteractions?: number;
  readonly assignmentRecordV2Writes?: boolean;
  readonly dataPlaneTickets?: ConstructorParameters<
    typeof ConversationAssignmentLedger
  >[0]["dataPlaneTickets"];
}

/** Creates the one durable conversation ledger used by either local or remote execution. */
export function createConversationExecutorLedger(
  options: ConversationExecutorLedgerOptions,
): ConversationAssignmentLedger {
  const clock = options.clock ?? (() => new Date().toISOString());
  return new options.Constructor({
    log: options.authority.executorLog,
    artifacts: options.authority.artifacts,
    executorId: options.authority.executorId,
    signer: options.authority.signer,
    verifier: options.authority.verifier,
    ownerControl: createOwnerControlAuthorizer(options.authority.verifier, clock),
    resources: options.authority.assignmentResources,
    usageFinal: options.usageFinal,
    snapshotFor: (executorId: string): ExecutorCapabilitySnapshot | undefined =>
      options.authority.executorCapabilities.snapshotFor(executorId),
    permissionSnapshotFor: (digest: string): TrustRuleSnapshot | undefined =>
      options.authority.permissionSnapshotFor(digest),
    runtimeBindingGuard: options.runtimeBindingGuard ?? (async ({
      assignmentId,
      manifest,
    }) => {
      const compatibility =
        options.authority.validateLocalConversationManifest(manifest);
      if (compatibility) return compatibility;
      return (await options.authority.preflightLocalConversationEnvironment(
        manifest,
        assignmentId,
      )).error;
    }),
    clock,
    ...(options.dataPlaneTickets === undefined
      ? {}
      : { dataPlaneTickets: options.dataPlaneTickets }),
    ...(options.maxPendingInteractions === undefined
      ? {}
      : { maxPendingInteractions: options.maxPendingInteractions }),
    ...(options.assignmentRecordV2Writes === undefined
      ? {}
      : { assignmentRecordV2Writes: options.assignmentRecordV2Writes }),
  });
}
