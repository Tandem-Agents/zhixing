import type {
  CredentialBindingDescriptor,
  CredentialExposureRecord,
} from "@zhixing/core/contracts";
import { protocolDigest } from "./canonical.js";

export function createCredentialExposureRecord(input: {
  readonly deviceId: string;
  readonly bindingId: string;
  readonly bindingRevision?: number;
  readonly service: string;
  readonly verifiedPrincipal?: {
    readonly verification: "service-verified";
    readonly canonicalProviderPrincipal: string;
  };
  readonly tenant?: string;
  readonly scopes?: readonly string[];
  readonly markedAt: string;
  readonly rotationHint?: string;
}): CredentialExposureRecord {
  if (input.tenant !== undefined && !isCanonicalText(input.tenant)) {
    throw new TypeError("Credential exposure tenant is invalid");
  }
  if (input.rotationHint !== undefined && !isCanonicalText(input.rotationHint)) {
    throw new TypeError("Credential exposure rotation hint is invalid");
  }
  if (input.verifiedPrincipal) {
    if (
      input.verifiedPrincipal.verification !== "service-verified" ||
      !isCanonicalText(input.verifiedPrincipal.canonicalProviderPrincipal)
    ) {
      throw new TypeError("Credential principal must come from a service-verified identity");
    }
  }
  const scopes = input.scopes ? [...new Set(input.scopes)].sort() : undefined;
  const record: CredentialExposureRecord = {
    deviceId: input.deviceId,
    bindingId: input.bindingId,
    ...(input.bindingRevision !== undefined
      ? { bindingRevision: input.bindingRevision }
      : {}),
    service: input.service,
    ...(input.verifiedPrincipal
      ? {
          principalFingerprint: protocolDigest("CredentialPrincipal", 1, {
            service: input.service,
            canonicalProviderPrincipal:
              input.verifiedPrincipal.canonicalProviderPrincipal,
          }),
        }
      : {}),
    ...(input.tenant !== undefined ? { tenant: input.tenant } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
    state: "active",
    markedAt: input.markedAt,
    ...(input.rotationHint !== undefined ? { rotationHint: input.rotationHint } : {}),
  };
  validateExposureRecord(record);
  return freezeRecord(record);
}

export function createCredentialExposureRecordFromDescriptor(input: {
  readonly deviceId: string;
  readonly binding: CredentialBindingDescriptor;
  readonly markedAt: string;
  readonly rotationHint?: string;
}): CredentialExposureRecord {
  const record: CredentialExposureRecord = {
    deviceId: input.deviceId,
    bindingId: input.binding.bindingId,
    bindingRevision: input.binding.revision,
    service: input.binding.service,
    ...(input.binding.principalFingerprint === undefined
      ? {}
      : { principalFingerprint: input.binding.principalFingerprint }),
    ...(input.binding.tenant === undefined ? {} : { tenant: input.binding.tenant }),
    ...(input.binding.scopes === undefined ? {} : { scopes: [...input.binding.scopes] }),
    state: "active",
    markedAt: input.markedAt,
    ...(input.rotationHint === undefined ? {} : { rotationHint: input.rotationHint }),
  };
  validateExposureRecord(record);
  return freezeRecord(record);
}

export interface DeviceRevocationExposureProjection {
  readonly records: readonly CredentialExposureRecord[];
  readonly affectedAccounts: readonly {
    readonly bindingId: string;
    readonly service: string;
    readonly tenant?: string;
    readonly scopes?: readonly string[];
    readonly rotationHint?: string;
  }[];
}

export interface CredentialExposureProjection {
  readonly records: readonly CredentialExposureRecord[];
  readonly rotationRequired: readonly {
    readonly bindingId: string;
    readonly service: string;
    readonly tenant?: string;
    readonly scopes?: readonly string[];
    readonly rotationHint?: string;
  }[];
}

export function projectCredentialExposures(
  input: readonly CredentialExposureRecord[],
): CredentialExposureProjection {
  const latest = new Map<string, CredentialExposureRecord>();
  for (const record of input) {
    validateExposureRecord(record);
    const key = exposureIdentity(record);
    const prior = latest.get(key);
    if (prior && Date.parse(record.markedAt) < Date.parse(prior.markedAt)) {
      throw new TypeError("Credential exposure history moves backwards in time");
    }
    if (
      prior?.bindingRevision !== undefined && record.bindingRevision !== undefined &&
      record.bindingRevision < prior.bindingRevision
    ) {
      throw new TypeError("Credential exposure binding revision moves backwards");
    }
    if (prior && Date.parse(record.markedAt) === Date.parse(prior.markedAt) &&
      JSON.stringify(prior) !== JSON.stringify(record)) {
      throw new TypeError("Credential exposure history has an ambiguous latest state");
    }
    latest.set(key, freezeRecord(record));
  }
  const records = [...latest.values()].sort((left, right) =>
    exposureIdentity(left).localeCompare(exposureIdentity(right), "en-US"));
  const publicItems = new Map<string, CredentialExposureProjection["rotationRequired"][number]>();
  for (const record of records) {
    if (record.state !== "compromised") continue;
    const key = [
      record.bindingId,
      record.service,
      record.principalFingerprint ?? "",
      record.tenant ?? "",
      ...(record.scopes ?? []),
    ].join("\0");
    publicItems.set(key, Object.freeze({
      bindingId: record.bindingId,
      service: record.service,
      ...(record.tenant ? { tenant: record.tenant } : {}),
      ...(record.scopes ? { scopes: Object.freeze([...record.scopes]) } : {}),
      ...(record.rotationHint ? { rotationHint: record.rotationHint } : {}),
    }));
  }
  return Object.freeze({
    records: Object.freeze(records),
    rotationRequired: Object.freeze([...publicItems.values()].sort((left, right) =>
      `${left.service}/${left.bindingId}`.localeCompare(`${right.service}/${right.bindingId}`, "en-US"))),
  });
}

export function assertCredentialRouteAllowed(input: {
  readonly projection: CredentialExposureProjection;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly service: string;
  readonly principalFingerprint?: string;
  readonly tenant?: string;
  readonly scopes?: readonly string[];
}): void {
  const sameBinding = input.projection.records.filter((record) =>
    record.bindingId === input.bindingId && record.service === input.service &&
    (input.principalFingerprint === undefined ||
      record.principalFingerprint === input.principalFingerprint) &&
    (input.tenant === undefined || record.tenant === input.tenant) &&
    (input.scopes === undefined ||
      JSON.stringify(record.scopes ?? []) === JSON.stringify(input.scopes)));
  if (sameBinding.length === 0) return;
  const compromised = sameBinding.some((record) => record.state === "compromised");
  const currentActive = sameBinding.some((record) =>
    record.deviceId === input.deviceId && record.state === "active");
  if (compromised || !currentActive) {
    throw new Error("Credential binding is blocked until the affected account is rotated");
  }
}

export function projectDeviceCredentialRevocation(input: {
  readonly records: readonly CredentialExposureRecord[];
  readonly deviceId: string;
  readonly markedAt: string;
}): DeviceRevocationExposureProjection {
  if (!isCanonicalText(input.deviceId)) {
    throw new TypeError("Credential revocation device identity is invalid");
  }
  assertCanonicalTime(input.markedAt);
  const keys = new Set<string>();
  const records = input.records.map((record) => {
    validateExposureRecord(record);
    const key = [
      record.deviceId,
      record.bindingId,
      record.service,
      record.principalFingerprint ?? "",
      record.tenant ?? "",
      ...(record.scopes ?? []),
    ].join("\0");
    if (keys.has(key)) {
      throw new TypeError("Credential exposure records must be unique per exposure identity");
    }
    keys.add(key);
    if (record.deviceId !== input.deviceId || record.state !== "active") {
      return freezeRecord(record);
    }
    if (Date.parse(input.markedAt) < Date.parse(record.markedAt)) {
      throw new TypeError("Credential revocation time cannot precede the exposure state");
    }
    return freezeRecord({
      ...cloneRecord(record),
      state: "compromised" as const,
      markedAt: input.markedAt,
    });
  });
  const affectedAccounts = records
    .filter((record) => record.deviceId === input.deviceId && record.state === "compromised")
    .map((record) =>
      Object.freeze({
        bindingId: record.bindingId,
        service: record.service,
        ...(record.tenant ? { tenant: record.tenant } : {}),
        ...(record.scopes ? { scopes: Object.freeze([...record.scopes]) } : {}),
        ...(record.rotationHint ? { rotationHint: record.rotationHint } : {}),
      }),
    )
    .sort((left, right) => `${left.service}/${left.bindingId}`.localeCompare(`${right.service}/${right.bindingId}`));
  return Object.freeze({
    records: Object.freeze(records),
    affectedAccounts: Object.freeze(affectedAccounts),
  });
}

function validateExposureRecord(record: CredentialExposureRecord): void {
  if (
    record === null ||
    typeof record !== "object" ||
    (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)
  ) {
    throw new TypeError("Credential exposure record must be a plain object");
  }
  if (
    !isCanonicalText(record.deviceId) ||
    !isCanonicalText(record.bindingId) ||
    !isCanonicalText(record.service)
  ) {
    throw new TypeError("Credential exposure identity fields are required");
  }
  if (
    Object.keys(record).some(
      (field) =>
        ![
          "deviceId",
          "bindingId",
          "bindingRevision",
          "service",
          "principalFingerprint",
          "tenant",
          "scopes",
          "state",
          "markedAt",
          "rotationHint",
        ].includes(field),
    )
  ) {
    throw new TypeError("Credential exposure record contains unknown fields");
  }
  if (
    record.principalFingerprint !== undefined &&
    !/^sha256:[a-f0-9]{64}$/u.test(record.principalFingerprint)
  ) {
    throw new TypeError("Credential exposure principal fingerprint is invalid");
  }
  if (
    record.bindingRevision !== undefined &&
    (!Number.isSafeInteger(record.bindingRevision) || record.bindingRevision < 1)
  ) {
    throw new TypeError("Credential exposure binding revision is invalid");
  }
  if (record.tenant !== undefined && !isCanonicalText(record.tenant)) {
    throw new TypeError("Credential exposure tenant is invalid");
  }
  if (record.rotationHint !== undefined && !isCanonicalText(record.rotationHint)) {
    throw new TypeError("Credential exposure rotation hint is invalid");
  }
  if (!new Set(["active", "compromised", "rotated"]).has(record.state)) {
    throw new TypeError("Credential exposure state is invalid");
  }
  assertCanonicalTime(record.markedAt);
  if (record.scopes) {
    if (
      !Array.isArray(record.scopes) ||
      record.scopes.some((scope) => !isCanonicalText(scope)) ||
      new Set(record.scopes).size !== record.scopes.length ||
      record.scopes.some((scope, index) => index > 0 && record.scopes![index - 1]! > scope)
    ) {
      throw new TypeError("Credential exposure scopes must be canonical and unique");
    }
  }
}

function cloneRecord(record: CredentialExposureRecord): CredentialExposureRecord {
  return { ...record, ...(record.scopes ? { scopes: [...record.scopes] } : {}) };
}

function exposureIdentity(record: CredentialExposureRecord): string {
  return [
    record.deviceId,
    record.bindingId,
    record.service,
    record.principalFingerprint ?? "",
    record.tenant ?? "",
    ...(record.scopes ?? []),
  ].join("\0");
}

function freezeRecord(record: CredentialExposureRecord): CredentialExposureRecord {
  const clone = cloneRecord(record);
  if (clone.scopes) Object.freeze(clone.scopes);
  return Object.freeze(clone);
}

function assertCanonicalTime(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError("Credential exposure time must be canonical ISO time");
  }
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
