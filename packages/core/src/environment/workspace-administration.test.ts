import { describe, expect, it, vi } from "vitest";
import type {
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
} from "../contracts/ports.js";
import {
  WorkspaceAdministrationApplicationService,
  WorkspaceAdministrationBusinessError,
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

function harness(initial: readonly LocalWorkspaceBinding[] = []) {
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
  return {
    admin,
    requestIds,
    aborts,
    application: new WorkspaceAdministrationApplicationService({
      deviceId: "device-a",
      admin,
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
});
