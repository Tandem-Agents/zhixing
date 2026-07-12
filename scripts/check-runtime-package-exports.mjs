import { readFile } from "node:fs/promises";

const [
  server,
  ownerKernel,
  ownerServices,
  rpcCompat,
  runtimeHost,
  runtimeHostSegmentDeps,
  runtimeHostSessionAdapter,
] = await Promise.all([
  import("../packages/server/dist/index.js"),
  import("../packages/owner-kernel/dist/index.js"),
  import("../packages/owner-services/dist/index.js"),
  import("../packages/rpc/dist/server-compat.js"),
  import("../packages/runtime-host/dist/index.js"),
  import("../packages/runtime-host/dist/segment-deps.js"),
  import("../packages/runtime-host/dist/session-adapter.js"),
]);

const ownerCompatibilityValues = [
  "ConfirmationHub",
  "ConversationManager",
  "EphemeralRunBuffer",
  "WorksceneBusyError",
  "generateConversationId",
  "runTurnWithCommit",
];

const rpcCompatibilityValues = [
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
  "buildAdvancementProxyMessage",
  "renderRecentContextFromMessages",
];

const ownerServiceAdaptedValues = [
  "ProxyMessageScheduler",
  "createAdvancementRecoveryMaintenance",
  "dispatchAdvancementReviewResult",
];

const runtimeHostCanonicalValues = {
  createOwnerRuntimeAdapter: runtimeHostSessionAdapter,
  createRuntimeHostFactory: runtimeHostSessionAdapter,
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
];

const failures = [];
for (const name of ownerCompatibilityValues) {
  if (server[name] !== ownerKernel[name]) failures.push(`owner-kernel:${name}`);
}
for (const name of rpcCompatibilityValues) {
  if (server[name] !== rpcCompat[name]) failures.push(`rpc:${name}`);
}
for (const name of ownerServiceCanonicalValues) {
  if (server[name] !== ownerServices[name]) failures.push(`owner-services:${name}`);
}
for (const name of ownerServiceAdaptedValues) {
  if (typeof server[name] !== "function" || server[name] === ownerServices[name]) {
    failures.push(`owner-services-adapter:${name}`);
  }
}
for (const [name, subpath] of Object.entries(runtimeHostCanonicalValues)) {
  if (runtimeHost[name] !== subpath[name]) failures.push(`runtime-host:${name}`);
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
