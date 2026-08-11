import { Duplex } from "node:stream";
import type { HomeTrustRecord, SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import {
  MeshEndpointDirectory,
  commitMeshEndpointUpdate,
  createMeshEndpointDescriptor,
  currentAndPreviousRendezvousKeys,
  derivePairwiseRendezvousSecret,
  persistPairwiseRendezvousSecret,
  resolveEffectiveMeshRoles,
  resolveHostLaunchPlan,
  validateBlindRendezvousHello,
  validateMeshEndpointDescriptor,
  validateMeshRoleBootConfig,
  validateRendezvousKey,
} from "../bootstrap.js";
import {
  BlindRendezvousMatcher,
  encodeBlindRendezvousHello,
  readBlindRendezvousHello,
} from "../blind-rendezvous.js";

const AT = "2026-07-22T00:00:00.000Z";
const LOCAL = "device:local";

describe("production mesh bootstrap contracts", () => {
  it("resolves the host launch plan from current trust without trimming roles", () => {
    const anchor = trustRecord(["anchor", "executor"]);
    expect(resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: anchor,
      configuration: {
        enabledRoles: ["anchor", "executor"],
        executorAutoStart: false,
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    })).toEqual({ mode: "managed", roles: ["anchor", "executor"] });

    const executor = trustRecordFor({
      issuerDeviceId: "device:anchor",
      localRoles: ["executor", "surface"],
    });
    expect(resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: executor,
      configuration: { enabledRoles: ["executor", "surface"] },
    })).toEqual({ mode: "on-demand", roles: ["executor", "surface"] });
    expect(resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: executor,
      configuration: {
        enabledRoles: ["executor", "surface"],
        executorAutoStart: true,
      },
    })).toEqual({ mode: "managed", roles: ["executor", "surface"] });

    const surface = trustRecordFor({
      issuerDeviceId: "device:anchor",
      localRoles: ["surface"],
    });
    expect(resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: surface,
      configuration: { enabledRoles: ["surface"] },
    })).toEqual({ mode: "none", roles: ["surface"] });
    expect(resolveHostLaunchPlan({ localDeviceId: LOCAL })).toEqual({
      mode: "on-demand",
      roles: ["anchor", "executor"],
    });
  });

  it("fails closed on stale anchor, inactive or ambiguous identity and invalid selection", () => {
    const staleAnchor = trustRecordFor({
      issuerDeviceId: "device:anchor",
      localRoles: ["anchor", "executor"],
    });
    expect(() => resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: staleAnchor,
      configuration: {
        enabledRoles: ["anchor", "executor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    })).toThrow(/non-current device/);
    expect(() => resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: staleAnchor,
      configuration: {
        enabledRoles: ["executor"],
        executorAutoStart: "yes",
      } as never,
    })).toThrow(/must be a boolean/);

    const inactive = trustRecordFor({
      issuerDeviceId: "device:anchor",
      localRoles: ["executor"],
      localState: "revoked",
    });
    expect(() => resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: inactive,
      configuration: { enabledRoles: ["executor"] },
    })).toThrow(/not an active member/);

    const duplicate = trustRecordFor({
      issuerDeviceId: "device:anchor",
      localRoles: ["executor"],
    });
    duplicate.members.push({ ...duplicate.members[0]! });
    expect(() => resolveHostLaunchPlan({
      localDeviceId: LOCAL,
      trust: duplicate,
      configuration: { enabledRoles: ["executor"] },
    })).toThrow(/exactly once/);
  });
  it("keeps the no-genesis path local and validates trusted-home roles fail-closed", () => {
    expect(resolveEffectiveMeshRoles({ localDeviceId: LOCAL })).toEqual({
      mode: "single-machine",
      roles: ["anchor", "executor"],
    });

    const trust = trustRecord(["anchor"]);
    expect(() => resolveEffectiveMeshRoles({
      localDeviceId: LOCAL,
      trust,
      configuration: {
        enabledRoles: ["executor"],
      },
    })).toThrow(/not authorized/);
    expect(() => resolveEffectiveMeshRoles({
      localDeviceId: LOCAL,
      trust,
      configuration: { enabledRoles: ["anchor"] },
    })).toThrow(/requires direct or relay reachability/);
    expect(resolveEffectiveMeshRoles({
      localDeviceId: LOCAL,
      trust,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: {
          bind: { host: "0.0.0.0", port: 7443 },
          advertised: [{ host: "anchor.example", port: 7443 }],
        },
      },
    })).toEqual({ mode: "trusted-home", roles: ["anchor"] });
  });

  it("rejects an anchor that listens only on a wildcard address without advertised reachability", () => {
    expect(() => validateMeshRoleBootConfig({
      enabledRoles: ["anchor"],
      anchorListen: { bind: { host: "0.0.0.0", port: 7443 } },
    })).toThrow(/requires direct or relay reachability/);

    expect(validateMeshRoleBootConfig({
      enabledRoles: ["anchor"],
      anchorListen: { bind: { host: "0.0.0.0", port: 7443 } },
      relayRegistration: { host: "relay.example", port: 8443 },
    })).toEqual({
      enabledRoles: ["anchor"],
      anchorListen: { bind: { host: "0.0.0.0", port: 7443 } },
      relayRegistration: { host: "relay.example", port: 8443 },
    });
  });

  it("validates endpoint shape and rejects replay or rollback by revision", () => {
    const first = createMeshEndpointDescriptor({
      deviceId: LOCAL,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: {
          bind: { host: "0.0.0.0", port: 7443 },
          advertised: [{ host: "anchor.example", port: 7443 }],
        },
        relayRegistration: { host: "relay.example", port: 8443 },
      },
      revision: 1,
      at: AT,
    });
    expect(first.transports.map((transport) => transport.kind)).toEqual([
      "direct",
      "blind-relay",
    ]);
    expect(() => validateMeshEndpointDescriptor({ ...first, unknown: true })).toThrow(
      /unknown/,
    );
    expect(() => validateMeshEndpointDescriptor({ ...first, transports: [] })).toThrow(
      /one to eight/,
    );

    const directory = new MeshEndpointDirectory([first]);
    expect(() => directory.accept(first)).toThrow(/did not advance/);
    const second = directory.accept({ ...first, revision: 2 });
    expect(directory.get(LOCAL)).toEqual(second);

    expect(createMeshEndpointDescriptor({
      deviceId: LOCAL,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
      revision: 3,
      at: AT,
    }).transports).toEqual([{ kind: "direct", host: "127.0.0.1", port: 7443 }]);
  });

  it("publishes endpoint updates only after durable acceptance", async () => {
    const descriptor = createMeshEndpointDescriptor({
      deviceId: LOCAL,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
      revision: 1,
      at: AT,
    });
    const directory = new MeshEndpointDirectory();
    await expect(commitMeshEndpointUpdate(
      directory,
      descriptor,
      async () => { throw new Error("disk unavailable"); },
    )).rejects.toThrow("disk unavailable");
    expect(directory.get(LOCAL)).toBeUndefined();

    await expect(commitMeshEndpointUpdate(
      directory,
      descriptor,
      async (accepted) => accepted,
    )).resolves.toEqual(descriptor);
    expect(directory.get(LOCAL)).toEqual(descriptor);
  });

  it("derives, persists and rotates opaque rendezvous keys without transporting the secret", async () => {
    const secret = derivePairwiseRendezvousSecret(Buffer.alloc(32, 0x5a));
    const store = new MemorySecretStore();
    await persistPairwiseRendezvousSecret(store, "device:peer", secret);
    expect(await store.get({ kind: "rendezvous", bindingId: "device:peer" })).toBe(secret);

    const [current, previous] = currentAndPreviousRendezvousKeys(
      secret,
      Date.parse("2026-07-22T12:00:00.000Z"),
    );
    expect(validateRendezvousKey(current)).toBe(current);
    expect(previous).not.toBe(current);
    expect(() => validateRendezvousKey(`sha256:${"0".repeat(64)}`)).toThrow();
    expect(validateBlindRendezvousHello({ v: 1, key: current, ttlMs: 60_000 })).toEqual({
      v: 1,
      key: current,
      ttlMs: 60_000,
    });
  });

  it("frames canonical rendezvous hellos and cleans waiting entries on close", async () => {
    const key = `rzv:${"a".repeat(64)}` as const;
    const stream = new MemoryDuplex();
    const decoded = readBlindRendezvousHello(stream);
    stream.push(encodeBlindRendezvousHello({ v: 1, key, ttlMs: 1_000 }));
    expect(await decoded).toEqual({ v: 1, key, ttlMs: 1_000 });

    const matcher = new BlindRendezvousMatcher();
    const pending = new MemoryDuplex();
    expect(matcher.accept(pending, { v: 1, key, ttlMs: 1_000 })).toBe("waiting");
    expect(matcher.waiting).toBe(1);
    pending.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(matcher.waiting).toBe(0);
    matcher.close();
  });

  it("bounds pending rendezvous entries without blocking a matching peer", () => {
    const firstKey = `rzv:${"a".repeat(64)}` as const;
    const secondKey = `rzv:${"b".repeat(64)}` as const;
    const matcher = new BlindRendezvousMatcher({ maxPending: 1 });
    const waiting = new MemoryDuplex();
    expect(matcher.accept(waiting, { v: 1, key: firstKey, ttlMs: 1_000 })).toBe("waiting");
    expect(() => matcher.accept(
      new MemoryDuplex(),
      { v: 1, key: secondKey, ttlMs: 1_000 },
    )).toThrow(/pending connection limit/);
    expect(matcher.accept(
      new MemoryDuplex(),
      { v: 1, key: firstKey, ttlMs: 1_000 },
    )).toBe("bridged");
    expect(matcher.waiting).toBe(0);
    matcher.close();
  });

  it("cancels a partial rendezvous hello at the caller deadline", async () => {
    const stream = new MemoryDuplex();
    const controller = new AbortController();
    const pending = readBlindRendezvousHello(stream, controller.signal);
    stream.push(Buffer.from([0, 0]));
    controller.abort(new Error("pre-auth deadline exceeded"));
    await expect(pending).rejects.toThrow("pre-auth deadline exceeded");
    expect(stream.destroyed).toBe(true);
  });
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(`${ref.kind}:${ref.bindingId}`, value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(`${ref.kind}:${ref.bindingId}`) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(`${ref.kind}:${ref.bindingId}`);
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const [kind, ...binding] = key.split(":");
        return { kind: kind as SecretRef["kind"], bindingId: binding.join(":") };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

class MemoryDuplex extends Duplex {
  _read(): void {}
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function trustRecord(roles: HomeTrustRecord["members"][number]["roles"]): HomeTrustRecord {
  return {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home-1",
    trustEpoch: 1,
    issuer: { deviceId: LOCAL, issuerKeyId: LOCAL },
    chainHead: { seq: 1, eventDigest: `sha256:${"1".repeat(64)}` },
    members: [{
      device: {
        deviceId: LOCAL,
        publicKey: "ed25519:test",
        displayName: "local",
        platform: "headless",
        enrolledAt: AT,
      },
      roles,
      state: "active",
    }],
    signature: {
      alg: "Ed25519",
      keyId: LOCAL,
      sig: "test",
    },
  };
}

function trustRecordFor(input: {
  readonly issuerDeviceId: string;
  readonly localRoles: HomeTrustRecord["members"][number]["roles"];
  readonly localState?: HomeTrustRecord["members"][number]["state"];
}): HomeTrustRecord {
  const record = trustRecord(input.localRoles);
  return {
    ...record,
    issuer: { deviceId: input.issuerDeviceId, issuerKeyId: input.issuerDeviceId },
    members: [{
      ...record.members[0]!,
      state: input.localState ?? "active",
    }],
  };
}
