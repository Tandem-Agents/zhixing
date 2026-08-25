import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { protocolDigest, type StopLifecycleIdentity } from "../protocol/index.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "../protocol/signature.js";
import { FileArtifactStore } from "./artifact-store.js";
import { FileAuthorityCommitLog } from "./commit-log.js";
import { DeviceLifecycleJournal } from "./device-lifecycle-journal.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

function identity(): ProtocolSigner & ProtocolSignatureVerifier {
  return {
    sign(schemaId, version, payload) {
      return { alg: "test", keyId: "device-anchor", sig: protocolDigest(schemaId, version, payload) };
    },
    verify(schemaId, version, payload, signature) {
      expect(signature).toEqual(this.sign(schemaId, version, payload));
    },
  };
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
    await fixture.log.append([{ stream: "device-lifecycle", body: { v: 1, t: "accepted" } }]);
    await expect(fixture.journal.active()).rejects.toThrow("incomplete or unknown");
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
