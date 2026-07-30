import type {
  Digest,
  EnvironmentControlGrant,
  ExplicitEnvironmentSelection,
  ImmediateRootResourceLease,
  Signature,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import { validateReservableResourceLease } from "./resource-governor.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";
import { assertProtocolIdentifier } from "./validation.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type UnsignedEnvironmentControlGrant = Omit<
  EnvironmentControlGrant,
  "signature"
>;

export type UnsignedWorkspaceProbeResult = Omit<
  WorkspaceProbeResult,
  "signature"
>;

export function validateExplicitEnvironmentSelection(
  input: unknown,
): ExplicitEnvironmentSelection {
  const value = clone(input, "Explicit environment selection");
  assertPlainObject(value, "Explicit environment selection");
  assertExactKeys(
    value,
    ["workspace"],
    "Explicit environment selection",
  );
  assertPlainObject(value.workspace, "Explicit workspace selection");
  assertExactKeys(
    value.workspace,
    ["bindingRef", "deviceId"],
    "Explicit workspace selection",
  );
  assertProtocolIdentifier(
    value.workspace.deviceId,
    "Explicit environment deviceId",
  );
  assertProtocolIdentifier(
    value.workspace.bindingRef,
    "Explicit environment bindingRef",
  );
  return value as unknown as ExplicitEnvironmentSelection;
}

export function environmentControlSubject(
  deviceId: string,
  bindingRef: string,
  requestId: string,
): string {
  assertProtocolIdentifier(deviceId, "Environment deviceId");
  assertProtocolIdentifier(bindingRef, "Environment bindingRef");
  assertProtocolIdentifier(requestId, "Environment requestId");
  return `environment:${deviceId}:${bindingRef}:${requestId}`;
}

export function createSignedEnvironmentControlGrant(
  input: UnsignedEnvironmentControlGrant,
  signer: ProtocolSigner,
): EnvironmentControlGrant {
  const payload = validateUnsignedEnvironmentControlGrant(input);
  return {
    ...payload,
    signature: signer.sign("EnvironmentControlGrant", 1, payload),
  };
}

export function validateEnvironmentControlGrant(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): EnvironmentControlGrant {
  const value = clone(input, "Environment control grant");
  assertPlainObject(value, "Environment control grant");
  assertSignature(value.signature, "Environment control grant signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedEnvironmentControlGrant(
    unsigned as UnsignedEnvironmentControlGrant,
  );
  verifier.verify("EnvironmentControlGrant", 1, payload, signature);
  return value as unknown as EnvironmentControlGrant;
}

export function environmentControlGrantDigest(
  grant: EnvironmentControlGrant,
): Digest {
  const { signature: _, ...payload } = grant;
  return protocolDigest("EnvironmentControlGrant", 1, payload) as Digest;
}

export function validateWorkspaceProbeRequest(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
  options: { readonly requireActiveAt?: boolean } = {},
): WorkspaceProbeRequest {
  const value = clone(input, "Workspace probe request");
  assertPlainObject(value, "Workspace probe request");
  assertExactKeys(
    value,
    [
      "at",
      "bindingRef",
      "deviceId",
      "grant",
      "requestId",
      "resourceLease",
      "v",
    ],
    "Workspace probe request",
  );
  if (value.v !== 1) {
    throw new TypeError("Workspace probe request version must be 1");
  }
  assertProtocolIdentifier(value.requestId, "Workspace probe requestId");
  assertProtocolIdentifier(value.deviceId, "Workspace probe deviceId");
  assertProtocolIdentifier(value.bindingRef, "Workspace probe bindingRef");
  const at = parseCanonicalTime(value.at, "Workspace probe time");
  const grant = validateEnvironmentControlGrant(value.grant, verifier);
  const lease = validateReservableResourceLease(
    value.resourceLease,
    verifier,
  ) as ImmediateRootResourceLease;
  if (
    lease.parentId !== undefined ||
    lease.workload.kind !== "control" ||
    lease.workload.id !== value.requestId ||
    lease.admissionClass !== "interactive" ||
    lease.scopeBinding.kind !== "control" ||
    lease.scopeBinding.subject !== value.requestId
  ) {
    throw new TypeError(
      "Workspace probe resource lease does not bind the environment control request",
    );
  }
  if (
    grant.requestId !== value.requestId ||
    grant.deviceId !== value.deviceId ||
    grant.bindingRef !== value.bindingRef ||
    grant.resourceLeaseDigest !== lease.digest
  ) {
    throw new TypeError(
      "Environment control grant does not bind the workspace probe request",
    );
  }
  const issuedAt = parseCanonicalTime(
    grant.issuedAt,
    "Environment control grant issuedAt",
  );
  const expiry = parseCanonicalTime(
    grant.expiry,
    "Environment control grant expiry",
  );
  if (
    options.requireActiveAt !== false &&
    (at < issuedAt || at >= expiry)
  ) {
    throw new TypeError(
      "Environment control grant is not active at the requested time",
    );
  }
  if (
    options.requireActiveAt !== false &&
    (at < parseCanonicalTime(lease.issuedAt, "Resource lease issuedAt") ||
      at >= parseCanonicalTime(lease.expiry, "Resource lease expiry"))
  ) {
    throw new TypeError(
      "Environment control resource lease is not active at the requested time",
    );
  }
  return value as unknown as WorkspaceProbeRequest;
}

export function workspaceProbeRequestDigest(
  request: WorkspaceProbeRequest,
): Digest {
  return protocolDigest("WorkspaceProbeRequest", 1, request) as Digest;
}

export function createSignedWorkspaceProbeResult(
  input: UnsignedWorkspaceProbeResult,
  signer: ProtocolSigner,
): WorkspaceProbeResult {
  const payload = validateUnsignedWorkspaceProbeResult(input);
  return {
    ...payload,
    signature: signer.sign("WorkspaceProbeResult", 1, payload),
  };
}

export function validateWorkspaceProbeResult(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): WorkspaceProbeResult {
  const value = clone(input, "Workspace probe result");
  assertPlainObject(value, "Workspace probe result");
  assertSignature(value.signature, "Workspace probe result signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedWorkspaceProbeResult(
    unsigned as UnsignedWorkspaceProbeResult,
  );
  verifier.verify("WorkspaceProbeResult", 1, payload, signature);
  return value as unknown as WorkspaceProbeResult;
}

function validateUnsignedEnvironmentControlGrant(
  input: UnsignedEnvironmentControlGrant,
): UnsignedEnvironmentControlGrant {
  const value = clone(input, "Unsigned environment control grant");
  assertPlainObject(value, "Unsigned environment control grant");
  assertExactKeys(
    value,
    [
      "bindingRef",
      "deviceId",
      "expiry",
      "grantId",
      "issuedAt",
      "methods",
      "requestId",
      "resourceLeaseDigest",
      "v",
    ],
    "Unsigned environment control grant",
  );
  if (value.v !== 1) {
    throw new TypeError("Environment control grant version must be 1");
  }
  assertProtocolIdentifier(value.grantId, "Environment control grantId");
  assertProtocolIdentifier(value.deviceId, "Environment control deviceId");
  assertProtocolIdentifier(value.bindingRef, "Environment control bindingRef");
  assertProtocolIdentifier(value.requestId, "Environment control requestId");
  if (
    !Array.isArray(value.methods) ||
    value.methods.length !== 1 ||
    value.methods[0] !== "environment.probe"
  ) {
    throw new TypeError(
      "Environment control grant methods must contain only environment.probe",
    );
  }
  assertDigest(
    value.resourceLeaseDigest,
    "Environment control resource lease digest",
  );
  const issuedAt = parseCanonicalTime(
    value.issuedAt,
    "Environment control grant issuedAt",
  );
  const expiry = parseCanonicalTime(
    value.expiry,
    "Environment control grant expiry",
  );
  if (expiry <= issuedAt) {
    throw new TypeError(
      "Environment control grant expiry must follow issuedAt",
    );
  }
  return value as unknown as UnsignedEnvironmentControlGrant;
}

function validateUnsignedWorkspaceProbeResult(
  input: UnsignedWorkspaceProbeResult,
): UnsignedWorkspaceProbeResult {
  const value = clone(input, "Unsigned workspace probe result");
  assertPlainObject(value, "Unsigned workspace probe result");
  assertExactKeys(
    value,
    [
      "bindingRef",
      "executorId",
      "probe",
      "requestId",
      "v",
      "workspaceBindingRevision",
    ],
    "Unsigned workspace probe result",
  );
  if (value.v !== 1) {
    throw new TypeError("Workspace probe result version must be 1");
  }
  assertProtocolIdentifier(value.requestId, "Workspace probe result requestId");
  assertProtocolIdentifier(
    value.bindingRef,
    "Workspace probe result bindingRef",
  );
  assertProtocolIdentifier(value.executorId, "Workspace probe executorId");
  if (
    !Number.isSafeInteger(value.workspaceBindingRevision) ||
    (value.workspaceBindingRevision as number) <= 0
  ) {
    throw new TypeError(
      "Workspace probe binding revision must be a positive safe integer",
    );
  }
  if (
    value.probe !== "directory" &&
    value.probe !== "missing" &&
    value.probe !== "non_directory" &&
    value.probe !== "inaccessible" &&
    value.probe !== "error"
  ) {
    throw new TypeError("Workspace probe result state is invalid");
  }
  return value as unknown as UnsignedWorkspaceProbeResult;
}

function clone(input: unknown, label: string): Record<string, unknown> {
  try {
    return JSON.parse(canonicalize(input)) as Record<string, unknown>;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON data`, {
      cause: error,
    });
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
      canonicalize([...keys].sort())
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertSignature(
  value: unknown,
  label: string,
): asserts value is Signature {
  assertPlainObject(value, label);
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertProtocolIdentifier(value.alg, `${label} algorithm`);
  assertProtocolIdentifier(value.keyId, `${label} keyId`);
  assertProtocolIdentifier(value.sig, `${label} bytes`);
}

function parseCanonicalTime(value: unknown, label: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return time;
}
