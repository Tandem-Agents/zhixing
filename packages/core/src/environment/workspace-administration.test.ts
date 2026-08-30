import { describe, expect, it, vi } from "vitest";
import type {
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
  WorkspaceBindingRecoveryPort,
} from "../contracts/ports.js";
import {
  WorkspaceAdministrationApplicationService,
  WorkspaceAdministrationBusinessError,
  WORKSPACE_CATALOG_RESET_IMPACT,
  type WorkspaceAdministrationControlPort,
} from "./workspace-administration.js";
import {
  WorkspaceBindingCancelledError,
  WorkspaceBindingRevisionError,
} from "./workspace-bindings.js";

function binding(
  bindingRef: string,
  displayName: string,
  absolutePath: string,
  revision = 1,
  workspaceBindingRevision = 1,
): LocalWorkspaceBinding {
  return {
    bindingRef,
    displayName,
    absolutePath,
    revision,
    workspaceBindingRevision,
  };
}

function harness(
  initial: readonly LocalWorkspaceBinding[] = [],
  catalogStatus: Awaited<ReturnType<WorkspaceBindingRecoveryPort["status"]>> = {
    state: "healthy",
    catalogGeneration: "catalog-a",
  },
) {
  let entries = initial.map((entry) => ({ ...entry }));
  const requestIds: string[] = [];
  const aborts: AbortSignal[] = [];
  const admin: WorkspaceBindingAdminPort = {
    list: vi.fn(async () => entries.map((entry) => ({ ...entry }))),
    create: vi.fn(async (input) => {
      const created = binding(
        `binding-${entries.length + 1}`,
        input.displayName,
        input.absolutePath,
      );
      entries = [...entries, created];
      return { ...created };
    }),
    update: vi.fn(async (bindingRef, patch, expectedRevision) => {
      const current = entries.find((entry) => entry.bindingRef === bindingRef);
      if (!current) throw new Error("missing binding");
      const updated = {
        ...current,
        ...patch,
        revision: expectedRevision + 1,
        workspaceBindingRevision:
          "absolutePath" in patch
            ? current.workspaceBindingRevision + 1
            : current.workspaceBindingRevision,
      };
      entries = entries.map((entry) =>
        entry.bindingRef === bindingRef ? updated : entry,
      );
      return { ...updated };
    }),
    remove: vi.fn(async (bindingRef) => {
      entries = entries.filter((entry) => entry.bindingRef !== bindingRef);
    }),
  };
  const control: WorkspaceAdministrationControlPort = {
    async execute(requestId, abort, operation) {
      requestIds.push(requestId);
      aborts.push(abort);
      if (abort.aborted) throw new WorkspaceBindingCancelledError();
      return operation({
        requestId,
        abort,
        lease: { leaseId: "lease-a" } as LocalEnvironmentControlContext["lease"],
      });
    },
  };
  const recovery: WorkspaceBindingRecoveryPort = {
    status: vi.fn(async () => ({ ...catalogStatus })),
    beginReset: vi.fn(async (_input, context) => ({
      requestId: context.requestId,
      confirmationDigest: "sha256:confirmation",
      previousCatalogGeneration: context.confirmation.catalogGeneration,
      catalogGeneration: "catalog-b",
      preparedAt: context.confirmation.issuedAt,
    })),
    completeReset: vi.fn(async (requestId) => ({
      requestId,
      confirmationDigest: "sha256:confirmation",
      previousCatalogGeneration: "catalog-a",
      catalogGeneration: "catalog-b",
      logId: "workspace-log-b",
      capabilityRevision: 2,
      preparedAt: "2026-08-01T00:00:00.000Z",
    })),
  };
  return {
    admin,
    recovery,
    requestIds,
    aborts,
    application: new WorkspaceAdministrationApplicationService({
      deviceId: "device-a",
      admin,
      recovery,
      control,
    }),
  };
}

describe("WorkspaceAdministrationApplicationService", () => {
  it("owns stable views, CRUD and control authorization", async () => {
    const { application, admin } = harness();
    await expect(
      application.create({ displayName: "Project", absolutePath: "C:\\project" }),
    ).resolves.toEqual({
      name: "Project",
      path: "C:\\project",
      revision: 1,
      workspaceBindingRevision: 1,
    });
    await expect(application.list()).resolves.toEqual([
      {
        name: "Project",
        path: "C:\\project",
        revision: 1,
        workspaceBindingRevision: 1,
      },
    ]);
    await expect(application.viewByName("Project")).resolves.toEqual({
      name: "Project",
      path: "C:\\project",
      revision: 1,
      workspaceBindingRevision: 1,
    });
    await expect(
      application.rename({
        currentName: "Project",
        displayName: "Renamed",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ name: "Renamed", revision: 2 });
    await expect(
      application.repath({
        name: "Renamed",
        absolutePath: "D:\\project",
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({
      path: "D:\\project",
      revision: 3,
      workspaceBindingRevision: 2,
    });
    await expect(
      application.authorizeForControl({
        displayName: "Control",
        absolutePath: "E:\\control",
      }),
    ).resolves.toEqual({ deviceId: "device-a", bindingRef: "binding-2" });
    await application.remove({ name: "Renamed", expectedRevision: 3 });
    expect(admin.remove).toHaveBeenCalledWith(
      "binding-1",
      3,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("owns zero and duplicate name rejection", async () => {
    const missing = harness();
    await expect(missing.application.viewByName("Absent")).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_NOT_FOUND",
    });
    await expect(
      missing.application.remove({ name: "Absent", expectedRevision: 1 }),
    ).rejects.toMatchObject({
      name: "WorkspaceAdministrationBusinessError",
      code: "LOCAL_WORKSPACE_NOT_FOUND",
    });

    const duplicate = harness([
      binding("binding-a", "Same", "C:\\a"),
      binding("binding-b", "Same", "C:\\b"),
    ]);
    await expect(duplicate.application.viewByName("Same")).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_NAME_CONFLICT",
    });
    await expect(
      duplicate.application.rename({
        currentName: "Same",
        displayName: "Other",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(WorkspaceAdministrationBusinessError);
    await expect(
      duplicate.application.rename({
        currentName: "Same",
        displayName: "Other",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_WORKSPACE_NAME_CONFLICT" });
  });

  it("derives one durable request identity and forwards abort without caching state", async () => {
    const { application, requestIds, aborts } = harness();
    const abort = new AbortController();
    const operation = {
      outboxId: "outbox-01234567890123456789012345678901",
      localSeq: 7,
      operationId: "workspace-operation-a",
      inputDigest: `sha256:${"a".repeat(64)}`,
    };
    const input = { displayName: "Project", absolutePath: "C:\\project" };
    await application.create(input, { operation, abort: abort.signal });
    await application.create(input, { operation, abort: abort.signal });

    expect(requestIds).toEqual([
      "environment-admin:device-a:workspace-operation:outbox-01234567890123456789012345678901:7:workspace-operation-a:sha256:" +
        "a".repeat(64),
      "environment-admin:device-a:workspace-operation:outbox-01234567890123456789012345678901:7:workspace-operation-a:sha256:" +
        "a".repeat(64),
    ]);
    expect(aborts).toEqual([abort.signal, abort.signal]);
  });

  it("preserves revision conflicts and cancelled control admission", async () => {
    const revision = new WorkspaceBindingRevisionError("binding-a", 1, 2);
    const revisionHarness = harness([
      binding("binding-a", "Project", "C:\\project", 2),
    ]);
    vi.mocked(revisionHarness.admin.update).mockRejectedValueOnce(revision);
    await expect(
      revisionHarness.application.rename({
        currentName: "Project",
        displayName: "Renamed",
        expectedRevision: 1,
      }),
    ).rejects.toBe(revision);

    const cancelledHarness = harness();
    const abort = new AbortController();
    abort.abort();
    await expect(
      cancelledHarness.application.create(
        { displayName: "Project", absolutePath: "C:\\project" },
        { abort: abort.signal },
      ),
    ).rejects.toBeInstanceOf(WorkspaceBindingCancelledError);
    expect(cancelledHarness.admin.create).not.toHaveBeenCalled();
  });

  it("owns catalog status, reset impact and preview generation consistency", async () => {
    const degraded = harness([], {
      state: "degraded",
      catalogGeneration: "catalog-a",
      reason: "broken-generation-link",
    });
    await expect(degraded.application.status()).resolves.toEqual({
      state: "degraded",
      catalogGeneration: "catalog-a",
      reason: "broken-generation-link",
      resetImpact: WORKSPACE_CATALOG_RESET_IMPACT,
    });
    await expect(
      degraded.application.previewReset({
        expectedCatalogGeneration: "catalog-a",
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      }),
    ).resolves.toEqual({
      expectedCatalogGeneration: "catalog-a",
      impact: WORKSPACE_CATALOG_RESET_IMPACT,
    });
    await expect(
      degraded.application.previewReset({
        expectedCatalogGeneration: "catalog-other",
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      }),
    ).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_CATALOG_CHANGED",
      message: "工作区目录世代已经变化，请重新查看恢复影响",
    });
    await expect(
      degraded.application.previewReset({
        expectedCatalogGeneration: "catalog-a",
        impact: "different impact",
      }),
    ).rejects.toThrow("工作区目录恢复确认内容不完整");

    await expect(harness().application.status()).resolves.toEqual({
      state: "healthy",
      catalogGeneration: "catalog-a",
    });
  });

  it("owns stable reset identity, confirmation and begin/complete sequencing", async () => {
    const { application, recovery, requestIds } = harness([], {
      state: "degraded",
      catalogGeneration: "catalog-a",
      reason: "broken-generation-link",
    });
    const operation = {
      outboxId: "outbox-01234567890123456789012345678901",
      localSeq: 9,
      operationId: "workspace-operation-reset",
      inputDigest: `sha256:${"b".repeat(64)}`,
    };
    const execution = {
      operation,
      confirmationToken: "confirmation-token-with-at-least-32-bytes",
      confirmationIssuedAt: "2026-08-01T00:00:00.000Z",
    };

    await application.reset(
      {
        expectedCatalogGeneration: "catalog-a",
        confirmedImpact: WORKSPACE_CATALOG_RESET_IMPACT,
      },
      execution,
    );
    await application.reset(
      {
        expectedCatalogGeneration: "catalog-a",
        confirmedImpact: WORKSPACE_CATALOG_RESET_IMPACT,
      },
      execution,
    );

    const requestId =
      "environment-admin:device-a:workspace-operation:outbox-01234567890123456789012345678901:9:workspace-operation-reset:sha256:" +
      "b".repeat(64);
    expect(requestIds).toEqual([requestId, requestId]);
    expect(recovery.beginReset).toHaveBeenCalledTimes(2);
    expect(recovery.beginReset).toHaveBeenNthCalledWith(
      1,
      { expectedCatalogGeneration: "catalog-a" },
      expect.objectContaining({
        requestId,
        confirmation: {
          kind: "workspace-binding-reset",
          token: execution.confirmationToken,
          requestId,
          catalogGeneration: "catalog-a",
          issuedAt: execution.confirmationIssuedAt,
        },
      }),
    );
    expect(recovery.beginReset).toHaveBeenNthCalledWith(
      2,
      { expectedCatalogGeneration: "catalog-a" },
      expect.objectContaining({
        confirmation: expect.objectContaining({
          token: execution.confirmationToken,
          issuedAt: execution.confirmationIssuedAt,
        }),
      }),
    );
    expect(recovery.completeReset).toHaveBeenCalledTimes(2);
    expect(recovery.completeReset).toHaveBeenCalledWith(
      requestId,
      expect.any(AbortSignal),
    );
    expect(recovery.status).not.toHaveBeenCalled();
  });

  it("rejects invalid impact before effects and preserves recovery conflicts", async () => {
    const degraded = harness();
    await expect(
      degraded.application.reset({
        expectedCatalogGeneration: "catalog-a",
        confirmedImpact: "different impact",
      }),
    ).rejects.toThrow("工作区目录恢复确认内容不完整");
    expect(degraded.recovery.beginReset).not.toHaveBeenCalled();

    const conflict = Object.assign(new Error("catalog conflict"), {
      code: "WORKSPACE_CATALOG_CONFLICT",
    });
    degraded.recovery.beginReset.mockRejectedValueOnce(conflict);
    await expect(
      degraded.application.reset({
        expectedCatalogGeneration: "catalog-a",
        confirmedImpact: WORKSPACE_CATALOG_RESET_IMPACT,
      }),
    ).rejects.toBe(conflict);
    expect(degraded.recovery.completeReset).not.toHaveBeenCalled();
  });
});
