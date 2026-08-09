import { describe, expect, it } from "vitest";
import type {
  AnchorTransferCommand,
  AuthorityCatalog,
  HomeTrustRecord,
  HomeTrustEventWithBody,
  HomeTrustEventBody,
  TransferRecord,
} from "../contracts/index.js";
import { protocolDigest } from "./canonical.js";
import {
  anchorTransferCommitDigest,
  createSignedAnchorTransferAbort,
  createSignedAnchorTransferCommand,
  createSignedPlannedAnchorTransferCommit,
  createSignedReadyProof,
  prepareAuthorityCatalog,
  readyProofDigest,
  reducePlannedAnchorTransfer,
  validateAnchorTransferCommand,
  validateAnchorTransferResult,
  validateAuthorityCatalog,
  validateReadyProof,
} from "./anchor-transfer.js";
import { createSignedSourceFreezeProof, sourceFreezeProofDigest } from "./conversation-transfer.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE = "device-source";
const TARGET = "device-target";
const ISSUER = "issuer-target";
const AT = "2026-08-09T00:00:00.000Z";
const EXPIRES = "2026-08-09T00:10:00.000Z";

function identity(keyId: string): ProtocolSigner & ProtocolSignatureVerifier {
  return {
    sign(schemaId, version, payload) {
      return { alg: "test-digest", keyId, sig: protocolDigest(schemaId, version, payload) };
    },
    verify(schemaId, version, payload, signature) {
      expect(signature).toEqual(this.sign(schemaId, version, payload));
    },
  };
}

const source = identity(SOURCE);
const target = identity(TARGET);
const targetIssuer = identity(ISSUER);

describe("planned anchor transfer protocol", () => {
  it("validates a finite ready proof and rejects secret/field drift", () => {
    const proof = readyProof();
    expect(validateReadyProof(proof, target, targetIssuer, Date.parse(AT) + 1)).toEqual(proof);
    expect(() => validateReadyProof({ ...proof, providerToken: "secret" }, target, targetIssuer, Date.parse(AT) + 1)).toThrow("incomplete or unknown");
    expect(() => validateReadyProof(proof, target, targetIssuer, Date.parse(EXPIRES))).toThrow("not currently active");
    expect(() => validateReadyProof({ ...proof, targetDeviceId: SOURCE }, target, targetIssuer, Date.parse(AT) + 1)).toThrow();
  });

  it("freezes a complete canonical authority catalog and rejects coverage or ordering drift", () => {
    const prepared = prepareAuthorityCatalog(catalog());
    expect(prepared.ref.bytes).toBe(prepared.bytes.byteLength);
    expect(prepared.ref.digest).toMatch(/^sha256:/u);
    expect(validateAuthorityCatalog(prepared.catalog)).toEqual(prepared.catalog);
    expect(() => validateAuthorityCatalog({
      ...prepared.catalog,
      coverage: prepared.catalog.coverage.slice(1),
    })).toThrow("complete canonical set");
    expect(() => validateAuthorityCatalog({
      ...prepared.catalog,
      retainedArtifacts: [...prepared.catalog.retainedArtifacts].reverse(),
    })).toThrow("canonically sorted");
  });

  it("advances exact records through one commit and permanently rejects late abort", () => {
    const facts = records();
    let state = reducePlannedAnchorTransfer(undefined, facts.prepared, source);
    for (const phase of ["fenced", "frozen", "imported", "committed", "tombstoned"] as const) {
      state = reducePlannedAnchorTransfer(state, facts[phase], source);
      expect(state.phase).toBe(phase);
      expect(reducePlannedAnchorTransfer(state, facts[phase], source)).toBe(state);
    }
    expect(() => reducePlannedAnchorTransfer(state, facts.aborted, source)).toThrow("cannot abort");
    expect(() => reducePlannedAnchorTransfer(state, {
      ...facts.committed,
      commit: { ...facts.committed.commit, authorityCatalogDigest: digest("drift") },
    }, source)).toThrow("Conflicting anchor-committed");
    expect(anchorTransferCommitDigest(facts.committed.commit)).toMatch(/^sha256:/u);
  });

  it("allows only a pre-commit signed abort and exact terminal replay", () => {
    const facts = records();
    let state = reducePlannedAnchorTransfer(undefined, facts.prepared, source);
    state = reducePlannedAnchorTransfer(state, facts.fenced, source);
    state = reducePlannedAnchorTransfer(state, facts.aborted, source);
    expect(state.phase).toBe("aborted");
    expect(reducePlannedAnchorTransfer(state, facts.aborted, source)).toBe(state);
    expect(() => reducePlannedAnchorTransfer(state, facts.frozen, source)).toThrow("from aborted");
  });

  it("binds strict command results to their originating range/commit/abort", () => {
    const read = signedCommand({
      v: 1, op: "read-range", requestId: "request-1", transferId: TRANSFER_ID,
      ref: { digest: digest("checkpoint"), bytes: 16 }, offset: 4, length: 4,
    });
    expect(validateAnchorTransferResult({
      v: 1, status: "range", requestId: "request-1", transferId: TRANSFER_ID,
      ref: read.ref, offset: 4, data: Buffer.from("data").toString("base64"),
    }, read)).toBeTruthy();
    expect(() => validateAnchorTransferResult({
      v: 1, status: "range", requestId: "request-1", transferId: TRANSFER_ID,
      ref: read.ref, offset: 3, data: Buffer.from("data").toString("base64"),
    }, read)).toThrow("originating range");

    const commit = records().committed.commit;
    const command = signedCommand({
      v: 1, op: "commit", requestId: "request-2", transferId: TRANSFER_ID, commit,
    });
    const record = trustRecord();
    expect(() => validateAnchorTransferResult({
      v: 1, status: "ok", requestId: "request-2", transferId: TRANSFER_ID,
      state: "committed", commit: { ...commit, checkpointDigest: digest("other") }, trustRecord: record,
    }, command, source)).toThrow();
    expect(() => validateAnchorTransferResult({
      v: 1, status: "ok", requestId: "wrong-request", transferId: TRANSFER_ID,
      state: "committed", commit, trustRecord: record,
    }, command, source)).toThrow("originating command");
    expect(validateAnchorTransferResult({
      v: 1, status: "ok", requestId: "request-2", transferId: TRANSFER_ID,
      state: "committed", commit, trustRecord: record,
    }, command, source)).toMatchObject({ state: "committed", trustRecord: record });
    expect(() => validateAnchorTransferResult({
      v: 1, status: "ok", requestId: "request-2", transferId: TRANSFER_ID,
      state: "committed", commit,
    }, command, source)).toThrow("incomplete or unknown");
  });

  it("rejects planned/disaster and command state confusion before side effects", () => {
    const command = signedCommand({
      v: 1, op: "status", requestId: "request-status", transferId: TRANSFER_ID,
    });
    expect(validateAnchorTransferCommand(command, source)).toEqual(command);
    expect(() => validateAnchorTransferCommand({ ...command, checkpointEnvelopeDigest: digest("dr") }, source)).toThrow("incomplete or unknown");
    expect(() => validateAnchorTransferResult({
      v: 1, status: "range", requestId: command.requestId, transferId: TRANSFER_ID,
      ref: { digest: digest("range"), bytes: 4 }, offset: 0, data: "ZGF0YQ==",
    }, command)).toThrow("not valid for this command");
  });
});

function readyProof() {
  return createSignedReadyProof({
    v: 1,
    transferId: TRANSFER_ID,
    homeId: "home-1",
    targetDeviceId: TARGET,
    trustEpoch: 3,
    trustChainHead: { seq: 7, eventDigest: digest("chain") },
    targetIssuerKeyId: ISSUER,
    targetIssuerPublicKey: "ed25519:target-issuer-public-key",
    roles: ["anchor"],
    configuredCapabilities: { providers: ["provider-a"], mcpServers: ["mcp-a"], channels: ["channel-a"] },
    protocolRevision: "protocol-1",
    assetRevision: "assets-1",
    serviceRevision: "services-1",
    secretStore: "unlocked",
    issuedAt: AT,
    expiresAt: EXPIRES,
  }, target, targetIssuer);
}

function transition(): HomeTrustEventWithBody<Extract<HomeTrustEventBody, { t: "issuer-transition"; reason: "migration" }>> {
  const unsigned = {
    v: 1 as const,
    homeId: "home-1",
    seq: 8,
    prevEventDigest: digest("chain"),
    trustEpoch: 3,
    body: {
      t: "issuer-transition" as const,
      nextTrustEpoch: 4,
      fromIssuerKeyId: SOURCE,
      toIssuerKeyId: ISSUER,
      toIssuerPublicKey: "ed25519:target-issuer-public-key",
      toDeviceId: TARGET,
      reason: "migration" as const,
      signedBy: "issuer" as const,
    },
    at: AT,
  };
  return { ...unsigned, signature: source.sign("HomeTrustEvent", 1, unsigned) };
}

function trustRecord(): HomeTrustRecord {
  const event = transition();
  const { signature: _eventSignature, ...unsignedEvent } = event;
  const unsigned = {
    v: 1 as const,
    homeId: "home-1",
    trustEpoch: 4,
    chainHead: {
      seq: event.seq,
      eventDigest: protocolDigest("HomeTrustEvent", 1, unsignedEvent),
    },
    issuer: {
      deviceId: TARGET,
      issuerKeyId: ISSUER,
      issuerPublicKey: "ed25519:target-issuer-public-key",
    },
    members: [{
      device: {
        deviceId: TARGET,
        publicKey: "ed25519:target-device-public-key",
        displayName: "Target",
        platform: "linux" as const,
        enrolledAt: AT,
      },
      roles: ["anchor" as const],
      state: "active" as const,
    }],
  };
  return {
    ...unsigned,
    signature: targetIssuer.sign("HomeTrustRecord", 1, unsigned),
  };
}

function catalog(): AuthorityCatalog {
  return {
    v: 1,
    transferId: TRANSFER_ID,
    sourceDeviceId: SOURCE,
    targetDeviceId: TARGET,
    sourceAnchorEpoch: 5,
    source: { logId: "authority-log", lsn: 9, frameEndOffset: 512, prefixDigest: digest("prefix") },
    trust: { homeId: "home-1", trustEpoch: 3, chainHead: { seq: 7, eventDigest: digest("chain") }, issuerDeviceId: SOURCE, issuerKeyId: SOURCE },
    coverage: ["conversation-authority", "conversation-content", "execution-assets", "global-authority", "pending-obligations", "trust-and-anchor"],
    streams: [
      { stream: "control", firstLsn: 1, lastLsn: 9, recordCount: 2, digest: digest("control") },
      { stream: "trust", firstLsn: 1, lastLsn: 7, recordCount: 3, digest: digest("trust") },
    ],
    authorityRecords: { digest: digest("records"), bytes: 1024 },
    retainedArtifacts: [
      { digest: digest("artifact-a"), bytes: 1 },
      { digest: digest("artifact-b"), bytes: 2 },
    ],
    pendingObligations: [{ kind: "final", id: "final-1" }],
  };
}

function records() {
  const proof = readyProof();
  const trustTransition = transition();
  const preparedCatalog = prepareAuthorityCatalog(catalog());
  const checkpoint = { digest: digest("checkpoint"), bytes: 2048 };
  const freezeProof = createSignedSourceFreezeProof({
    v: 1,
    transferId: TRANSFER_ID,
    scope: "anchor",
    subject: "home-1",
    sourceEpoch: 5,
    checkpointDigest: checkpoint.digest,
    lastLsn: preparedCatalog.catalog.source.lsn,
  }, source);
  const commit = createSignedPlannedAnchorTransferCommit({
    v: 1,
    mode: "planned",
    transferId: TRANSFER_ID,
    sourceDeviceId: SOURCE,
    targetDeviceId: TARGET,
    freezeProofDigest: sourceFreezeProofDigest(freezeProof),
    checkpointDigest: checkpoint.digest,
    authorityCatalogDigest: preparedCatalog.ref.digest,
    trustTransitionDigest: protocolDigest("HomeTrustEvent", 1, (() => {
      const { signature: _, ...unsigned } = trustTransition;
      return unsigned;
    })()),
    nextAnchorEpoch: 6,
    nextTrustEpoch: 4,
    targetIssuerPublicKey: proof.targetIssuerPublicKey,
    readyProofDigest: readyProofDigest(proof),
    at: AT,
  }, source);
  const abort = createSignedAnchorTransferAbort({
    v: 1,
    requestId: "request-prepare",
    transferId: TRANSFER_ID,
    sourceDeviceId: SOURCE,
    targetDeviceId: TARGET,
    sourceAnchorEpoch: 5,
    reason: "operator-cancelled",
    at: AT,
  }, source);
  return {
    prepared: {
      v: 1, mode: "planned", t: "anchor-prepared", requestId: "request-prepare",
      transferId: TRANSFER_ID, sourceDeviceId: SOURCE, targetDeviceId: TARGET,
      sourceAnchorEpoch: 5, nextAnchorEpoch: 6, readyProof: proof, trustTransition,
    } satisfies TransferRecord,
    fenced: {
      v: 1, mode: "planned", t: "anchor-fenced", transferId: TRANSFER_ID,
      sourceAnchorEpoch: 5, recoveryCheckpointDigest: digest("recovery"), at: AT,
    } satisfies TransferRecord,
    frozen: {
      v: 1, mode: "planned", t: "anchor-frozen", transferId: TRANSFER_ID,
      checkpoint, catalog: preparedCatalog.catalog, catalogRef: preparedCatalog.ref, proof: freezeProof,
    } satisfies TransferRecord,
    imported: {
      v: 1, mode: "planned", t: "anchor-imported", transferId: TRANSFER_ID,
      checkpointDigest: checkpoint.digest, authorityCatalogDigest: preparedCatalog.ref.digest,
    } satisfies TransferRecord,
    committed: {
      v: 1, mode: "planned", t: "anchor-committed", transferId: TRANSFER_ID, commit,
    } satisfies TransferRecord,
    tombstoned: {
      v: 1, mode: "planned", t: "anchor-tombstoned", transferId: TRANSFER_ID,
      commitDigest: anchorTransferCommitDigest(commit), at: AT,
    } satisfies TransferRecord,
    aborted: {
      v: 1, mode: "planned", t: "anchor-aborted", transferId: TRANSFER_ID, abort,
    } satisfies TransferRecord,
  };
}

function signedCommand(input: Omit<AnchorTransferCommand, "signature">): AnchorTransferCommand {
  return createSignedAnchorTransferCommand(input as Parameters<typeof createSignedAnchorTransferCommand>[0], source);
}

function digest(seed: string): `sha256:${string}` {
  return protocolDigest("test", 1, { seed }) as `sha256:${string}`;
}
