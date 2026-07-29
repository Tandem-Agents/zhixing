import type {
  AssignmentMethodId,
  AuthorityCapability,
  AuthorityEpochRef,
  AuthorityPortMethodId,
  AuthorityPrincipal,
  ControlLease,
  HostMethodId,
  OwnerControlMethodId,
  OwnerControlGrant,
  PermissionSnapshotLease,
  PrincipalMethodMatrix,
  ResourceSelector,
  SubmissionMethodId,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import type { ProtocolSignatureVerifier } from "./signature.js";
import { assertProtocolIdentifier } from "./validation.js";

type AnyPermissionSnapshotLease =
  | PermissionSnapshotLease<"conversation">
  | PermissionSnapshotLease<"job">;

export const MAX_CLOCK_SKEW_MS = 120_000;
export const MAX_CONTROL_LEASE_TTL_MS = 60_000;
export const MAX_PERMISSION_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

export const AUTHORITY_PORT_METHODS = [
  "session.readSessionMeta",
  "session.readTranscriptTail",
  "session.readTaskList",
  "session.readAdvancementState",
  "session.mutate",
  "global.read",
  "global.mutate",
  "intent.record",
  "intent.list",
  "intent.decide",
  "reservation.enqueueRoot",
  "reservation.prepareAssignmentRoot",
  "reservation.prepareSystemJobRoot",
  "reservation.acquireRoot",
  "reservation.acquireChild",
  "reservation.reserveUsage",
  "reservation.consume",
  "reservation.settle",
  "reservation.release",
  "submission.reportStarted",
  "submission.submitBundle",
  "submission.submitCancelProof",
  "submission.mirrorInteractions",
  "submission.completeInteractionSettlement",
  "governor.submitUsageReport",
  "executor.dispatch",
  "executor.cancel",
  "executor.supersede",
  "executor.queryLedger",
] as const satisfies readonly AuthorityPortMethodId[];

type MissingAuthorityPortMethod = Exclude<
  AuthorityPortMethodId,
  (typeof AUTHORITY_PORT_METHODS)[number]
>;
const AUTHORITY_PORT_METHODS_ARE_COMPLETE: MissingAuthorityPortMethod extends never
  ? true
  : never = true;

export const ASSIGNMENT_SUBMISSION_METHODS = [
  "submission.reportStarted",
  "submission.submitBundle",
  "submission.submitCancelProof",
  "submission.mirrorInteractions",
  "submission.completeInteractionSettlement",
] as const satisfies readonly SubmissionMethodId[];

type MissingAssignmentSubmissionMethod = Exclude<
  SubmissionMethodId,
  (typeof ASSIGNMENT_SUBMISSION_METHODS)[number]
>;
const ASSIGNMENT_SUBMISSION_METHODS_ARE_COMPLETE:
  MissingAssignmentSubmissionMethod extends never ? true : never = true;

export const PRINCIPAL_METHODS = {
  assignment: [
    "session.readSessionMeta",
    "session.readTranscriptTail",
    "session.readTaskList",
    "session.readAdvancementState",
    "session.mutate",
    "global.read",
    "global.mutate",
    "reservation.acquireChild",
    "reservation.reserveUsage",
    "reservation.consume",
    "reservation.settle",
    "reservation.release",
    ...ASSIGNMENT_SUBMISSION_METHODS,
  ],
  surface: [
    "session.readSessionMeta",
    "session.readTranscriptTail",
    "session.readTaskList",
    "session.readAdvancementState",
    "session.mutate",
    "global.read",
    "global.mutate",
    "intent.list",
    "intent.decide",
  ],
  host: [
    "session.readSessionMeta",
    "session.readTranscriptTail",
    "session.readTaskList",
    "session.readAdvancementState",
    "session.mutate",
    "global.read",
    "global.mutate",
    "intent.record",
    "intent.list",
    "intent.decide",
    "reservation.enqueueRoot",
    "reservation.prepareAssignmentRoot",
    "reservation.prepareSystemJobRoot",
    "reservation.acquireRoot",
    "reservation.acquireChild",
    "reservation.reserveUsage",
    "reservation.consume",
    "reservation.settle",
    "reservation.release",
  ],
  "owner-control": [
    "executor.dispatch",
    "executor.cancel",
    "executor.supersede",
    "executor.queryLedger",
  ],
  "usage-reporter": ["governor.submitUsageReport"],
} as const satisfies {
  readonly [K in keyof PrincipalMethodMatrix]: readonly PrincipalMethodMatrix[K][];
};

type MissingPrincipalMethod<K extends keyof PrincipalMethodMatrix> = Exclude<
  PrincipalMethodMatrix[K],
  (typeof PRINCIPAL_METHODS)[K][number]
>;
const PRINCIPAL_METHODS_ARE_COMPLETE: {
  readonly [K in keyof PrincipalMethodMatrix]: MissingPrincipalMethod<K> extends never
    ? true
    : never;
} = {
  assignment: true,
  surface: true,
  host: true,
  "owner-control": true,
  "usage-reporter": true,
};

void AUTHORITY_PORT_METHODS_ARE_COMPLETE;
void ASSIGNMENT_SUBMISSION_METHODS_ARE_COMPLETE;
void PRINCIPAL_METHODS_ARE_COMPLETE;

const METHOD_SET = new Set<string>(AUTHORITY_PORT_METHODS);
const PRINCIPAL_METHOD_SETS: Record<
  AuthorityPrincipal["kind"],
  ReadonlySet<AuthorityPortMethodId>
> = {
  assignment: new Set(PRINCIPAL_METHODS.assignment),
  surface: new Set(PRINCIPAL_METHODS.surface),
  host: new Set(PRINCIPAL_METHODS.host),
  "owner-control": new Set(PRINCIPAL_METHODS["owner-control"]),
  "usage-reporter": new Set(PRINCIPAL_METHODS["usage-reporter"]),
};

export function isAuthorityPortMethodId(
  value: unknown,
): value is AuthorityPortMethodId {
  return typeof value === "string" && METHOD_SET.has(value);
}

export function principalAllowsAuthorityMethod(
  principal: AuthorityPrincipal["kind"],
  method: AuthorityPortMethodId,
): boolean {
  return PRINCIPAL_METHOD_SETS[principal]?.has(method) === true;
}

export function assertPrincipalAllowsAuthorityMethod(
  principal: AuthorityPrincipal["kind"],
  method: AuthorityPortMethodId,
): void {
  if (!principalAllowsAuthorityMethod(principal, method)) {
    throw new TypeError(`${principal} principal cannot call ${method}`);
  }
}

export type HostComponentMethodRegistry = Readonly<
  Record<string, readonly HostMethodId[]>
>;

export interface AuthorityPrincipalMethodGuard {
  allows(principal: AuthorityPrincipal, method: AuthorityPortMethodId): boolean;
  assert(principal: AuthorityPrincipal, method: AuthorityPortMethodId): void;
}

export function createAuthorityPrincipalMethodGuard(
  hostComponents: HostComponentMethodRegistry,
): AuthorityPrincipalMethodGuard {
  const hostMethods = new Map<string, ReadonlySet<HostMethodId>>();
  for (const [component, methods] of Object.entries(hostComponents)) {
    assertIdentifier(component, "Host authority component");
    assertDenseUniqueArray(methods, `Host authority methods for ${component}`);
    for (const method of methods) {
      if (!principalAllowsAuthorityMethod("host", method)) {
        throw new TypeError(`Host component ${component} contains a forbidden method`);
      }
    }
    hostMethods.set(component, new Set(methods as readonly HostMethodId[]));
  }
  const allows = (
    principal: AuthorityPrincipal,
    method: AuthorityPortMethodId,
  ): boolean => {
    if (!principalAllowsAuthorityMethod(principal.kind, method)) return false;
    return principal.kind !== "host" ||
      hostMethods.get(principal.component)?.has(method as HostMethodId) === true;
  };
  return {
    allows,
    assert(principal, method) {
      if (!allows(principal, method)) {
        throw new TypeError(`${principal.kind} principal cannot call ${method}`);
      }
    },
  };
}

export function validateAuthorityCapability(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AuthorityCapability {
  const capability = clone(input, "Authority capability") as AuthorityCapability;
  assertObject(capability, "Authority capability");
  assertObject(capability.scope, "Authority capability scope");
  const epochKey = capability.scope.execution === "conversation"
    ? "ownerEpoch"
    : capability.scope.execution === "job"
      ? "anchorEpoch"
      : undefined;
  if (!epochKey) throw new TypeError("Authority capability execution kind is invalid");
  assertExactKeys(
    capability,
    [
      "assignmentId",
      "capId",
      "executorId",
      "expiry",
      "issuedAt",
      "methods",
      epochKey,
      "resources",
      "scope",
      "signature",
      "v",
    ],
    "Authority capability",
  );
  assertExactKeys(
    capability.scope,
    capability.scope.execution === "conversation"
      ? ["conversationId", "execution"]
      : ["execution", "taskId"],
    "Authority capability scope",
  );
  assertVersion(capability.v, "Authority capability");
  assertIdentifier(capability.capId, "Authority capability capId");
  assertIdentifier(capability.executorId, "Authority capability executorId");
  assertIdentifier(capability.assignmentId, "Authority capability assignmentId");
  if (capability.scope.execution === "conversation") {
    assertIdentifier(capability.scope.conversationId, "Authority capability conversationId");
    assertNonNegativeInteger(capability.ownerEpoch, "Authority capability ownerEpoch");
  } else {
    assertIdentifier(capability.scope.taskId, "Authority capability taskId");
    assertNonNegativeInteger(capability.anchorEpoch, "Authority capability anchorEpoch");
  }
  assertCanonicalInterval(capability.issuedAt, capability.expiry, "Authority capability");
  assertDenseUniqueArray(capability.methods, "Authority capability methods");
  for (const method of capability.methods) {
    if (!isAuthorityPortMethodId(method) || !principalAllowsAuthorityMethod("assignment", method)) {
      throw new TypeError("Authority capability contains a forbidden method");
    }
  }
  assertDenseUniqueArray(capability.resources, "Authority capability resources");
  for (const resource of capability.resources) validateResourceSelector(resource);
  assertSignature(capability.signature, "Authority capability signature");
  const { signature, ...payload } = capability;
  verifier.verify("AuthorityCapability", 1, payload, signature);
  return capability;
}

export function validatePermissionSnapshotLease(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): AnyPermissionSnapshotLease {
  const lease = clone(input, "Permission snapshot lease") as AnyPermissionSnapshotLease;
  assertObject(lease, "Permission snapshot lease");
  assertObject(lease.binding, "Permission snapshot lease binding");
  assertExactKeys(
    lease,
    [
      "assignmentId",
      "binding",
      "controlLeaseId",
      "executorId",
      "expiry",
      "issuedAt",
      "signature",
      "snapshotDigest",
      "snapshotVersion",
      "v",
    ],
    "Permission snapshot lease",
  );
  assertVersion(lease.v, "Permission snapshot lease");
  if (lease.binding.execution === "conversation") {
    assertExactKeys(
      lease.binding,
      ["conversationId", "execution", "ownerEpoch", "runId"],
      "Permission snapshot lease binding",
    );
    assertIdentifier(lease.binding.runId, "Permission snapshot lease runId");
    assertIdentifier(
      lease.binding.conversationId,
      "Permission snapshot lease conversationId",
    );
    assertNonNegativeInteger(
      lease.binding.ownerEpoch,
      "Permission snapshot lease ownerEpoch",
    );
  } else if (lease.binding.execution === "job") {
    assertExactKeys(
      lease.binding,
      ["anchorEpoch", "execution", "jobRunId", "taskId"],
      "Permission snapshot lease binding",
    );
    assertIdentifier(lease.binding.jobRunId, "Permission snapshot lease jobRunId");
    assertIdentifier(lease.binding.taskId, "Permission snapshot lease taskId");
    assertNonNegativeInteger(
      lease.binding.anchorEpoch,
      "Permission snapshot lease anchorEpoch",
    );
  } else {
    throw new TypeError("Permission snapshot lease execution kind is invalid");
  }
  assertIdentifier(lease.assignmentId, "Permission snapshot lease assignmentId");
  assertIdentifier(lease.executorId, "Permission snapshot lease executorId");
  assertIdentifier(lease.controlLeaseId, "Permission snapshot lease controlLeaseId");
  assertNonNegativeInteger(lease.snapshotVersion, "Permission snapshot lease version");
  assertDigest(lease.snapshotDigest, "Permission snapshot lease digest");
  assertCanonicalInterval(lease.issuedAt, lease.expiry, "Permission snapshot lease");
  const ttlMs =
    parseCanonicalTime(lease.expiry, "Permission snapshot lease expiry") -
    parseCanonicalTime(lease.issuedAt, "Permission snapshot lease issuedAt");
  if (ttlMs > MAX_PERMISSION_LEASE_TTL_MS) {
    throw new TypeError("Permission snapshot lease TTL exceeds the protocol limit");
  }
  assertSignature(lease.signature, "Permission snapshot lease signature");
  const { signature, ...payload } = lease;
  verifier.verify("PermissionSnapshotLease", 1, payload, signature);
  return lease;
}

export function validateControlLease(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ControlLease {
  const lease = clone(input, "Control lease") as ControlLease;
  assertObject(lease, "Control lease");
  assertObject(lease.authority, "Control lease authority");
  assertExactKeys(
    lease,
    [
      "assignmentId",
      "authority",
      "controlLeaseId",
      "expiry",
      "issuedAt",
      "renewalSeq",
      "signature",
      "v",
    ],
    "Control lease",
  );
  assertVersion(lease.v, "Control lease");
  assertAuthorityEpochRef(lease.authority, "Control lease authority");
  assertIdentifier(lease.controlLeaseId, "Control lease id");
  assertIdentifier(lease.assignmentId, "Control lease assignmentId");
  assertNonNegativeInteger(lease.renewalSeq, "Control lease renewal sequence");
  assertCanonicalInterval(lease.issuedAt, lease.expiry, "Control lease");
  const ttlMs =
    parseCanonicalTime(lease.expiry, "Control lease expiry") -
    parseCanonicalTime(lease.issuedAt, "Control lease issuedAt");
  if (ttlMs > MAX_CONTROL_LEASE_TTL_MS) {
    throw new TypeError("Control lease TTL exceeds the protocol limit");
  }
  assertSignature(lease.signature, "Control lease signature");
  const { signature, ...payload } = lease;
  verifier.verify("ControlLease", 1, payload, signature);
  return lease;
}

export function controlLeaseIdentityDigest(lease: ControlLease): string {
  const { signature: _, ...payload } = lease;
  return protocolDigest("ControlLease", 1, payload);
}

export function ownerControlRequestDigest(input: {
  readonly method: OwnerControlMethodId;
  readonly assignmentId: string;
  readonly authority: AuthorityEpochRef;
  readonly requestId: string;
  readonly body: unknown;
}): string {
  assertPrincipalAllowsAuthorityMethod("owner-control", input.method);
  assertIdentifier(input.assignmentId, "Owner control request assignmentId");
  assertIdentifier(input.requestId, "Owner control request requestId");
  assertAuthorityEpochRef(input.authority, "Owner control request authority");
  return protocolDigest("OwnerControlRequest", 1, {
    method: input.method,
    assignmentId: input.assignmentId,
    authority: input.authority,
    requestId: input.requestId,
    body: clone(input.body, "Owner control request body"),
  });
}

export type AcceptedRemoteIntervalStatus =
  | { readonly kind: "active"; readonly remainingMs: number }
  | { readonly kind: "expired" };

export function acceptedRemoteIntervalStatus(input: {
  readonly issuedAt: string;
  readonly expiry: string;
  readonly acceptedAt: string;
  readonly maxTtlMs: number;
}): AcceptedRemoteIntervalStatus {
  const issuedAt = parseCanonicalTime(input.issuedAt, "Remote interval issuedAt");
  const expiry = parseCanonicalTime(input.expiry, "Remote interval expiry");
  const acceptedAt = parseCanonicalTime(input.acceptedAt, "Remote interval acceptedAt");
  const ttlMs = expiry - issuedAt;
  if (
    !Number.isSafeInteger(input.maxTtlMs) ||
    input.maxTtlMs <= 0 ||
    ttlMs <= 0 ||
    ttlMs > input.maxTtlMs
  ) {
    throw new TypeError("Remote interval TTL is outside the protocol limit");
  }
  const skew = acceptedAt - issuedAt;
  if (skew < -MAX_CLOCK_SKEW_MS) {
    throw new TypeError("Remote interval is outside the accepted clock-skew window");
  }
  const elapsedMs = Math.max(0, skew - MAX_CLOCK_SKEW_MS);
  const remainingMs = ttlMs - elapsedMs;
  return remainingMs <= 0
    ? { kind: "expired" }
    : { kind: "active", remainingMs };
}

export function acceptedRemoteIntervalRemainingMs(input: {
  readonly issuedAt: string;
  readonly expiry: string;
  readonly acceptedAt: string;
  readonly maxTtlMs: number;
}): number {
  const status = acceptedRemoteIntervalStatus(input);
  if (status.kind === "expired") {
    throw new TypeError("Remote interval is outside the accepted clock-skew window");
  }
  return status.remainingMs;
}

export function validateOwnerControlGrant(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): OwnerControlGrant {
  const grant = clone(input, "Owner control grant") as OwnerControlGrant;
  assertObject(grant, "Owner control grant");
  assertObject(grant.scope, "Owner control grant scope");
  assertExactKeys(
    grant,
    [
      "assignmentId",
      "callerDeviceId",
      "controlLease",
      "expiry",
      "issuedAt",
      "methods",
      "requestId",
      "requestDigest",
      "scope",
      "signature",
      "v",
    ],
    "Owner control grant",
  );
  assertVersion(grant.v, "Owner control grant");
  if (grant.scope.execution === "conversation") {
    assertExactKeys(
      grant.scope,
      ["conversationId", "execution", "ownerEpoch"],
      "Owner control grant scope",
    );
    assertIdentifier(grant.scope.conversationId, "Owner control grant conversationId");
    assertNonNegativeInteger(grant.scope.ownerEpoch, "Owner control grant ownerEpoch");
  } else if (grant.scope.execution === "job") {
    assertExactKeys(
      grant.scope,
      ["anchorEpoch", "execution", "taskId"],
      "Owner control grant scope",
    );
    assertIdentifier(grant.scope.taskId, "Owner control grant taskId");
    assertNonNegativeInteger(grant.scope.anchorEpoch, "Owner control grant anchorEpoch");
  } else {
    throw new TypeError("Owner control grant execution kind is invalid");
  }
  assertIdentifier(grant.assignmentId, "Owner control grant assignmentId");
  assertIdentifier(grant.callerDeviceId, "Owner control grant callerDeviceId");
  assertIdentifier(grant.requestId, "Owner control grant requestId");
  assertDigest(grant.requestDigest, "Owner control grant request digest");
  assertDenseUniqueArray(grant.methods, "Owner control grant methods");
  for (const method of grant.methods) {
    if (!isAuthorityPortMethodId(method) || !principalAllowsAuthorityMethod("owner-control", method)) {
      throw new TypeError("Owner control grant contains a forbidden method");
    }
  }
  assertCanonicalInterval(grant.issuedAt, grant.expiry, "Owner control grant");
  const controlLease = validateControlLease(grant.controlLease, verifier);
  if (
    controlLease.assignmentId !== grant.assignmentId ||
    canonicalize(controlLease.authority) !== canonicalize(grant.scope) ||
    controlLease.signature.keyId !== grant.callerDeviceId ||
    parseCanonicalTime(grant.issuedAt, "Owner control grant issuedAt") <
      parseCanonicalTime(controlLease.issuedAt, "Control lease issuedAt") ||
    parseCanonicalTime(grant.expiry, "Owner control grant expiry") >
      parseCanonicalTime(controlLease.expiry, "Control lease expiry")
  ) {
    throw new TypeError("Owner control grant does not bind its control lease");
  }
  assertSignature(grant.signature, "Owner control grant signature");
  if (grant.signature.keyId !== grant.callerDeviceId) {
    throw new TypeError("Owner control grant signer does not match its caller device");
  }
  const { signature, ...payload } = grant;
  verifier.verify("OwnerControlGrant", 1, payload, signature);
  return grant;
}

export function assertAuthorizedOwnerControlGrant(input: {
  readonly grant: OwnerControlGrant;
  readonly verifier: ProtocolSignatureVerifier;
  readonly method: OwnerControlMethodId;
  readonly assignmentId: string;
  readonly callerDeviceId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly authenticatedCallerDeviceId: string;
  readonly expectedOwnerDeviceId?: string;
  readonly now: string;
  readonly deadlineAt: string;
  readonly authority?:
    | {
        readonly execution: "conversation";
        readonly conversationId: string;
        readonly ownerEpoch: number;
      }
    | {
        readonly execution: "job";
        readonly taskId: string;
        readonly anchorEpoch: number;
      };
}): OwnerControlGrant {
  const grant = validateOwnerControlGrant(input.grant, input.verifier);
  assertPrincipalAllowsAuthorityMethod("owner-control", input.method);
  const issuedAt = parseCanonicalTime(grant.issuedAt, "Owner control grant issuedAt");
  const expiry = parseCanonicalTime(grant.expiry, "Owner control grant expiry");
  const deadline = parseCanonicalTime(input.deadlineAt, "Owner control deadline");
  const grantRemainingMs = acceptedRemoteIntervalRemainingMs({
    issuedAt: grant.issuedAt,
    expiry: grant.expiry,
    acceptedAt: input.now,
    maxTtlMs: MAX_CONTROL_LEASE_TTL_MS,
  });
  const deadlineOffset = deadline - issuedAt;
  const grantTtlMs = expiry - issuedAt;
  if (
    grant.assignmentId !== input.assignmentId ||
    grant.callerDeviceId !== input.callerDeviceId ||
    grant.requestId !== input.requestId ||
    grant.requestDigest !== input.requestDigest ||
    grant.signature.keyId !== grant.callerDeviceId ||
    grant.callerDeviceId !== input.authenticatedCallerDeviceId ||
    (input.expectedOwnerDeviceId !== undefined &&
      grant.callerDeviceId !== input.expectedOwnerDeviceId) ||
    !grant.methods.includes(input.method) ||
    deadlineOffset < 0 ||
    deadlineOffset > grantTtlMs ||
    grantRemainingMs <= 0 ||
    (input.authority !== undefined &&
      canonicalize(grant.scope) !== canonicalize(input.authority))
  ) {
    throw new TypeError("Owner control grant does not authorize this executor call");
  }
  return grant;
}

export type AssignmentCapabilityUseMode =
  | "active"
  | "settlement"
  | "durable-replay"
  | "durable-rejection";

export function assertActivatedAssignmentCapability(input: {
  readonly capability: AuthorityCapability;
  readonly activation:
    | {
        readonly capIds: ReadonlySet<string> | readonly string[];
        readonly assignmentId: string;
        readonly executorId: string;
        readonly authority:
          | {
              readonly execution: "conversation";
              readonly conversationId: string;
              readonly ownerEpoch: number;
            }
          | {
              readonly execution: "job";
              readonly taskId: string;
              readonly anchorEpoch: number;
            };
      }
    | undefined;
  readonly verifier: ProtocolSignatureVerifier;
  readonly method: AssignmentMethodId;
  readonly resource: ResourceSelector;
  readonly mode: AssignmentCapabilityUseMode;
  readonly revoked: boolean;
  readonly now: string;
  readonly deadlineAt: string;
}): void {
  const capability = validateAuthorityCapability(input.capability, input.verifier);
  assertPrincipalAllowsAuthorityMethod("assignment", input.method);
  const activation = input.activation;
  const activatedCapIds = activation?.capIds instanceof Set
    ? activation.capIds
    : new Set(activation?.capIds ?? []);
  const authorityMatches = activation?.authority.execution === "conversation"
    ? capability.scope.execution === "conversation" &&
      "ownerEpoch" in capability &&
      capability.scope.conversationId === activation.authority.conversationId &&
      capability.ownerEpoch === activation.authority.ownerEpoch
    : activation?.authority.execution === "job"
      ? capability.scope.execution === "job" &&
        "anchorEpoch" in capability &&
        capability.scope.taskId === activation.authority.taskId &&
        capability.anchorEpoch === activation.authority.anchorEpoch
      : false;
  if (
    activation === undefined ||
    !activatedCapIds.has(capability.capId) ||
    activation.assignmentId !== capability.assignmentId ||
    activation.executorId !== capability.executorId ||
    !authorityMatches
  ) {
    throw new TypeError("Assignment capability is not activated by durable authority state");
  }
  if (!capability.methods.includes(input.method)) {
    throw new TypeError("Assignment capability does not authorize this method");
  }
  if (!capability.resources.includes(input.resource)) {
    throw new TypeError("Assignment capability does not authorize this resource");
  }
  if (parseCanonicalTime(input.deadlineAt, "Authority call deadline") > parseCanonicalTime(capability.expiry, "Authority capability expiry")) {
    throw new TypeError("Authority call deadline exceeds capability expiry");
  }
  if (
    input.mode === "active" &&
    (input.revoked ||
      parseCanonicalTime(input.now, "Authority clock") <
        parseCanonicalTime(capability.issuedAt, "Authority capability issuedAt") ||
      parseCanonicalTime(input.now, "Authority clock") >=
        parseCanonicalTime(capability.expiry, "Authority capability expiry") ||
      parseCanonicalTime(input.deadlineAt, "Authority call deadline") <
        parseCanonicalTime(input.now, "Authority clock"))
  ) {
    throw new TypeError("Assignment capability is expired or revoked");
  }
}

export function permissionSnapshotLeaseIdentityDigest(
  lease: AnyPermissionSnapshotLease,
): string {
  const { signature: _, ...payload } = lease;
  return protocolDigest("PermissionSnapshotLease", 1, payload);
}

export function assertActivePermissionSnapshotLease(input: {
  readonly lease: AnyPermissionSnapshotLease;
  readonly verifier: ProtocolSignatureVerifier;
  readonly activationDigest: string | undefined;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly active: boolean;
  readonly now: string;
  readonly timeValid?: boolean;
}): AnyPermissionSnapshotLease {
  const lease = validatePermissionSnapshotLease(input.lease, input.verifier);
  if (
    !input.active ||
    input.activationDigest === undefined ||
    permissionSnapshotLeaseIdentityDigest(lease) !== input.activationDigest ||
    lease.assignmentId !== input.assignmentId ||
    lease.executorId !== input.executorId ||
    (input.timeValid === undefined
      ? parseCanonicalTime(input.now, "Permission guard clock") <
          parseCanonicalTime(lease.issuedAt, "Permission snapshot lease issuedAt") ||
        parseCanonicalTime(input.now, "Permission guard clock") >=
          parseCanonicalTime(lease.expiry, "Permission snapshot lease expiry")
      : !input.timeValid)
  ) {
    throw new TypeError("Permission snapshot lease is inactive, expired, or misbound");
  }
  return lease;
}

function validateResourceSelector(value: unknown): asserts value is ResourceSelector {
  assertIdentifier(value, "Authority capability resource");
  if (!/^(conversation|task|asset|memory-domain):[^*]+$/u.test(value)) {
    throw new TypeError("Authority capability resource selector is invalid");
  }
}

function clone(value: unknown, label: string): unknown {
  try {
    return JSON.parse(canonicalize(value));
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}

function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  assertProtocolIdentifier(value, label);
}

function assertAuthorityEpochRef(
  value: AuthorityEpochRef,
  label: string,
): void {
  assertObject(value, label);
  if (value.execution === "conversation") {
    assertExactKeys(
      value,
      ["conversationId", "execution", "ownerEpoch"],
      label,
    );
    assertIdentifier(value.conversationId, `${label} conversationId`);
    assertNonNegativeInteger(value.ownerEpoch, `${label} ownerEpoch`);
    return;
  }
  if (value.execution === "job") {
    assertExactKeys(value, ["anchorEpoch", "execution", "taskId"], label);
    assertIdentifier(value.taskId, `${label} taskId`);
    assertNonNegativeInteger(value.anchorEpoch, `${label} anchorEpoch`);
    return;
  }
  throw new TypeError(`${label} execution kind is invalid`);
}

function assertVersion(value: unknown, label: string): asserts value is 1 {
  if (value !== 1) throw new TypeError(`${label} version must be 1`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertDenseUniqueArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be a dense string array`);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertSignature(
  value: unknown,
  label: string,
): asserts value is { alg: string; keyId: string; sig: string } {
  assertObject(value, label);
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertIdentifier(value.alg, `${label} algorithm`);
  assertIdentifier(value.keyId, `${label} keyId`);
  assertIdentifier(value.sig, `${label} bytes`);
}

function parseCanonicalTime(value: unknown, label: string): number {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertCanonicalInterval(issuedAt: unknown, expiry: unknown, label: string): void {
  const issued = parseCanonicalTime(issuedAt, `${label} issuedAt`);
  const expires = parseCanonicalTime(expiry, `${label} expiry`);
  if (expires <= issued) throw new TypeError(`${label} expiry must follow issuedAt`);
}
