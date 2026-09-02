import type {
  ArtifactRef,
  DeviceIdentity,
  DisasterRecoveryAbort,
  DisasterRecoveryCommand,
  TransferRecord,
} from "@zhixing/core/contracts";
import type {
  ArtifactReceiveProgress,
  ArtifactStore,
  IdentifiedPhysicalStepRunner,
  ProjectionReplayOptions,
  ProjectionReducer,
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
  ProjectionTransactionOptions,
  ProjectionTransactionReducer,
  ProjectionTransactionResult,
} from "@zhixing/core/authority";
import type { DisasterRecoveryState } from "@zhixing/core/protocol";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import type {
  DisasterRecoveryCandidateState,
  DisasterRecoveryInstallDecision,
  DisasterRecoveryVerifiedCandidate,
} from "./disaster-recovery-candidate.js";

type DisasterRecord = Extract<TransferRecord, { mode: "disaster-recovery" }>;
type PrepareCommand = Extract<DisasterRecoveryCommand, { op: "prepare" }>;

/** Finite storage mechanism consumed by the disaster-recovery journals. */
export interface DisasterRecoveryJournalStorage {
  readonly artifactStore: ArtifactStore;
  rebuildProjection<State, Body = unknown>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options?: ProjectionReplayOptions,
  ): Promise<State>;
  transactProjection<State, Body = unknown, Value = void>(
    initial: State,
    reducer: ProjectionTransactionReducer<State, Body>,
    decide: (
      state: State,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
    options?: ProjectionTransactionOptions,
  ): Promise<ProjectionTransactionResult<State, Body, Value>>;
  readStream<Body = unknown>(
    stream: string,
  ): Promise<Array<{ readonly lsn: number; readonly at: string; readonly body: Body }>>;
  stopStorageMaintenance(): Promise<void>;
}

export interface DisasterRecoveryCandidateJournalPort {
  state(transferId: string): Promise<DisasterRecoveryCandidateState | undefined>;
  states(): Promise<ReadonlyMap<string, DisasterRecoveryCandidateState>>;
  claim(input: PrepareCommand): Promise<DisasterRecoveryCandidateState>;
  recordVerified(
    transferId: string,
    input: DisasterRecoveryVerifiedCandidate,
  ): Promise<DisasterRecoveryCandidateState>;
  decideInstall(
    transferId: string,
    input: DisasterRecoveryInstallDecision,
  ): Promise<DisasterRecoveryCandidateState>;
  terminal(
    transferId: string,
    terminal: "committed" | "aborted",
    abort?: DisasterRecoveryAbort,
  ): Promise<DisasterRecoveryCandidateState>;
}

export interface DisasterRecoveryPrivateJournalPort {
  state(transferId: string): Promise<DisasterRecoveryState | undefined>;
  states(): Promise<ReadonlyMap<string, DisasterRecoveryState>>;
  append(
    record: DisasterRecord,
    candidateReferences?: readonly ArtifactRef[],
  ): Promise<DisasterRecoveryState>;
}

export interface DisasterRecoveryStagingReceiver {
  progress(
    ref: ArtifactRef,
    runPhysicalStep?: IdentifiedPhysicalStepRunner,
  ): Promise<ArtifactReceiveProgress>;
  append(
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
    runPhysicalStep?: IdentifiedPhysicalStepRunner,
  ): Promise<ArtifactReceiveProgress>;
}

export interface DisasterRecoveryTransferStagingSession {
  readonly transferId: string;
  readonly artifacts: ArtifactStore;
  readonly journal: DisasterRecoveryPrivateJournalPort;
  readonly privateImport: DisasterRecoveryStagingReceiver;
  readonly promotion: DisasterRecoveryStagingReceiver;
  exists(): Promise<boolean>;
  cleanupTransfer(): Promise<void>;
  close(): Promise<void>;
}

export interface DisasterRecoveryTargetStaging {
  candidateFor(rootPublicKey: string): DisasterRecoveryCandidateJournalPort;
  forTransfer(input: Readonly<{
    transferId: string;
    rootPublicKey: string;
    identity: DeviceIdentity;
    issuerKey?: Pick<DeviceKey, "deviceId" | "publicKey">;
    now?: () => number;
  }>): Promise<DisasterRecoveryTransferStagingSession>;
  close(): Promise<void>;
}

export interface DisasterRecoveryStagingArea {
  openTarget(input: Readonly<{
    sharedArtifacts: ArtifactStore;
  }>): DisasterRecoveryTargetStaging;
  cleanupPostInstall(transferId: string): Promise<void>;
  cleanupCurrentDevice(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
