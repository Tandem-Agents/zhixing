import type {
  DeviceIdentity,
  DeviceRole,
  HomeTrustEvent,
  HomeTrustEventBody,
  HomeTrustEventWithBody,
  HomeTrustRecord,
  RecoveryActivationPlan,
  Signature,
} from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "./canonical.js";
import { deviceIdFromPublicKey, verifyDeviceSignature } from "./device-identity.js";
import {
  keyIdForPublicKey,
  importEncodedPublicKey,
  RecoveryRoot,
  verifyRecoverySignature,
} from "./recovery-root.js";

export interface TrustProjection {
  readonly homeId: string;
  readonly trustEpoch: number;
  readonly chainHead: { readonly seq: number; readonly eventDigest: string };
  readonly issuer: {
    readonly deviceId: string;
    readonly issuerKeyId: string;
    readonly issuerPublicKey?: string;
  };
  readonly recoveryRootPublicKey?: string;
  readonly recoveryBackupPublicKey?: string;
  readonly recoveryActivationDigest?: string;
  readonly pendingResetEvent?: HomeTrustEventWithBody<
    Extract<HomeTrustEventBody, { t: "domain-reset" }>
  >;
  readonly members: readonly {
    readonly device: DeviceIdentity;
    readonly roles: readonly DeviceRole[];
    readonly state: "active" | "revoked" | "pending-reenroll";
  }[];
}

export interface TrustSigner {
  sign(schemaId: string, version: number, payload: unknown): Signature;
}

export interface DeviceTrustSigner extends TrustSigner {
  readonly deviceId: string;
}

export function createTrustGenesisEvent(input: {
  homeId: string;
  issuer: DeviceIdentity;
  signer: DeviceTrustSigner;
  at: string;
}): HomeTrustEventWithBody<Extract<HomeTrustEventBody, { t: "genesis" }>> {
  if (input.homeId.length === 0 || input.signer.deviceId !== input.issuer.deviceId) {
    throw new TypeError("Trust genesis requires its issuer's signer");
  }
  assertDeviceIdentity(input.issuer);
  assertCanonicalTime(input.at, "Trust genesis time");
  const unsigned = {
    v: 1 as const,
    homeId: input.homeId,
    seq: 0,
    prevEventDigest: protocolDigest("HomeTrustChainSeed", 1, { homeId: input.homeId }),
    trustEpoch: 1,
    body: { t: "genesis" as const, issuer: input.issuer },
    at: input.at,
  };
  return { ...unsigned, signature: input.signer.sign("HomeTrustEvent", 1, unsigned) };
}

export function initializeTrustChain(genesis: HomeTrustEvent): TrustProjection {
  if (
    genesis.v !== 1 ||
    genesis.body.t !== "genesis" ||
    genesis.seq !== 0 ||
    genesis.trustEpoch !== 1 ||
    genesis.prevEventDigest !== protocolDigest("HomeTrustChainSeed", 1, { homeId: genesis.homeId })
  ) {
    throw new TypeError("Trust chain must begin with a canonical genesis event");
  }
  assertCanonicalTime(genesis.at, "Trust genesis time");
  assertDeviceIdentity(genesis.body.issuer);
  const { signature, ...unsigned } = genesis;
  verifyDeviceSignature(genesis.body.issuer, "HomeTrustEvent", 1, unsigned, signature);
  return freezeProjection({
    homeId: genesis.homeId,
    trustEpoch: 1,
    chainHead: { seq: 0, eventDigest: homeTrustEventDigest(genesis) },
    issuer: {
      deviceId: genesis.body.issuer.deviceId,
      issuerKeyId: genesis.body.issuer.deviceId,
    },
    members: [{ device: genesis.body.issuer, roles: ["anchor"], state: "active" }],
  });
}

export function replayTrustChain(events: readonly HomeTrustEvent[]): TrustProjection {
  const [genesis, ...rest] = events;
  if (!genesis) throw new TypeError("Trust chain is empty");
  let projection = initializeTrustChain(genesis);
  for (const event of rest) projection = applyTrustEvent(projection, event);
  return projection;
}

export function applyTrustEvent(
  current: TrustProjection,
  event: HomeTrustEvent,
): TrustProjection {
  assertEventPosition(current, event);
  if (
    current.pendingResetEvent &&
    !(event.body.t === "recovery-root" && event.body.op === "establish")
  ) {
    throw new TypeError("Domain reset must be followed atomically by recovery-root establish");
  }
  verifyOuterSignature(current, event);
  const members = current.members.map((member) => ({
    device: member.device,
    roles: [...member.roles],
    state: member.state,
  }));
  let trustEpoch = current.trustEpoch;
  let issuer = { ...current.issuer };
  let recoveryRootPublicKey = current.recoveryRootPublicKey;
  let recoveryBackupPublicKey = current.recoveryBackupPublicKey;
  let recoveryActivationDigest = current.recoveryActivationDigest;
  let pendingResetEvent = current.pendingResetEvent;

  switch (event.body.t) {
    case "genesis":
      throw new TypeError("Trust genesis may only appear at the beginning of a chain");
    case "enroll": {
      assertCurrentEpoch(current, event);
      const body = event.body;
      assertDeviceIdentity(body.device);
      if (members.some((member) => member.device.deviceId === body.device.deviceId)) {
        throw new TypeError("Enrolled device already exists in the trust chain");
      }
      assertRoles(body.roles);
      members.push({ device: body.device, roles: [...body.roles], state: "active" });
      break;
    }
    case "reenroll": {
      assertCurrentEpoch(current, event);
      const member = requiredMember(members, event.body.deviceId);
      if (member.state !== "pending-reenroll") {
        throw new TypeError("Only pending devices can be re-enrolled");
      }
      member.state = "active";
      break;
    }
    case "role-change": {
      assertCurrentEpoch(current, event);
      assertRoles(event.body.roles);
      const member = requiredActiveMember(members, event.body.deviceId);
      if (
        event.body.deviceId === current.issuer.deviceId &&
        !event.body.roles.includes("anchor")
      ) {
        throw new TypeError("The current issuer must retain the anchor role");
      }
      member.roles = [...event.body.roles];
      break;
    }
    case "revoke": {
      assertCurrentEpoch(current, event);
      if (event.body.deviceId === current.issuer.deviceId) {
        throw new TypeError("Issuer must transition before its device can be revoked");
      }
      const member = requiredMember(members, event.body.deviceId);
      if (member.state === "revoked") throw new TypeError("Device is already revoked");
      member.state = "revoked";
      break;
    }
    case "recovery-root": {
      if (event.body.op === "establish") {
        if (event.body.signedBy !== "issuer") {
          throw new TypeError("Recovery root establishment must be issuer-signed");
        }
        assertCurrentEpoch(current, event);
        if (recoveryRootPublicKey) throw new TypeError("Recovery root already exists");
        assertRecoveryKeyPair(event.body.rootPublicKey, event.body.backupPublicKey);
        verifyRecoverySignature(
          event.body.rootPublicKey,
          "HomeTrustRootProof",
          1,
          rootProofPayload(event),
          event.body.rootProof,
        );
        recoveryRootPublicKey = event.body.rootPublicKey;
        recoveryBackupPublicKey = event.body.backupPublicKey;
        const rootEvent = { ...event, body: event.body };
        const activationPlan: RecoveryActivationPlan = pendingResetEvent
          ? {
              v: 1,
              kind: "domain-reset-establish",
              resetEvent: pendingResetEvent,
              rootEvent,
            }
          : { v: 1, kind: "establish", rootEvent };
        recoveryActivationDigest = protocolDigest(
          "RecoveryActivationPlan",
          1,
          activationPlan,
        );
        pendingResetEvent = undefined;
      } else if (event.body.op === "rotate") {
        if (event.body.signedBy !== "recovery-root") {
          throw new TypeError("Recovery root rotation must be recovery-root-signed");
        }
        assertCurrentEpoch(current, event);
        if (!recoveryRootPublicKey) throw new TypeError("Recovery root does not exist");
        assertRecoveryKeyPair(event.body.rootPublicKey, event.body.backupPublicKey);
        verifyRecoverySignature(
          event.body.rootPublicKey,
          "HomeTrustRootProof",
          1,
          rootProofPayload(event),
          event.body.rootProof,
        );
        recoveryRootPublicKey = event.body.rootPublicKey;
        recoveryBackupPublicKey = event.body.backupPublicKey;
        const rootEvent = { ...event, body: event.body };
        recoveryActivationDigest = protocolDigest("RecoveryActivationPlan", 1, {
          v: 1,
          kind: "rotate",
          rootEvent,
        });
      } else if (event.body.op === "invalidate") {
        if (event.body.signedBy !== "recovery-root") {
          throw new TypeError("Recovery root invalidation must be recovery-root-signed");
        }
        assertCurrentEpoch(current, event);
        if (!recoveryRootPublicKey) throw new TypeError("Recovery root does not exist");
        recoveryRootPublicKey = undefined;
        recoveryBackupPublicKey = undefined;
        recoveryActivationDigest = undefined;
      } else {
        throw new TypeError("Recovery root operation is unsupported");
      }
      break;
    }
    case "domain-reset": {
      assertCurrentEpoch(current, event);
      if (event.body.reason !== "recovery-root-lost") {
        throw new TypeError("Domain reset reason is unsupported");
      }
      if (!current.recoveryRootPublicKey) {
        throw new TypeError("Domain reset requires an active recovery root");
      }
      if (event.body.nextTrustEpoch !== current.trustEpoch + 1) {
        throw new TypeError("Domain reset must increment trust epoch by one");
      }
      if (event.body.coSign.deviceId === current.issuer.deviceId) {
        throw new TypeError("Domain reset requires a distinct active co-signer");
      }
      const coSigner = requiredActiveMember(members, event.body.coSign.deviceId);
      verifyDeviceSignature(
        coSigner.device,
        "HomeTrustDomainResetCoSign",
        1,
        domainResetCoSignPayload(event),
        event.body.coSign.sig,
      );
      trustEpoch = event.body.nextTrustEpoch;
      recoveryRootPublicKey = undefined;
      recoveryBackupPublicKey = undefined;
      recoveryActivationDigest = undefined;
      pendingResetEvent = { ...event, body: event.body };
      for (const member of members) {
        if (member.device.deviceId !== current.issuer.deviceId && member.state === "active") {
          member.state = "pending-reenroll";
        }
      }
      break;
    }
    case "issuer-transition": {
      assertCurrentEpoch(current, event);
      assertIssuerTransitionAuthority(event.body);
      if (
        event.body.nextTrustEpoch !== current.trustEpoch + 1 ||
        event.body.fromIssuerKeyId !== current.issuer.issuerKeyId
      ) {
        throw new TypeError("Issuer transition does not follow the current trust epoch");
      }
      const target = requiredActiveMember(members, event.body.toDeviceId);
      const issuerPublicKey = event.body.toIssuerPublicKey;
      const issuerKeyMatches = issuerPublicKey
        ? deviceIdFromPublicKey(issuerPublicKey) === event.body.toIssuerKeyId
        : event.body.toIssuerKeyId === target.device.deviceId;
      if (
        !issuerKeyMatches ||
        event.body.toDeviceId === current.issuer.deviceId ||
        !target.roles.includes("anchor")
      ) {
        throw new TypeError("Issuer transition target is invalid");
      }
      trustEpoch = event.body.nextTrustEpoch;
      issuer = {
        deviceId: target.device.deviceId,
        issuerKeyId: event.body.toIssuerKeyId,
        ...(issuerPublicKey ? { issuerPublicKey } : {}),
      };
      break;
    }
    default:
      throw new TypeError("Trust event type is unsupported");
  }

  return freezeProjection({
    homeId: current.homeId,
    trustEpoch,
    chainHead: { seq: event.seq, eventDigest: homeTrustEventDigest(event) },
    issuer,
    ...(recoveryRootPublicKey ? { recoveryRootPublicKey } : {}),
    ...(recoveryBackupPublicKey ? { recoveryBackupPublicKey } : {}),
    ...(recoveryActivationDigest ? { recoveryActivationDigest } : {}),
    ...(pendingResetEvent ? { pendingResetEvent } : {}),
    members,
  });
}

export function createSignedTrustEvent<Body extends HomeTrustEventBody>(input: {
  current: TrustProjection;
  body: Body;
  at: string;
  signer: TrustSigner;
  trustEpoch?: number;
}): HomeTrustEventWithBody<Body> {
  const unsigned = {
    v: 1 as const,
    homeId: input.current.homeId,
    seq: input.current.chainHead.seq + 1,
    prevEventDigest: input.current.chainHead.eventDigest,
    trustEpoch: input.trustEpoch ?? input.current.trustEpoch,
    body: input.body,
    at: input.at,
  };
  return { ...unsigned, signature: input.signer.sign("HomeTrustEvent", 1, unsigned) };
}

export function createRecoveryRootEvent<Op extends "establish" | "rotate">(input: {
  current: TrustProjection;
  op: Op;
  candidate: RecoveryRoot;
  outerSigner: TrustSigner;
  at: string;
}): HomeTrustEventWithBody<
  Extract<HomeTrustEventBody, { t: "recovery-root"; op: Op }>
> {
  const identity = input.candidate.publicIdentity();
  const eventBase = {
    v: 1 as const,
    homeId: input.current.homeId,
    seq: input.current.chainHead.seq + 1,
    prevEventDigest: input.current.chainHead.eventDigest,
    trustEpoch: input.current.trustEpoch,
    at: input.at,
  };
  const bodyWithoutProof =
    input.op === "establish"
      ? {
          t: "recovery-root" as const,
          op: "establish" as const,
          rootPublicKey: identity.rootPublicKey,
          backupPublicKey: identity.backupPublicKey,
          signedBy: "issuer" as const,
        }
      : {
          t: "recovery-root" as const,
          op: "rotate" as const,
          rootPublicKey: identity.rootPublicKey,
          backupPublicKey: identity.backupPublicKey,
          signedBy: "recovery-root" as const,
        };
  const rootProof = input.candidate.sign("HomeTrustRootProof", 1, {
    ...eventBase,
    body: bodyWithoutProof,
  });
  return createSignedTrustEvent({
    current: input.current,
    at: input.at,
    signer: input.outerSigner,
    body: { ...bodyWithoutProof, rootProof },
  }) as HomeTrustEventWithBody<
    Extract<HomeTrustEventBody, { t: "recovery-root"; op: Op }>
  >;
}

export function createDomainResetEvent(input: {
  current: TrustProjection;
  issuer: DeviceTrustSigner;
  coSigner: DeviceTrustSigner;
  at: string;
}): HomeTrustEventWithBody<Extract<HomeTrustEventBody, { t: "domain-reset" }>> {
  if (input.coSigner.deviceId === input.issuer.deviceId) {
    throw new TypeError("Domain reset requires another active device");
  }
  const eventBase = {
    v: 1 as const,
    homeId: input.current.homeId,
    seq: input.current.chainHead.seq + 1,
    prevEventDigest: input.current.chainHead.eventDigest,
    trustEpoch: input.current.trustEpoch,
    at: input.at,
  };
  const bodyWithoutCoSign = {
    t: "domain-reset" as const,
    nextTrustEpoch: input.current.trustEpoch + 1,
    reason: "recovery-root-lost" as const,
  };
  const coSign = {
    deviceId: input.coSigner.deviceId,
    sig: input.coSigner.sign("HomeTrustDomainResetCoSign", 1, {
      ...eventBase,
      body: bodyWithoutCoSign,
    }),
  };
  return createSignedTrustEvent({
    current: input.current,
    at: input.at,
    signer: input.issuer,
    body: { ...bodyWithoutCoSign, coSign },
  });
}

export function buildHomeTrustRecord(
  projection: TrustProjection,
  signer: DeviceTrustSigner,
): HomeTrustRecord {
  if (signer.deviceId !== projection.issuer.issuerKeyId) {
    throw new TypeError("Only the current issuer can sign a trust projection");
  }
  const unsigned = {
    v: 1 as const,
    homeId: projection.homeId,
    trustEpoch: projection.trustEpoch,
    chainHead: { ...projection.chainHead },
    issuer: { ...projection.issuer },
    ...(projection.recoveryRootPublicKey
      ? { recoveryRootPublicKey: projection.recoveryRootPublicKey }
      : {}),
    ...(projection.recoveryBackupPublicKey
      ? { recoveryBackupPublicKey: projection.recoveryBackupPublicKey }
      : {}),
    members: projection.members.map((member) => ({
      device: member.device,
      roles: [...member.roles],
      state: member.state,
    })),
  };
  return { ...unsigned, signature: signer.sign("HomeTrustRecord", 1, unsigned) };
}

export function verifyHomeTrustRecord(
  record: HomeTrustRecord,
  projection: TrustProjection,
): void {
  const issuer = issuerSigningIdentity(projection);
  const { signature, ...unsigned } = record;
  verifyDeviceSignature(issuer, "HomeTrustRecord", 1, unsigned, signature);
  const expected = buildComparableProjection(projection);
  if (canonicalize(unsigned) !== canonicalize(expected)) {
    throw new TypeError("Trust record does not match its event-chain projection");
  }
}

export function rootProofPayload(event: HomeTrustEvent): unknown {
  if (event.body.t !== "recovery-root" || event.body.op === "invalidate") {
    throw new TypeError("Trust event does not carry a root proof");
  }
  const { rootProof: _rootProof, ...body } = event.body;
  const { signature: _signature, body: _body, ...eventBase } = event;
  return { ...eventBase, body };
}

export function homeTrustEventDigest(event: HomeTrustEvent): string {
  const { signature: _signature, ...unsigned } = event;
  return protocolDigest("HomeTrustEvent", 1, unsigned);
}

export function domainResetCoSignPayload(event: HomeTrustEvent): unknown {
  if (event.body.t !== "domain-reset") throw new TypeError("Trust event is not a domain reset");
  const { coSign: _coSign, ...body } = event.body;
  const { signature: _signature, body: _body, ...eventBase } = event;
  return { ...eventBase, body };
}

function verifyOuterSignature(current: TrustProjection, event: HomeTrustEvent): void {
  const { signature, ...unsigned } = event;
  const body = event.body;
  if (body.t === "genesis") {
    throw new TypeError("Trust genesis may only appear at the beginning of a chain");
  }
  if (body.t === "issuer-transition") assertIssuerTransitionAuthority(body);
  const recoverySigned =
    (body.t === "recovery-root" && body.op !== "establish") ||
    (body.t === "issuer-transition" && body.signedBy === "recovery-root");
  if (recoverySigned) {
    if (!current.recoveryRootPublicKey) throw new TypeError("No active recovery root can sign this event");
    verifyRecoverySignature(
      current.recoveryRootPublicKey,
      "HomeTrustEvent",
      1,
      unsigned,
      signature,
    );
    return;
  }
  verifyDeviceSignature(issuerSigningIdentity(current), "HomeTrustEvent", 1, unsigned, signature);
}

function assertEventPosition(current: TrustProjection, event: HomeTrustEvent): void {
  if (
    event.v !== 1 ||
    event.homeId !== current.homeId ||
    event.seq !== current.chainHead.seq + 1 ||
    event.prevEventDigest !== current.chainHead.eventDigest
  ) {
    throw new TypeError("Trust event is out of order or belongs to another chain");
  }
  const at = Date.parse(event.at);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== event.at) {
    throw new TypeError("Trust event time must be canonical ISO");
  }
}

function assertIssuerTransitionAuthority(
  body: Extract<HomeTrustEventBody, { t: "issuer-transition" }>,
): void {
  if (
    !(
      (body.reason === "migration" && body.signedBy === "issuer") ||
      (body.reason === "disaster-recovery" && body.signedBy === "recovery-root")
    )
  ) {
    throw new TypeError("Issuer transition reason does not match its signing authority");
  }
}

function assertCanonicalTime(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO`);
  }
}

function assertCurrentEpoch(current: TrustProjection, event: HomeTrustEvent): void {
  if (event.trustEpoch !== current.trustEpoch) throw new TypeError("Trust event epoch is stale");
}

function assertRoles(roles: readonly DeviceRole[]): void {
  const allowed = new Set<DeviceRole>(["anchor", "executor", "surface"]);
  if (
    roles.length === 0 ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !allowed.has(role))
  ) {
    throw new TypeError("Device roles must be non-empty and unique");
  }
}

function assertDeviceIdentity(identity: DeviceIdentity): void {
  if (
    identity.displayName.length === 0 ||
    !new Set(["windows", "macos", "linux", "headless"]).has(identity.platform)
  ) {
    throw new TypeError("Device identity metadata is invalid");
  }
  if (deviceIdFromPublicKey(identity.publicKey) !== identity.deviceId) {
    throw new TypeError("Device identity does not match its public key");
  }
  const enrolledAt = Date.parse(identity.enrolledAt);
  if (!Number.isFinite(enrolledAt) || new Date(enrolledAt).toISOString() !== identity.enrolledAt) {
    throw new TypeError("Device enrollment time must be canonical ISO");
  }
}

function requiredMember(
  members: Array<{ device: DeviceIdentity; roles: DeviceRole[]; state: "active" | "revoked" | "pending-reenroll" }>,
  deviceId: string,
) {
  const member = members.find((candidate) => candidate.device.deviceId === deviceId);
  if (!member) throw new TypeError("Trust event references an unknown device");
  return member;
}

function requiredActiveMember(
  members: Array<{ device: DeviceIdentity; roles: DeviceRole[]; state: "active" | "revoked" | "pending-reenroll" }>,
  deviceId: string,
) {
  const member = requiredMember(members, deviceId);
  if (member.state !== "active") throw new TypeError("Trust event requires an active device");
  return member;
}

function freezeProjection(input: {
  homeId: string;
  trustEpoch: number;
  chainHead: { seq: number; eventDigest: string };
  issuer: { deviceId: string; issuerKeyId: string; issuerPublicKey?: string };
  recoveryRootPublicKey?: string;
  recoveryBackupPublicKey?: string;
  recoveryActivationDigest?: string;
  pendingResetEvent?: HomeTrustEventWithBody<Extract<HomeTrustEventBody, { t: "domain-reset" }>>;
  members: Array<{ device: DeviceIdentity; roles: DeviceRole[]; state: "active" | "revoked" | "pending-reenroll" }>;
}): TrustProjection {
  return Object.freeze({
    ...input,
    chainHead: Object.freeze({ ...input.chainHead }),
    issuer: Object.freeze({ ...input.issuer }),
    members: Object.freeze(
      input.members.map((member) =>
        Object.freeze({ ...member, roles: Object.freeze([...member.roles]) }),
      ),
    ),
  });
}

function issuerSigningIdentity(projection: TrustProjection): DeviceIdentity {
  const member = requiredActiveMember(
    projection.members.map((candidate) => ({ ...candidate, roles: [...candidate.roles] })),
    projection.issuer.deviceId,
  );
  if (!projection.issuer.issuerPublicKey) return member.device;
  if (deviceIdFromPublicKey(projection.issuer.issuerPublicKey) !== projection.issuer.issuerKeyId) {
    throw new TypeError("Trust projection issuer key does not match its public key");
  }
  return {
    ...member.device,
    deviceId: projection.issuer.issuerKeyId,
    publicKey: projection.issuer.issuerPublicKey,
  };
}

function buildComparableProjection(projection: TrustProjection): Omit<HomeTrustRecord, "signature"> {
  return {
    v: 1,
    homeId: projection.homeId,
    trustEpoch: projection.trustEpoch,
    chainHead: { ...projection.chainHead },
    issuer: { ...projection.issuer },
    ...(projection.recoveryRootPublicKey ? { recoveryRootPublicKey: projection.recoveryRootPublicKey } : {}),
    ...(projection.recoveryBackupPublicKey ? { recoveryBackupPublicKey: projection.recoveryBackupPublicKey } : {}),
    members: projection.members.map((member) => ({
      device: member.device,
      roles: [...member.roles],
      state: member.state,
    })),
  };
}

export function assertRecoveryKeyPair(rootPublicKey: string, backupPublicKey: string): void {
  keyIdForPublicKey(rootPublicKey);
  keyIdForPublicKey(backupPublicKey);
  if (!rootPublicKey.startsWith("ed25519:") || !backupPublicKey.startsWith("x25519:")) {
    throw new TypeError("Recovery root must separate signing and backup keys");
  }
  importEncodedPublicKey(rootPublicKey, "ed25519");
  importEncodedPublicKey(backupPublicKey, "x25519");
}
