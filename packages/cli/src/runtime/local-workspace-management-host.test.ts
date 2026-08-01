import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  LocalWorkspaceManagementHost,
  RecoveredLocalWorkspaceOperationsError,
  createLocalWorkspaceClient,
  decodeLocalWorkspaceResetPreview,
  encodeLocalWorkspaceResetPreview,
} from "./local-workspace-management-host.js";
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
});
