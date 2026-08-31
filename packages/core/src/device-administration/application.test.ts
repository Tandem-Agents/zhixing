import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  createDeviceAdministrationProductApiContribution,
  DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND,
  DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND,
  DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY,
  DEVICE_ADMINISTRATION_LIST_QUERY,
  DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  DEVICE_ADMINISTRATION_STATUS_QUERY,
  DeviceAdministrationApplicationService,
} from "./application.js";

function fixture() {
  const relationships = {
    list: vi.fn(async () => [
      { displayName: "书房设备", reachable: true },
    ]),
  };
  const removalState = {
    read: vi.fn(async () => ({
      phase: "moving-conversations" as const,
      conversations: ["conv-main"],
      localData: "known" as const,
      credentialActions: ["等待设备完成清理"],
    })),
  };
  const dutyMigrationTargets = {
    list: vi.fn(async () => [
      { deviceId: "device-2", displayName: "客厅主机", ready: false, code: "unavailable" as const },
    ]),
  };
  const removalContext = {
    read: vi.fn(() => ({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      members: [
        { deviceId: "device-duty", displayName: "值班设备", state: "active" as const },
        { deviceId: "device-target", displayName: "书房设备", state: "active" as const },
      ],
    })),
  };
  const removalAuthority = {
    acceptForTarget: vi.fn(async () => "accepted-token"),
    operation: vi.fn(async () => ({
      operationId: "operation-1",
      targetDeviceId: "device-target",
    })),
    operationForTarget: vi.fn(async () => ({
      operationId: "operation-1",
      targetDeviceId: "device-target",
    })),
    abort: vi.fn(async () => "abort-token"),
    commitLost: vi.fn(async () => undefined),
  };
  const removalEffects = {
    isConnected: vi.fn(() => true),
    accept: vi.fn(async () => ({ conversations: ["conv-main"], hasAcceptedWork: true })),
    abort: vi.fn(async () => removalPublicState("cancelled")),
    decide: vi.fn(async () => removalPublicState("moving-conversations")),
  };
  const application = new DeviceAdministrationApplicationService({
    relationships,
    removalState,
    dutyMigrationTargets,
    removalContext,
    removalAuthority,
    removalEffects,
  });
  return {
    application,
    relationships,
    removalState,
    dutyMigrationTargets,
    removalContext,
    removalAuthority,
    removalEffects,
  };
}

describe("DeviceAdministrationApplicationService", () => {
  it("owns the finite user-visible read projections and freezes returned values", async () => {
    const f = fixture();

    const devices = await f.application.query({ kind: "list-device-relationships" });
    const state = await f.application.query({
      kind: "read-device-removal-state",
      targetName: "书房设备",
    });
    const targets = await f.application.query({ kind: "list-duty-migration-targets" });

    expect(devices).toEqual({ devices: [{ displayName: "书房设备", reachable: true }] });
    expect(state).toEqual({
      state: {
        phase: "moving-conversations",
        conversations: ["conv-main"],
        localData: "known",
        credentialActions: ["等待设备完成清理"],
      },
    });
    expect(targets).toEqual({
      devices: [{
        deviceId: "device-2",
        displayName: "客厅主机",
        ready: false,
        code: "unavailable",
      }],
    });
    expect(Object.isFrozen(devices.devices)).toBe(true);
    expect(Object.isFrozen(state.state?.conversations)).toBe(true);
    expect(Object.isFrozen(targets.devices[0])).toBe(true);
    expect(f.removalState.read).toHaveBeenCalledWith("书房设备");
  });

  it("projects missing durable removal state as null and rejects an invalid identity", async () => {
    const f = fixture();
    f.removalState.read.mockResolvedValueOnce(undefined);
    await expect(f.application.query({
      kind: "read-device-removal-state",
      targetName: "书房设备",
    })).resolves.toEqual({ state: null });
    await expect(f.application.query({
      kind: "read-device-removal-state",
      targetName: "",
    })).rejects.toThrow("Device name must be a non-empty string");
  });

  it("contributes exactly three Query and two Command operations with no Fact event", async () => {
    const f = fixture();
    const dispatcher = new ProductApiDispatcher(
      DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
      [createDeviceAdministrationProductApiContribution(f.application)],
    );

    await expect(dispatcher.query(DEVICE_ADMINISTRATION_LIST_QUERY, {
      kind: "list-device-relationships",
    })).resolves.toEqual({ devices: [{ displayName: "书房设备", reachable: true }] });
    await expect(dispatcher.query(DEVICE_ADMINISTRATION_STATUS_QUERY, {
      kind: "read-device-removal-state",
      targetName: "书房设备",
    })).resolves.toMatchObject({ state: { phase: "moving-conversations" } });
    await expect(dispatcher.query(DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY, {
      kind: "list-duty-migration-targets",
    })).resolves.toMatchObject({ devices: [{ deviceId: "device-2" }] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND, {
      kind: "begin-device-removal",
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "书房设备",
    })).resolves.toMatchObject({ result: { conversations: ["conv-main"] }, facts: [] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND, {
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "transfer",
    })).resolves.toMatchObject({ result: { phase: "moving-conversations" }, facts: [] });
    expect(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.factEvents).toEqual([]);
    expect(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.operations.map(({ identity }) => identity))
      .toEqual([
        "device-administration.query.list",
        "device-administration.query.removal-status",
        "device-administration.query.duty-migration-targets",
        "device-administration.command.begin-removal",
        "device-administration.command.continue-removal",
      ]);
  });

  it("owns begin selection and only sends an accepted receipt to a connected target", async () => {
    const f = fixture();
    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "书房设备",
    })).resolves.toEqual({ conversations: ["conv-main"], hasAcceptedWork: true });
    expect(f.removalAuthority.acceptForTarget).toHaveBeenCalledWith({
      requestId: "request-1",
      operationId: "operation-1",
      targetDeviceId: "device-target",
    });
    expect(f.removalEffects.accept).toHaveBeenCalledWith({
      targetDeviceId: "device-target",
      accepted: "accepted-token",
    });

    f.removalEffects.isConnected.mockReturnValueOnce(false);
    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-2",
      operationId: "operation-2",
      targetName: "书房设备",
    })).resolves.toEqual({ conversations: [], hasAcceptedWork: false });
    expect(f.removalEffects.accept).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a non-duty caller, unknown target and current-duty self removal", async () => {
    const f = fixture();
    f.removalContext.read.mockReturnValueOnce({
      localDeviceId: "device-target",
      currentDutyDeviceId: "device-duty",
      members: [],
    });
    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "书房设备",
    })).rejects.toThrow("Only the current duty device can remove a paired device");
    expect(f.removalAuthority.acceptForTarget).not.toHaveBeenCalled();

    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-2",
      operationId: "operation-2",
      targetName: "未知设备",
    })).rejects.toThrow("No active paired device has that name");

    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-3",
      operationId: "operation-3",
      targetName: "值班设备",
    })).rejects.toThrow("The current duty device cannot remove itself");
    expect(f.removalAuthority.acceptForTarget).not.toHaveBeenCalled();
  });

  it("owns transfer, lost and offline cancellation results without interpreting mechanism tokens", async () => {
    const f = fixture();
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "transfer",
    })).resolves.toMatchObject({ phase: "moving-conversations" });
    expect(f.removalEffects.decide).toHaveBeenCalledWith({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      mode: "transfer",
      currentDutyDeviceId: "device-duty",
    });

    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "lost",
    })).resolves.toEqual({
      phase: "removed",
      conversations: [],
      localData: "unknown",
      credentialActions: ["Change credentials for accounts used on this device"],
    });
    expect(f.removalAuthority.commitLost).toHaveBeenCalledWith("operation-1");

    f.removalEffects.isConnected.mockReturnValueOnce(false);
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "cancel",
    })).resolves.toEqual({
      phase: "waiting-for-device",
      conversations: [],
      localData: "known",
      credentialActions: ["取消已安全记录；目标设备上线后会自动恢复准入"],
    });
    expect(f.removalAuthority.abort).toHaveBeenCalledWith("operation-1");
    expect(f.removalEffects.abort).not.toHaveBeenCalled();
  });

  it("keeps exact cancellation replay and rejects ambiguous or mismatched identities", async () => {
    const f = fixture();
    f.removalAuthority.operation.mockResolvedValueOnce(undefined);
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "cancel",
      operationId: "operation-complete",
    })).resolves.toEqual(removalPublicState("cancelled"));

    f.removalContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      members: [
        { deviceId: "device-a", displayName: "同名设备", state: "active" },
        { deviceId: "device-b", displayName: "同名设备", state: "active" },
      ],
    });
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "同名设备",
      mode: "destroy",
    })).rejects.toThrow("Paired device name is not unique");

    f.removalAuthority.operationForTarget.mockResolvedValueOnce({
      operationId: "operation-other",
      targetDeviceId: "device-other",
    });
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "destroy",
    })).rejects.toThrow("Removal target name does not match the accepted device");
  });

  it("passes the durable abort token once and refuses inactive or offline transfer", async () => {
    const f = fixture();
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "cancel",
      operationId: "operation-1",
    })).resolves.toEqual(removalPublicState("cancelled"));
    expect(f.removalAuthority.abort).toHaveBeenCalledTimes(1);
    expect(f.removalEffects.abort).toHaveBeenCalledWith({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      abort: "abort-token",
    });

    f.removalContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      members: [{
        deviceId: "device-target",
        displayName: "书房设备",
        state: "revoked",
      }],
    });
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "destroy",
    })).rejects.toThrow("Removal target is no longer an active paired device");

    f.removalEffects.isConnected.mockReturnValueOnce(false);
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "transfer",
    })).rejects.toThrow("The device is offline");
    expect(f.removalEffects.decide).not.toHaveBeenCalled();
  });
});

function removalPublicState(
  phase: "moving-conversations" | "cancelled",
) {
  return {
    phase,
    conversations: [],
    localData: "known" as const,
    credentialActions: [],
  };
}
