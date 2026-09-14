/** Finite contracts shared by the Host construction and activation phases. */
import type { AdvancementRecentContextPort } from "./advancement-controller.js";
import type { AdvancementEvidenceRemoteDirectory } from "./advancement-evidence-topology.js";
import type { AssignmentDataPlaneRemoteDirectory } from "./assignment-data-plane-topology.js";
import type { ChannelConversationProductBinding } from "./channel-conversation-product-binding.js";
import type { SetupChannelsResult } from "./channels.js";
import type { DeviceRemovalLifecycleContribution } from "./device-removal-lifecycle-contribution.js";
import type { MeshRuntimeAssembly } from "./mesh-runtime-assembly.js";
import type {
  PlannedDutyMigrationLifecycleContribution,
} from "./planned-duty-migration-lifecycle-contribution.js";
import type { PostAdoptionReviewLifecycleContribution } from "./post-adoption-review.js";
import type {
  AdvancementConversationLifecycleApplication,
  AdvancementReviewAttemptApplication,
} from "@zhixing/core/advancement/application";
import type { SessionStatePort } from "@zhixing/core/contracts";
import type { DeliveryLifecycleRestoration } from "@zhixing/core/delivery";
import type { MeshConnectionRegistry } from "@zhixing/mesh/bootstrap";
import type { ConversationManagerCallbacks } from "@zhixing/owner-kernel/conversation-manager";
import type { AdvancementController } from "@zhixing/owner-services/advancement";

export type ConversationRuntimeStoragePort = Readonly<
  Required<
    Pick<
      ConversationManagerCallbacks,
      | "loadHistory"
      | "initTranscript"
      | "appendRun"
      | "appendCommittedRun"
      | "writeSnapshot"
    >
  >
>;

export interface AdvancementConversationComposition {
  create(input: Readonly<{
    sessionState: SessionStatePort;
    recentContext: AdvancementRecentContextPort;
  }>): Promise<Readonly<{
    controller: AdvancementController;
    reviews: AdvancementReviewAttemptApplication;
    lifecycle: AdvancementConversationLifecycleApplication;
  }>>;
}

export interface MeshRuntimePreparation {
  readonly runtime: MeshRuntimeAssembly;
  readonly connections: MeshConnectionRegistry;
  readonly advancementEvidence: AdvancementEvidenceRemoteDirectory;
  readonly assignmentDataPlane: AssignmentDataPlaneRemoteDirectory;
  readonly currentAnchorDeviceId: () => string;
  readonly plannedCurrentOwnerReady: () => boolean;
  readonly start: (options: {
    readonly deviceRemovalLifecycle: DeviceRemovalLifecycleContribution;
    readonly plannedDutyMigrationLifecycle: PlannedDutyMigrationLifecycleContribution;
    readonly postAdoptionReviewLifecycle: PostAdoptionReviewLifecycleContribution;
    readonly lifecycleAdmissionClosed?: boolean;
    readonly recoverAcceptedWork?: boolean;
  }) => Promise<MeshRuntimeAssembly>;
  readonly stop: () => Promise<void>;
}

export type PreparedChannelMechanism =
  | Readonly<{
      kind: "available";
      channels: SetupChannelsResult;
      conversationProduct: ChannelConversationProductBinding;
    }>
  | Readonly<{
      kind: "absent";
      reason: "not-configured" | "setup-failed";
    }>;

export interface StartupLifecycleRestoration {
  readonly kind: "stop" | "executor-removal" | "anchor-uninstall";
  readonly artifactReady: boolean;
  readonly recoverAcceptedWork: boolean;
  readonly alreadySettled: boolean;
  readonly delivery: DeliveryLifecycleRestoration;
}
