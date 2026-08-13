import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assert,
  createS7TempDir,
  expectFailure,
  observeReasonCode,
  type DurableCaseKind,
} from "@zhixing/core/test-support/s7-durable-harness";
import {
  LocalWorkspaceOperationOutbox,
  type LocalWorkspaceWriteOperation,
} from "../../runtime/local-workspace-operation-outbox.js";
import {
  LocalWorkspaceManagementHost,
  readLocalWorkspaceHostStatus,
} from "../../runtime/local-workspace-management-host.js";
import { acquireLocalWorkspaceOwner } from "../../runtime/local-workspace-owner.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "../../runtime/workspace-reset-impact.js";

export async function executeLocalWorkspaceOutboxCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    if (caseKey === "prepared") {
      const outbox = await createOutbox();
      const prepared = await outbox.prepare(createInput("prepared"));
      assert(prepared.state === "prepared", "prepare did not persist the prepared state");
      await recoverOutboxWithHost(outbox);
      assert(
        (await new LocalWorkspaceOperationOutbox({ rootDir: outboxRoot(outbox) }).pending()).operations[0]?.state === "prepared",
        "recovery host changed an uncommitted operation",
        { kind: "variant", caseKey: "prepared" },
      );
    } else if (caseKey === "committed") {
      const outbox = await createOutbox();
      const committed = await outbox.commit(await outbox.prepare(createInput("committed")));
      assert(committed.state === "committed", "commit did not persist the committed state");
      const recovery = await recoverOutboxWithHost(outbox);
      assert(recovery.executions === 1, "recovery host did not drive the committed side effect once");
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "completed",
        "recovery host did not complete the committed operation",
        { kind: "variant", caseKey: "committed" },
      );
    } else if (caseKey === "completed") {
      const outbox = await createOutbox();
      const committed = await outbox.commit(await outbox.prepare(createInput("completed")));
      const completed = await outbox.complete(committed, { ok: true, value: { name: "completed" } });
      assert(completed.state === "completed", "completion did not persist the completed state");
      const recovery = await recoverOutboxWithHost(outbox);
      assert(recovery.executions === 0, "recovery host repeated a completed side effect");
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "completed",
        "recovery host did not replay the completed state",
        { kind: "variant", caseKey: "completed" },
      );
    } else if (caseKey === "abandoned") {
      const root = path.join(
        await createS7TempDir("s7-outbox-abandoned"),
        "runtime",
        "local-workspace-operation-outbox",
      );
      let now = "2026-08-01T00:00:00.000Z";
      const outbox = trackOutbox(new LocalWorkspaceOperationOutbox({ rootDir: root, clock: () => now }), root);
      const prepared = await outbox.prepare({
        kind: "reset",
        expectedCatalogGeneration: "catalog-a",
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      });
      now = "2026-08-01T00:15:00.001Z";
      await expectFailure(
        () => outbox.commit(prepared, { impact: WORKSPACE_CATALOG_RESET_IMPACT }),
        "abandoned",
      );
      const recovery = await recoverOutboxWithHost(outbox);
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "abandoned",
        "expired preview did not recover as abandoned",
        { kind: "variant", caseKey: "abandoned" },
      );
    } else {
      throw new Error(`Unimplemented local workspace outbox variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "identity-mismatch") {
      const outbox = await createOutbox();
      const prepared = await outbox.prepare(createInput("identity"));
      await expectFailure(
        () => outbox.commit({ ...prepared, operationId: `${prepared.operationId}-forged` }),
        "identity",
        { kind: "rejection", caseKey: "identity-mismatch" },
      );
      await recoverOutboxWithHost(outbox);
    } else if (caseKey === "confirmation-hole") {
      const outbox = await createOutbox();
      await outbox.prepare(createInput("hole-one"));
      const second = await outbox.commit(await outbox.prepare(createInput("hole-two")));
      const completed = await outbox.complete(second, { ok: true, value: null });
      await expectFailure(
        () => outbox.acknowledge({
          outboxId: outbox.outboxId,
          throughSeq: completed.localSeq,
          prefixDigest: completed.resultDigest!,
          entries: [{
            localSeq: completed.localSeq,
            operationId: completed.operationId,
            inputDigest: completed.inputDigest,
            resultDigest: completed.resultDigest!,
          }],
        }),
        "hole",
        { kind: "rejection", caseKey: "confirmation-hole" },
      );
      await recoverOutboxWithHost(outbox);
    } else {
      throw new Error(`Unimplemented local workspace outbox rejection: ${caseKey}`);
    }
    return;
  }

  if (caseKey === "checkpoint-chain") {
    const root = path.join(
      await createS7TempDir("s7-outbox-chain"),
      "runtime",
      "local-workspace-operation-outbox",
    );
    const outbox = trackOutbox(new LocalWorkspaceOperationOutbox({ rootDir: root }), root);
    await outbox.prepare(createInput("chain"));
    const file = path.join(root, "operations.ndjson");
    const content = await readFile(file, "utf8");
    await writeFile(
      file,
      content.replace(
        /"digest":"sha256:[0-9a-f]+"/u,
        '"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
      ),
      "utf8",
    );
    const recovered = await recoverOutboxWithHost(outbox);
    assert(
      recovered.status.state === "degraded" &&
        recovered.status.diagnostic?.message.toLowerCase().includes("digest") === true,
      "corrupt outbox chain did not produce a durable degraded diagnostic",
      { kind: "corruption", caseKey: "checkpoint-chain" },
    );
    observeReasonCode(recovered.status.diagnostic?.code ?? "", "host diagnostic after reopening the corrupt outbox chain");
  } else if (caseKey === "establishment-marker") {
    const root = path.join(
      await createS7TempDir("s7-outbox-marker"),
      "runtime",
      "local-workspace-operation-outbox",
    );
    const outbox = trackOutbox(new LocalWorkspaceOperationOutbox({ rootDir: root }), root);
    await outbox.initialize();
    const marker = `${root}.established`;
    const value = JSON.parse(await readFile(marker, "utf8"));
    value.outboxId = "outbox-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(marker, `${JSON.stringify(value)}\n`, "utf8");
    const recovered = await recoverOutboxWithHost(outbox);
    assert(
      recovered.status.state === "degraded" &&
        recovered.status.diagnostic?.message.toLowerCase().includes("identity") === true,
      "corrupt outbox identity did not produce a durable degraded diagnostic",
      { kind: "corruption", caseKey: "establishment-marker" },
    );
    observeReasonCode(recovered.status.diagnostic?.code ?? "", "host diagnostic after reopening the corrupt establishment marker");
  } else {
    throw new Error(`Unimplemented local workspace outbox corruption: ${caseKey}`);
  }
}

function createInput(name: string): LocalWorkspaceWriteOperation {
  return { kind: "create", purpose: "settings", displayName: name, absolutePath: path.resolve(name) };
}

const roots = new WeakMap<LocalWorkspaceOperationOutbox, string>();

async function createOutbox(): Promise<LocalWorkspaceOperationOutbox> {
  const root = path.join(
    await createS7TempDir("s7-outbox-scenario"),
    "runtime",
    "local-workspace-operation-outbox",
  );
  const outbox = trackOutbox(new LocalWorkspaceOperationOutbox({ rootDir: root }), root);
  await outbox.initialize();
  return outbox;
}

function trackOutbox(outbox: LocalWorkspaceOperationOutbox, root: string): LocalWorkspaceOperationOutbox {
  roots.set(outbox, root);
  return outbox;
}

async function recoverOutboxWithHost(outbox: LocalWorkspaceOperationOutbox): Promise<{
  readonly executions: number;
  readonly outbox: LocalWorkspaceOperationOutbox;
  readonly status: Awaited<ReturnType<typeof readLocalWorkspaceHostStatus>>;
}> {
  const root = outboxRoot(outbox);
  const home = path.dirname(path.dirname(root));
  const lease = await acquireLocalWorkspaceOwner(home);
  const recoveredOutbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
  let executions = 0;
  const unavailable = async (): Promise<never> => { throw new Error("Unexpected local workspace recovery operation"); };
  const host = new LocalWorkspaceManagementHost({
    lease,
    facade: {
      status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
      list: async () => [],
      create: async (displayName: string, absolutePath: string) => {
        executions += 1;
        return { name: displayName, path: absolutePath, revision: 1, workspaceBindingRevision: 1 };
      },
      authorizeForControl: async () => ({ deviceId: "device-a", bindingRef: "binding-a" }),
      rename: unavailable,
      repath: unavailable,
      remove: unavailable,
      reset: unavailable,
    },
    outbox: recoveredOutbox,
  });
  try {
    await host.start();
    const status = await waitForLocalWorkspaceHostSettlement(home);
    return { executions, outbox: recoveredOutbox, status };
  } finally {
    await host.close();
    await lease.release();
  }
}

async function waitForLocalWorkspaceHostSettlement(
  home: string,
): Promise<Awaited<ReturnType<typeof readLocalWorkspaceHostStatus>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await readLocalWorkspaceHostStatus(home);
    if (status.state !== "recovering") return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Local workspace recovery did not reach a durable settlement");
}

function outboxRoot(outbox: LocalWorkspaceOperationOutbox): string {
  const root = roots.get(outbox);
  if (!root) throw new Error("Outbox scenario root is unavailable");
  return root;
}
