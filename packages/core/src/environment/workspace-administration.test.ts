import { describe, expect, it, vi } from "vitest";
import { protocolDigest } from "../protocol/canonical.js";
import type {
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
  WorkspaceBindingRecoveryPort,
  WorkspaceBindingRequestOutcome,
} from "../contracts/ports.js";
import {
  WorkspaceAdministrationApplicationService,
  WorkspaceAdministrationBusinessError,
  WorkspaceAdministrationDurableLifecycleApplicationService,
  WorkspaceAdministrationResultDeliveryApplicationService,
  RecoveredWorkspaceAdministrationOperationsError,
  WORKSPACE_CATALOG_RESET_IMPACT,
  type WorkspaceAdministrationDurableLifecycleDelegate,
  type WorkspaceAdministrationDurableOperation,
  type WorkspaceAdministrationDurableOperationKey,
  type WorkspaceAdministrationDurableOperationMechanismPort,
  type WorkspaceAdministrationDurableOperationRecord,
  type WorkspaceAdministrationResultDeliveryMechanismPort,
  type WorkspaceAdministrationControlPort,
  WorkspaceControlAttemptSpentError,
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
  const attempts: (number | undefined)[] = [];
  const aborts: AbortSignal[] = [];
  const outcomes = new Map<string, WorkspaceBindingRequestOutcome>();
  const admin: WorkspaceBindingAdminPort = {
    list: vi.fn(async () => entries.map((entry) => ({ ...entry }))),
    requestOutcome: vi.fn(async (control) => outcomes.get(control.requestId)),
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
    async execute({ requestId, attempt }, abort, operation) {
      requestIds.push(requestId);
      attempts.push(attempt);
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
    attempts,
    aborts,
    outcomes,
    entries: () => entries.map((entry) => ({ ...entry })),
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
    pending: vi.fn(async () => ({
      outboxId: "outbox-lifecycle-test",
      operations: operation ? [structuredClone(operation)] : [],
      confirmation: {
        throughSeq: 0,
        prefixDigest: `sha256:${"0".repeat(64)}`,
      },
    })),
    acknowledge: vi.fn(async (acknowledgment) => ({
      outboxId: acknowledgment.outboxId,
      throughSeq: acknowledgment.throughSeq,
      prefixDigest: acknowledgment.prefixDigest,
    })),
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
    advanceExecutionAttempt: vi.fn(async (
      identity: WorkspaceAdministrationDurableOperationKey,
      observed: number,
    ) => {
      if (!operation || operation.localSeq !== identity.localSeq) {
        throw new Error("missing operation");
      }
      if ((operation.executionAttempt ?? 1) === observed) {
        operation = { ...operation, executionAttempt: observed + 1 };
      }
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
    viewByReference: vi.fn(async () => null),

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
      attempt: 1,
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

  it("重放已生效的改名与移除时按稳定主体取回原结果，不按旧名称重新定位", async () => {
    const renamed = binding("binding-a", "Renamed", "C:\\project", 2);
    const fixture = harness([renamed]);
    const identity = (localSeq: number) => ({
      outboxId: "outbox-01234567890123456789012345678901",
      localSeq,
      operationId: `workspace-operation-${localSeq}`,
      inputDigest: `sha256:${String(localSeq).padStart(64, "0")}`,
    });
    const subject = (localSeq: number) =>
      "environment-admin:device-a:workspace-operation:outbox-01234567890123456789012345678901:" +
      `${localSeq}:workspace-operation-${localSeq}:sha256:${String(localSeq).padStart(64, "0")}`;
    fixture.outcomes.set(subject(1), { binding: renamed });
    fixture.outcomes.set(subject(2), { removed: { bindingRef: "binding-gone", previousRevision: 3 } });
    const abort = new AbortController().signal;

    await expect(fixture.application.rename(
      { currentName: "Project", displayName: "Renamed", expectedRevision: 1 },
      { operation: identity(1), attempt: 2, abort },
    )).resolves.toMatchObject({ name: "Renamed", revision: 2 });
    await expect(fixture.application.remove(
      { name: "Gone", expectedRevision: 3 },
      { operation: identity(2), attempt: 3, abort },
    )).resolves.toBeUndefined();
    expect(fixture.admin.update).not.toHaveBeenCalled();
    expect(fixture.admin.remove).not.toHaveBeenCalled();
    expect(fixture.attempts).toEqual([2, 3]);

    // 尝试 1 之前没有执行能生效，不读记录，照常按名称定位
    await expect(fixture.application.repath(
      { name: "Renamed", absolutePath: "D:\\project", expectedRevision: 2 },
      { operation: identity(3), attempt: 1, abort },
    )).resolves.toMatchObject({ path: "D:\\project" });
    expect(fixture.admin.requestOutcome).toHaveBeenCalledTimes(2);

    // 记录与操作种类不符是完整性问题，不当业务结果
    fixture.outcomes.set(subject(4), { removed: { bindingRef: "binding-a", previousRevision: 3 } });
    await expect(fixture.application.rename(
      { currentName: "Renamed", displayName: "Other", expectedRevision: 3 },
      { operation: identity(4), attempt: 2, abort },
    )).rejects.toThrow("does not match the replayed operation");
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
    // 与重置执行同一判定：目录正常时预览就拒绝，不签发确认凭据
    await expect(
      harness().application.previewReset({
        expectedCatalogGeneration: "catalog-a",
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      }),
    ).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_CATALOG_HEALTHY",
      message: "本机工作区目录正常，无需也不能重置",
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

describe("WorkspaceAdministrationResultDeliveryApplicationService", () => {
  const outboxId = "outbox-01234567890123456789012345678901";
  const input: WorkspaceAdministrationDurableOperation = {
    kind: "create",
    purpose: "settings",
    displayName: "Project",
    absolutePath: "C:\\project",
  };

  function completed(
    localSeq: number,
    operationInput: WorkspaceAdministrationDurableOperation = input,
  ): WorkspaceAdministrationDurableOperationRecord {
    const result = { ok: true, value: { localSeq } };
    return {
      localSeq,
      operationId: `workspace-operation-${localSeq}`,
      inputDigest: protocolDigest(
        "LocalWorkspaceOperationInput",
        1,
        operationInput,
      ),
      input: operationInput,
      state: "completed",
      preparedAt: "2026-08-30T00:00:00.000Z",
      result,
      resultDigest: protocolDigest(
        "LocalWorkspaceOperationResult",
        1,
        result,
      ),
    };
  }

  function deliveryHarness(
    operations: readonly WorkspaceAdministrationDurableOperationRecord[],
  ) {
    const prefixDigest = protocolDigest(
      "LocalWorkspaceOperationPrefix",
      1,
      null,
    );
    const acknowledge = vi.fn(async (request) => ({
      outboxId: request.outboxId,
      throughSeq: request.throughSeq,
      prefixDigest: request.prefixDigest,
    }));
    const mechanism: WorkspaceAdministrationResultDeliveryMechanismPort = {
      pending: vi.fn(async () => ({
        outboxId,
        operations: operations.map((operation) => structuredClone(operation)),
        confirmation: { throughSeq: 0, prefixDigest },
      })),
      acknowledge,
    };
    return {
      acknowledge,
      application:
        new WorkspaceAdministrationResultDeliveryApplicationService({
          mechanism,
        }),
    };
  }

  it("claims the current operation while surfacing every other recovered result", async () => {
    const first = completed(1);
    const secondInput: WorkspaceAdministrationDurableOperation = {
      ...input,
      displayName: "Other",
    };
    const second = completed(2, secondInput);
    const fixture = deliveryHarness([first, second]);

    await expect(
      fixture.application.recover({
        kind: "operation",
        identity: first,
      }),
    ).rejects.toMatchObject({
      name: "RecoveredLocalWorkspaceOperationsError",
      outboxId,
      operations: [expect.objectContaining({ localSeq: 2 })],
    });
    expect(fixture.application.consumptionCredential()).toMatchObject({
      outboxId,
      localSeq: 1,
      resultDigest: first.resultDigest,
    });
  });

  it("reconstructs the same claim from durable operation input after restart", async () => {
    const operation = completed(1);
    const fixture = deliveryHarness([operation]);

    await expect(
      fixture.application.recover({ kind: "operation-input", input }),
    ).resolves.toMatchObject({ localSeq: 1, operationId: operation.operationId });
    expect(fixture.application.consumptionCredential()).toEqual({
      outboxId,
      localSeq: operation.localSeq,
      operationId: operation.operationId,
      inputDigest: operation.inputDigest,
      resultDigest: operation.resultDigest,
    });
  });

  it("returns no claim for an empty prefix and rejects a mismatched durable identity", async () => {
    const empty = deliveryHarness([]);
    await expect(
      empty.application.recover({ kind: "none" }),
    ).resolves.toBeUndefined();
    expect(empty.application.consumptionCredential()).toBeUndefined();

    const operation = completed(1);
    const fixture = deliveryHarness([operation]);
    await expect(
      fixture.application.capture({
        ...operation,
        inputDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).rejects.toThrow(
      "Local workspace result is not part of the recoverable delivery prefix",
    );
    expect(fixture.application.consumptionCredential()).toBeUndefined();
  });

  it("acknowledges the exact terminal prefix and clears state only after success", async () => {
    const operation = completed(1);
    const fixture = deliveryHarness([operation]);
    await fixture.application.capture(operation);
    fixture.acknowledge.mockRejectedValueOnce(new Error("response lost"));

    await expect(fixture.application.confirmDelivered()).rejects.toThrow(
      "response lost",
    );
    expect(fixture.application.consumptionCredential()).toBeDefined();
    await fixture.application.confirmDelivered();
    expect(fixture.acknowledge).toHaveBeenCalledTimes(2);
    expect(fixture.acknowledge.mock.calls[1]?.[0]).toMatchObject({
      outboxId,
      throughSeq: 1,
      entries: [
        {
          localSeq: 1,
          operationId: operation.operationId,
          inputDigest: operation.inputDigest,
          resultDigest: operation.resultDigest,
        },
      ],
    });
    expect(fixture.application.consumptionCredential()).toBeUndefined();
    await fixture.application.confirmDelivered();
    expect(fixture.acknowledge).toHaveBeenCalledTimes(2);
  });
});

describe("WorkspaceAdministrationDurableLifecycleApplicationService", () => {
  it('按设备和稳定绑定标识查询，不按可变名称误配另一目录', async () => {
    const { application, admin } = harness([binding('id-a', 'renamed', '/workspace-a'), binding('id-b', 'old-name', '/workspace-b')]);
    expect(await application.viewByReference({ deviceId: 'device-a', bindingRef: 'id-a' })).toMatchObject({ name: 'renamed', path: '/workspace-a' });
    expect(await application.viewByReference({ deviceId: 'another-device', bindingRef: 'id-a' })).toBeNull();
    expect(await application.viewByReference({ deviceId: 'device-a', bindingRef: 'missing' })).toBeNull();
    expect(admin.list).toHaveBeenCalledTimes(2);
  });
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

  it("尝试用尽时先耐久推进尝试号，再以新号立即重派；缺字段的记录按尝试 1 续接", async () => {
    const committed: WorkspaceAdministrationDurableOperationRecord = {
      localSeq: 4,
      operationId: "workspace-operation-legacy",
      inputDigest: `sha256:${"4".repeat(64)}`,
      input: createInput,
      state: "committed",
      preparedAt: "2026-08-30T00:00:00.000Z",
    };
    const fixture = durableLifecycleHarness({
      committed,
      execute: async (_input, execution) => {
        if (execution.attempt === 1) throw new WorkspaceControlAttemptSpentError(1, "已释放");
        return { name: "Project", path: "C:\\project", revision: 1, workspaceBindingRevision: 1 };
      },
    });
    await fixture.lifecycle.start();
    await vi.waitFor(() => expect(fixture.lifecycle.hostStatus()).toEqual({ state: "ready" }));

    expect(fixture.execute.mock.calls.map(([, execution]) => execution.attempt)).toEqual([1, 2]);
    expect(fixture.mechanism.advanceExecutionAttempt).toHaveBeenCalledTimes(1);
    expect(fixture.mechanism.advanceExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ localSeq: 4, operationId: committed.operationId }),
      1,
    );
    expect(fixture.operation()).toMatchObject({ state: "completed", executionAttempt: 2 });
  });

  it("刚推进出的尝试号又被判用尽时降级并给出原因，不无限推进", async () => {
    const fixture = durableLifecycleHarness({
      execute: async (_input, execution) => {
        throw new WorkspaceControlAttemptSpentError(execution.attempt, "已释放");
      },
    });
    await fixture.lifecycle.start();
    const prepared = await fixture.lifecycle.prepare(createInput);
    await expect(fixture.lifecycle.commit(prepared)).rejects.toMatchObject({
      code: "LOCAL_WORKSPACE_CONTROL_ATTEMPT_SPENT",
    });
    expect(fixture.mechanism.advanceExecutionAttempt).toHaveBeenCalledTimes(1);
    expect(fixture.lifecycle.hostStatus()).toMatchObject({
      state: "degraded",
      diagnostic: {
        code: "LOCAL_WORKSPACE_CONTROL_ATTEMPT_SPENT",
        message: expect.stringContaining("第 2 次执行尝试已用过"),
      },
    });
    expect(fixture.operation()?.state).toBe("committed");
  });

  it("新尝试真实执行过、遇可恢复故障并收束后再判用尽，是常规进展：继续推进直到完成", async () => {
    const calls: number[] = [];
    let secondAttemptCalls = 0;
    const fixture = durableLifecycleHarness({
      execute: async (_input, execution) => {
        calls.push(execution.attempt);
        if (execution.attempt === 1) throw new WorkspaceControlAttemptSpentError(1, "已释放");
        if (execution.attempt === 2) {
          secondAttemptCalls += 1;
          // 第一次：进入效果后遇一次可恢复故障（适配器随后正常释放根 2）；第二次派发：根 2 已释放
          if (secondAttemptCalls === 1) throw new Error("retry");
          throw new WorkspaceControlAttemptSpentError(2, "已释放");
        }
        return { ok: "third-attempt" };
      },
    });
    await fixture.lifecycle.start();
    const prepared = await fixture.lifecycle.prepare(createInput);
    await expect(fixture.lifecycle.commit(prepared)).resolves.toMatchObject({
      state: "completed",
      executionAttempt: 3,
      result: { ok: true, value: { ok: "third-attempt" } },
    });
    expect(calls).toEqual([1, 2, 2, 3]);
    expect(fixture.mechanism.advanceExecutionAttempt).toHaveBeenCalledTimes(2);
    expect(fixture.lifecycle.hostStatus()).toEqual({ state: "ready" });
  });

  it("推进写失败按基础设施分类重试，按重读后的记录继续", async () => {
    const fixture = durableLifecycleHarness({
      execute: async (_input, execution) => {
        if (execution.attempt === 1) throw new WorkspaceControlAttemptSpentError(1, "已释放");
        return { ok: "second-attempt" };
      },
    });
    vi.mocked(fixture.mechanism.advanceExecutionAttempt).mockRejectedValueOnce(new Error("retry"));
    await fixture.lifecycle.start();
    const prepared = await fixture.lifecycle.prepare(createInput);
    await expect(fixture.lifecycle.commit(prepared)).resolves.toMatchObject({
      state: "completed",
      executionAttempt: 2,
    });
    expect(fixture.mechanism.advanceExecutionAttempt).toHaveBeenCalledTimes(2);
    expect(fixture.execute.mock.calls.map(([, execution]) => execution.attempt)).toEqual([1, 1, 2]);
  });

  it("写请求前的恢复等待有上限，排空结束即返回，关闭时不再等", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const committed: WorkspaceAdministrationDurableOperationRecord = {
      localSeq: 1,
      operationId: "workspace-operation-slow",
      inputDigest: `sha256:${"1".repeat(64)}`,
      input: createInput,
      state: "committed",
      preparedAt: "2026-08-30T00:00:00.000Z",
    };
    const fixture = durableLifecycleHarness({
      committed,
      execute: async () => {
        await gate;
        return { ok: true };
      },
    });
    await fixture.lifecycle.start();
    await expect(fixture.lifecycle.awaitRecovery(20)).resolves.toMatchObject({
      state: "recovering",
      diagnostic: { code: "LOCAL_WORKSPACE_RECOVERING_COMMITTED", localSeq: 1 },
    });
    const waiting = fixture.lifecycle.awaitRecovery(60_000);
    release();
    await expect(waiting).resolves.toEqual({ state: "ready" });

    const blocked = durableLifecycleHarness({
      committed,
      execute: async (_input, execution) =>
        new Promise((_resolve, reject) => {
          execution.abort.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
            { once: true },
          );
        }),
    });
    await blocked.lifecycle.start();
    const pending = blocked.lifecycle.awaitRecovery(60_000);
    await blocked.lifecycle.close();
    await expect(pending).resolves.toMatchObject({ state: expect.stringMatching(/^(draining|closed)$/u) });
  });
});
