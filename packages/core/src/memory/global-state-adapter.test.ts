import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "../authority/index.js";
import type {
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStagedMutation,
} from "../contracts/index.js";
import { MemoryStore } from "./memory-store.js";
import { AnchorMemoryGlobalStateAdapter } from "./global-state-adapter.js";
import { projectMemoryLogicalEntry } from "./logical-entry.js";

const NOW = "2026-08-04T00:00:00.000Z";

describe("AnchorMemoryGlobalStateAdapter", () => {
  it("plans staged personal memory, materializes only after commit, and returns path-free DTOs", async () => {
    const fixture = await createFixture();
    const mutation: GlobalStagedMutation = {
      kind: "memory-append",
      payload: {
        domain: "memory",
        scope: { kind: "personal" },
        category: "profile",
        id: "profile",
        meta: { name: "Alice" },
        content: "Prefers concise answers.",
      },
    };
    const plan = fixture.adapter.prepareStagedMutations({
      records: [{ seq: 1, requestId: "memory-save", mutation }],
    });
    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 1 });
    expect(await fixture.store.load("profile", "profile")).toBeNull();

    await fixture.log.append(plan.records);
    await fixture.adapter.applyStagedMutation({
      requestId: "memory-save",
      mutation,
      targetRevision: 1,
    });
    const result = await fixture.adapter.read(
      {
        kind: "memory-list",
        scope: { kind: "personal" },
        domain: "memory",
        category: "profile",
      },
      readContext("memory-list"),
    );
    expect(result.kind).toBe("memory-list");
    if (result.kind !== "memory-list") throw new Error("unexpected read result");
    expect(result.entries[0]).toMatchObject({
      id: "profile",
      revision: 1,
      content: "Prefers concise answers.",
    });
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(await fixture.store.load("profile", "profile")).toMatchObject({
      content: "Prefers concise answers.",
    });
  });

  it("serializes same-batch update/delete by digest and rejects stale scope capability", async () => {
    const fixture = await createFixture();
    await fixture.adapter.mutate(
      {
        kind: "memory-append",
        payload: {
          domain: "people",
          scope: { kind: "workscene", sceneId: "scene-a" },
          id: "person-a",
          meta: { name: "A" },
          content: "first",
        },
      },
      controlContext("create"),
    );
    const listed = await fixture.adapter.read(
      {
        kind: "memory-list",
        scope: { kind: "workscene", sceneId: "scene-a" },
        domain: "people",
      },
      readContext("read-created"),
    );
    if (listed.kind !== "memory-list") throw new Error("unexpected result");
    const current = listed.entries[0]!;
    const update: GlobalStagedMutation = {
      kind: "memory-append",
      payload: {
        domain: "people",
        scope: { kind: "workscene", sceneId: "scene-a" },
        id: "person-a",
        meta: { name: "A" },
        content: "second",
        expectedDigest: current.digest,
      },
    };
    const remove: GlobalStagedMutation = {
      kind: "memory-delete",
      scope: { kind: "workscene", sceneId: "scene-a" },
      domain: "people",
      id: "person-a",
      expectedDigest: "0".repeat(64),
    };
    const plan = fixture.adapter.prepareStagedMutations({
      records: [
        { seq: 1, requestId: "update", mutation: update },
        { seq: 2, requestId: "delete", mutation: remove },
      ],
    });
    expect(plan.outcomes.get(1)).toMatchObject({ t: "granted", targetRevision: 2 });
    expect(plan.outcomes.get(2)).toMatchObject({
      t: "conflicted",
      error: { code: "revision-conflict" },
    });

    await expect(
      fixture.adapter.read(
        {
          kind: "memory-list",
          scope: { kind: "workscene", sceneId: "scene-a" },
          domain: "people",
        },
        {
          ...readContext("wrong-capability"),
          principal: {
            kind: "assignment",
            capability: {
              authorityId: "authority",
              subject: "assignment",
              methods: ["global.read"],
              resources: ["memory-domain:personal"],
              issuedAt: NOW,
              expiresAt: "2026-08-04T02:00:00.000Z",
              nonce: "nonce",
              signature: { keyId: "key", algorithm: "ed25519", value: "sig" },
            },
          },
        },
      ),
    ).rejects.toThrow("does not cover");
  });

  it("accepts consecutive same-batch people updates using the shared projected digest", async () => {
    const fixture = await createFixture();
    await fixture.adapter.mutate(
      {
        kind: "memory-append",
        payload: {
          domain: "people",
          scope: { kind: "personal" },
          id: "person-a",
          meta: { name: "A", relation: "friend" },
          content: "first",
        },
      },
      controlContext("people-create"),
    );
    const listed = await fixture.adapter.read(
      { kind: "memory-list", scope: { kind: "personal" }, domain: "people" },
      readContext("people-current"),
    );
    if (listed.kind !== "memory-list") throw new Error("unexpected result");
    const current = listed.entries[0]!;
    const secondPayload = {
      domain: "people" as const,
      scope: { kind: "personal" as const },
      id: "person-a",
      meta: { name: "A", relation: "friend" },
      content: "second",
      expectedDigest: current.digest,
    };
    const projected = projectMemoryLogicalEntry(secondPayload, current, { revision: 2 });
    const plan = fixture.adapter.prepareStagedMutations({
      records: [
        {
          seq: 1,
          requestId: "people-second",
          mutation: { kind: "memory-append", payload: secondPayload },
        },
        {
          seq: 2,
          requestId: "people-third",
          mutation: {
            kind: "memory-append",
            payload: {
              ...secondPayload,
              content: "third",
              expectedDigest: projected.digest,
            },
          },
        },
      ],
    });

    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 2 });
    expect(plan.outcomes.get(2)).toEqual({ t: "granted", targetRevision: 3 });
  });
});

async function createFixture() {
  const root = await createTempDir("zhixing-memory-global-state");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  });
  const memoryRoot = path.join(root, "memory");
  return {
    root,
    log,
    store: new MemoryStore(memoryRoot),
    adapter: new AnchorMemoryGlobalStateAdapter({
      log,
      anchorEpoch: 1,
      scopeRoot: () => memoryRoot,
      clock: () => NOW,
    }),
  };
}

function readContext(requestId: string): GlobalReadCallContext {
  return {
    principal: { kind: "host", component: "memory-test" },
    requestId,
    authority: { domain: "global", anchorEpoch: 1 },
    deadlineAt: "2026-08-04T01:00:00.000Z",
  };
}

function controlContext(requestId: string): GlobalControlCallContext {
  return readContext(requestId) as GlobalControlCallContext;
}
