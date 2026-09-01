import { access, readFile } from "node:fs/promises";

const [
  coreRoot,
  coreConversationApplication,
  coreAdvancementApplication,
  coreSkillCatalog,
  coreScheduleApplication,
  coreDeliveryApplication,
  coreChannelDeliveryEffect,
  coreDeviceAdministrationApplication,
  coreProductApi,
  coreTrustAdministration,
  coreAuthority,
  corePersistence,
  coreProtocol,
  coreWorkspaceAdministration,
  orchestratorRoot,
  orchestratorRuntime,
  rpcRoot,
  rpcSkillCatalogClient,
  ownerKernel,
  ownerKernelDelivery,
  ownerKernelControlAdmission,
  ownerKernelConversationAssignment,
  server,
  ownerServices,
  ownerServicesAdvancement,
  runtimeHost,
  runtimeHostSessionAdapter,
  runtimeHostConversationProjection,
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
  import("../packages/core/dist/index.js"),
  import("../packages/core/dist/conversation/application.js"),
  import("../packages/core/dist/advancement/application.js"),
  import("../packages/core/dist/skills/catalog-application.js"),
  import("../packages/core/dist/scheduler/application.js"),
  import("../packages/core/dist/delivery/application.js"),
  import("../packages/core/dist/delivery/channel-effect.js"),
  import("../packages/core/dist/device-administration/application.js"),
  import("../packages/core/dist/product-api/catalog.js"),
  import("../packages/core/dist/trust-administration/application.js"),
  import("../packages/core/dist/authority/index.js"),
  import("../packages/core/dist/persistence/index.js"),
  import("../packages/core/dist/protocol/index.js"),
  import("../packages/core/dist/environment/workspace-administration.js"),
  import("../packages/orchestrator/dist/index.js"),
  import("../packages/orchestrator/dist/runtime/index.js"),
  import("../packages/rpc/dist/index.js"),
  import("../packages/rpc/dist/skill-catalog-client.js"),
  import("../packages/owner-kernel/dist/index.js"),
  import("../packages/owner-kernel/dist/delivery.js"),
  import("../packages/owner-kernel/dist/control-admission.js"),
  import("../packages/owner-kernel/dist/conversation-assignment.js"),
  import("../packages/server/dist/index.js"),
  import("../packages/owner-services/dist/index.js"),
  import("../packages/owner-services/dist/advancement/index.js"),
  import("../packages/runtime-host/dist/index.js"),
  import("../packages/runtime-host/dist/session-adapter.js"),
  import("../packages/runtime-host/dist/conversation-runtime-projection.js"),
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
  "TrustDirectory",
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
await verifyCorePackageExports(failures);
await verifyRpcSkillCatalogClientExport(failures);
await verifyRuntimeHostProductBoundary(failures);
if (
  typeof orchestratorRuntime.createAgentRuntime !== "function" ||
  "createAgentRuntime" in orchestratorRoot
) {
  failures.push("orchestrator-agent-runtime:invalid-runtime-boundary");
}
if (
  typeof orchestratorRuntime.assertKernelRunEvent !== "function" ||
  "assertKernelRunEvent" in orchestratorRoot
) {
  failures.push("orchestrator-kernel-run-event:invalid-runtime-boundary");
}
if (
  typeof orchestratorRuntime.assertKernelTerminal !== "function" ||
  typeof orchestratorRuntime.projectAgentResultToKernelTerminal !== "function" ||
  "assertKernelTerminal" in orchestratorRoot ||
  "projectAgentResultToKernelTerminal" in orchestratorRoot
) {
  failures.push("orchestrator-kernel-terminal:invalid-runtime-boundary");
}
if (
  typeof orchestratorRuntime.createKernelRuntimeIdentityContribution !== "function" ||
  typeof orchestratorRuntime.assertKernelRuntimeIdentityContribution !== "function" ||
  "createKernelRuntimeIdentityContribution" in orchestratorRoot ||
  "assertKernelRuntimeIdentityContribution" in orchestratorRoot
) {
  failures.push("orchestrator-kernel-runtime-identity:invalid-runtime-boundary");
}
for (const name of [
  "createKernelModelProviderBinding",
  "assertKernelModelProviderBinding",
  "createKernelRuntimeEnvironment",
  "assertKernelRuntimeEnvironment",
]) {
  if (typeof orchestratorRuntime[name] !== "function" || name in orchestratorRoot) {
    failures.push(`orchestrator-kernel-provider:${name}:invalid-runtime-boundary`);
  }
}
for (const name of [
  "assertConversationRuntimeProjection",
  "createConversationRuntimeProjection",
]) {
  if (
    typeof runtimeHostConversationProjection[name] !== "function" ||
    name in runtimeHost
  ) {
    failures.push(`runtime-host-conversation-projection:${name}:invalid-subpath`);
  }
}
if (
  typeof rpcSkillCatalogClient.SkillCatalogRpcClient !== "function" ||
  "SkillCatalogRpcClient" in rpcRoot
) {
  failures.push("rpc-skill-catalog-client:invalid-runtime-boundary");
}
for (const name of [
  "SkillCatalogApplicationError",
  "SkillCatalogApplicationService",
  "SkillCatalogAdmissionApplicationService",
  "SkillCatalogKernelProjectionApplicationService",
  "SkillCatalogLoadApplicationService",
  "SkillCatalogSaveApplicationService",
]) {
  if (typeof coreSkillCatalog[name] !== "function") {
    failures.push(`core-skill-catalog:${name}:missing`);
  }
  if (name in coreRoot) failures.push(`core-root-skill-catalog-leak:${name}`);
}
if ("assignmentMutationRequestId" in coreRoot) {
  failures.push("core-root-assignment-mutation-identity-leak");
}
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
      "assignmentMutationRequestId",
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
    new URL("../packages/runtime-host/dist/session-adapter.d.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../packages/runtime-host/dist/runtime-host.d.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL(
      "../packages/runtime-host/dist/conversation-runtime-projection.d.ts",
      import.meta.url,
    ),
    "utf8",
  ),
]);
const [orchestratorRootDeclarations, orchestratorRuntimeDeclarations] =
  await Promise.all([
    readFile(
      new URL("../packages/orchestrator/dist/index.d.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../packages/orchestrator/dist/runtime/index.d.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
const runtimeHostRootDeclaration = runtimeHostDeclarations[0] ?? "";
if (
  orchestratorRootDeclarations.includes("KernelRunEvent") ||
  orchestratorRootDeclarations.includes("assertKernelRunEvent") ||
  !orchestratorRuntimeDeclarations.includes("KernelRunEvent") ||
  !orchestratorRuntimeDeclarations.includes("assertKernelRunEvent")
) {
  failures.push("orchestrator-kernel-run-event:invalid-declaration-boundary");
}
if (
  orchestratorRootDeclarations.includes("KernelTerminal") ||
  orchestratorRootDeclarations.includes("KernelRunCompletion") ||
  orchestratorRootDeclarations.includes("assertKernelTerminal") ||
  orchestratorRootDeclarations.includes("projectAgentResultToKernelTerminal") ||
  /\bRunResult\b/u.test(orchestratorRuntimeDeclarations) ||
  !orchestratorRuntimeDeclarations.includes("KernelTerminal") ||
  !orchestratorRuntimeDeclarations.includes("KernelRunCompletion") ||
  !orchestratorRuntimeDeclarations.includes("assertKernelTerminal") ||
  !orchestratorRuntimeDeclarations.includes("projectAgentResultToKernelTerminal")
) {
  failures.push("orchestrator-kernel-terminal:invalid-declaration-boundary");
}
const agentRuntimeDeclaration = orchestratorRuntimeDeclarations.match(
  /interface AgentRuntime \{(?<body>[\s\S]*?)\n\}/u,
)?.groups?.body;
const createAgentRuntimeOptionsDeclaration = orchestratorRuntimeDeclarations.match(
  /interface CreateAgentRuntimeOptions \{(?<body>[\s\S]*?)\n\}/u,
)?.groups?.body;
if (
  !agentRuntimeDeclaration ||
  /\b(?:AgentRuntime|createAgentRuntime|KernelRunEnvelope|KernelRunEvent|KernelRunCompletion|KernelTerminal|KernelModelProviderBinding|KernelRuntimeEnvironment)\b/u.test(
    orchestratorRootDeclarations,
  )
) {
  failures.push("orchestrator-agent-runtime:invalid-declaration-boundary");
}
const expectedAgentRuntimeMembers = [
  "run",
  "estimateConversationRequestBudget",
  "estimateMessagesTokens",
  "forceCompact",
  "callText",
  "callTextWithUsage",
  "runOrchestrationV1",
  "subAgentUsages",
  "securitySnapshot",
  "executionPermissionRules",
  "executionProfile",
  "calibrationFactor",
  "confirmationBroker",
  "drainLifecycleDiagnostics",
  "dispose",
  "onAttentionWindowChange",
];
const actualAgentRuntimeMembers = agentRuntimeDeclaration
  ? agentRuntimeDeclaration
      .split("\n")
      .map((line) =>
        line.match(/^ {4}(?:readonly\s+)?(?<name>[A-Za-z_$][\w$]*)\??\s*(?::|\()/u)
          ?.groups?.name,
      )
      .filter(Boolean)
  : [];
if (
  JSON.stringify(actualAgentRuntimeMembers) !==
  JSON.stringify(expectedAgentRuntimeMembers)
) {
  failures.push("orchestrator-agent-runtime:public-member-exact-set-drift");
}
if (
  !agentRuntimeDeclaration ||
  /\b(?:securityPipeline|permissionStore|SecurityPipeline|IPermissionStore)\b/u.test(
    agentRuntimeDeclaration,
  )
) {
  failures.push("orchestrator-agent-runtime:security-implementation-leak");
}
if (
  !agentRuntimeDeclaration ||
  /\b(?:resolvedWorkspace|workspaceDirStatus|ResolvedWorkspace|WorkspaceDirStatus)\b/u.test(
    agentRuntimeDeclaration,
  ) ||
  /\bworkspace(?:Resolution|DirectoryStatus|Metadata|Info)\b/iu.test(
    agentRuntimeDeclaration,
  )
) {
  failures.push("orchestrator-agent-runtime:workspace-implementation-leak");
}
if (
  !agentRuntimeDeclaration ||
  /registerTurnContextProvider|turnContextProviders/u.test(agentRuntimeDeclaration) ||
  !createAgentRuntimeOptionsDeclaration ||
  !/readonly turnContextProviders\?: readonly TurnContextProvider\[\]/u.test(
    createAgentRuntimeOptionsDeclaration,
  ) ||
  runtimeHostDeclarations.some((text) =>
    /registerTurnContextProvider|onRuntimeCreated/u.test(text)
  ) ||
  !runtimeHostDeclarations.some((text) =>
    /readonly turnContextProviders\?: \(\) => TurnContextProvidersOption/u.test(text)
  )
) {
  failures.push("orchestrator-agent-runtime:turn-context-assembly-boundary");
}
if (
  !createAgentRuntimeOptionsDeclaration ||
  !/readonly modelProvider: KernelModelProviderBinding;/u.test(
    createAgentRuntimeOptionsDeclaration,
  ) ||
  !/readonly runtimeEnvironment: KernelRuntimeEnvironment;/u.test(
    createAgentRuntimeOptionsDeclaration,
  ) ||
  /providerConfiguration|ZhixingConfig|ProviderCredential/u.test(
    createAgentRuntimeOptionsDeclaration,
  ) ||
  !orchestratorRuntimeDeclarations.includes("KernelModelProviderFactory") ||
  !orchestratorRuntimeDeclarations.includes("KernelRuntimeEnvironmentFactory")
) {
  failures.push("orchestrator-kernel-provider:invalid-declaration-boundary");
}
const runtimeHostDeclaration = runtimeHostDeclarations.find((text) =>
  text.includes("declare class RuntimeHost"),
);
const conversationProjectionDeclaration = runtimeHostDeclarations.find((text) =>
  text.includes("interface ConversationRuntimeProjection"),
);
if (
  !runtimeHostDeclaration ||
  /BuiltinExtraToolsAssembly|SchedulerFacade|ExecutionSchedulerFacade|JobExecutionInstruction|TaskListService|McpHub/u.test(
    runtimeHostDeclaration,
  ) ||
  /\b(?:WorksceneDto|WorksceneToolDirectory|powerProfile|createWorksceneRuntime|worksceneDirectory|capabilityCatalog)\b/iu.test(
    runtimeHostDeclaration,
  ) ||
  !/createConversationRuntime\(projection: ConversationRuntimeProjection\)/u.test(
    runtimeHostDeclaration,
  ) ||
  !/createEphemeralRuntime\(runtimeTools: RuntimeToolProjection\)/u.test(
    runtimeHostDeclaration,
  ) ||
  !runtimeHostDeclaration.includes("readonly runtimeTools: RuntimeToolProjection") ||
  !conversationProjectionDeclaration ||
  !conversationProjectionDeclaration.includes("createConversationRuntimeProjection") ||
  !conversationProjectionDeclaration.includes("interface RuntimeToolProjection") ||
  !conversationProjectionDeclaration.includes("createRuntimeToolProjection") ||
  !conversationProjectionDeclaration.includes("assertRuntimeToolProjection") ||
  !conversationProjectionDeclaration.includes("readonly runtimeTools: RuntimeToolProjection") ||
  conversationProjectionDeclaration.includes("readonly productTools") ||
  /\bsceneId\b/u.test(runtimeHostDeclaration) ||
  /\bsceneId\b/u.test(conversationProjectionDeclaration) ||
  runtimeHostRootDeclaration.includes("ConversationRuntimeProjection") ||
  /\bworksceneIdentity\b/u.test(orchestratorRuntimeDeclarations) ||
  !/runtimeIdentity\?: KernelRuntimeIdentityContribution;/u.test(
    createAgentRuntimeOptionsDeclaration ?? "",
  ) ||
  orchestratorRootDeclarations.includes("createKernelRuntimeIdentityContribution") ||
  orchestratorRootDeclarations.includes("assertKernelRuntimeIdentityContribution") ||
  !orchestratorRuntimeDeclarations.includes("createKernelRuntimeIdentityContribution") ||
  !orchestratorRuntimeDeclarations.includes("assertKernelRuntimeIdentityContribution")
) {
  failures.push("runtime-host:workscene-product-projection-boundary");
}
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

async function verifyRuntimeHostProductBoundary(failures) {
  const packageRoot = new URL("../packages/runtime-host/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("package.json", packageRoot), "utf8"),
  );
  const retired = [
    "builtin-extra-tools",
    "segment-deps",
    "workmode-tools",
    "workscene-port",
  ];
  for (const name of retired) {
    if (`./${name}` in (manifest.exports ?? {})) {
      failures.push(`runtime-host:${name}:retired-product-subpath`);
    }
    for (const relative of [
      `src/${name}.ts`,
      `dist/${name}.js`,
      `dist/${name}.d.ts`,
    ]) {
      try {
        await access(new URL(relative, packageRoot));
        failures.push(`runtime-host:${relative}:retired-product-file`);
      } catch {}
    }
  }
  for (const dependency of ["@zhixing/mcp", "@zhixing/tools-builtin"]) {
    if (dependency in (manifest.dependencies ?? {})) {
      failures.push(`runtime-host:${dependency}:retired-product-dependency`);
    }
  }
  const [rootSource, buildConfig] = await Promise.all([
    readFile(new URL("src/index.ts", packageRoot), "utf8"),
    readFile(new URL("tsup.config.ts", packageRoot), "utf8"),
  ]);
  if (retired.some((name) => rootSource.includes(name))) {
    failures.push("runtime-host:retired-product-root-export");
  }
  if (retired.some((name) => buildConfig.includes(name))) {
    failures.push("runtime-host:retired-product-build-entry");
  }
}

async function verifyCorePackageExports(failures) {
  const packageRoot = new URL("../packages/core/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("package.json", packageRoot), "utf8"),
  );
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports)) {
    failures.push("core-exports:invalid-manifest");
    return;
  }

  if ("./memory" in manifest.exports) {
    failures.push("core-exports:retired-memory-subpath");
  }

  const conversationApplicationConditions =
    manifest.exports["./conversation/application"];
  if (
    !conversationApplicationConditions ||
    conversationApplicationConditions.types !==
      "./dist/conversation/application.d.ts" ||
    conversationApplicationConditions.import !==
      "./dist/conversation/application.js" ||
    typeof coreConversationApplication.ConversationDirectoryApplicationService !==
      "function" ||
    typeof coreConversationApplication.createConversationDirectoryProductApiContribution !==
      "function" ||
    "ConversationDirectoryApplicationService" in coreRoot
  ) {
    failures.push(
      "core-exports:conversation-application:invalid-runtime-boundary",
    );
  }

  const advancementApplicationConditions =
    manifest.exports["./advancement/application"];
  if (
    !advancementApplicationConditions ||
    advancementApplicationConditions.types !==
      "./dist/advancement/application.d.ts" ||
    advancementApplicationConditions.import !==
      "./dist/advancement/application.js" ||
    typeof coreAdvancementApplication.AdvancementApplicationService !==
      "function" ||
    typeof coreAdvancementApplication.createAdvancementProductApiContribution !==
      "function" ||
    typeof coreAdvancementApplication.ADVANCEMENT_REVISE_RUBRIC_COMMAND !==
      "object" ||
    typeof coreAdvancementApplication.ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT !==
      "object" ||
    "AdvancementApplicationService" in coreRoot ||
    "createAdvancementProductApiContribution" in coreRoot ||
    "ADVANCEMENT_REVISE_RUBRIC_COMMAND" in coreRoot ||
    "ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT" in coreRoot
  ) {
    failures.push(
      "core-exports:advancement-application:invalid-runtime-boundary",
    );
  }

  const skillCatalogConditions = manifest.exports["./skills/catalog"];
  if (
    !skillCatalogConditions ||
    skillCatalogConditions.types !== "./dist/skills/catalog-application.d.ts" ||
    skillCatalogConditions.import !== "./dist/skills/catalog-application.js"
  ) {
    failures.push("core-exports:skill-catalog:invalid-canonical-subpath");
  }
  const productApiConditions = manifest.exports["./product-api"];
  if (
    !productApiConditions ||
    productApiConditions.types !== "./dist/product-api/catalog.d.ts" ||
    productApiConditions.import !== "./dist/product-api/catalog.js"
  ) {
    failures.push("core-exports:product-api:invalid-canonical-subpath");
  }
  if (
    typeof coreProductApi.ProductApiDispatcher !== "function" ||
    "ProductApiDispatcher" in coreRoot ||
    "ProductApiDispatcher" in coreSkillCatalog
  ) {
    failures.push("core-exports:product-api:invalid-runtime-boundary");
  }
  const scheduleApplicationConditions = manifest.exports["./scheduler/application"];
  if (
    !scheduleApplicationConditions ||
    scheduleApplicationConditions.types !== "./dist/scheduler/application.d.ts" ||
    scheduleApplicationConditions.import !== "./dist/scheduler/application.js" ||
    typeof coreScheduleApplication.ScheduleManagementApplicationService !== "function" ||
    typeof coreScheduleApplication.createScheduleManagementProductApiContribution !== "function" ||
    "ScheduleManagementApplicationService" in coreRoot
  ) {
    failures.push("core-exports:schedule-application:invalid-runtime-boundary");
  }
  const trustAdministrationConditions = manifest.exports["./trust-administration"];
  if (
    !trustAdministrationConditions ||
    trustAdministrationConditions.types !==
      "./dist/trust-administration/application.d.ts" ||
    trustAdministrationConditions.import !==
      "./dist/trust-administration/application.js" ||
    typeof coreTrustAdministration.TrustAdministrationApplicationService !==
      "function" ||
    typeof coreTrustAdministration.createTrustAdministrationProductApiContribution !==
      "function" ||
    "TrustAdministrationApplicationService" in coreRoot ||
    "TrustAdministrationApplicationService" in coreProductApi
  ) {
    failures.push("core-exports:trust-administration:invalid-runtime-boundary");
  }
  const workspaceAdministrationConditions =
    manifest.exports["./environment/workspace-administration"];
  if (
    !workspaceAdministrationConditions ||
    workspaceAdministrationConditions.types !==
      "./dist/environment/workspace-administration.d.ts" ||
    workspaceAdministrationConditions.import !==
      "./dist/environment/workspace-administration.js" ||
    typeof coreWorkspaceAdministration.WorkspaceAdministrationApplicationService !==
      "function" ||
    typeof coreWorkspaceAdministration.WorkspaceAdministrationBusinessError !==
      "function" ||
    "WorkspaceAdministrationApplicationService" in coreRoot ||
    "WorkspaceAdministrationBusinessError" in coreRoot
  ) {
    failures.push(
      "core-exports:workspace-administration:invalid-runtime-boundary",
    );
  }
  const deliveryApplicationConditions = manifest.exports["./delivery/application"];
  if (
    !deliveryApplicationConditions ||
    deliveryApplicationConditions.types !==
      "./dist/delivery/application.d.ts" ||
    deliveryApplicationConditions.import !==
      "./dist/delivery/application.js" ||
    typeof coreDeliveryApplication.DeliveryUncertainResolutionApplicationService !==
      "function" ||
    typeof coreDeliveryApplication.DeliveryObligationApplicationService !==
      "function" ||
    typeof coreDeliveryApplication.DeliveryLifecycleApplicationService !==
      "function" ||
    typeof coreDeliveryApplication.DeliveryProjectionInvariantError !== "function" ||
    typeof coreDeliveryApplication.createDeliveryResolutionProductApiContribution !==
      "function" ||
    "DeliveryUncertainResolutionApplicationService" in coreRoot ||
    "DeliveryObligationApplicationService" in coreRoot ||
    "DeliveryLifecycleApplicationService" in coreRoot ||
    "DeliveryProjectionInvariantError" in coreRoot ||
    "createDeliveryResolutionProductApiContribution" in coreRoot
  ) {
    failures.push("core-exports:delivery-application:invalid-runtime-boundary");
  }
  const channelEffectConditions = manifest.exports["./delivery/channel-effect"];
  if (
    !channelEffectConditions ||
    channelEffectConditions.types !== "./dist/delivery/channel-effect.d.ts" ||
    channelEffectConditions.import !== "./dist/delivery/channel-effect.js" ||
    typeof coreChannelDeliveryEffect.createChannelDeliveryEffect !== "function" ||
    "createChannelDeliveryEffect" in coreRoot ||
    "createChannelDeliveryEffect" in coreDeliveryApplication
  ) {
    failures.push("core-exports:delivery-channel-effect:invalid-runtime-boundary");
  }
  const deviceAdministrationConditions =
    manifest.exports["./device-administration/application"];
  if (
    !deviceAdministrationConditions ||
    deviceAdministrationConditions.types !==
      "./dist/device-administration/application.d.ts" ||
    deviceAdministrationConditions.import !==
      "./dist/device-administration/application.js" ||
    typeof coreDeviceAdministrationApplication.DeviceAdministrationApplicationService !==
      "function" ||
    typeof coreDeviceAdministrationApplication.createDeviceAdministrationProductApiContribution !==
      "function" ||
    "DeviceAdministrationApplicationService" in coreRoot ||
    "createDeviceAdministrationProductApiContribution" in coreRoot
  ) {
    failures.push(
      "core-exports:device-administration-application:invalid-runtime-boundary",
    );
  }
  for (const retiredTarget of [
    "dist/delivery/resolution-application.d.ts",
    "dist/delivery/resolution-application.js",
  ]) {
    try {
      await access(new URL(retiredTarget, packageRoot));
      failures.push(`core-exports:delivery-application:retired-target:${retiredTarget}`);
    } catch {
      // A fresh build must leave no resolution-only compatibility artifact.
    }
  }
  if (
    typeof ownerKernelDelivery.createOwnerDeliveryParticipant !== "function" ||
    typeof ownerKernelDelivery.createOwnerDeliveryLifecycleBinding !== "function" ||
    "createOwnerDeliveryParticipant" in ownerKernel ||
    "createOwnerDeliveryLifecycleBinding" in ownerKernel
  ) {
    failures.push("owner-kernel-exports:delivery-obligation:invalid-runtime-boundary");
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./conversation/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === conversationApplicationConditions?.types ||
        conditions.import === conversationApplicationConditions?.import)
    ) {
      failures.push(
        `core-exports:${subpath}:duplicate-conversation-application-entry`,
      );
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./advancement/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === advancementApplicationConditions?.types ||
        conditions.import === advancementApplicationConditions?.import)
    ) {
      failures.push(
        `core-exports:${subpath}:duplicate-advancement-application-entry`,
      );
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./scheduler/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === scheduleApplicationConditions?.types ||
        conditions.import === scheduleApplicationConditions?.import)
    ) {
      failures.push(`core-exports:${subpath}:duplicate-schedule-application-entry`);
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./trust-administration" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === trustAdministrationConditions?.types ||
        conditions.import === trustAdministrationConditions?.import)
    ) {
      failures.push(`core-exports:${subpath}:duplicate-trust-administration-entry`);
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./environment/workspace-administration" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === workspaceAdministrationConditions?.types ||
        conditions.import === workspaceAdministrationConditions?.import)
    ) {
      failures.push(
        `core-exports:${subpath}:duplicate-workspace-administration-entry`,
      );
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./product-api" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === productApiConditions?.types ||
        conditions.import === productApiConditions?.import)
    ) {
      failures.push(`core-exports:${subpath}:duplicate-product-api-entry`);
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./delivery/channel-effect" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === channelEffectConditions?.types ||
        conditions.import === channelEffectConditions?.import)
    ) {
      failures.push(`core-exports:${subpath}:duplicate-delivery-channel-effect-entry`);
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./device-administration/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === deviceAdministrationConditions?.types ||
        conditions.import === deviceAdministrationConditions?.import)
    ) {
      failures.push(
        `core-exports:${subpath}:duplicate-device-administration-application-entry`,
      );
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./delivery/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === deliveryApplicationConditions?.types ||
        conditions.import === deliveryApplicationConditions?.import)
    ) {
      failures.push(`core-exports:${subpath}:duplicate-delivery-application-entry`);
    }
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./skills/catalog" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === skillCatalogConditions?.types ||
        conditions.import === skillCatalogConditions?.import)
    ) {
      failures.push(`core-exports:${subpath}:duplicate-skill-catalog-entry`);
    }
  }

  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) {
      failures.push(`core-exports:${subpath}:invalid-conditions`);
      continue;
    }
    for (const condition of ["types", "import"]) {
      const target = conditions[condition];
      if (typeof target !== "string" || !target.startsWith("./dist/")) {
        failures.push(`core-exports:${subpath}:${condition}:invalid-target`);
        continue;
      }
      const targetUrl = new URL(target.slice(2), packageRoot);
      try {
        await access(targetUrl);
      } catch {
        failures.push(`core-exports:${subpath}:${condition}:missing-target`);
        continue;
      }
      if (condition === "import") {
        try {
          const exported = await import(targetUrl.href);
          if (
            subpath !== "./conversation/application" &&
            "ConversationDirectoryApplicationService" in exported
          ) {
            failures.push(
              `core-exports:${subpath}:conversation-application-runtime-leak`,
            );
          }
          if (
            subpath !== "./advancement/application" &&
            ("AdvancementApplicationService" in exported ||
              "createAdvancementProductApiContribution" in exported ||
              "ADVANCEMENT_REVISE_RUBRIC_COMMAND" in exported ||
              "ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT" in exported)
          ) {
            failures.push(
              `core-exports:${subpath}:advancement-application-runtime-leak`,
            );
          }
          if (
            subpath === "." &&
            ("SkillStore" in exported || "getSkillsRoot" in exported)
          ) {
            failures.push("core-exports:root:retired-skill-storage-runtime-leak");
          }
          if (
            subpath !== "./skills/catalog" &&
            ("SkillCatalogApplicationError" in exported ||
              "SkillCatalogApplicationService" in exported ||
              "SkillCatalogAdmissionApplicationService" in exported ||
              "SkillCatalogKernelProjectionApplicationService" in exported ||
              "SkillCatalogLoadApplicationService" in exported ||
              "SkillCatalogSaveApplicationService" in exported)
          ) {
            failures.push(`core-exports:${subpath}:skill-catalog-runtime-leak`);
          }
          if (
            subpath !== "./environment/workspace-administration" &&
            ("WorkspaceAdministrationApplicationService" in exported ||
              "WorkspaceAdministrationBusinessError" in exported)
          ) {
            failures.push(
              `core-exports:${subpath}:workspace-administration-runtime-leak`,
            );
          }
          if (
            subpath !== "./device-administration/application" &&
            ("DeviceAdministrationApplicationService" in exported ||
              "createDeviceAdministrationProductApiContribution" in exported)
          ) {
            failures.push(
              `core-exports:${subpath}:device-administration-application-runtime-leak`,
            );
          }
        } catch {
          failures.push(`core-exports:${subpath}:${condition}:unloadable-target`);
        }
      } else if (subpath !== "./skills/catalog") {
        const declaration = await readFile(targetUrl, "utf8");
        if (
          subpath !== "./conversation/application" &&
          /ConversationDirectoryApplication(?:Service)?/u.test(declaration)
        ) {
          failures.push(
            `core-exports:${subpath}:conversation-application-type-leak`,
          );
        }
        if (
          subpath === "." &&
          /\b(?:SkillStore|getSkillsRoot)\b/u.test(declaration)
        ) {
          failures.push("core-exports:root:retired-skill-storage-type-leak");
        }
        if (
          /SkillCatalog(?:Save|Admission|Load|KernelProjection)?Application/u.test(declaration) ||
          declaration.includes("catalog-application")
        ) {
          failures.push(`core-exports:${subpath}:skill-catalog-type-leak`);
        }
        if (
          subpath !== "./device-administration/application" &&
          /DeviceAdministrationApplication(?:Service)?/u.test(declaration)
        ) {
          failures.push(
            `core-exports:${subpath}:device-administration-application-type-leak`,
          );
        }
      }
    }
  }
}

async function verifyRpcSkillCatalogClientExport(failures) {
  const packageRoot = new URL("../packages/rpc/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("package.json", packageRoot), "utf8"),
  );
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports)) {
    failures.push("rpc-exports:invalid-manifest");
    return;
  }
  const canonical = manifest.exports["./skill-catalog-client"];
  if (
    canonical?.types !== "./dist/skill-catalog-client.d.ts" ||
    canonical?.import !== "./dist/skill-catalog-client.js"
  ) {
    failures.push("rpc-exports:skill-catalog-client:invalid-canonical-subpath");
  }
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (
      subpath !== "./skill-catalog-client" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === canonical?.types || conditions.import === canonical?.import)
    ) {
      failures.push(`rpc-exports:${subpath}:duplicate-skill-catalog-client-entry`);
    }
  }
  for (const condition of ["types", "import"]) {
    const target = canonical?.[condition];
    if (typeof target !== "string" || !target.startsWith("./dist/")) {
      failures.push(`rpc-exports:skill-catalog-client:${condition}:invalid-target`);
      continue;
    }
    try {
      await access(new URL(target.slice(2), packageRoot));
    } catch {
      failures.push(`rpc-exports:skill-catalog-client:${condition}:missing-target`);
    }
  }
  const rootDeclaration = await readFile(
    new URL("dist/index.d.ts", packageRoot),
    "utf8",
  );
  if (
    rootDeclaration.includes("SkillCatalogRpcClient") ||
    rootDeclaration.includes("skill-catalog-client")
  ) {
    failures.push("rpc-exports:root:skill-catalog-client-type-leak");
  }
}
