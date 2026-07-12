const [server, ownerKernel, rpcCompat] = await Promise.all([
  import("../packages/server/dist/index.js"),
  import("../packages/owner-kernel/dist/index.js"),
  import("../packages/rpc/dist/server-compat.js"),
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

const failures = [];
for (const name of ownerCompatibilityValues) {
  if (server[name] !== ownerKernel[name]) failures.push(`owner-kernel:${name}`);
}
for (const name of rpcCompatibilityValues) {
  if (server[name] !== rpcCompat[name]) failures.push(`rpc:${name}`);
}

if (failures.length > 0) {
  throw new Error(`Server compatibility exports diverged: ${failures.join(", ")}`);
}
