import { readFile, writeFile, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { protocolDigest, type StopLifecycleIdentity } from "../protocol/index.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "../protocol/signature.js";
import { FileArtifactStore } from "./artifact-store.js";
import { FileAuthorityCommitLog } from "./commit-log.js";
import { DeviceLifecycleJournal } from "./device-lifecycle-journal.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

// 同一物理日志只登记一个活验签器；测试身份无状态，全部 journal 共用同一实例。
const IDENTITY: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return { alg: "test", keyId: "device-anchor", sig: protocolDigest(schemaId, version, payload) };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};
function identity(): ProtocolSigner & ProtocolSignatureVerifier {
  return IDENTITY;
}

describe("DeviceLifecycleJournal", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("keeps acceptance durable across response loss and repeated process restart", async () => {
    const fixture = await createFixture();
    const accepted = await fixture.journal.accept(stopIdentity());
    expect(accepted.phase).toBe("accepted");
    await expect(fixture.journal.accept(stopIdentity())).resolves.toEqual(accepted);

    let reopened = new DeviceLifecycleJournal(fixture.log, identity());
    await expect(reopened.state("stop-1")).resolves.toEqual(accepted);
    await reopened.advance("stop-1", "gate-closed");
    reopened = new DeviceLifecycleJournal(fixture.log, identity());
    await expect(reopened.state("stop-1")).resolves.toMatchObject({ phase: "gate-closed" });
    await expect(reopened.active()).resolves.toHaveLength(1);
  });

  it("serializes cross-kind subjects in the same physical log transaction", async () => {
    const fixture = await createFixture();
    await fixture.journal.accept({
      v: 1,
      kind: "executor-removal",
      requestId: "request-remove",
      operationId: "remove-1",
      homeId: "home-1",
      targetDeviceId: "device-a",
      targetMemberPublicKey: "ed25519:device-a",
      targetDeviceKeyGeneration: "generation-1",
      acceptedIssuerDeviceId: "device-anchor",
      acceptedIssuerKeyId: "device-anchor",
      acceptedTrustHeadDigest: DIGEST,
    });
    await expect(fixture.journal.accept({
      v: 1,
      kind: "anchor-uninstall",
      requestId: "request-uninstall",
      operationId: "uninstall-1",
      homeId: "home-1",
      currentDeviceId: "device-a",
      anchorEpoch: 1,
      trustHeadDigest: DIGEST,
      path: { kind: "migration", targetDeviceId: "device-b", transferId: "transfer-1" },
    })).rejects.toThrow("already owns this home subject");
    await expect(fixture.log.readStream("device-lifecycle")).resolves.toHaveLength(1);
  });

  it("fails closed when the physical stream contains a malformed lifecycle record", async () => {
    const fixture = await createFixture();
    const malformed = [{ stream: "device-lifecycle", body: { v: 1, t: "accepted" } }];
    await expect(fixture.log.append(malformed)).rejects.toThrow("incomplete or unknown");
    expect((await fixture.log.checkpoint()).lsn).toBe(0);
    // Retain source validation against a writer without the registered reducer.
    const unregistered = new FileAuthorityCommitLog(fixture.log.rootDir, fixture.log.artifactStore);
    await unregistered.append(malformed);
    await expect(fixture.journal.active()).rejects.toThrow("incomplete or unknown");
    await unregistered.stopStorageMaintenance();
  });

  it("reuses verified prefixes while observing another journal and isolating returned objects", async () => {
    const fixture = await createFixture();
    const accepted = await fixture.journal.accept(stopIdentity());
    (accepted.identity as { requestId: string }).requestId = "caller-mutation";
    const read = vi.spyOn(fixture.log, "readProjection");
    await expect(fixture.journal.state("stop-1")).resolves.toMatchObject({ identity: { requestId: "request-stop" } });
    expect(read).not.toHaveBeenCalled();
    const other = new DeviceLifecycleJournal(fixture.log, identity());
    await other.advance("stop-1", "gate-closed");
    await expect(fixture.journal.state("stop-1")).resolves.toMatchObject({ phase: "gate-closed" });
    await expect(fixture.journal.advance("stop-1", "ready-to-stop")).rejects.toThrow();
    await fixture.journal.advance("stop-1", "work-settled");
    await expect(other.state("stop-1")).resolves.toMatchObject({ phase: "work-settled" });
  });

  it("does not trust cached lifecycle state after same-size authority corruption", async () => {
    const fixture = await createFixture();
    await fixture.journal.accept(stopIdentity());
    await fixture.journal.active();
    const before = await stat(fixture.log.logPath), bytes = await readFile(fixture.log.logPath);
    const at = bytes.indexOf(Buffer.from('"request-stop"'));
    expect(at).toBeGreaterThan(0); bytes[at + 1] = "X".charCodeAt(0);
    await writeFile(fixture.log.logPath, bytes); await utimes(fixture.log.logPath, before.atime, before.mtime);
    await expect(fixture.journal.active()).rejects.toThrow();
  });

  it("declares retained artifact evidence again when writing the terminal record", async () => {
    const fixture = await createFixture();
    const artifact = await fixture.log.artifactStore.put(Buffer.from("settled work", "utf8"));
    await fixture.journal.accept(stopIdentity());
    await fixture.journal.advance("stop-1", "gate-closed", [{
      kind: "accepted-work",
      digest: artifact.digest,
      artifact,
    }]);
    for (const phase of ["work-settled", "flushed", "ready-to-stop"] as const) {
      await fixture.journal.advance("stop-1", phase);
    }
    const ready = await fixture.journal.state("stop-1");
    await expect(fixture.journal.terminal("stop-1", "stopped", ready!.evidence))
      .resolves.toMatchObject({ phase: "terminal" });
  });
});

describe("DeviceLifecycleJournal durable current state", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("restores verifier and plain readers without loading a historical scalar projection", async () => {
    const { AuthorityCacheIntegrity } = await import("./startup-proofs.js");
    const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 4));
    {
      const root = await createTempDir("device-lifecycle-checkpoint");
      const open = () => new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
        clock: () => "2026-08-12T00:00:00.000Z", integrity,
      });
      const log = open();
      const plain = new DeviceLifecycleJournal(log, identity());
      await plain.accept(stopIdentity());
      await plain.advance("stop-1", "gate-closed");
      // 进度远不足一个检查点间隔：正式停止前仍补存。
      await log.stopStorageMaintenance();

      // 所有者先登记带验签器的定义，之后的普通读者沿用同一登记。
      for (const plainReader of [false, true]) {
        const reopened = open();
        const read = vi.spyOn(reopened, "readProjection");
        const registered = new DeviceLifecycleJournal(reopened, identity());
        const journal = plainReader ? new DeviceLifecycleJournal(reopened) : registered;
        await expect(journal.state("stop-1")).resolves.toMatchObject({ phase: "gate-closed" });
        // No full operations Map or scalar replay cursor enters the process.
        expect(read).not.toHaveBeenCalled();
        await reopened.stopStorageMaintenance();
      }
    }
  });

  it("opens current gates without enumerating completed stop operations", async () => {
    const { AuthorityCacheIntegrity } = await import("./startup-proofs.js");
    const { FileDurableProjectionIndex } = await import("./durable-projection-index.js");
    const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 48));
    const root = await createTempDir("device-lifecycle-growth");
    const open = () => new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), { integrity });
    const writer = open();
    let cold: FileAuthorityCommitLog | undefined;
    const journal = new DeviceLifecycleJournal(writer, identity());
    try {
      for (let n = 0; n < 20; n++) {
        const id = "old-stop-" + n;
        await journal.accept({ ...stopIdentity(), operationId: id, requestId: id });
        for (const phase of ["gate-closed", "work-settled", "flushed", "ready-to-stop"] as const) await journal.advance(id, phase);
        await journal.terminal(id, "stopped");
      }
      await writer.stopStorageMaintenance();
      cold = open();
      const scan = vi.spyOn(FileDurableProjectionIndex.prototype, "scan");
      try {
        expect(await new DeviceLifecycleJournal(cold, identity()).startupState("device-a")).toEqual({ active: false });
        expect(scan.mock.calls.length).toBeLessThanOrEqual(2);
        expect(scan.mock.calls.every(call => call[1] === 1)).toBe(true);
      } finally { scan.mockRestore(); }
      expect(await new DeviceLifecycleJournal(cold).state("old-stop-0")).toMatchObject({ phase: "terminal" });
    } finally {
      await cold?.stopStorageMaintenance();
      await writer.stopStorageMaintenance();
    }
  });
});

describe("DeviceLifecycleJournal superseded executor removal", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  const removal = (operationId: string) => ({
    v: 1 as const, kind: "executor-removal" as const, requestId: `target:${operationId}`, operationId, homeId: "home-1",
    targetDeviceId: "device-a", targetMemberPublicKey: "ed25519:device-a", targetDeviceKeyGeneration: "generation-1",
    acceptedIssuerDeviceId: "device-anchor", acceptedIssuerKeyId: "device-anchor", acceptedTrustHeadDigest: DIGEST,
  });
  // 被显式新配对取代：独立终态，不是退役，不放宽 removed 的阶段守卫
  it("ends an unfinished removal as superseded only with the superseding trust event and never records it as retirement", async () => {
    const fixture = await createFixture();
    await fixture.journal.accept(removal("remove-1"));
    for (const phase of ["gate-frozen", "authority-decided", "authority-settled", "revocation-ready", "revoked"] as const) {
      await fixture.journal.advance("remove-1", phase);
    }
    await expect(fixture.journal.terminal("remove-1", "removed")).rejects.toThrow("missing required durable phases");
    await expect(fixture.journal.terminal("remove-1", "superseded")).rejects.toThrow("requires the superseding trust event");
    const superseded = await fixture.journal.terminal("remove-1", "superseded", [{ kind: "trust-event", digest: DIGEST }]);
    expect(superseded).toMatchObject({ phase: "terminal", terminalOutcome: "superseded" });
    const state = await new DeviceLifecycleJournal(fixture.log, identity()).startupState("device-a");
    expect(state).toEqual({ active: false });
    // 本机已 cleanup-complete、还没删钥写 removed（lost 场景）同样可被显式新配对取代
    await fixture.journal.accept({ ...removal("remove-2"), requestId: "target:remove-2" });
    for (const phase of ["gate-frozen", "authority-decided", "authority-settled", "revocation-ready", "revoked", "cleanup-complete"] as const) {
      await fixture.journal.advance("remove-2", phase);
    }
    expect(await fixture.journal.terminal("remove-2", "superseded", [{ kind: "trust-event", digest: DIGEST }])).toMatchObject({ terminalOutcome: "superseded" });
    // 已真正 removed 的历史不能改写成 superseded；removed 的退役指针照常
    await fixture.journal.accept({ ...removal("remove-3"), requestId: "target:remove-3" });
    for (const phase of ["gate-frozen", "authority-decided", "authority-settled", "revocation-ready", "revoked", "cleanup-complete"] as const) {
      await fixture.journal.advance("remove-3", phase);
    }
    expect(await fixture.journal.terminal("remove-3", "removed")).toMatchObject({ terminalOutcome: "removed" });
    await expect(fixture.journal.terminal("remove-3", "superseded", [{ kind: "trust-event", digest: DIGEST }])).rejects.toThrow();
    expect((await new DeviceLifecycleJournal(fixture.log, identity()).startupState("device-a")).retirement?.identity.operationId).toBe("remove-3");
  });

  it("does not let other lifecycle kinds end as superseded", async () => {
    const fixture = await createFixture();
    await fixture.journal.accept(stopIdentity());
    await expect(fixture.journal.terminal("stop-1", "superseded", [{ kind: "trust-event", digest: DIGEST }])).rejects.toThrow("does not match operation kind");
  });
});

async function createFixture() {
  const root = await createTempDir("device-lifecycle");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => "2026-08-12T00:00:00.000Z",
  });
  return { log, journal: new DeviceLifecycleJournal(log, identity()) };
}

function stopIdentity(): StopLifecycleIdentity {
  return {
    v: 1,
    kind: "stop",
    localDeviceId: "device-local",
    requestId: "request-stop",
    operationId: "stop-1",
    homeId: "home-1",
    strategy: "drain",
    host: {
      kind: "managed",
      serviceId: "zhixing-home-1",
      definitionDigest: DIGEST,
      instanceId: "managed-instance-1",
    },
  };
}
