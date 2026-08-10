import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { loadConfig } from "@zhixing/providers";
import { BlindRendezvousMatcher, readBlindRendezvousHello } from "@zhixing/mesh/blind-rendezvous";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import {
  applyTrustEvent,
  createDomainResetEvent,
  createRecoveryRootEvent,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  initializeTrustChain,
} from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { connect, createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { FileBackupTargetConfiguration } from "./backup-target-config.js";
import { FileMeshPairingContinuationStore } from "./mesh-pairing-continuation.js";
import { createPairingTrustEvent, runPairCommand } from "./mesh-pair-command.js";

const TEST_DURABLE_IO_TIMEOUT_MS = 120_000;

describe("production mesh pairing command", () => {
  it("turns a fresh pairing transcript into reenroll for the same pending device", async () => {
    const issuerKey = await DeviceKey.generate();
    const peerKey = await DeviceKey.generate();
    const issuer = enrollDeviceIdentity(issuerKey, {
      displayName: "issuer",
      platform: "headless",
      enrolledAt: "2026-08-10T00:00:00.000Z",
    });
    const peer = enrollDeviceIdentity(peerKey, {
      displayName: "peer",
      platform: "headless",
      enrolledAt: "2026-08-10T00:00:00.000Z",
    });
    let trust = initializeTrustChain(createTrustGenesisEvent({
      homeId: "home-reenroll",
      issuer,
      signer: issuerKey,
      at: "2026-08-10T00:00:00.000Z",
    }));
    trust = applyTrustEvent(trust, createSignedTrustEvent({
      current: trust,
      signer: issuerKey,
      at: "2026-08-10T00:01:00.000Z",
      body: { t: "enroll", device: peer, roles: ["executor"] },
    }));
    const recoveryRoot = RecoveryRoot.generate();
    trust = applyTrustEvent(trust, createRecoveryRootEvent({
      current: trust,
      op: "establish",
      candidate: recoveryRoot,
      outerSigner: issuerKey,
      at: "2026-08-10T00:01:30.000Z",
    }));
    trust = applyTrustEvent(trust, createDomainResetEvent({
      current: trust,
      issuer: issuerKey,
      coSigner: peerKey,
      at: "2026-08-10T00:02:00.000Z",
    }));
    trust = applyTrustEvent(trust, createRecoveryRootEvent({
      current: trust,
      op: "establish",
      candidate: RecoveryRoot.generate(),
      outerSigner: issuerKey,
      at: "2026-08-10T00:02:30.000Z",
    }));

    const event = createPairingTrustEvent({
      current: trust,
      device: peer,
      roles: ["anchor"],
      pairingTranscriptDigest: "sha256:fresh-pairing-transcript",
      at: "2026-08-10T00:03:00.000Z",
      issuerKey,
    });

    expect(event.body).toEqual({
      t: "reenroll",
      deviceId: peer.deviceId,
      pairingTranscriptDigest: "sha256:fresh-pairing-transcript",
    });
    expect(applyTrustEvent(trust, event).members.find((member) =>
      member.device.deviceId === peer.deviceId)?.state).toBe("active");
  });

  it("persists the offer secret before exposing a resumable issuer continuation", async () => {
    const home = await createTempDir("mesh-pair-offer-write-order");
    const entered = deferred<void>();
    const release = deferred<void>();
    const secrets = new class extends MemorySecretStore {
      failNextPairingWrite = true;
      override async put(ref: SecretRef, value: string): Promise<void> {
        if (
          this.failNextPairingWrite &&
          ref.kind === "rendezvous" &&
          ref.bindingId.startsWith("pairing:")
        ) {
          this.failNextPairingWrite = false;
          entered.resolve(undefined);
          await release.promise;
          throw new Error("simulated secret persistence failure");
        }
        await super.put(ref, value);
      }
    }();
    let invitationPublished = false;
    const pairing = runPairCommand({
      zhixingHome: home,
      secretStore: secrets,
      advertise: "127.0.0.1:0",
      confirmRecoveryPackage: echoRecoveryPackage,
      writeLine: (line) => {
        if (line.startsWith("Pairing invitation: ")) invitationPublished = true;
      },
    });

    await entered.promise;
    await expect(new FileMeshPairingContinuationStore(home).load()).resolves.toMatchObject({
      side: "issuer",
      phase: "offer-secret-pending",
    });
    expect(invitationPublished).toBe(false);
    release.resolve(undefined);
    await expect(pairing).rejects.toThrow("simulated secret persistence failure");
    await expect(new FileMeshPairingContinuationStore(home).load()).resolves.toBeUndefined();
    await expect(runPairCommand({
      zhixingHome: home,
      secretStore: secrets,
      writeLine: (line) => {
        if (line.startsWith("Pairing invitation: ")) throw new Error("invitation reissued");
      },
    })).rejects.toThrow("invitation reissued");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("keeps mesh disabled when the recovery package does not survive read-back", async () => {
    const anchorHome = await createTempDir("mesh-pair-recovery-readback-anchor");
    const targetHome = await createTempDir("mesh-pair-recovery-readback-target");
    const invitation = deferred<string>();
    const issuer = runPairCommand({
      zhixingHome: anchorHome,
      secretStore: new MemorySecretStore(),
      advertise: "127.0.0.1:0",
      confirmRecoveryPackage: async (recoveryPackage) => `${recoveryPackage}x`,
      writeLine: (line) => {
        if (line.startsWith("Pairing invitation: ")) {
          invitation.resolve(line.slice("Pairing invitation: ".length));
        }
      },
    });
    const joiner = runPairCommand({
      zhixingHome: targetHome,
      secretStore: new MemorySecretStore(),
      invitation: await invitation.promise,
      writeLine: () => undefined,
    });
    const [issuerResult, joinerResult] = await Promise.allSettled([issuer, joiner]);
    expect(issuerResult).toMatchObject({ status: "rejected" });
    expect(joinerResult).toMatchObject({ status: "rejected" });
    expect((await new FileMeshBootstrapStore(anchorHome).loadTrustRecord())?.recoveryRootPublicKey)
      .toBeUndefined();
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["qr", "short"] as const)(
    "pairs two clean installations over direct %s rendezvous",
    async (method) => {
      const anchorHome = await createTempDir(`mesh-pair-anchor-${method}`);
      const executorHome = await createTempDir(`mesh-pair-executor-${method}`);
      const anchorSecrets = new MemorySecretStore();
      const executorSecrets = new MemorySecretStore();
      const invitation = deferred<string>();
      let shortCode: string | undefined;
      const issuer = runPairCommand({
        zhixingHome: anchorHome,
        secretStore: anchorSecrets,
        confirmRecoveryPackage: echoRecoveryPackage,
        method,
        advertise: "127.0.0.1:0",
        writeLine: (line) => {
          if (line.startsWith("Pairing invitation: ")) {
            invitation.resolve(line.slice("Pairing invitation: ".length));
          }
          if (line.startsWith("Pairing code: ")) {
            shortCode = line.slice("Pairing code: ".length);
          }
        },
      });
      const encoded = await invitation.promise;
      await runPairCommand({
        zhixingHome: executorHome,
        secretStore: executorSecrets,
        invitation: encoded,
        ...(method === "short" ? { shortCode: requireValue(() => shortCode) } : {}),
        writeLine: () => undefined,
      });
      await issuer;

      const anchorStore = new FileMeshBootstrapStore(anchorHome);
      const executorStore = new FileMeshBootstrapStore(executorHome);
      const anchorTrust = await anchorStore.loadTrustRecord();
      const executorTrust = await executorStore.loadTrustRecord();
      expect(executorTrust).toEqual(anchorTrust);
      expect(anchorTrust?.recoveryRootPublicKey).toMatch(/^ed25519:/u);
      expect(anchorTrust?.recoveryBackupPublicKey).toMatch(/^x25519:/u);
      expect(anchorTrust?.members.map((member) => member.roles)).toEqual([
        ["anchor", "executor"],
        ["executor"],
      ]);
      const anchorId = anchorTrust!.issuer.deviceId;
      const executorId = anchorTrust!.members.find((member) => member.device.deviceId !== anchorId)!.device.deviceId;
      const checkpointRecords = await anchorStore.loadCheckpointRecords();
      const created = checkpointRecords.find((record) =>
        record.t === "checkpoint-created" && record.targetId === `backup-device:${executorId}`);
      expect(created?.purpose.kind).toBe("root-activation");
      expect(checkpointRecords.some((record) =>
        record.t === "checkpoint-verified" && record.checkpointId === created?.checkpointId)).toBe(true);
      const target = await FileRecoveryCheckpointTarget.openPaired({
        targetRoot: `${executorHome}/distributed-runtime/recovery-checkpoints`,
        targetDeviceId: executorId,
      });
      await expect(target.read(created!.checkpointId)).resolves.toMatchObject({
        envelope: { checkpointId: created!.checkpointId },
      });
      expect(await anchorSecrets.get({ kind: "rendezvous", bindingId: executorId }))
        .toBe(await executorSecrets.get({ kind: "rendezvous", bindingId: anchorId }));
      expect(loadConfig({ homeDir: anchorHome }).mesh?.enabledRoles).toEqual(["anchor", "executor"]);
      expect(loadConfig({ homeDir: executorHome }).mesh?.enabledRoles).toEqual(["executor"]);
      await expect(new FileBackupTargetConfiguration(anchorHome).load()).resolves.toMatchObject({
        currentTargetId: `backup-device:${executorId}`,
        bindings: [{ kind: "paired-device", deviceId: executorId }],
      });
    },
    TEST_DURABLE_IO_TIMEOUT_MS,
  );

  it("pairs through a blind relay without a direct endpoint", async () => {
    const anchorHome = await createTempDir("mesh-pair-relay-anchor");
    const executorHome = await createTempDir("mesh-pair-relay-executor");
    const matcher = new BlindRendezvousMatcher();
    const relay = createServer((socket) => {
      void readBlindRendezvousHello(socket)
        .then((hello) => matcher.accept(socket, hello))
        .catch((error) => socket.destroy(error instanceof Error ? error : undefined));
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", () => resolve());
    });
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("relay did not bind");
    const invitation = deferred<string>();
    try {
      const issuer = runPairCommand({
        zhixingHome: anchorHome,
        secretStore: new MemorySecretStore(),
        confirmRecoveryPackage: echoRecoveryPackage,
        relay: `127.0.0.1:${address.port}`,
        relayOnly: true,
        writeLine: (line) => {
          if (line.startsWith("Pairing invitation: ")) {
            invitation.resolve(line.slice("Pairing invitation: ".length));
          }
        },
      });
      await runPairCommand({
        zhixingHome: executorHome,
        secretStore: new MemorySecretStore(),
        invitation: await invitation.promise,
        writeLine: () => undefined,
      });
      await issuer;
      expect((await new FileMeshBootstrapStore(anchorHome).loadTrustRecord())?.members).toHaveLength(2);
    } finally {
      matcher.close();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("prefers the direct peer when a relay registration is also available", async () => {
    const anchorHome = await createTempDir("mesh-pair-mixed-anchor");
    const executorHome = await createTempDir("mesh-pair-mixed-executor");
    const matcher = new BlindRendezvousMatcher();
    const relay = createServer((socket) => {
      void readBlindRendezvousHello(socket)
        .then((hello) => matcher.accept(socket, hello))
        .catch((error) => socket.destroy(error instanceof Error ? error : undefined));
    });
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", () => resolve());
    });
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("relay did not bind");
    const invitation = deferred<string>();
    try {
      const issuer = runPairCommand({
        zhixingHome: anchorHome,
        secretStore: new MemorySecretStore(),
        confirmRecoveryPackage: echoRecoveryPackage,
        advertise: "127.0.0.1:0",
        relay: `127.0.0.1:${address.port}`,
        writeLine: (line) => {
          if (line.startsWith("Pairing invitation: ")) {
            invitation.resolve(line.slice("Pairing invitation: ".length));
          }
        },
      });
      await runPairCommand({
        zhixingHome: executorHome,
        secretStore: new MemorySecretStore(),
        invitation: await invitation.promise,
        writeLine: () => undefined,
      });
      await issuer;
      expect((await new FileMeshBootstrapStore(anchorHome).loadTrustRecord())?.members).toHaveLength(2);
    } finally {
      matcher.close();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("resumes the committed bootstrap after the response connection is lost", async () => {
    const anchorHome = await createTempDir("mesh-pair-resume-anchor");
    const executorHome = await createTempDir("mesh-pair-resume-executor");
    const anchorSecrets = new MemorySecretStore();
    const executorSecrets = new MemorySecretStore();
    const targetPort = await reservePort();
    const proxyPort = await reservePort();
    let proxy = await startPairingProxy(proxyPort, targetPort, true);
    const invitation = deferred<string>();
    const issuer = runPairCommand({
      zhixingHome: anchorHome,
      secretStore: anchorSecrets,
      confirmRecoveryPackage: echoRecoveryPackage,
      listen: `127.0.0.1:${targetPort}`,
      advertise: `127.0.0.1:${proxyPort}`,
      writeLine: (line) => {
        if (line.startsWith("Pairing invitation: ")) {
          invitation.resolve(line.slice("Pairing invitation: ".length));
        }
      },
    });
    const encoded = await invitation.promise;
    const joiner = runPairCommand({
      zhixingHome: executorHome,
      secretStore: executorSecrets,
      invitation: encoded,
      writeLine: () => undefined,
    });
    const interrupted = await Promise.allSettled([issuer, joiner]);
    expect(interrupted.every((result) => result.status === "rejected")).toBe(true);
    await proxy.close();

    proxy = await startPairingProxy(proxyPort, targetPort, false);
    try {
      const resumedInvitation = deferred<string>();
      const resumedIssuer = runPairCommand({
        zhixingHome: anchorHome,
        secretStore: anchorSecrets,
        writeLine: (line) => {
          if (line.startsWith("Pairing invitation: ")) {
            resumedInvitation.resolve(line.slice("Pairing invitation: ".length));
          }
        },
      });
      expect(await Promise.race([
        resumedInvitation.promise,
        resumedIssuer.then(() => { throw new Error("pairing issuer ended before publishing its invitation"); }),
      ])).toBe(encoded);
      await runPairCommand({
        zhixingHome: executorHome,
        secretStore: executorSecrets,
        writeLine: () => undefined,
      });
      await resumedIssuer;
      const anchorTrust = await new FileMeshBootstrapStore(anchorHome).loadTrustRecord();
      const executorTrust = await new FileMeshBootstrapStore(executorHome).loadTrustRecord();
      expect(executorTrust).toEqual(anchorTrust);
      expect(anchorTrust?.members).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(key(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(key(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(key(ref));
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => {
        const separator = entry.indexOf("/");
        return {
          kind: entry.slice(0, separator) as SecretRef["kind"],
          bindingId: entry.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function key(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function requireValue<T>(read: () => T | undefined): T {
  const value = read();
  if (value === undefined) throw new Error("Expected value was not produced");
  return value;
}

async function echoRecoveryPackage(recoveryPackage: string): Promise<string> {
  return recoveryPackage;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port did not bind");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startPairingProxy(
  port: number,
  targetPort: number,
  dropCommitted: boolean,
): Promise<{ readonly close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((downstream) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(downstream);
    sockets.add(upstream);
    const remove = (socket: Socket) => sockets.delete(socket);
    downstream.once("close", () => remove(downstream));
    upstream.once("close", () => remove(upstream));
    downstream.on("data", (bytes) => upstream.write(bytes));
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    let pending = Buffer.alloc(0);
    upstream.on("data", (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.byteLength >= 4) {
        const length = pending.readUInt32BE(0);
        if (pending.byteLength < length + 4) return;
        const frame = pending.subarray(0, length + 4);
        pending = pending.subarray(length + 4);
        const value = JSON.parse(frame.subarray(4).toString("utf8")) as { readonly t?: string };
        if (dropCommitted && value.t === "committed") {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
