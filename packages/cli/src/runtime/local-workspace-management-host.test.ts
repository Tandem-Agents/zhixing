import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ExecutorResourceBackpressureError } from "@zhixing/executor";
import { protocolDigest } from "@zhixing/core/protocol";
import {
  WorkspaceBindingCancelledError,
  WorkspaceBindingCatalogConflictError,
  WorkspaceBindingCatalogDegradedError,
  WorkspaceBindingCatalogIntegrityError,
} from "@zhixing/core/environment";
import {
  RecoveredWorkspaceAdministrationOperationsError,
  WorkspaceAdministrationBusinessError,
  WorkspaceAdministrationDurableLifecycleApplicationService,
  type WorkspaceAdministrationConsumptionCredential,
  type WorkspaceAdministrationApplication,
} from "@zhixing/core/environment/workspace-administration";
import {
  LocalWorkspaceManagementHost,
  createLocalWorkspaceClient,
  decodeLocalWorkspaceResetPreview,
  encodeLocalWorkspaceResetPreview,
  readLocalWorkspaceHostStatus,
} from "./local-workspace-management-host.js";
import {
  LocalWorkspaceOperationOutbox,
  validateLocalWorkspaceOperation,
} from "./local-workspace-operation-outbox.js";
import {
  acquireLocalWorkspaceOwner,
  callLocalWorkspaceHost,
} from "./local-workspace-owner.js";
import { useLocalWorkspaceClient } from "./workspace-command.js";
import { observeLocalWorkspaceDurableInfrastructureFailure } from "./local-workspace-durable-lifecycle-adapter.js";

type TestWorkspaceApplications = Omit<
  WorkspaceAdministrationApplication,
  "executeDurableOperation"
>;

function testWorkspaceApplications(
  applications: TestWorkspaceApplications,
): WorkspaceAdministrationApplication {
  return {
    ...applications,
    async executeDurableOperation(operation, execution) {
      const commonExecution = {
        operation: execution.operation,
        abort: execution.abort,
      };
      switch (operation.kind) {
        case "create":
          return operation.purpose === "control"
            ? applications.authorizeForControl(operation, commonExecution)
            : applications.create(operation, commonExecution);
        case "rename":
          return applications.rename(operation, commonExecution);
        case "repath":
          return applications.repath(operation, commonExecution);
        case "remove":
          await applications.remove(operation, commonExecution);
          return null;
        case "reset":
          return applications.reset(
            {
              expectedCatalogGeneration: operation.expectedCatalogGeneration,
              confirmedImpact: operation.impact,
            },
            {
              ...commonExecution,
              confirmationToken: execution.confirmationToken,
              confirmationIssuedAt: execution.preparedAt,
            },
          );
      }
    },
  };
}

function createTestLocalWorkspaceManagementHost(input: {
  readonly lease: Awaited<ReturnType<typeof acquireLocalWorkspaceOwner>>;
  readonly applications: WorkspaceAdministrationApplication;
  readonly outbox: LocalWorkspaceOperationOutbox;
}): LocalWorkspaceManagementHost {
  return new LocalWorkspaceManagementHost({
    lease: input.lease,
    lifecycle: new WorkspaceAdministrationDurableLifecycleApplicationService({
      application: input.applications,
      mechanism: input.outbox,
      observeInfrastructureFailure:
        observeLocalWorkspaceDurableInfrastructureFailure,
    }),
  });
}

describe("LocalWorkspaceManagementHost", () => {
  it("owns side effects after commit and replays one result to concurrent clients", async () => {
    const home = await createTempDir("workspace-host");
    const create = vi.fn(async ({ displayName, absolutePath }: {
      displayName: string;
      absolutePath: string;
    }) => ({
      name: displayName,
      path: absolutePath,
      revision: 1,
      workspaceBindingRevision: 1,
    }));
    const applications = testWorkspaceApplications({
      status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
      previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
      list: async () => [],
      viewByName: vi.fn(),
      create,
      authorizeForControl: async () => ({
        deviceId: "device-a",
        bindingRef: "binding-a",
      }),
      rename: vi.fn(),
      repath: vi.fn(),
      remove: vi.fn(),
      reset: vi.fn(),
    });
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications,
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
    const create = vi.fn(async ({ displayName, absolutePath }: {
      displayName: string;
      absolutePath: string;
    }) => ({
      name: displayName,
      path: absolutePath,
      revision: 1,
      workspaceBindingRevision: 1,
    }));
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create,
        authorizeForControl: async () => ({
          deviceId: "device-a",
          bindingRef: "binding-a",
        }),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
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

  it("recovers and confirms a completed legacy two-field control authorization", async () => {
    const home = await createTempDir("workspace-host-control-recovery");
    const lease = await acquireLocalWorkspaceOwner(home);
    const authorization = {
      deviceId: "device-a",
      bindingRef: "binding-a",
    };
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: vi.fn(),
        authorizeForControl: vi.fn(async () => authorization),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      await expect(
        createLocalWorkspaceClient(home).authorizeForControl("paper", "C:\\paper"),
      ).resolves.toEqual(authorization);
      const pending = await callLocalWorkspaceHost(home, {
        kind: "pending",
        afterSeq: 0,
      }) as { readonly operations: readonly unknown[] };
      const completed = validateLocalWorkspaceOperation(pending.operations[0]);
      expect(completed.result).toEqual({ ok: true, value: authorization });
      expect(completed.resultDigest).toBe(
        protocolDigest("LocalWorkspaceOperationResult", 1, completed.result),
      );

      const recovered = vi.fn(async (operations) => {
        expect(operations).toEqual([
          expect.objectContaining({ controlWorkspace: authorization }),
        ]);
      });
      await expect(
        useLocalWorkspaceClient(
          createLocalWorkspaceClient(home),
          (workspace) => workspace.list(),
          {
            result: async (value) => value,
            recovered,
            failure: vi.fn(),
          },
        ),
      ).resolves.toEqual([]);
      expect(recovered).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("keeps the current credential claimed while a real delivery callback reads its view", async () => {
    const home = await createTempDir("workspace-host-current-delivery-view");
    const lease = await acquireLocalWorkspaceOwner(home);
    const authorization = { deviceId: "device-a", bindingRef: "binding-a" };
    const view = {
      name: "paper",
      path: "C:\\paper",
      revision: 1,
      workspaceBindingRevision: 7,
    };
    const viewByName = vi.fn(async () => view);
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName,
        create: vi.fn(),
        authorizeForControl: vi.fn(async () => authorization),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const client = createLocalWorkspaceClient(home);
      let deliveredCredential: WorkspaceAdministrationConsumptionCredential | undefined;
      await expect(
        useLocalWorkspaceClient(
          client,
          (workspace) => workspace.authorizeForControl("paper", "C:\\paper"),
          {
            result: async (result, credential) => {
              expect(result).toEqual(authorization);
              expect(credential).toBeDefined();
              deliveredCredential = credential;
              expect(client.consumptionCredential()).toEqual(credential);
              return client.viewByName("paper");
            },
            recovered: vi.fn(),
            failure: vi.fn(),
          },
        ),
      ).resolves.toEqual(view);
      expect(viewByName).toHaveBeenCalledWith("paper");
      expect(deliveredCredential).toBeDefined();
      expect(client.consumptionCredential()).toBeUndefined();
      const pending = await callLocalWorkspaceHost(home, {
        kind: "pending",
        afterSeq: 0,
      }) as { readonly operations: readonly unknown[] };
      expect(pending.operations).toEqual([]);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("retains the current credential and pending result when its view fails", async () => {
    const home = await createTempDir("workspace-host-current-delivery-view-failure");
    const lease = await acquireLocalWorkspaceOwner(home);
    const viewFailure = new Error("workspace view unavailable");
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(async () => { throw viewFailure; }),
        create: vi.fn(),
        authorizeForControl: vi.fn(async () => ({
          deviceId: "device-a",
          bindingRef: "binding-a",
        })),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const client = createLocalWorkspaceClient(home);
      let deliveredCredential: WorkspaceAdministrationConsumptionCredential | undefined;
      await expect(
        useLocalWorkspaceClient(
          client,
          (workspace) => workspace.authorizeForControl("paper", "C:\\paper"),
          {
            result: async (_result, credential) => {
              deliveredCredential = credential;
              return client.viewByName("paper");
            },
            recovered: vi.fn(),
            failure: vi.fn(),
          },
        ),
      ).rejects.toMatchObject({ message: viewFailure.message });
      expect(deliveredCredential).toBeDefined();
      expect(client.consumptionCredential()).toEqual(deliveredCredential);
      const pending = await callLocalWorkspaceHost(home, {
        kind: "pending",
        afterSeq: 0,
      }) as { readonly operations: readonly unknown[] };
      expect(pending.operations).toHaveLength(1);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("still rejects another completed result while reading the claimed operation view", async () => {
    const home = await createTempDir("workspace-host-current-delivery-other-pending");
    const lease = await acquireLocalWorkspaceOwner(home);
    const viewByName = vi.fn();
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName,
        create: async ({ displayName, absolutePath }) => ({
          name: displayName,
          path: absolutePath,
          revision: 1,
          workspaceBindingRevision: 1,
        }),
        authorizeForControl: vi.fn(async () => ({
          deviceId: "device-a",
          bindingRef: "binding-a",
        })),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      const client = createLocalWorkspaceClient(home);
      await client.authorizeForControl("paper", "C:\\paper");
      const prepared = validateLocalWorkspaceOperation(
        await callLocalWorkspaceHost(home, {
          kind: "prepare",
          input: {
            kind: "create",
            purpose: "settings",
            displayName: "other",
            absolutePath: "C:\\other",
          },
        }),
      );
      await callLocalWorkspaceHost(home, {
        kind: "commit",
        identity: operationIdentity(prepared),
      });

      await expect(client.viewByName("paper")).rejects.toBeInstanceOf(
        RecoveredWorkspaceAdministrationOperationsError,
      );
      expect(viewByName).not.toHaveBeenCalled();
      expect(client.consumptionCredential()).toBeDefined();
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("keeps the durable control authorization exact instead of accepting a third field", async () => {
    const home = await createTempDir("workspace-host-control-invalid");
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: vi.fn(),
        authorizeForControl: vi.fn(async () => ({
          deviceId: "device-a",
          bindingRef: "binding-a",
          workspaceBindingRevision: 7,
        }) as never),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      await expect(
        createLocalWorkspaceClient(home).authorizeForControl("paper", "C:\\paper"),
      ).rejects.toThrow("control authorization fields are invalid");

      const recovered = vi.fn();
      await expect(
        useLocalWorkspaceClient(
          createLocalWorkspaceClient(home),
          (workspace) => workspace.list(),
          {
            result: async (value) => value,
            recovered,
            failure: vi.fn(),
          },
        ),
      ).rejects.toThrow("control authorization fields are invalid");
      expect(recovered).not.toHaveBeenCalled();
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("keeps a completed business failure addressable until the caller confirms delivery", async () => {
    const home = await createTempDir("workspace-host-failed-delivery");
    const lease = await acquireLocalWorkspaceOwner(home);
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: async () => {
          throw new WorkspaceAdministrationBusinessError(
            "WORKSPACE_POLICY_REJECTED",
            "rejected by policy",
          );
        },
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
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
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: async ({ displayName, absolutePath }) => ({
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
      }),
      outbox: new LocalWorkspaceOperationOutbox({
        rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
      }),
    });
    try {
      await host.start();
      await createLocalWorkspaceClient(home).create("paper", "C:\\paper");
      const recovering = createLocalWorkspaceClient(home);
      const error = await recovering.list().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RecoveredWorkspaceAdministrationOperationsError);
      expect((error as RecoveredWorkspaceAdministrationOperationsError).operations)
        .toEqual([expect.objectContaining({ state: "completed" })]);
      await expect(recovering.list()).rejects.toBeInstanceOf(
        RecoveredWorkspaceAdministrationOperationsError,
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
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: async ({ displayName, absolutePath }) => ({
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
      }),
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
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({
          state: "degraded" as const,
          catalogGeneration: "catalog-a",
          reason: "broken",
        }),
        previewReset: async (input: {
          expectedCatalogGeneration: string;
          impact: string;
        }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: vi.fn(),
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset,
      }),
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
      const receipt = await client.confirmReset(preview, preview.impact);
      expect(receipt).toMatchObject({ catalogGeneration: "catalog-b" });
      expect(reset).toHaveBeenCalledTimes(1);
      expect(reset.mock.calls[0]![1]).toMatchObject({
        operation: {
          outboxId: expect.stringMatching(/^outbox-/u),
          localSeq: preview.localSeq,
          operationId: preview.operationId,
          inputDigest: preview.inputDigest,
        },
        confirmationIssuedAt: "2026-08-01T00:00:00.000Z",
        confirmationToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/u),
      });
      await expect(
        createLocalWorkspaceClient(home).confirmReset(preview, preview.impact),
      ).resolves.toEqual(receipt);
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
      await lease.release();
    }
  });

  it("drains the oldest committed operation through retry without letting a later write pass it", async () => {
    const home = await createTempDir("workspace-host-ordered-drain");
    const attempts: string[] = [];
    let firstAttempt = true;
    const create = vi.fn(async ({ displayName, absolutePath }: {
      displayName: string;
      absolutePath: string;
    }) => {
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
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create,
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
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
    const create = vi.fn(async ({ displayName }: { displayName: string }) => {
      if (displayName === "rejected") {
        throw new WorkspaceAdministrationBusinessError(
          "WORKSPACE_POLICY_REJECTED",
          "rejected by policy",
        );
      }
      throw new Error("unexpected storage state");
    });
    const outbox = new LocalWorkspaceOperationOutbox({
      rootDir: path.join(home, "runtime", "local-workspace-operation-outbox"),
    });
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create,
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
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
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: async () => { throw error; },
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
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
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: async () => {
          throw new WorkspaceBindingCatalogConflictError("request generation changed");
        },
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
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
    const firstHost = createTestLocalWorkspaceManagementHost({
      lease: firstLease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: async (_input, execution) => {
          executionStarted();
          await new Promise<void>((_resolve, reject) => {
            execution?.abort?.addEventListener(
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
      }),
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
    const secondHost = createTestLocalWorkspaceManagementHost({
      lease: secondLease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: async ({ displayName, absolutePath }) => ({
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
      }),
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
    const host = createTestLocalWorkspaceManagementHost({
      lease,
      applications: testWorkspaceApplications({
        status: async () => ({ state: "healthy" as const, catalogGeneration: "catalog-a" }),
        previewReset: async (input: { expectedCatalogGeneration: string; impact: string }) => input,
        list: async () => [],
        viewByName: vi.fn(),
        create: vi.fn(),
        authorizeForControl: vi.fn(),
        rename: vi.fn(),
        repath: vi.fn(),
        remove: vi.fn(),
        reset: vi.fn(),
      }),
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
