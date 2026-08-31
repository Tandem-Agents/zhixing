import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  createDeviceAdministrationProductApiContribution,
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
  const application = new DeviceAdministrationApplicationService({
    relationships,
    removalState,
    dutyMigrationTargets,
  });
  return { application, relationships, removalState, dutyMigrationTargets };
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

  it("contributes exactly three Query operations and no Fact event", async () => {
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
    expect(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.factEvents).toEqual([]);
    expect(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.operations.map(({ identity }) => identity))
      .toEqual([
        "device-administration.query.list",
        "device-administration.query.removal-status",
        "device-administration.query.duty-migration-targets",
      ]);
  });
});
