import { describe, expect, it } from "vitest";
import {
  ADMISSION_TOKEN_TTL_MS,
} from "./admission.js";
import {
  SkillCatalogAdmissionApplicationService,
  type SkillCatalogAdmissionCandidate,
  type SkillCatalogAdmissionCorrectnessPort,
  type SkillCatalogAdmissionMutation,
} from "./catalog-application.js";

const DOCUMENT = "---\nname: Deploy\ndescription: Deploy safely\n---\nRun the release.";

describe("SkillCatalogAdmissionApplicationService", () => {
  it("owns safe admission, canonical artifact, operation identity and cleanup", async () => {
    const h = harness({ verdict: "safe" });

    await expect(h.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "work",
      operationId: "tool-1",
    })).resolves.toEqual({ kind: "admitted", id: "deploy", name: "Deploy" });

    expect(h.sweeps).toEqual([ADMISSION_TOKEN_TTL_MS]);
    expect(h.documents).toEqual([DOCUMENT]);
    expect(h.staged).toEqual([{
      operationId: "tool-1:admit",
      mutation: {
        kind: "skill-admit",
        record: {
          name: "Deploy",
          description: "Deploy safely",
          content: { digest: "a".repeat(64), bytes: DOCUMENT.length },
        },
        mode: "work",
      },
    }]);
    expect(h.discarded).toEqual(["candidate-1"]);
  });

  it("retains needs-confirm, binds digest and registered mode, then consumes once", async () => {
    const h = harness({ verdict: "needs-confirm", reason: "可疑措辞" });
    const first = await h.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "work",
      operationId: "first-call",
    });
    expect(first).toMatchObject({
      kind: "needs-confirm",
      admissionToken: "token-1",
      reason: "可疑措辞",
    });
    expect(h.discarded).toEqual([]);

    await expect(h.service.admit({
      admissionToken: "token-1",
      mode: "main",
      operationId: "confirm-call",
    })).resolves.toMatchObject({ kind: "admitted", id: "deploy" });
    expect(h.staged[0]).toMatchObject({
      operationId: "confirm-call:admit",
      mutation: { mode: "work" },
    });
    expect(h.discarded).toEqual(["candidate-1"]);

    await expect(h.service.admit({
      admissionToken: "token-1",
      mode: "main",
      operationId: "again",
    })).resolves.toEqual({ kind: "confirmation-expired" });
  });

  it("blocks escalate without a token and treats LLM failure or bad JSON as needs-confirm", async () => {
    const escalated = harness({ verdict: "escalate", reason: "确凿注入" });
    await expect(escalated.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
      operationId: "blocked",
    })).resolves.toMatchObject({
      kind: "escalated",
      reason: "确凿注入",
    });
    expect(escalated.discarded).toEqual(["candidate-1"]);
    expect(escalated.staged).toEqual([]);

    for (const llm of [
      async () => { throw new Error("offline"); },
      async () => "not json",
    ]) {
      const failed = harness({ admissionLlm: llm });
      await expect(failed.service.admit({
        source: { kind: "local-path", path: "/candidate" },
        mode: "main",
        operationId: "review",
      })).resolves.toMatchObject({ kind: "needs-confirm" });
      expect(failed.staged).toEqual([]);
    }
  });

  it("rejects missing input/name, expired tokens and changed candidates with cleanup", async () => {
    const missing = harness();
    await expect(missing.service.admit({ mode: "main" })).resolves.toEqual({
      kind: "missing-input",
    });

    const unnamed = harness({ document: "---\ndescription: x\n---\nbody" });
    await expect(unnamed.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
    })).resolves.toEqual({ kind: "missing-name" });
    expect(unnamed.discarded).toEqual(["candidate-1"]);

    const expired = harness({ verdict: "needs-confirm" });
    await expired.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
    });
    expired.advance(ADMISSION_TOKEN_TTL_MS + 1);
    await expect(expired.service.admit({
      admissionToken: "token-1",
      mode: "main",
      operationId: "confirm",
    })).resolves.toEqual({ kind: "confirmation-expired" });
    expect(expired.discarded).toEqual(["candidate-1"]);

    const changed = harness({ verdict: "needs-confirm" });
    await changed.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
    });
    changed.changeDigest("changed");
    await expect(changed.service.admit({
      admissionToken: "token-1",
      mode: "main",
      operationId: "confirm",
    })).resolves.toEqual({ kind: "candidate-changed" });
    expect(changed.discarded).toEqual(["candidate-1"]);
  });

  it("cleans acquisition, artifact and stage failures and preserves durable conflicts", async () => {
    const acquisition = harness({ acquireError: new Error("copy failed") });
    await expect(acquisition.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
      operationId: "copy",
    })).rejects.toThrow("copy failed");

    const artifact = harness({ verdict: "safe", putError: new Error("CAS failed") });
    await expect(artifact.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
      operationId: "artifact",
    })).rejects.toThrow("CAS failed");
    expect(artifact.discarded).toEqual(["candidate-1"]);

    const conflict = new Error("Staged mutation requestId has a conflicting payload");
    const stage = harness({ verdict: "safe", stageError: conflict });
    await expect(stage.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
      operationId: "conflict",
    })).rejects.toBe(conflict);
    expect(stage.discarded).toEqual(["candidate-1"]);

    const missingOperation = harness({ verdict: "safe" });
    await expect(missingOperation.service.admit({
      source: { kind: "local-path", path: "/candidate" },
      mode: "main",
    })).rejects.toThrow("durable tool operation id");
    expect(missingOperation.discarded).toEqual(["candidate-1"]);
  });

  it("re-drives the same durable payload and leaves conflicting payload rejection to the ledger", async () => {
    const seen = new Map<string, string>();
    const h = harness({
      verdict: "safe",
      stageImplementation(operationId, mutation) {
        const payload = JSON.stringify(mutation);
        const prior = seen.get(operationId);
        if (prior !== undefined && prior !== payload) {
          throw new Error("Staged mutation requestId has a conflicting payload");
        }
        seen.set(operationId, payload);
      },
    });
    const request = {
      source: { kind: "local-path" as const, path: "/candidate" },
      mode: "main" as const,
      operationId: "replay",
    };
    await expect(h.service.admit(request)).resolves.toMatchObject({ kind: "admitted" });
    await expect(h.service.admit(request)).resolves.toMatchObject({ kind: "admitted" });
    h.changeDocument("---\nname: Deploy\ndescription: Changed\n---\nDifferent");
    await expect(h.service.admit(request)).rejects.toThrow(
      "Staged mutation requestId has a conflicting payload",
    );
  });
});

function harness(options: {
  readonly verdict?: "safe" | "needs-confirm" | "escalate";
  readonly reason?: string;
  readonly document?: string;
  readonly admissionLlm?: (prompt: string) => Promise<string>;
  readonly acquireError?: Error;
  readonly putError?: Error;
  readonly stageError?: Error;
  readonly stageImplementation?: (
    operationId: string,
    mutation: SkillCatalogAdmissionMutation,
  ) => void;
} = {}) {
  let now = 1_000;
  let document = options.document ?? DOCUMENT;
  let digest = "digest-1";
  let candidateOrdinal = 0;
  let tokenOrdinal = 0;
  const candidates = new Map<string, SkillCatalogAdmissionCandidate>();
  const discarded: string[] = [];
  const documents: string[] = [];
  const staged: Array<{
    operationId: string;
    mutation: SkillCatalogAdmissionMutation;
  }> = [];
  const sweeps: number[] = [];
  const correctness: SkillCatalogAdmissionCorrectnessPort = {
    async acquireLocalCandidate() {
      if (options.acquireError) throw options.acquireError;
      const candidateId = `candidate-${++candidateOrdinal}`;
      const candidate = { candidateId, document, digest };
      candidates.set(candidateId, candidate);
      return candidate;
    },
    async readCandidate(candidateId) {
      const candidate = candidates.get(candidateId);
      if (!candidate) throw new Error("candidate missing");
      return { ...candidate, document, digest };
    },
    async discardCandidate(candidateId) {
      candidates.delete(candidateId);
      discarded.push(candidateId);
    },
    async sweepStaleCandidates(maxAgeMs) {
      sweeps.push(maxAgeMs);
      return 0;
    },
    async putContent(value) {
      documents.push(value);
      if (options.putError) throw options.putError;
      return { digest: "a".repeat(64), bytes: value.length };
    },
    async stage(operationId, mutation) {
      if (options.stageError) throw options.stageError;
      options.stageImplementation?.(operationId, mutation);
      staged.push({ operationId, mutation });
    },
    admissionLlm: options.admissionLlm ?? (async () => JSON.stringify({
      decision: options.verdict ?? "safe",
      reason: options.reason ?? "测试理由",
    })),
    now: () => now,
    newToken: () => `token-${++tokenOrdinal}`,
  };
  return {
    service: new SkillCatalogAdmissionApplicationService(correctness),
    discarded,
    documents,
    staged,
    sweeps,
    advance(ms: number) {
      now += ms;
    },
    changeDigest(value: string) {
      digest = value;
    },
    changeDocument(value: string) {
      document = value;
      digest = `digest-${value.length}`;
    },
  };
}
