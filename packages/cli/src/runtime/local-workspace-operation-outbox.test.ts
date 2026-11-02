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

  it("执行尝试号缺省为 1、只在已提交后逐位推进并跨重启保留，完成沿用最后一次", async () => {
    const root = await createRoot();
    const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
    const prepared = await outbox.prepare({ kind: "create", purpose: "settings", displayName: "paper", absolutePath: "C:\\paper" });
    await expect(outbox.advanceExecutionAttempt(prepared, 1)).rejects.toThrow("Only a committed");
    const committed = await outbox.commit(prepared);
    expect(committed.executionAttempt).toBeUndefined();

    await expect(outbox.advanceExecutionAttempt(committed, 1)).resolves.toMatchObject({ executionAttempt: 2 });
    // 观察到的号已过时（先前的推进已落盘）：原样返回，不再追加
    const before = (await readFile(path.join(root, "operations.ndjson"), "utf8")).split("\n").filter(Boolean).length;
    await expect(outbox.advanceExecutionAttempt(committed, 1)).resolves.toMatchObject({ executionAttempt: 2 });
    expect((await readFile(path.join(root, "operations.ndjson"), "utf8")).split("\n").filter(Boolean)).toHaveLength(before);
    await expect(outbox.advanceExecutionAttempt(committed, 3)).rejects.toThrow("moved backwards");

    const restarted = new LocalWorkspaceOperationOutbox({ rootDir: root });
    await expect(restarted.oldestCommitted()).resolves.toMatchObject({ executionAttempt: 2 });
    await expect(restarted.advanceExecutionAttempt(committed, 2)).resolves.toMatchObject({ executionAttempt: 3 });
    await expect(restarted.complete(committed, { ok: true, value: null })).resolves.toMatchObject({
      state: "completed",
      executionAttempt: 3,
    });
    await expect(new LocalWorkspaceOperationOutbox({ rootDir: root }).pending()).resolves.toMatchObject({
      operations: [expect.objectContaining({ state: "completed", executionAttempt: 3 })],
    });
  });

  it("拒绝越位或出现在未提交记录上的尝试号", async () => {
    const root = await createRoot();
    const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
    const prepared = await outbox.prepare({ kind: "create", purpose: "settings", displayName: "paper", absolutePath: "C:\\paper" });
    await outbox.commit(prepared);
    const file = path.join(root, "operations.ndjson");
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const tamper = async (mutate: (operation: Record<string, unknown>) => void, index = lines.length - 1) => {
      const rewritten = [...lines];
      const event = JSON.parse(rewritten[index]!) as Record<string, unknown> & { operation: Record<string, unknown> };
      mutate(event.operation);
      const { digest: _digest, ...body } = event;
      rewritten[index] = JSON.stringify({ ...body, digest: protocolDigest("LocalWorkspaceOperationEvent", 1, body) });
      await writeFile(file, `${rewritten.join("\n")}\n`);
      return new LocalWorkspaceOperationOutbox({ rootDir: root }).pending();
    };
    await expect(tamper((operation) => { operation.executionAttempt = 3; })).rejects.toThrow();
    await expect(tamper((operation) => { operation.executionAttempt = 1; })).rejects.toThrow();
    await expect(tamper((operation) => { operation.executionAttempt = 2; }, lines.length - 2)).rejects.toThrow();
  });

  it("追加结果不明时按磁盘重读，已落盘的推进不会再写第二次", async () => {
    const root = await createRoot();
    let failAfterWrite = false;
    const storageMaintenance = {
      acquire: async () => ({
        kind: "granted" as const,
        permit: {
          granted: { occupancy: { memoryReservationBytes: 0, temporaryBytes: 0, slots: 0 }, quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 } },
          tryBegin: () => ({
            complete: () => {
              if (failAfterWrite) {
                failAfterWrite = false;
                throw new Error("write outcome unknown");
              }
            },
          }),
          release: () => undefined,
        },
      }),
      snapshot: () => ({}),
    } as never;
    const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root, storageMaintenance });
    const prepared = await outbox.prepare({ kind: "create", purpose: "settings", displayName: "paper", absolutePath: "C:\\paper" });
    const committed = await outbox.commit(prepared);
    failAfterWrite = true;
    await expect(outbox.advanceExecutionAttempt(committed, 1)).rejects.toThrow("write outcome unknown");
    // 内存态已按磁盘重读：看到推进已落盘，原样返回；后续追加接在真实链尾
    expect(outbox.operation(committed).executionAttempt).toBe(2);
    await expect(outbox.advanceExecutionAttempt(committed, 1)).resolves.toMatchObject({ executionAttempt: 2 });
    await outbox.complete(committed, { ok: true, value: null });
    await expect(new LocalWorkspaceOperationOutbox({ rootDir: root }).pending()).resolves.toMatchObject({
      operations: [expect.objectContaining({ state: "completed", executionAttempt: 2 })],
    });
  });
});
