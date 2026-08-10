import type {
  CredentialBindingDescriptor,
  CredentialExposureRecord,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import type { FileAuthorityCommitLog } from "@zhixing/core/authority";
import { canonicalize } from "@zhixing/core/protocol";
import {
  assertCredentialRouteAllowed,
  createCredentialExposureRecord,
  createCredentialExposureRecordFromDescriptor,
  projectCredentialExposures,
  type CredentialExposureProjection,
} from "@zhixing/mesh/credential-exposure";

export const CREDENTIAL_EXPOSURE_ROUTE_DESCRIPTOR = Object.freeze({
  owner: "current-device",
  protectedKinds: Object.freeze(["provider", "channel", "mcp", "webhook", "rendezvous"]),
  excludedKinds: Object.freeze(["device-key"]),
  states: Object.freeze(["active", "compromised", "rotated"]),
});

export class CredentialExposureAuthority {
  constructor(private readonly options: {
    readonly deviceId: string;
    readonly log: FileAuthorityCommitLog;
    readonly secretStore: SecretStorePort;
    readonly now?: () => string;
  }) {}

  async projection(): Promise<CredentialExposureProjection> {
    return projectCredentialExposures(
      (await this.options.log.readStream<CredentialExposureRecord>("exposure"))
        .map((entry) => entry.body),
    );
  }

  async rotationRequired() {
    return (await this.projection()).rotationRequired;
  }

  async publishActiveBindings(input: {
    readonly bindings: readonly CredentialBindingDescriptor[];
    readonly markedAt: string;
  }): Promise<CredentialExposureProjection> {
    const candidates = input.bindings.map((binding) =>
      createCredentialExposureRecordFromDescriptor({
        deviceId: this.options.deviceId,
        binding,
        markedAt: input.markedAt,
      }));
    const result = await this.options.log.transactProjection<
      readonly CredentialExposureRecord[],
      CredentialExposureRecord,
      CredentialExposureProjection
    >(
      [],
      (records, entry) => [...records, entry.body],
      (records) => {
        const projected = projectCredentialExposures(records);
        const entries: Array<{ stream: "exposure"; body: CredentialExposureRecord }> = [];
        for (const candidate of candidates) {
          const current = projected.records.find((record) =>
            sameExposureIdentity(record, candidate));
          if (current?.state === "compromised" || current?.state === "rotated") {
            continue;
          }
          if (current?.bindingRevision !== undefined &&
            current.bindingRevision > candidate.bindingRevision!) {
            throw new Error("Credential exposure publication moved a binding revision backwards");
          }
          if (current?.state === "active" &&
            current.bindingRevision === candidate.bindingRevision) {
            continue;
          }
          entries.push({ stream: "exposure", body: candidate });
        }
        const next = projectCredentialExposures([
          ...records,
          ...entries.map((entry) => entry.body),
        ]);
        return entries.length === 0
          ? { kind: "return", value: next }
          : { kind: "append", entries, value: next };
      },
      { stream: "exposure" },
    );
    return result.value;
  }

  async secretForRoute(input: {
    readonly ref: SecretRef;
    readonly service: string;
    readonly principalFingerprint?: string;
    readonly tenant?: string;
    readonly scopes?: readonly string[];
  }): Promise<string | null> {
    await this.assertRoute(input);
    return this.options.secretStore.get(input.ref);
  }

  async assertRoute(input: {
    readonly ref: SecretRef;
    readonly service: string;
    readonly principalFingerprint?: string;
    readonly tenant?: string;
    readonly scopes?: readonly string[];
  }): Promise<void> {
    assertCredentialRouteAllowed({
      projection: await this.projection(),
      deviceId: this.options.deviceId,
      bindingId: input.ref.bindingId,
      service: input.service,
      ...(input.principalFingerprint
        ? { principalFingerprint: input.principalFingerprint }
        : {}),
      ...(input.tenant ? { tenant: input.tenant } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
    });
  }

  async publishRotation(input: {
    readonly requestId: string;
    readonly oldDeviceId: string;
    readonly oldBindingId?: string;
    readonly ref: SecretRef;
    readonly service: string;
    readonly bindingRevision: number;
    readonly verifiedPrincipal?: {
      readonly verification: "service-verified";
      readonly canonicalProviderPrincipal: string;
    };
    readonly verifyPrincipal?: () => Promise<{
      readonly verification: "service-verified";
      readonly canonicalProviderPrincipal: string;
    }>;
    readonly tenant?: string;
    readonly scopes?: readonly string[];
    readonly rotationHint?: string;
    readonly publishAndReadBack: () => Promise<void>;
    readonly readiness: () => Promise<void>;
  }): Promise<CredentialExposureProjection> {
    if (!/^[A-Za-z0-9._:-]{1,192}$/u.test(input.requestId)) {
      throw new TypeError("Credential rotation request identity is invalid");
    }
    if ((input.verifiedPrincipal === undefined) === (input.verifyPrincipal === undefined)) {
      throw new TypeError("Credential rotation requires exactly one principal verifier");
    }
    await input.publishAndReadBack();
    const verifiedPrincipal = input.verifyPrincipal
      ? await input.verifyPrincipal()
      : input.verifiedPrincipal!;
    await input.readiness();
    const markedAt = this.options.now?.() ?? new Date().toISOString();
    const active = createCredentialExposureRecord({
      deviceId: this.options.deviceId,
      bindingId: input.ref.bindingId,
      bindingRevision: input.bindingRevision,
      service: input.service,
      verifiedPrincipal,
      ...(input.tenant ? { tenant: input.tenant } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.rotationHint ? { rotationHint: input.rotationHint } : {}),
      markedAt,
    });
    const result = await this.options.log.transactProjection<
      readonly CredentialExposureRecord[],
      CredentialExposureRecord,
      CredentialExposureProjection
    >(
      [],
      (records, entry) => [...records, entry.body],
      (records) => {
        const projected = projectCredentialExposures(records);
        const old = projected.records.find((record) =>
          record.deviceId === input.oldDeviceId &&
          record.bindingId === (input.oldBindingId ?? input.ref.bindingId) &&
          record.service === input.service && record.state === "compromised");
        if (!old) {
          const current = projected.records.find((record) =>
            record.deviceId === this.options.deviceId &&
            record.bindingId === input.ref.bindingId && record.service === input.service &&
            record.state === "active");
          if (current && sameExposureIdentity(current, active) &&
            current.bindingRevision === input.bindingRevision) {
            return { kind: "return", value: projected };
          }
          throw new Error("Credential rotation has no matching compromised exposure");
        }
        if (
          old.bindingRevision !== undefined &&
          input.bindingRevision <= old.bindingRevision
        ) throw new Error("Credential rotation revision must advance the affected binding");
        const rotated: CredentialExposureRecord = Object.freeze({
          ...old,
          state: "rotated",
          markedAt,
        });
        const next = projectCredentialExposures([...records, active, rotated]);
        return {
          kind: "append",
          entries: [
            { stream: "exposure", body: active },
            { stream: "exposure", body: rotated },
          ],
          value: next,
        };
      },
      { stream: "exposure" },
    );
    return result.value;
  }
}

export function exposureGuardedSecretStore(
  store: SecretStorePort,
  authority: CredentialExposureAuthority,
): SecretStorePort {
  return {
    put: (ref, value) => store.put(ref, value),
    get: async (ref) => {
      const route = credentialRoute(ref);
      if (route) await authority.assertRoute({ ref: route.ref, service: route.service });
      return store.get(ref);
    },
    delete: (ref) => store.delete(ref),
    list: (prefix) => store.list(prefix),
    unlockState: () => store.unlockState(),
  };
}

function credentialRoute(ref: SecretRef): {
  readonly ref: SecretRef;
  readonly service: string;
} | undefined {
  if ((CREDENTIAL_EXPOSURE_ROUTE_DESCRIPTOR.excludedKinds as readonly string[])
    .includes(ref.kind)) return undefined;
  if (!(CREDENTIAL_EXPOSURE_ROUTE_DESCRIPTOR.protectedKinds as readonly string[])
    .includes(ref.kind)) {
    throw new TypeError("Credential route kind is outside the exposure descriptor");
  }
  if (ref.kind === "provider" || ref.kind === "channel" || ref.kind === "mcp") {
    const match = /^credentials\/v1\/generations\/[A-Za-z0-9_-]{16,64}\/([^/]+)$/u
      .exec(ref.bindingId);
    if (!match) {
      if (ref.bindingId === "credentials/v1/manifest" ||
        ref.bindingId.startsWith("credentials/v1/generation-markers/")) return undefined;
      return { ref, service: ref.kind };
    }
    let id: string;
    try {
      id = Buffer.from(match[1]!, "base64url").toString("utf8");
    } catch {
      throw new TypeError("Credential binding identity is invalid");
    }
    return {
      ref: { kind: ref.kind, bindingId: `credential-${ref.kind}-${id}` },
      service: ref.kind,
    };
  }
  return { ref, service: ref.kind };
}

function sameExposureIdentity(
  left: CredentialExposureRecord,
  right: CredentialExposureRecord,
): boolean {
  const omitState = (record: CredentialExposureRecord) => ({
    deviceId: record.deviceId,
    bindingId: record.bindingId,
    service: record.service,
    principalFingerprint: record.principalFingerprint ?? null,
    tenant: record.tenant ?? null,
    scopes: record.scopes ?? [],
    rotationHint: record.rotationHint ?? null,
  });
  return canonicalize(omitState(left)) === canonicalize(omitState(right));
}
