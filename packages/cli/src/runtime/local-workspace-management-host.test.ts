import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { LocalWorkspaceManagementHost, createLocalWorkspaceClient } from "./local-workspace-management-host.js";
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
    } finally {
      await host.close();
      await lease.release();
    }
  });
});
