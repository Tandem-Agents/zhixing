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
  WorkspaceAdministrationDurableLifecycleApplicationService,
  WORKSPACE_CATALOG_RESET_IMPACT,
  type WorkspaceAdministrationDurableLifecycleDelegate,
  type WorkspaceAdministrationDurableOperation,
  type WorkspaceAdministrationDurableOperationKey,
  type WorkspaceAdministrationDurableOperationMechanismPort,
  type WorkspaceAdministrationDurableOperationRecord,
  type WorkspaceAdministrationControlPort,
  validateWorkspaceAdministrationDurableOperation,
  validateWorkspaceAdministrationDurableResult,
  validateWorkspaceAdministrationDurableValue,
  workspaceAdministrationOperationTarget,
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

function durableLifecycleHarness(input?: {
  readonly committed?: WorkspaceAdministrationDurableOperationRecord;
  readonly execute?: WorkspaceAdministrationDurableLifecycleDelegate["executeDurableOperation"];
  readonly initialize?: () => Promise<void>;
}) {
  let operation = input?.committed
    ? structuredClone(input.committed)
    : undefined;
  let nextSeq = operation ? operation.localSeq + 1 : 1;
  const mechanism: WorkspaceAdministrationDurableOperationMechanismPort = {
    outboxId: "outbox-lifecycle-test",
    initialize: vi.fn(input?.initialize ?? (async () => undefined)),
    prepare: vi.fn(async (candidate: WorkspaceAdministrationDurableOperation) => {
      operation = {
        localSeq: nextSeq++,
        operationId: `workspace-operation-${nextSeq}`,
        inputDigest: `sha256:${String(nextSeq).padStart(64, "0")}`,
        input: structuredClone(candidate),
        state: "prepared",
        preparedAt: "2026-08-30T00:00:00.000Z",
      };
      return structuredClone(operation);
    }),
    commit: vi.fn(async (identity: WorkspaceAdministrationDurableOperationKey) => {
      if (!operation || operation.localSeq !== identity.localSeq) {
        throw new Error("missing operation");
      }
      operation = { ...operation, state: "committed" };
      return structuredClone(operation);
    }),
    complete: vi.fn(async (
      identity: WorkspaceAdministrationDurableOperationKey,
      result: unknown,
    ) => {
      if (!operation || operation.localSeq !== identity.localSeq) {
        throw new Error("missing operation");
      }
      operation = { ...operation, state: "completed", result };
      return structuredClone(operation);
    }),
    operation: vi.fn((identity: WorkspaceAdministrationDurableOperationKey) => {
      if (!operation || operation.localSeq !== identity.localSeq) {
        throw new Error("missing operation");
      }
      return structuredClone(operation);
    }),
    oldestCommitted: vi.fn(async () =>
      operation?.state === "committed" ? structuredClone(operation) : undefined,
    ),
  };
  const execute = vi.fn(
    input?.execute ??
      (async () => ({
        name: "Project",
        path: "C:\\project",
        revision: 1,
        workspaceBindingRevision: 1,
      })),
  );
  const application: WorkspaceAdministrationDurableLifecycleDelegate = {
    status: vi.fn(async () => ({
      state: "healthy",
      catalogGeneration: "catalog-a",
    })),
    list: vi.fn(async () => []),
    viewByName: vi.fn(async () => {
      throw new Error("not used");
    }),
    previewReset: vi.fn(async (preview) => preview),
    executeDurableOperation: execute,
  };
  const observeInfrastructureFailure = vi.fn((error: unknown) => ({
    code: error instanceof Error ? error.name : "INFRASTRUCTURE_ERROR",
    message: error instanceof Error ? error.message : "infrastructure failure",
    ...(error instanceof Error && error.message === "retry"
      ? { retryAfterMs: 0 }
      : {}),
  }));
  const lifecycle = new WorkspaceAdministrationDurableLifecycleApplicationService({
    application,
    mechanism,
    observeInfrastructureFailure,
  });
  return {
    application,
    execute,
    lifecycle,
    mechanism,
    observeInfrastructureFailure,
    operation: () => (operation ? structuredClone(operation) : undefined),
  };
}

describe("WorkspaceAdministrationApplicationService", () => {
  it("owns strict durable operation dispatch, targets and result values", async () => {
    const { application, admin } = harness();
    const execution = (localSeq: number) => ({
      operation: {
        outboxId: "outbox-01234567890123456789012345678901",
        localSeq,
        operationId: `workspace-operation-${localSeq}`,
        inputDigest: `sha256:${String(localSeq).padStart(64, "0")}`,
      },
      abort: new AbortController().signal,
      preparedAt: "2026-08-01T00:00:00.000Z",
    });
    const operations = [
      {
        kind: "create" as const,
        purpose: "settings" as const,
        displayName: "Project",
        absolutePath: "C:\\project",
      },
      {
        kind: "create" as const,
        purpose: "control" as const,
        displayName: "Control",
        absolutePath: "C:\\control",
      },
      {
        kind: "rename" as const,
        currentName: "Project",
        displayName: "Renamed",
        expectedRevision: 1,
      },
      {
        kind: "repath" as const,
        name: "Renamed",
        absolutePath: "D:\\project",
        expectedRevision: 2,
      },
      {
        kind: "remove" as const,
        name: "Renamed",
        expectedRevision: 3,
      },
      {
        kind: "reset" as const,
        expectedCatalogGeneration: "catalog-a",
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      },
    ];

    await expect(
      application.executeDurableOperation(operations[0]!, execution(1)),
    ).resolves.toMatchObject({ name: "Project" });
    await expect(
      application.executeDurableOperation(operations[1]!, execution(2)),
    ).resolves.toEqual({ deviceId: "device-a", bindingRef: "binding-2" });
    await expect(
      application.executeDurableOperation(operations[2]!, execution(3)),
    ).resolves.toMatchObject({ name: "Renamed", revision: 2 });
    await expect(
      application.executeDurableOperation(operations[3]!, execution(4)),
    ).resolves.toMatchObject({ path: "D:\\project", revision: 3 });
    await expect(
      application.executeDurableOperation(operations[4]!, execution(5)),
    ).resolves.toBeNull();
    await expect(
      application.executeDurableOperation(operations[5]!, {
        ...execution(6),
        confirmationToken: "confirmation-token-with-at-least-32-bytes",
      }),
    ).resolves.toMatchObject({ catalogGeneration: "catalog-b" });
    expect(admin.remove).toHaveBeenCalledTimes(1);
    expect(operations.map(workspaceAdministrationOperationTarget)).toEqual([
      "Project",
      "Control",
      "Project",
      "Renamed",
      "Renamed",
      "catalog-a",
    ]);

    expect(() =>
      validateWorkspaceAdministrationDurableOperation({
        ...operations[0],
        extra: true,
      }),
    ).toThrow("operation fields are invalid");
    expect(() =>
      validateWorkspaceAdministrationDurableResult({
        ok: true,
        value: null,
        extra: true,
      }),
    ).toThrow("operation result fields are invalid");
    expect(() =>
      validateWorkspaceAdministrationDurableValue(operations[1]!, {
        deviceId: "device-a",
        bindingRef: "binding-a",
        extra: true,
      }),
    ).toThrow("control authorization fields are invalid");
  });

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

describe("WorkspaceAdministrationDurableLifecycleApplicationService", () => {
  const createInput: WorkspaceAdministrationDurableOperation = {
    kind: "create",
    purpose: "settings",
    displayName: "Project",
    absolutePath: "C:\\project",
  };

  it("owns prepare, commit, execution and business completion", async () => {
    const fixture = durableLifecycleHarness({
      execute: async () => {
        throw new WorkspaceAdministrationBusinessError(
          "LOCAL_WORKSPACE_NAME_CONFLICT",
          "duplicate workspace",
        );
      },
    });
    await fixture.lifecycle.start();

    const prepared = await fixture.lifecycle.prepare(createInput);
    const completed = await fixture.lifecycle.commit(prepared);

    expect(completed).toMatchObject({
      state: "completed",
      result: {
        ok: false,
        error: {
          code: "LOCAL_WORKSPACE_NAME_CONFLICT",
          message: "duplicate workspace",
        },
      },
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.mechanism.complete).toHaveBeenCalledTimes(1);
    expect(fixture.observeInfrastructureFailure).not.toHaveBeenCalled();
    expect(fixture.lifecycle.hostStatus()).toEqual({ state: "ready" });
  });

  it("recovers the oldest committed record and preserves its durable identity", async () => {
    const committed: WorkspaceAdministrationDurableOperationRecord = {
      localSeq: 4,
      operationId: "workspace-operation-recovered",
      inputDigest: `sha256:${"4".repeat(64)}`,
      input: createInput,
      state: "committed",
      preparedAt: "2026-08-30T00:00:00.000Z",
    };
    const fixture = durableLifecycleHarness({ committed });
    vi.mocked(fixture.mechanism.oldestCommitted).mockRejectedValueOnce(
      new Error("retry"),
    );

    await fixture.lifecycle.start();
    await vi.waitFor(() => {
      expect(fixture.lifecycle.hostStatus()).toEqual({ state: "ready" });
    });

    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledWith(
      createInput,
      expect.objectContaining({
        operation: {
          outboxId: "outbox-lifecycle-test",
          localSeq: 4,
          operationId: committed.operationId,
          inputDigest: committed.inputDigest,
        },
      }),
    );
    expect(fixture.operation()).toMatchObject({
      localSeq: 4,
      state: "completed",
    });
  });

  it("retries infrastructure failure in-order and degrades without completing on a terminal failure", async () => {
    let attempts = 0;
    const retrying = durableLifecycleHarness({
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("retry");
        return { ok: "after-retry" };
      },
    });
    await retrying.lifecycle.start();
    const prepared = await retrying.lifecycle.prepare(createInput);
    await expect(retrying.lifecycle.commit(prepared)).resolves.toMatchObject({
      state: "completed",
      result: { ok: true, value: { ok: "after-retry" } },
    });
    expect(retrying.execute).toHaveBeenCalledTimes(2);

    const degraded = durableLifecycleHarness({
      execute: async () => {
        throw new Error("permanent infrastructure failure");
      },
    });
    await degraded.lifecycle.start();
    const degradedPrepared = await degraded.lifecycle.prepare(createInput);
    await expect(degraded.lifecycle.commit(degradedPrepared)).rejects.toThrow(
      "permanent infrastructure failure",
    );
    expect(degraded.lifecycle.hostStatus()).toEqual({
      state: "degraded",
      diagnostic: {
        code: "Error",
        message: "permanent infrastructure failure",
        localSeq: degradedPrepared.localSeq,
      },
    });
    expect(degraded.operation()?.state).toBe("committed");
    expect(degraded.mechanism.complete).not.toHaveBeenCalled();
  });

  it("aborts an in-flight attempt on close and leaves committed work recoverable", async () => {
    const fixture = durableLifecycleHarness({
      execute: async (_input, execution) =>
        new Promise((_resolve, reject) => {
          execution.abort.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
            { once: true },
          );
        }),
    });
    await fixture.lifecycle.start();
    const prepared = await fixture.lifecycle.prepare(createInput);
    const commit = fixture.lifecycle.commit(prepared);
    await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledTimes(1));

    await fixture.lifecycle.close();

    await expect(commit).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_DRAINING",
    });
    expect(fixture.lifecycle.hostStatus()).toEqual({ state: "closed" });
    expect(fixture.operation()?.state).toBe("committed");
    expect(fixture.mechanism.complete).not.toHaveBeenCalled();
  });
});
