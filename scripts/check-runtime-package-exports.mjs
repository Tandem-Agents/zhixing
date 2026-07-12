import { readFile } from "node:fs/promises";

const [
  server,
  ownerServices,
  ownerServicesAdvancement,
  runtimeHost,
  runtimeHostSegmentDeps,
  runtimeHostSessionAdapter,
  executor,
  executorRuntimeRole,
  mesh,
  meshHandshake,
  meshPairing,
  meshTransport,
] = await Promise.all([
  import("../packages/server/dist/index.js"),
  import("../packages/owner-services/dist/index.js"),
  import("../packages/owner-services/dist/advancement/index.js"),
  import("../packages/runtime-host/dist/index.js"),
  import("../packages/runtime-host/dist/segment-deps.js"),
  import("../packages/runtime-host/dist/session-adapter.js"),
  import("../packages/executor/dist/index.js"),
  import("../packages/executor/dist/runtime-role.js"),
  import("../packages/mesh/dist/index.js"),
  import("../packages/mesh/dist/handshake.js"),
  import("../packages/mesh/dist/pairing-public.js"),
  import("../packages/mesh/dist/transport.js"),
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

const meshCanonicalValues = {
  connectAuthenticatedMesh: meshHandshake,
  createAuthenticatedMeshServer: meshHandshake,
  SecureMeshConnection: meshTransport,
};

const failures = [];
for (const name of ownerServiceCanonicalValues) {
  if (ownerServices[name] !== ownerServicesAdvancement[name]) {
    failures.push(`owner-services:${name}`);
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
