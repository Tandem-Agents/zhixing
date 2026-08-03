import type {
  EvidenceBundle,
  EvidenceRequest,
  ResourceLease,
  Signature,
} from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  createSignedEvidenceBundle,
  createSignedEvidenceRequest,
  evidenceObservationStateFingerprint,
  evidenceRequestDigest,
  MAX_EVIDENCE_DOCUMENT_BYTES,
  MAX_EVIDENCE_SUMMARY_BYTES,
  validateEvidenceBundle,
  validateEvidenceRequest,
} from "./evidence.js";

const NOW = "2026-08-01T00:00:00.000Z";
const EXPIRY = "2026-08-01T01:00:00.000Z";
const REQUEST_DIGEST_VECTOR =
  "sha256:f8263d5642dd50fa900d0dc29af0c2bc3bc514156fa5c051a9597fc519e6f5e8";

const signer = {
  sign(schemaId: string, version: number, payload: unknown): Signature {
    return {
      alg: "test-sha256",
      keyId: "owner-1",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier = {
  verify(
    schemaId: string,
    version: number,
    payload: unknown,
    signature: Signature,
  ) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

function signLease(
  payload: Omit<ResourceLease, "digest" | "signature"> & Record<string, unknown>,
): ResourceLease {
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("ResourceLease", 1, withDigest),
  };
}

function reviewRootLease(): ResourceLease {
  return signLease({
    v: 1,
    reservationId: "rsv-review-1",
    admissionClass: "advancement",
    workload: { kind: "control", id: "review-1", attempt: 1 },
    scopeBinding: { kind: "conversation", conversationId: "conv-1", ownerEpoch: 3 },
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 8 },
    domain: { kind: "anchor", anchorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  });
}

function evidenceLease(
  overrides: Record<string, unknown> = {},
): ResourceLease {
  const parent = reviewRootLease();
  return signLease({
    v: 1,
    reservationId: "rsv-evidence-1",
    parentId: parent.reservationId,
    parentDigest: parent.digest,
    admissionClass: "advancement",
    workload: { kind: "evidence", id: "req-1", attempt: 1 },
    scopeBinding: { kind: "conversation", conversationId: "conv-1", ownerEpoch: 3 },
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 4 },
    domain: parent.domain,
    issuedAt: NOW,
    expiry: EXPIRY,
    ...overrides,
  });
}

function unsignedRequest(
  overrides: Record<string, unknown> = {},
): Omit<EvidenceRequest, "signature"> {
  return {
    v: 1,
    requestId: "req-1",
    reviewId: "review-1",
    runId: "run-1",
    conversationId: "conv-1",
    ownerEpoch: 3,
    executorId: "executor-1",
    workspace: { bindingRef: "workspace-1", workspaceBindingRevision: 7 },
    items: [
      { kind: "file-diff", locator: {} },
      {
        kind: "log",
        locator: { paths: ["logs/build.log"] },
        digestHint: protocolDigest("hint", 1, { id: 1 }),
      },
    ],
    lease: evidenceLease(),
    issuedAt: NOW,
    expiry: EXPIRY,
    ...overrides,
  } as Omit<EvidenceRequest, "signature">;
}

function request(overrides: Record<string, unknown> = {}): EvidenceRequest {
  return createSignedEvidenceRequest(unsignedRequest(overrides), verifier, signer);
}

function unsignedBundle(
  overrides: Record<string, unknown> = {},
): Omit<EvidenceBundle, "signature"> {
  return {
    v: 1,
    requestId: "req-1",
    requestDigest: evidenceRequestDigest(request()),
    executorId: "executor-1",
    observation: {
      observedAt: NOW,
      preStateFingerprint: protocolDigest("pre", 1, { id: 1 }),
      postStateFingerprint: protocolDigest("pre", 1, { id: 1 }),
      consistent: true,
    },
    items: [
      {
        kind: "file-diff",
        locator: {},
        contentDigest: protocolDigest("content", 1, { id: 1 }),
        summary: "工作区存在两处未提交修改。",
        source: "independent",
      },
    ],
    ...overrides,
  } as Omit<EvidenceBundle, "signature">;
}

function bundle(overrides: Record<string, unknown> = {}): EvidenceBundle {
  return createSignedEvidenceBundle(unsignedBundle(overrides), signer);
}

describe("evidence protocol", () => {
  it("round-trips strictly validated requests and bundles", () => {
    const req = request();
    expect(validateEvidenceRequest(req, verifier)).toEqual(req);
    const pack = bundle();
    expect(validateEvidenceBundle(pack, verifier)).toEqual(pack);
  });

  it("keeps request identity stable across re-signatures", () => {
    const req = request();
    const resigned = {
      ...req,
      signature: { alg: "other-alg", keyId: "other-key", sig: "00" },
    };
    expect(evidenceRequestDigest(resigned)).toBe(evidenceRequestDigest(req));
    expect(() => validateEvidenceRequest(resigned, verifier)).toThrow();
  });

  it("freezes the observation fingerprint algorithm", () => {
    const fingerprint = evidenceObservationStateFingerprint([
      { kind: "file-diff", locator: {}, state: { kind: "missing" } },
      {
        kind: "log",
        locator: { paths: ["logs/build.log"] },
        state: {
          kind: "present",
          contentDigest: protocolDigest("content", 1, { id: 1 }),
        },
      },
    ]);
    expect(fingerprint).toBe(
      "sha256:4a88708bbb4f77d9b317e962b5a337a5d8f659bd8f3e955ba3eb7db86ca04a81",
    );
    const reordered = evidenceObservationStateFingerprint([
      {
        kind: "log",
        locator: { paths: ["logs/build.log"] },
        state: {
          kind: "present",
          contentDigest: protocolDigest("content", 1, { id: 1 }),
        },
      },
      { kind: "file-diff", locator: {}, state: { kind: "missing" } },
    ]);
    expect(reordered).not.toBe(fingerprint);
  });

  it("freezes the request identity vector", () => {
    expect(evidenceRequestDigest(request())).toBe(REQUEST_DIGEST_VECTOR);
    expect(
      validateEvidenceRequest(
        JSON.parse(canonicalize(request())),
        verifier,
      ),
    ).toEqual(request());
  });

  it("rejects unknown and missing fields, wrong versions and non-plain objects", () => {
    const req = request();
    expect(() => validateEvidenceRequest(null, verifier)).toThrow("plain object");
    expect(() =>
      validateEvidenceRequest({ ...req, extra: true }, verifier),
    ).toThrow("incomplete or unknown");
    const { workspace: _dropped, ...missingWorkspace } = req;
    expect(() => validateEvidenceRequest(missingWorkspace, verifier)).toThrow(
      "incomplete or unknown",
    );
    expect(() =>
      validateEvidenceRequest({ ...req, v: 2 }, verifier),
    ).toThrow("version");
    const pack = bundle();
    expect(() =>
      validateEvidenceBundle({ ...pack, v: 2 }, verifier),
    ).toThrow("version");
    expect(() =>
      validateEvidenceBundle({ ...pack, extra: 1 }, verifier),
    ).toThrow("incomplete or unknown");
  });

  it("rejects tampered payloads field by field", () => {
    const req = request();
    const tamperings: Record<string, unknown>[] = [
      { requestId: "req-2" },
      { reviewId: "review-2" },
      { runId: "run-2" },
      { conversationId: "conv-2" },
      { ownerEpoch: 4 },
      { executorId: "executor-2" },
      { workspace: { bindingRef: "workspace-2", workspaceBindingRevision: 7 } },
      { workspace: { bindingRef: "workspace-1", workspaceBindingRevision: 8 } },
      { issuedAt: EXPIRY },
      { expiry: NOW },
    ];
    for (const tamper of tamperings) {
      expect(() =>
        validateEvidenceRequest({ ...req, ...tamper }, verifier),
      ).toThrow();
    }
  });

  it("rejects illegal enums, empty and duplicate items", () => {
    for (const kind of ["conversation-fact", "none", "bogus"]) {
      expect(() =>
        request({ items: [{ kind, locator: {} }] }),
      ).toThrow("collectible evidence kind");
    }
    expect(() => request({ items: [] })).toThrow("non-empty array");
    expect(() =>
      request({
        items: [
          { kind: "file-diff", locator: {} },
          { kind: "file-diff", locator: {} },
        ],
      }),
    ).toThrow("duplicates");
    expect(() =>
      bundle({
        items: [
          {
            kind: "log",
            locator: { paths: ["a.log"] },
            contentDigest: protocolDigest("c", 1, { id: 1 }),
            summary: "一",
            source: "independent",
          },
          {
            kind: "log",
            locator: { paths: ["a.log"] },
            contentDigest: protocolDigest("c", 1, { id: 2 }),
            summary: "二",
            source: "independent",
          },
        ],
      }),
    ).toThrow("duplicates");
  });

  it("rejects non-relative and malformed locator paths", () => {
    for (const entry of [
      "/etc/passwd",
      "\\server\\share",
      "~/secret",
      "C:\\Users\\owner",
      "D:/work",
      "",
    ]) {
      expect(() =>
        request({ items: [{ kind: "log", locator: { paths: [entry] } }] }),
      ).toThrow();
    }
    expect(() =>
      request({ items: [{ kind: "log", locator: { paths: [] } }] }),
    ).toThrow("non-empty array");
    expect(() =>
      request({ items: [{ kind: "log", locator: { paths: [".", 1] } }] }),
    ).toThrow();
  });

  it("rejects malformed digests and digest hints", () => {
    expect(() =>
      request({
        items: [{ kind: "log", locator: { paths: ["a.log"] }, digestHint: "zz" }],
      }),
    ).toThrow("digest hint");
    expect(() => bundle({ requestDigest: "md5:00" })).toThrow("digest");
    expect(() =>
      bundle({
        observation: {
          observedAt: NOW,
          preStateFingerprint: "sha256:zz",
          postStateFingerprint: protocolDigest("p", 1, { id: 1 }),
          consistent: true,
        },
      }),
    ).toThrow("fingerprint");
    expect(() =>
      bundle({
        observation: {
          observedAt: "2026-08-01",
          preStateFingerprint: protocolDigest("p", 1, { id: 1 }),
          postStateFingerprint: protocolDigest("p", 1, { id: 1 }),
          consistent: true,
        },
      }),
    ).toThrow("timestamp");
    expect(() =>
      bundle({
        observation: {
          observedAt: NOW,
          preStateFingerprint: protocolDigest("p", 1, { id: 1 }),
          postStateFingerprint: protocolDigest("p", 1, { id: 1 }),
          consistent: "yes",
        },
      }),
    ).toThrow("boolean");
  });

  it("enforces the evidence lease binding and bounded budget", () => {
    expect(() =>
      request({ lease: evidenceLease({ workload: { kind: "run", id: "req-1", attempt: 1 } }) }),
    ).toThrow("workload is invalid");
    expect(() =>
      request({ lease: evidenceLease({ workload: { kind: "evidence", id: "req-2", attempt: 1 } }) }),
    ).toThrow("does not bind");
    expect(() =>
      request({ lease: evidenceLease({ admissionClass: "interactive" }) }),
    ).toThrow("does not bind");
    expect(() =>
      request({ lease: evidenceLease({ audience: { executorId: "executor-2" } }) }),
    ).toThrow("does not bind");
    expect(() =>
      request({
        lease: evidenceLease({
          scopeBinding: { kind: "conversation", conversationId: "conv-2", ownerEpoch: 3 },
        }),
      }),
    ).toThrow("does not bind");
    expect(() =>
      request({
        lease: evidenceLease({
          scopeBinding: { kind: "conversation", conversationId: "conv-1", ownerEpoch: 4 },
        }),
      }),
    ).toThrow("does not bind");
    expect(() => request({ lease: evidenceLease({ budget: {} }) })).toThrow(
      "at least one limit",
    );
    const rootDisguised = evidenceLease();
    const { parentId: _pid, parentDigest: _pd, ...rootFields } =
      rootDisguised as Record<string, unknown>;
    expect(() =>
      request({ lease: rootFields }),
    ).toThrow();
  });

  it("enforces the inline document byte limit at the exact boundary", () => {
    const base = request({
      items: [{ kind: "log", locator: { paths: ["x"] } }],
    });
    const fillerBase = Buffer.byteLength(canonicalize(base), "utf8");
    const exact = 1 + MAX_EVIDENCE_DOCUMENT_BYTES - fillerBase;
    expect(() =>
      request({ items: [{ kind: "log", locator: { paths: ["x".repeat(exact)] } }] }),
    ).not.toThrow();
    expect(() =>
      request({
        items: [{ kind: "log", locator: { paths: ["x".repeat(exact + 1)] } }],
      }),
    ).toThrow("inline byte limit");
  });

  it("enforces the summary byte limit and bundle item contract", () => {
    const item = {
      kind: "log",
      locator: { paths: ["a.log"] },
      contentDigest: protocolDigest("c", 1, { id: 1 }),
      source: "independent",
    } as const;
    expect(() =>
      bundle({ items: [{ ...item, summary: "x".repeat(MAX_EVIDENCE_SUMMARY_BYTES) }] }),
    ).not.toThrow();
    expect(() =>
      bundle({
        items: [{ ...item, summary: "x".repeat(MAX_EVIDENCE_SUMMARY_BYTES + 1) }],
      }),
    ).toThrow("summary");
    expect(() => bundle({ items: [{ ...item, summary: "" }] })).toThrow(
      "summary",
    );
    expect(() =>
      bundle({ items: [{ ...item, summary: "一", source: "execution-report" }] }),
    ).toThrow("independent");
    expect(() =>
      bundle({ items: [{ ...item, summary: "一", contentDigest: "sha256:zz" }] }),
    ).toThrow("digest");
  });

  it("rejects an empty bundle item set", () => {
    expect(() => bundle({ items: [] })).toThrow("non-empty");
  });
});
