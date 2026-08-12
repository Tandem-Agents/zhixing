import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  cleanupRemovedDeviceSecrets,
} from "./device-removal.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";

describe("current issuer device removal", () => {
  it("commits trust revocation and the lifecycle terminal in one authority envelope and replays it", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const accepted = await authority.accept({
      requestId: "request-1",
      operationId: "remove-1",
      targetName: "工作电脑",
    });
    const ready = fixture.targetKey.sign("ExecutorRemovalReceipt", 1, {
      v: 1,
      operationId: accepted.operationId,
      homeId: accepted.homeId,
      targetDeviceId: accepted.targetDeviceId,
      targetDeviceKeyGeneration: accepted.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: accepted.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: accepted.acceptedTrustHeadDigest,
      phase: "revocation-ready",
      evidenceDigest: accepted.evidenceDigest,
      at: accepted.at,
    });
    const receipt = {
      v: 1 as const,
      operationId: accepted.operationId,
      homeId: accepted.homeId,
      targetDeviceId: accepted.targetDeviceId,
      targetDeviceKeyGeneration: accepted.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: accepted.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: accepted.acceptedTrustHeadDigest,
      phase: "revocation-ready" as const,
      evidenceDigest: accepted.evidenceDigest,
      at: accepted.at,
      signature: ready,
    };
    const revoked = await authority.commitReady(receipt);
    expect(revoked.phase).toBe("revoked");
    await expect(authority.commitReady(receipt)).resolves.toEqual(revoked);
    const tail = (await fixture.store.authorityLog().readAll()).at(-1);
    expect(tail?.entries.map((entry) => entry.stream)).toEqual(expect.arrayContaining([
      "trust",
      "device-lifecycle",
    ]));
    expect((await fixture.store.loadTrustRecord())?.members.find((member) =>
      member.device.deviceId === fixture.targetKey.deviceId)?.state).toBe("revoked");
    await expect(authority.terminal("remove-1")).resolves.toEqual(revoked);
  });

  it("restores the issuer guard after restart without creating a second lifecycle fact", async () => {
    const fixture = await createFixture();
    await fixture.authority().accept({
      requestId: "request-2",
      operationId: "remove-2",
      targetName: "工作电脑",
    });
    const restarted = fixture.authority();
    expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).toBe(false);
    await restarted.resumeActive();
    expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).toBe(true);
    expect((await fixture.store.authorityLog().readStream("device-lifecycle")).length).toBe(2);
  });

  it("redrives a target from its durable ready state after the revoke response is lost", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const accepted = await authority.accept({
      requestId: "request-target-replay",
      operationId: "remove-target-replay",
      targetName: "工作电脑",
    });
    const log = new FileAuthorityCommitLog(
      path.join(fixture.home, "target-executor-authority"),
      fixture.store.artifactStore(),
    );
    const cleanup = vi.fn(async () => [{
      kind: "cleanup" as const,
      digest: accepted.evidenceDigest,
    }]);
    const onRemoved = vi.fn(async () => undefined);
    const options = {
      log,
      homeId: "home-1",
      deviceKey: fixture.targetKey,
      verifier: fixture.verifier,
      closeAdmission: async () => undefined,
      settleAcceptedWork: async () => undefined,
      releaseAdmission: async () => undefined,
      transferToAnchor: async () => undefined,
      cleanup,
      onRemoved,
      now: () => "2026-08-12T00:00:04.000Z",
    };
    const target = new ExecutorRemovalTarget(options);
    await target.accept(accepted);
    const ready = await target.decide({
      operationId: accepted.operationId,
      mode: "transfer",
      currentAnchorDeviceId: fixture.issuerKey.deviceId,
    });
    await authority.commitReady(ready);

    const restarted = new ExecutorRemovalTarget(options);
    await restarted.resumeBeforeAdmission();
    await restarted.resumeWithIssuer({
      ready: (receipt) => authority.commitReady(receipt),
      terminal: (operationId) => authority.terminal(operationId),
    });

    await expect(restarted.state(accepted.operationId)).resolves.toMatchObject({
      phase: "removed",
      localData: "removed",
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("preserves the exact device key until the durable local terminal while removing other secrets", async () => {
    const fixture = await createFixture();
    await fixture.secrets.put({ kind: "device-key", bindingId: `device/v1/${fixture.targetKey.deviceId}` }, "key");
    await fixture.secrets.put({ kind: "channel", bindingId: "channel-a" }, "token");
    await cleanupRemovedDeviceSecrets({
      store: fixture.secrets,
      deviceKey: fixture.targetKey,
      preserveDeviceKey: true,
    });
    expect(await fixture.secrets.get({
      kind: "device-key",
      bindingId: `device/v1/${fixture.targetKey.deviceId}`,
    })).toBe("key");
    expect(await fixture.secrets.get({ kind: "channel", bindingId: "channel-a" })).toBeNull();
  });
});

async function createFixture() {
  const home = await createTempDir("device-removal-authority");
  const issuerKey = await DeviceKey.generate();
  const targetKey = await DeviceKey.generate();
  const issuer = enrollDeviceIdentity(issuerKey, {
    displayName: "值班电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:00.000Z",
  });
  const target = enrollDeviceIdentity(targetKey, {
    displayName: "工作电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:01.000Z",
  });
  const store = new FileMeshBootstrapStore(home, issuerKey);
  let trust = (await store.initializeLocalHome({
    key: issuerKey,
    identity: issuer,
    roles: ["anchor"],
    homeId: "home-1",
    at: "2026-08-12T00:00:00.000Z",
  })).projection;
  const enroll = createSignedTrustEvent({
    current: trust,
    body: { t: "enroll", device: target, roles: ["executor"] },
    signer: issuerKey,
    at: "2026-08-12T00:00:02.000Z",
  });
  trust = await store.appendTrustEvent({ event: enroll, issuerKey });
  const verifier = createTrustedDeviceProtocolVerifier([issuer, target]);
  const secrets = new MemorySecretStore();
  return {
    home,
    store,
    secrets,
    issuerKey,
    targetKey,
    verifier,
    authority: () => new CurrentIssuerDeviceRemovalAuthority({
      store,
      issuerKey,
      secretStore: secrets,
      verifier,
      isReachable: () => true,
      now: () => "2026-08-12T00:00:03.000Z",
    }),
  };
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(key(ref), value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(key(ref)) ?? null; }
  async delete(ref: SecretRef): Promise<void> { this.values.delete(key(ref)); }
  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()].filter((value) => value.startsWith(prefix)).map((value) => {
      const separator = value.indexOf("/");
      return { kind: value.slice(0, separator) as SecretRef["kind"], bindingId: value.slice(separator + 1) };
    });
  }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}

function key(ref: SecretRef): string { return `${ref.kind}/${ref.bindingId}`; }
