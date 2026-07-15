import { readFile } from "node:fs/promises";

const [
  coreAuthority,
  corePersistence,
  coreProtocol,
  ownerKernel,
  ownerKernelControlAdmission,
  ownerKernelConversationAssignment,
  server,
  ownerServices,
  ownerServicesAdvancement,
  runtimeHost,
  runtimeHostSegmentDeps,
  runtimeHostSessionAdapter,
  executor,
  executorRuntimeRole,
  executorAssignmentLedger,
  mesh,
  meshHandshake,
  meshPairing,
  meshTransport,
  meshDeviceKeyStore,
  meshDeviceReadiness,
  meshCredentialExposure,
  secrets,
] = await Promise.all([
  import("../packages/core/dist/authority/index.js"),
  import("../packages/core/dist/persistence/index.js"),
  import("../packages/core/dist/protocol/index.js"),
  import("../packages/owner-kernel/dist/index.js"),
  import("../packages/owner-kernel/dist/control-admission.js"),
  import("../packages/owner-kernel/dist/conversation-assignment.js"),
  import("../packages/server/dist/index.js"),
  import("../packages/owner-services/dist/index.js"),
  import("../packages/owner-services/dist/advancement/index.js"),
  import("../packages/runtime-host/dist/index.js"),
  import("../packages/runtime-host/dist/segment-deps.js"),
  import("../packages/runtime-host/dist/session-adapter.js"),
  import("../packages/executor/dist/index.js"),
  import("../packages/executor/dist/runtime-role.js"),
  import("../packages/executor/dist/assignment-ledger.js"),
  import("../packages/mesh/dist/index.js"),
  import("../packages/mesh/dist/handshake.js"),
  import("../packages/mesh/dist/pairing-public.js"),
  import("../packages/mesh/dist/transport.js"),
  import("../packages/mesh/dist/device-key-store.js"),
  import("../packages/mesh/dist/device-readiness.js"),
  import("../packages/mesh/dist/credential-exposure.js"),
  import("../packages/secrets/dist/index.js"),
]);

const retiredServerCompatibilityValues = [
  "ConfirmationHub",
  "ConversationManager",
  "EphemeralRunBuffer",
  "WorksceneBusyError",
  "generateConversationId",
  "runTurnWithCommit",
  "CONFIRMATION_NOTIFICATIONS",
  "SESSION_NOTIFICATIONS",
  "createActivityBroadcast",
  "createConfirmationBridge",
  "createControlSessionEventEnvelope",
  "createEventBridge",
  "createObserverBroadcast",
  "createRunEventForwarder",
  "toWireAgentResult",
];

const ownerServiceCanonicalValues = [
  "AdvancementController",
  "ProxyMessageScheduler",
  "buildAdvancementProxyMessage",
  "createAdvancementRecoveryMaintenance",
  "dispatchAdvancementReviewResult",
  "renderRecentContextFromMessages",
];

const ownerKernelControlAdmissionValues = [
  "ControlAdmissionJournal",
  "channelSurfacePrincipal",
  "createConversationControlEnvelope",
  "createInitialControlEnvelope",
];

const ownerKernelConversationAssignmentValues = [
  "ConversationRunJournal",
  "InProcessConversationDispatcher",
];

retiredServerCompatibilityValues.push(
  ...ownerServiceCanonicalValues,
  "DEFAULT_SESSION_TOKEN_BUDGET",
);

const runtimeHostCanonicalValues = {
  createOwnerRuntimeAdapter: runtimeHostSessionAdapter,
  createPersistentSegmentDeps: runtimeHostSegmentDeps,
  createTaskListReaderFromService: runtimeHostSegmentDeps,
  createTransientSegmentDeps: runtimeHostSegmentDeps,
};

const runtimeHostLegacyNames = [
  "CliSegmentDeps",
  "CliSegmentDepsInput",
  "RuntimeFactoryOptions",
  "createCliRuntimeFactory",
  "createCliSegmentDeps",
  "createServeSegmentDeps",
  "createServerRuntimeAdapter",
  "createRuntimeHostFactory",
];

const executorCanonicalValues = [
  "createExecutorRole",
  "createInProcessRuntimeFactory",
];

const executorAssignmentLedgerValues = [
  "ConversationAssignmentLedger",
  "InProcessAssignmentSubmission",
];

const meshCanonicalValues = {
  connectAuthenticatedMesh: meshHandshake,
  createAuthenticatedMeshServer: meshHandshake,
  SecureMeshConnection: meshTransport,
  persistDeviceKey: meshDeviceKeyStore,
  loadDeviceKey: meshDeviceKeyStore,
  deleteDeviceKey: meshDeviceKeyStore,
  evaluateDeviceReadiness: meshDeviceReadiness,
  assertDeviceReadyForRole: meshDeviceReadiness,
  nextDeviceOnboardingStep: meshDeviceReadiness,
  createCredentialExposureRecord: meshCredentialExposure,
  projectDeviceCredentialRevocation: meshCredentialExposure,
};

const failures = [];
for (const [moduleName, module, names] of [
  ["core-authority", coreAuthority, ["FileArtifactStore", "FileAuthorityCommitLog"]],
  [
    "core-persistence",
    corePersistence,
    ["acquireFileLock", "ensureDurableDirectory", "syncDirectory"],
  ],
  [
    "core-protocol",
    coreProtocol,
    [
      "advanceAssignmentLedger",
      "advanceInteractionMirrorDigest",
      "applyValidatedAssignmentEntry",
      "assignmentActivationDigest",
      "assignmentLedgerSeed",
      "buildConversationActivationPayload",
      "buildConversationActivationPayloadFromBinding",
      "byteDigest",
      "canonicalize",
      "conversationBundleRoots",
      "createConversationSealedBundle",
      "createAssignmentLedgerValidationState",
      "createMutationBatch",
      "createSignedConversationInteractionMirrorBatch",
      "createSignedConversationEnvelope",
      "dispatchEnvelopeArtifact",
      "dispatchEnvelopeDigest",
      "interactionMirrorBatchDigest",
      "interactionMirrorSeed",
      "mutationBatchArtifact",
      "permissionSnapshotLeaseDigest",
      "protocolBytes",
      "protocolDigest",
      "signCancelProof",
      "signConversationActivation",
      "signDispatchConflictProof",
      "signSupersedeProof",
      "sealedBundleArtifact",
      "validateAssignmentEntry",
      "validateAssignmentTerminationProof",
      "validateCancelProof",
      "validateChannelResponderRef",
      "validateConversationActivation",
      "validateConversationEnvelope",
      "validateConversationInteractionMirrorEntry",
      "validateConversationInteractionMirrorBatch",
      "validateConversationInteractionOutcome",
      "validateDispatchConflictProof",
      "validateDispatchRejectionProof",
      "validateDispatchResult",
      "validateLedgerEvidencePage",
      "validateLedgerSnapshot",
      "validateIngressContext",
      "validateEnvironmentRequirement",
      "validateMessage",
      "validateMessages",
      "validateNonEmptyUserTurnInput",
      "validateUserTurnInput",
      "validateConversationSealedBundle",
      "validateMutationBatch",
      "validateStagedMutationRecord",
      "validateSupersedeProof",
      "validateTranscriptRunRecord",
    ],
  ],
]) {
  for (const name of names) {
    if (typeof module[name] !== "function") failures.push(`${moduleName}:${name}`);
  }
}
for (const name of [
  "EncryptedVaultSecretStore",
  "createPlatformSecretStore",
  "getPlatformSecretStoreProtectedPaths",
]) {
  if (typeof secrets[name] !== "function") failures.push(`secrets:${name}`);
}
for (const name of ownerServiceCanonicalValues) {
  if (ownerServices[name] !== ownerServicesAdvancement[name]) {
    failures.push(`owner-services:${name}`);
  }
}
for (const name of ownerKernelControlAdmissionValues) {
  if (ownerKernel[name] !== ownerKernelControlAdmission[name]) {
    failures.push(`owner-kernel-control-admission:${name}`);
  }
}
for (const name of ownerKernelConversationAssignmentValues) {
  if (ownerKernel[name] !== ownerKernelConversationAssignment[name]) {
    failures.push(`owner-kernel-conversation-assignment:${name}`);
  }
}
for (const name of retiredServerCompatibilityValues) {
  if (name in server) failures.push(`server-retired-compatibility:${name}`);
}
for (const [name, subpath] of Object.entries(runtimeHostCanonicalValues)) {
  if (runtimeHost[name] !== subpath[name]) failures.push(`runtime-host:${name}`);
}
for (const name of executorCanonicalValues) {
  if (executor[name] !== executorRuntimeRole[name]) failures.push(`executor:${name}`);
}
for (const name of executorAssignmentLedgerValues) {
  if (executor[name] !== executorAssignmentLedger[name]) {
    failures.push(`executor-assignment-ledger:${name}`);
  }
}
for (const [name, subpath] of Object.entries(meshCanonicalValues)) {
  if (mesh[name] !== subpath[name]) failures.push(`mesh:${name}`);
}
for (const name of Object.keys(meshPairing)) {
  if (name in mesh) failures.push(`mesh-pairing-root-leak:${name}`);
}

const runtimeHostDeclarations = await Promise.all([
  readFile(
    new URL("../packages/runtime-host/dist/index.d.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../packages/runtime-host/dist/segment-deps.d.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../packages/runtime-host/dist/session-adapter.d.ts", import.meta.url),
    "utf8",
  ),
]);
for (const name of runtimeHostLegacyNames) {
  if (
    name in runtimeHost ||
    runtimeHostDeclarations.some((text) => text.includes(name))
  ) {
    failures.push(`runtime-host-legacy:${name}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Runtime package export checks failed: ${failures.join(", ")}`);
}
