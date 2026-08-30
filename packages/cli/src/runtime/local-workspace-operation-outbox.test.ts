import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { protocolDigest } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { LocalWorkspaceOperationOutbox } from "./local-workspace-operation-outbox.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "@zhixing/core/environment/workspace-administration";

async function createRoot(): Promise<string> {
  return path.join(await createTempDir("workspace-outbox"), "outbox");
}

describe("LocalWorkspaceOperationOutbox", () => {
  it("reuses one stable identity across restart until causal completion is acknowledged", async () => {
    const root = await createRoot();
    const first = new LocalWorkspaceOperationOutbox({ rootDir: root });
    const prepared = await first.prepare({
      kind: "create",
      purpose: "settings",
      displayName: "paper",
      absolutePath: "C:\\paper",
    });
    await first.commit(prepared);

    const restarted = new LocalWorkspaceOperationOutbox({ rootDir: root });
    const replay = await restarted.prepare(prepared.input);
    expect(replay).toMatchObject({
      localSeq: prepared.localSeq,
      operationId: prepared.operationId,
      inputDigest: prepared.inputDigest,
      state: "committed",
    });
    const completed = await restarted.complete(replay, { ok: true, value: { name: "paper" } });
    const page = await restarted.pending();
    let prefixDigest = page.confirmation.prefixDigest;
    const entry = {
      localSeq: completed.localSeq,
      operationId: completed.operationId,
      inputDigest: completed.inputDigest,
      resultDigest: completed.resultDigest!,
    };
    prefixDigest = protocolDigest("LocalWorkspaceOperationPrefix", 1, {
      previous: prefixDigest,
      ...entry,
    });
    const receipt = await restarted.acknowledge({
      outboxId: page.outboxId,
      throughSeq: completed.localSeq,
      prefixDigest,
      entries: [entry],
    });
    expect(receipt).toEqual({
      outboxId: page.outboxId,
      throughSeq: completed.localSeq,
      prefixDigest,
    });
    await expect(restarted.acknowledge({
      outboxId: page.outboxId,
      throughSeq: completed.localSeq,
      prefixDigest,
      entries: [entry],
    })).resolves.toEqual(receipt);
    await expect(restarted.acknowledge({
      outboxId: "outbox-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      throughSeq: completed.localSeq,
      prefixDigest,
      entries: [entry],
    })).rejects.toThrow("another outbox");
    expect((await restarted.pending()).operations).toEqual([]);
  });

  it("does not acknowledge across a prepared hole and rejects digest rebinding", async () => {
    const outbox = new LocalWorkspaceOperationOutbox({ rootDir: await createRoot() });
    await outbox.prepare({ kind: "remove", name: "one", expectedRevision: 1 });
    const second = await outbox.prepare({ kind: "remove", name: "two", expectedRevision: 1 });
    await outbox.commit(second);
    const completed = await outbox.complete(second, { ok: true, value: null });
    await expect(outbox.acknowledge({
      outboxId: outbox.outboxId,
      throughSeq: 2,
      prefixDigest: completed.resultDigest!,
      entries: [{
        localSeq: 2,
        operationId: completed.operationId,
        inputDigest: completed.inputDigest,
        resultDigest: completed.resultDigest!,
      }],
    })).rejects.toThrow("hole");
  });

  it("recovers a checkpoint rollback only from the complete causally confirmed log", async () => {
    const root = await createRoot();
    const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
    const prepared = await outbox.prepare({ kind: "remove", name: "one", expectedRevision: 1 });
    const committed = await outbox.commit(prepared);
    const completed = await outbox.complete(committed, { ok: true, value: null });
    const file = path.join(root, "operations.ndjson");
    const beforeCheckpoint = await readFile(file, "utf8");
    const page = await outbox.pending();
    const entry = {
      localSeq: completed.localSeq,
      operationId: completed.operationId,
      inputDigest: completed.inputDigest,
      resultDigest: completed.resultDigest!,
    };
    const prefixDigest = protocolDigest("LocalWorkspaceOperationPrefix", 1, {
      previous: page.confirmation.prefixDigest,
      ...entry,
    });
    await outbox.acknowledge({
      outboxId: page.outboxId,
      throughSeq: 1,
      prefixDigest,
      entries: [entry],
    });

    await writeFile(file, beforeCheckpoint, "utf8");
    const recovered = new LocalWorkspaceOperationOutbox({ rootDir: root });
    await recovered.initialize();
    expect((await recovered.pending()).operations).toEqual([]);
  });

  it("fails closed when established storage is missing or its hash chain is damaged", async () => {
    const root = await createRoot();
    const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
    await outbox.prepare({ kind: "remove", name: "one", expectedRevision: 1 });
    await unlink(path.join(root, "operations.ndjson"));
    await expect(new LocalWorkspaceOperationOutbox({ rootDir: root }).initialize())
      .rejects.toThrow("missing");

    const other = await createRoot();
    const intact = new LocalWorkspaceOperationOutbox({ rootDir: other });
    await intact.prepare({ kind: "remove", name: "one", expectedRevision: 1 });
    const file = path.join(other, "operations.ndjson");
    const content = await readFile(file, "utf8");
    await writeFile(file, content.replace(/"digest":"sha256:[0-9a-f]+"/u, '"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"'));
    await expect(new LocalWorkspaceOperationOutbox({ rootDir: other }).initialize())
      .rejects.toThrow("digest");

    const rebound = await createRoot();
    const established = new LocalWorkspaceOperationOutbox({ rootDir: rebound });
    await established.initialize();
    const marker = `${rebound}.established`;
    const markerRecord = JSON.parse(await readFile(marker, "utf8"));
    markerRecord.outboxId = "outbox-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(marker, `${JSON.stringify(markerRecord)}\n`, "utf8");
    await expect(new LocalWorkspaceOperationOutbox({ rootDir: rebound }).initialize())
      .rejects.toThrow("identity");
  });

  it("binds reset preview and commit to one durable identity across restart", async () => {
    const root = await createRoot();
    const clock = () => "2026-08-01T00:00:00.000Z";
    const first = new LocalWorkspaceOperationOutbox({ rootDir: root, clock });
    const preview = await first.prepare({
      kind: "reset",
      expectedCatalogGeneration: "catalog-a",
      impact: WORKSPACE_CATALOG_RESET_IMPACT,
    });
    expect(preview).toMatchObject({ state: "prepared" });
    expect(preview.confirmationToken).toBeUndefined();
    expect(preview.expiresAt).toBe("2026-08-01T00:15:00.000Z");

    const restarted = new LocalWorkspaceOperationOutbox({ rootDir: root, clock });
    await expect(restarted.prepare(preview.input)).resolves.toMatchObject({
      operationId: preview.operationId,
      localSeq: preview.localSeq,
      inputDigest: preview.inputDigest,
    });
    await expect(restarted.commit(preview, { impact: "another impact" }))
      .rejects.toThrow("does not match");
    const committed = await restarted.commit(preview, {
      impact: WORKSPACE_CATALOG_RESET_IMPACT,
    });
    expect(committed).toMatchObject({
      state: "committed",
      operationId: preview.operationId,
    });
    expect(committed.confirmationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("abandons an expired reset preview without creating a committed obligation", async () => {
    const root = await createRoot();
    let now = "2026-08-01T00:00:00.000Z";
    const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root, clock: () => now });
    const preview = await outbox.prepare({
      kind: "reset",
      expectedCatalogGeneration: "catalog-a",
      impact: WORKSPACE_CATALOG_RESET_IMPACT,
    });
    now = "2026-08-01T00:15:00.001Z";
    await expect(outbox.commit(preview, { impact: WORKSPACE_CATALOG_RESET_IMPACT }))
      .rejects.toThrow("abandoned");
    await expect(outbox.pending()).resolves.toMatchObject({
      operations: [expect.objectContaining({
        operationId: preview.operationId,
        state: "abandoned",
      })],
    });
  });
});
