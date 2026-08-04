import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CapabilityDescriptor,
  EnvironmentPort,
  EvidenceRequest,
  ExecutorVersionInventory,
  ResourceLease,
  Signature,
} from "@zhixing/core/contracts";
import {
  createSignedEvidenceRequest,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceJournal } from "../evidence-journal.js";
import { ExecutorEvidenceHandler } from "../executor-evidence.js";

const ISSUED_AT = "2026-08-03T00:00:00.000Z";
const EXPIRY = "2026-08-03T01:00:00.000Z";
const roots: string[] = [];

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId: string, version: number, payload: unknown): Signature {
    return {
      alg: "test-sha256",
      keyId: "test",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    if (
      signature.alg !== "test-sha256" ||
      signature.keyId !== "test" ||
      signature.sig !== protocolDigest(schemaId, version, payload)
    ) {
      throw new TypeError("signature mismatch");
    }
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ExecutorEvidenceHandler", () => {
  it("persists a bundle before return and replays it after expiry without filesystem access", async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, "workspace", "logs"), { recursive: true });
    await fs.writeFile(path.join(root, "workspace", "logs", "run.log"), "passed\n");
    let now = "2026-08-03T00:10:00.000Z";
    let environmentCalls = 0;
    const environment = environmentFor(path.join(root, "workspace"), () => environmentCalls++);
    const journal = new EvidenceJournal({
      file: path.join(root, "evidence.jsonl"),
      verifier: identity,
      now: () => now,
    });
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-1",
      environment,
      journal,
      signer: identity,
      verifier: identity,
      now: () => now,
    });
    const input = request();

    const first = await handler.collect(input, new AbortController().signal);
    expect(first.kind).toBe("bundle");
    expect(environmentCalls).toBe(2);
    expect(await fs.readFile(path.join(root, "evidence.jsonl"), "utf8")).toContain(
      '"t":"completed"',
    );

    now = "2026-08-03T02:00:00.000Z";
    const replay = await handler.collect(input, new AbortController().signal);
    expect(replay).toEqual(first);
    expect(environmentCalls).toBe(2);
  });

  it("rejects an invalid target before touching the environment or journal", async () => {
    const root = await temporaryRoot();
    let environmentCalls = 0;
    const environment = environmentFor(root, () => environmentCalls++);
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-2",
      environment,
      journal: new EvidenceJournal({
        file: path.join(root, "evidence.jsonl"),
        verifier: identity,
      }),
      signer: identity,
      verifier: identity,
      now: () => "2026-08-03T00:10:00.000Z",
    });

    await expect(handler.collect(request(), new AbortController().signal)).rejects.toThrow(
      "another executor",
    );
    expect(environmentCalls).toBe(0);
    await expect(fs.stat(path.join(root, "evidence.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects new evidence work after shutdown admission closes", async () => {
    const root = await temporaryRoot();
    let environmentCalls = 0;
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-1",
      environment: environmentFor(root, () => environmentCalls++),
      journal: new EvidenceJournal({
        file: path.join(root, "evidence.jsonl"),
        verifier: identity,
      }),
      signer: identity,
      verifier: identity,
      now: () => "2026-08-03T00:10:00.000Z",
    });

    handler.stopAccepting();
    await expect(handler.collect(request(), new AbortController().signal)).rejects.toThrow(
      "is stopping",
    );
    expect(environmentCalls).toBe(0);
    await expect(fs.stat(path.join(root, "evidence.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns typed stale evidence when the observed locator changes mid-read", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const log = path.join(workspace, "logs", "run.log");
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(log, "before\n");
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-1",
      environment: environmentFor(workspace),
      journal: new EvidenceJournal({
        file: path.join(root, "evidence.jsonl"),
        verifier: identity,
      }),
      signer: identity,
      verifier: identity,
      now: () => "2026-08-03T00:10:00.000Z",
      betweenObservations: () => fs.writeFile(log, "after\n"),
    });

    const result = await handler.collect(request(), new AbortController().signal);
    expect(result.kind).toBe("bundle");
    if (result.kind === "bundle") {
      expect(result.bundle.observation.consistent).toBe(false);
      expect(result.bundle.items[0]?.summary).not.toContain(workspace);
    }
  });

  it("discards bytes when the authorized path is replaced after its handle opens", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const log = path.join(workspace, "logs", "run.log");
    const displaced = path.join(workspace, "logs", "run.displaced.log");
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(log, "authorized-before-open\n");
    let replaced = false;
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-1",
      environment: environmentFor(workspace),
      journal: new EvidenceJournal({
        file: path.join(root, "evidence.jsonl"),
        verifier: identity,
      }),
      signer: identity,
      verifier: identity,
      now: () => "2026-08-03T00:10:00.000Z",
      afterFileOpened: async (canonicalPath) => {
        if (replaced) return;
        replaced = true;
        await fs.rename(canonicalPath, displaced);
        await fs.writeFile(canonicalPath, "replacement-must-not-be-evidence\n");
      },
    });

    const result = await handler.collect(request(), new AbortController().signal);
    expect(result.kind).toBe("bundle");
    if (result.kind === "bundle") {
      expect(result.bundle.observation.consistent).toBe(false);
      expect(result.bundle.items[0]?.summary).not.toContain(
        "replacement-must-not-be-evidence",
      );
    }
  });

  it("rejects binding revision drift before reading workspace evidence", async () => {
    const root = await temporaryRoot();
    let resolveCalls = 0;
    const base = environmentFor(root, () => resolveCalls++);
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-1",
      environment: {
        ...base,
        async resolveWorkspace() {
          resolveCalls++;
          return { absolutePath: root, workspaceBindingRevision: 8 };
        },
      },
      journal: new EvidenceJournal({ file: path.join(root, "journal.jsonl"), verifier: identity }),
      signer: identity,
      verifier: identity,
      now: () => "2026-08-03T00:10:00.000Z",
    });

    await expect(handler.collect(request(), new AbortController().signal)).resolves.toEqual({
      kind: "capability-gap",
    });
    expect(resolveCalls).toBe(2);
  });

  it("does not admit digest-mismatched or missing evidence as an independent bundle", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, "logs"), { recursive: true });
    await fs.writeFile(path.join(workspace, "logs", "run.log"), "api_key=sk-secret-value\n");
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-1",
      environment: environmentFor(workspace),
      journal: new EvidenceJournal({ file: path.join(root, "journal.jsonl"), verifier: identity }),
      signer: identity,
      verifier: identity,
      now: () => "2026-08-03T00:10:00.000Z",
    });
    const mismatch = request({
      items: [{
        kind: "log",
        locator: { paths: ["logs/run.log"] },
        digestHint: `sha256:${"a".repeat(64)}`,
      }],
    });
    await expect(handler.collect(mismatch, new AbortController().signal)).resolves.toEqual({
      kind: "capability-gap",
    });

    const visible = await handler.collect(
      request({ requestId: "request-secret" }),
      new AbortController().signal,
    );
    expect(visible.kind).toBe("bundle");
    if (visible.kind === "bundle") {
      expect(visible.bundle.items[0]?.summary).not.toContain("sk-secret-value");
    }
  });

  it("frames every requested file identity so byte redistribution cannot collide", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, "logs"), { recursive: true });
    const firstPath = path.join(workspace, "logs", "a.log");
    const secondPath = path.join(workspace, "logs", "b.log");
    await fs.writeFile(firstPath, "ab");
    await fs.writeFile(secondPath, "c");
    const makeHandler = (journalName: string) =>
      new ExecutorEvidenceHandler({
        executorId: "executor-1",
        environment: environmentFor(workspace),
        journal: new EvidenceJournal({
          file: path.join(root, journalName),
          verifier: identity,
        }),
        signer: identity,
        verifier: identity,
        now: () => "2026-08-03T00:10:00.000Z",
      });
    const first = await makeHandler("first.jsonl").collect(
      request({
        requestId: "request-framed-first",
        items: [
          {
            kind: "log",
            locator: { paths: ["logs/a.log", "logs/b.log"] },
          },
        ],
      }),
      new AbortController().signal,
    );
    await fs.writeFile(firstPath, "a");
    await fs.writeFile(secondPath, "bc");
    const second = await makeHandler("second.jsonl").collect(
      request({
        requestId: "request-framed-second",
        items: [
          {
            kind: "log",
            locator: { paths: ["logs/a.log", "logs/b.log"] },
          },
        ],
      }),
      new AbortController().signal,
    );

    expect(first.kind).toBe("bundle");
    expect(second.kind).toBe("bundle");
    if (first.kind === "bundle" && second.kind === "bundle") {
      expect(first.bundle.items[0]?.contentDigest).not.toBe(
        second.bundle.items[0]?.contentDigest,
      );
    }
  });

  it("coalesces concurrent duplicate requests and fails closed on journal corruption", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, "logs"), { recursive: true });
    await fs.writeFile(path.join(workspace, "logs", "run.log"), "passed\n");
    let environmentCalls = 0;
    const file = path.join(root, "journal.jsonl");
    const handler = new ExecutorEvidenceHandler({
      executorId: "executor-1",
      environment: environmentFor(workspace, () => environmentCalls++),
      journal: new EvidenceJournal({ file, verifier: identity }),
      signer: identity,
      verifier: identity,
      now: () => "2026-08-03T00:10:00.000Z",
    });
    const input = request();
    const [left, right] = await Promise.all([
      handler.collect(input, new AbortController().signal),
      handler.collect(input, new AbortController().signal),
    ]);
    expect(left).toEqual(right);
    expect(environmentCalls).toBe(2);

    await fs.writeFile(file, "not-json\n");
    const corrupt = new EvidenceJournal({ file, verifier: identity });
    await expect(corrupt.begin(input)).rejects.toThrow("corrupt");
  });
});

describe("EvidenceJournal", () => {
  it("rejects requestId conflicts and only compacts expired terminal records", async () => {
    const root = await temporaryRoot();
    let now = "2026-08-03T00:00:00.000Z";
    const file = path.join(root, "journal.jsonl");
    const journal = new EvidenceJournal({
      file,
      verifier: identity,
      now: () => now,
      retentionMs: 1_000,
    });
    const terminal = request();
    await journal.begin(terminal);
    await journal.complete(terminal, { kind: "capability-gap" });
    const pending = request({ requestId: "request-pending" });
    await journal.begin(pending);
    await expect(
      journal.begin(request({ requestId: terminal.requestId, runId: "run-other" })),
    ).rejects.toThrow("another request");

    now = "2026-08-03T00:00:02.000Z";
    expect(await journal.compact()).toBe(1);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain(terminal.requestId);
    expect(raw).toContain(pending.requestId);

    const reopened = new EvidenceJournal({ file, verifier: identity, now: () => now });
    expect(await reopened.begin(pending)).toEqual({ kind: "new" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-evidence-"));
  roots.push(root);
  return root;
}

function environmentFor(
  workspace: string,
  onUse: () => void = () => undefined,
): EnvironmentPort {
  const descriptor: CapabilityDescriptor = {
    v: 1,
    executorId: "executor-1",
    revision: 1,
    protocolVersion: "1",
    workspaces: [
      { bindingRef: "workspace-1", workspaceBindingRevision: 7, displayName: "项目" },
    ],
    tools: [],
    mcpServers: [],
    credentialBindings: [],
    evidenceCapabilities: ["file-diff", "log", "artifact"],
    at: ISSUED_AT,
    signature: identity.sign("CapabilityDescriptor", 1, {}),
  };
  return {
    async resolveWorkspace() {
      onUse();
      return { absolutePath: workspace, workspaceBindingRevision: 7 };
    },
    async capabilitySnapshot() {
      onUse();
      return descriptor;
    },
    async probePath() {
      return "directory";
    },
    async versionInventory(): Promise<ExecutorVersionInventory> {
      throw new Error("unused");
    },
  };
}

function request(overrides: Partial<Omit<EvidenceRequest, "signature">> = {}): EvidenceRequest {
  const requestId = overrides.requestId ?? "request-1";
  const lease = childLease(requestId);
  return createSignedEvidenceRequest(
    {
      v: 1,
      requestId,
      reviewId: "review-1",
      runId: "run-1",
      conversationId: "conversation-1",
      ownerEpoch: 3,
      executorId: "executor-1",
      workspace: { bindingRef: "workspace-1", workspaceBindingRevision: 7 },
      items: [{ kind: "log", locator: { paths: ["logs/run.log"] } }],
      lease,
      issuedAt: ISSUED_AT,
      expiry: EXPIRY,
      ...overrides,
    },
    identity,
    identity,
  );
}

function childLease(requestId: string): ResourceLease {
  const payload = {
    v: 1 as const,
    reservationId: `evidence-lease:${requestId}`,
    parentId: "review-lease-1",
    parentDigest: protocolDigest("ResourceLease", 1, { id: "review-lease-1" }),
    admissionClass: "advancement" as const,
    workload: { kind: "evidence" as const, id: requestId, attempt: 1 },
    scopeBinding: {
      kind: "conversation" as const,
      conversationId: "conversation-1",
      ownerEpoch: 3,
    },
    audience: { executorId: "executor-1" },
    budget: { maxCalls: 1 },
    domain: { kind: "anchor" as const, anchorEpoch: 1 },
    issuedAt: ISSUED_AT,
    expiry: EXPIRY,
  };
  const withDigest = { ...payload, digest: protocolDigest("ResourceLease", 1, payload) };
  return { ...withDigest, signature: identity.sign("ResourceLease", 1, withDigest) };
}
