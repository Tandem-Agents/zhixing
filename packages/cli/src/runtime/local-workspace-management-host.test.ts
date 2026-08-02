import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ExecutorResourceBackpressureError } from "@zhixing/executor";
import {
  WorkspaceBindingCancelledError,
  WorkspaceBindingCatalogConflictError,
  WorkspaceBindingCatalogDegradedError,
  WorkspaceBindingCatalogIntegrityError,
} from "@zhixing/core/environment";
import {
  CompletedLocalWorkspaceOperationError,
  LocalWorkspaceManagementHost,
  RecoveredLocalWorkspaceOperationsError,
  createLocalWorkspaceClient,
  decodeLocalWorkspaceResetPreview,
  encodeLocalWorkspaceResetPreview,
  readLocalWorkspaceHostStatus,
} from "./local-workspace-management-host.js";
import { LocalWorkspaceBusinessError } from "./local-workspace-facade.js";
import {
  LocalWorkspaceOperationOutbox,
  validateLocalWorkspaceOperation,
} from "./local-workspace-operation-outbox.js";
import {
  acquireLocalWorkspaceOwner,
  callLocalWorkspaceHost,
} from "./local-workspace-owner.js";

describe("LocalWorkspaceManagementHost", () => {
  it("owns side effects after commit and replays one result to concurrent clients", async () => {
    const home = await createTempDir("workspace-host");
    const create = vi.fn(async (displayName: string, absolutePath: string) => ({
      name: displayName,
      path: absolutePath,
      revision: 1,
      workspaceBindingRevision: 1,
    }));
    const facade = {
      status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
      list: async () => [],
      create,
      authorizeForControl: async () => ({ deviceId: "device-a", bindingRef: "binding-a" }),
      rename: vi.fn(),
      repath: vi.fn(),
      remove: vi.fn(),
      reset: vi.fn(),
    };
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade,
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const left = createLocalWorkspaceClient(home);
      const right = createLocalWorkspaceClient(home);
      const results = await Promise.all([
        left.create("paper", "C:\\paper"),
        right.create("paper", "C:\\paper"),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("returns the prior completed result instead of repeating a side effect after response loss", async () => {
    const home = await createTempDir("workspace-host-response-loss");
    const create = vi.fn(async (displayName: string, absolutePath: string) => ({
      name: displayName,
      path: absolutePath,
      revision: 1,
      workspaceBindingRevision: 1,
    }));
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create,
        authorizeForControl: async () => ({ deviceId: "device-a", bindingRef: "binding-a" }),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const input = {
        kind: "create" as const,
        purpose: "settings" as const,
        displayName: "paper",
        absolutePath: "C:\\paper",
      };
      const prepared = validateLocalWorkspaceOperation(
        await callLocalWorkspaceHost(home, { kind: "prepare", input }),
      );
      await callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: {
          localSeq: prepared.localSeq,
          operationId: prepared.operationId,
          inputDigest: prepared.inputDigest,
        },
      });

      await expect(createLocalWorkspaceClient(home).create("paper", "C:\\paper"))
        .resolves.toEqual({
          name: "paper",
          path: "C:\\paper",
          revision: 1,
          workspaceBindingRevision: 1,
        });
      expect(create).toHaveBeenCalledTimes(1);
      const pending = await callLocalWorkspaceHost(home, { kind: "pending", afterSeq: 0 }) as {
        operations: readonly unknown[];
      };
      expect(pending.operations).toHaveLength(1);
      const client = createLocalWorkspaceClient(home);
      await expect(client.create("paper", "C:\\paper")).resolves.toMatchObject({ name: "paper" });
      await client.confirmDelivered();
      const acknowledged = await callLocalWorkspaceHost(home, { kind: "pending", afterSeq: 0 }) as {
        operations: readonly unknown[];
      };
      expect(acknowledged.operations).toEqual([]);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("keeps a completed business failure addressable until the caller confirms delivery", async () => {
    const home = await createTempDir("workspace-host-failed-delivery");
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: async () => {
          throw new LocalWorkspaceBusinessError(
            "WORKSPACE_POLICY_REJECTED",
            "rejected by policy",
          );
        },
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const client = createLocalWorkspaceClient(home);
      await expect(client.create("paper", "C:\\paper")).rejects.toMatchObject({
        name: "CompletedLocalWorkspaceOperationError",
        code: "WORKSPACE_POLICY_REJECTED",
      });
      const credential = client.consumptionCredential();
      expect(credential).toMatchObject({
        outboxId: expect.stringMatching(/^outbox-/u),
        operationId: expect.stringMatching(/^workspace-operation-/u),
        resultDigest: expect.stringMatching(/^sha256:/u),
      });

      const restarted = createLocalWorkspaceClient(home);
      await expect(restarted.create("paper", "C:\\paper")).rejects.toMatchObject({
        name: "CompletedLocalWorkspaceOperationError",
        code: "WORKSPACE_POLICY_REJECTED",
      });
      expect(restarted.consumptionCredential()).toEqual(credential);
      await restarted.confirmDelivered();
      await expect(createLocalWorkspaceClient(home).list()).resolves.toEqual([]);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("keeps unrelated recovered results pending until the caller durably delivers them", async () => {
    const home = await createTempDir("workspace-host-recovered-delivery");
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: async (displayName: string, absolutePath: string) => ({
          name: displayName,
          path: absolutePath,
          revision: 1,
          workspaceBindingRevision: 1,
        }),
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      await createLocalWorkspaceClient(home).create("paper", "C:\\paper");
      const recovering = createLocalWorkspaceClient(home);
      const error = await recovering.list().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RecoveredLocalWorkspaceOperationsError);
      expect((error as RecoveredLocalWorkspaceOperationsError).operations)
        .toEqual([expect.objectContaining({ state: "completed" })]);
      await expect(recovering.list()).rejects.toBeInstanceOf(
        RecoveredLocalWorkspaceOperationsError,
      );
      await recovering.confirmDelivered();
      await expect(recovering.list()).resolves.toEqual([]);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("replays one stable consumption credential until the caller confirms delivery", async () => {
    const home = await createTempDir("workspace-host-consumption-credential");
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: async (displayName: string, absolutePath: string) => ({
          name: displayName,
          path: absolutePath,
          revision: 1,
          workspaceBindingRevision: 1,
        }),
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const first = createLocalWorkspaceClient(home);
      await first.create("paper", "C:\\paper");
      const credential = first.consumptionCredential();
      expect(credential).toMatchObject({
        outboxId: expect.stringMatching(/^outbox-/u),
        operationId: expect.stringMatching(/^workspace-operation-/u),
        resultDigest: expect.stringMatching(/^sha256:/u),
      });

      const restarted = createLocalWorkspaceClient(home);
      await restarted.create("paper", "C:\\paper");
      expect(restarted.consumptionCredential()).toEqual(credential);
      await restarted.confirmDelivered();
      expect(restarted.consumptionCredential()).toBeUndefined();
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("previews and confirms reset with the same durable identity", async () => {
    const home = await createTempDir("workspace-host-reset-preview");
    const reset = vi.fn(async () => ({
      requestId: "request-a",
      confirmationDigest: "sha256:confirmation",
      previousCatalogGeneration: "catalog-a",
      catalogGeneration: "catalog-b",
      logId: "binding-log-b",
      capabilityRevision: 2,
      preparedAt: "2026-08-01T00:00:00.000Z",
    }));
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "degraded" as const, catalogGeneration: "catalog-a", reason: "broken" }),
        list: async () => [],
        create: vi.fn(),
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset,
      },
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
        clock: () => "2026-08-01T00:00:00.000Z",
      }),
    });
    try {
      await host.start();
      const client = createLocalWorkspaceClient(home);
      const preview = await client.previewReset("catalog-a");
      expect(decodeLocalWorkspaceResetPreview(encodeLocalWorkspaceResetPreview(preview)))
        .toEqual(preview);
      await expect(client.confirmReset({
        ...preview,
        operationId: "workspace-operation-forged",
      }, preview.impact)).rejects.toThrow("identity");
      expect(reset).not.toHaveBeenCalled();
      await expect(client.confirmReset(preview, preview.impact)).resolves.toMatchObject({
        catalogGeneration: "catalog-b",
      });
      expect(reset).toHaveBeenCalledTimes(1);
      expect(reset.mock.calls[0]![2]).toMatchObject({
        requestNonce: expect.stringContaining(preview.operationId),
      });
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("drains the oldest committed operation through retry without letting a later write pass it", async () => {
    const home = await createTempDir("workspace-host-ordered-drain");
    const attempts: string[] = [];
    let firstAttempt = true;
    const create = vi.fn(async (displayName: string, absolutePath: string) => {
      attempts.push(displayName);
      if (displayName === "first" && firstAttempt) {
        firstAttempt = false;
        throw new ExecutorResourceBackpressureError(1);
      }
      return {
        name: displayName,
        path: absolutePath,
        revision: 1,
        workspaceBindingRevision: 1,
      };
    });
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create,
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const first = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
        kind: "prepare",
        input: { kind: "create", purpose: "settings", displayName: "first", absolutePath: "C:\\first" },
      }));
      const second = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
        kind: "prepare",
        input: { kind: "create", purpose: "settings", displayName: "second", absolutePath: "C:\\second" },
      }));
      const firstCommit = callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(first),
      });
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1), {
        interval: 1,
        timeout: 40,
      });
      await expect(callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(second),
      })).rejects.toThrow("capacity is limited");
      await expect(firstCommit).resolves.toMatchObject({ state: "completed" });
      await expect(callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(second),
      })).resolves.toMatchObject({ state: "completed" });
      expect(attempts).toEqual(["first", "first", "second"]);
      await expect(readLocalWorkspaceHostStatus(home)).resolves.toEqual({ state: "ready" });
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("persists deterministic rejection but keeps unknown failure committed and diagnosable", async () => {
    const home = await createTempDir("workspace-host-decisions");
    const lease = await acquireLocalWorkspaceOwner(home);
    const create = vi.fn(async (displayName: string) => {
      if (displayName === "rejected") {
        throw new LocalWorkspaceBusinessError("WORKSPACE_POLICY_REJECTED", "rejected by policy");
      }
      throw new Error("unexpected storage state");
    });
    const outbox = new LocalWorkspaceOperationOutbox({
      rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
    });
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create,
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox,
    });
    try {
      await host.start();
      const rejected = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
        kind: "prepare",
        input: { kind: "create", purpose: "settings", displayName: "rejected", absolutePath: "C:\\rejected" },
      }));
      const rejectedResult = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(rejected),
      }));
      expect(rejectedResult).toMatchObject({
        state: "completed",
        result: { ok: false, error: { code: "WORKSPACE_POLICY_REJECTED" } },
      });

      const corrupt = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
        kind: "prepare",
        input: { kind: "create", purpose: "settings", displayName: "corrupt", absolutePath: "C:\\corrupt" },
      }));
      await expect(callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(corrupt),
      })).rejects.toThrow("unexpected storage state");
      expect(outbox.operation(corrupt).state).toBe("committed");
      await expect(readLocalWorkspaceHostStatus(home)).resolves.toMatchObject({
        state: "degraded",
        diagnostic: {
          code: "LOCAL_WORKSPACE_OPERATION_FAILED",
          localSeq: corrupt.localSeq,
        },
      });
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it.each([
    {
      label: "catalog degraded",
      error: new WorkspaceBindingCatalogDegradedError("catalog unavailable"),
      code: "WORKSPACE_CATALOG_DEGRADED",
    },
    {
      label: "catalog integrity",
      error: new WorkspaceBindingCatalogIntegrityError("catalog chain is corrupt"),
      code: "WORKSPACE_CATALOG_INTEGRITY",
    },
  ])("keeps a committed operation recoverable after $label failure", async ({ error, code }) => {
    const home = await createTempDir(
      `workspace-host-${code.toLowerCase().replaceAll("_", "-")}`,
    );
    const lease = await acquireLocalWorkspaceOwner(home);
    const outbox = new LocalWorkspaceOperationOutbox({
      rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
    });
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: async () => { throw error; },
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox,
    });
    try {
      await host.start();
      const prepared = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
        kind: "prepare",
        input: { kind: "create", purpose: "settings", displayName: "paper", absolutePath: "C:\\paper" },
      }));
      await expect(callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(prepared),
      })).rejects.toThrow(error.message);
      expect(outbox.operation(prepared).state).toBe("committed");
      await expect(readLocalWorkspaceHostStatus(home)).resolves.toMatchObject({
        state: "degraded",
        diagnostic: { code, localSeq: prepared.localSeq },
      });
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("persists only an explicit catalog business conflict as a completed result", async () => {
    const home = await createTempDir("workspace-host-catalog-business-conflict");
    const lease = await acquireLocalWorkspaceOwner(home);
    const outbox = new LocalWorkspaceOperationOutbox({
      rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
    });
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: async () => {
          throw new WorkspaceBindingCatalogConflictError("request generation changed");
        },
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox,
    });
    try {
      await host.start();
      const prepared = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
        kind: "prepare",
        input: { kind: "create", purpose: "settings", displayName: "paper", absolutePath: "C:\\paper" },
      }));
      await expect(callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(prepared),
      })).resolves.toMatchObject({
        state: "completed",
        result: { ok: false, error: { code: "WORKSPACE_CATALOG_CONFLICT" } },
      });
      expect(outbox.operation(prepared).state).toBe("completed");
      await expect(readLocalWorkspaceHostStatus(home)).resolves.toEqual({ state: "ready" });
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("stops a retrying operation at a committed safe point and resumes it after restart", async () => {
    const home = await createTempDir("workspace-host-shutdown-resume");
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const rootDir = path.join(home, "runtime", "local-workspace-operation-outbox");
    const firstLease = await acquireLocalWorkspaceOwner(home);
    const firstOutbox = new LocalWorkspaceOperationOutbox({ rootDir });
    const firstHost = new LocalWorkspaceManagementHost({
      lease: firstLease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: async (_displayName: string, _absolutePath: string, authority?: { abort?: AbortSignal }) => {
          executionStarted();
          await new Promise<void>((_resolve, reject) => {
            authority?.abort?.addEventListener(
              "abort",
              () => reject(new WorkspaceBindingCancelledError()),
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: firstOutbox,
    });
    await firstHost.start();
    const prepared = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(home, {
      kind: "prepare",
      input: { kind: "create", purpose: "settings", displayName: "paper", absolutePath: "C:\\paper" },
    }));
    const committing = callLocalWorkspaceHost(home, {
      kind: "commit",
      identity: operationIdentity(prepared),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await started;
    await firstHost.close();
    expect(await committing).toBeInstanceOf(Error);
    expect(firstOutbox.operation(prepared).state).toBe("committed");
    await firstLease.release();

    const secondLease = await acquireLocalWorkspaceOwner(home);
    const secondOutbox = new LocalWorkspaceOperationOutbox({ rootDir });
    const secondHost = new LocalWorkspaceManagementHost({
      lease: secondLease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: async (displayName: string, absolutePath: string) => ({
          name: displayName,
          path: absolutePath,
          revision: 1,
          workspaceBindingRevision: 1,
        }),
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: secondOutbox,
    });
    try {
      await secondHost.start();
      await vi.waitFor(async () => {
        expect((await readLocalWorkspaceHostStatus(home)).state).toBe("ready");
      });
      expect(secondOutbox.operation(prepared).state).toBe("completed");
    } finally {
      await secondHost.close();
      await secondLease.release();
    }
  });

  it("publishes a read-only diagnostic surface when durable recovery is corrupt", async () => {
    const home = await createTempDir("workspace-host-corrupt-recovery");
    const rootDir = path.join(home, "runtime", "local-workspace-operation-outbox");
    await new LocalWorkspaceOperationOutbox({ rootDir }).initialize();
    await writeFile(path.join(rootDir, "operations.ndjson"), "not-json\n", "utf8");
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = new LocalWorkspaceManagementHost({
      lease,
      facade: {
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        list: async () => [],
        create: vi.fn(),
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      },
      outbox: new LocalWorkspaceOperationOutbox({ rootDir }),
    });
    try {
      await host.start();
      await expect(readLocalWorkspaceHostStatus(home)).resolves.toMatchObject({
        state: "degraded",
        diagnostic: { code: "LOCAL_WORKSPACE_OUTBOX_CHAIN_CORRUPT" },
      });
      await expect(callLocalWorkspaceHost(home, { kind: "status" })).resolves.toEqual({
        state: "healthy",
        catalogGeneration: "catalog-a",
      });
      await expect(callLocalWorkspaceHost(home, {
        kind: "prepare",
        input: { kind: "create", purpose: "settings", displayName: "paper", absolutePath: "C:\\paper" },
      })).rejects.toThrow();
    } finally {
      await host.close();
      await lease.release();
    }
  });
});

function operationIdentity(operation: {
  readonly localSeq: number;
  readonly operationId: string;
  readonly inputDigest: string;
}) {
  return {
    localSeq: operation.localSeq,
    operationId: operation.operationId,
    inputDigest: operation.inputDigest,
  };
}
