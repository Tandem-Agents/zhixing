import { describe, expect, it, vi } from "vitest";
import {
  createDutyMigrationTransferId,
  selectDutyMigrationTarget,
  type DutyMigrationSelectionIO,
} from "./duty-migration-command.js";

describe("duty migration target selection", () => {
  it("creates the strict planned-transfer identity consumed by staging and wire codecs", () => {
    expect(createDutyMigrationTransferId(1_720_000_000_000)).toMatch(
      /^xfer-[0-9A-HJKMNP-TV-Z]{26}$/u,
    );
  });

  it("selects a unique ready device by display name without requiring its internal id", async () => {
    const management = directory([
      { deviceId: "internal-device-a", displayName: "客厅主机", ready: true },
    ]);

    await expect(selectDutyMigrationTarget(
      management,
      "客厅主机",
      nonInteractive,
    )).resolves.toMatchObject({ deviceId: "internal-device-a" });
  });

  it("rejects duplicate names and unavailable targets without exposing internal ids", async () => {
    const duplicate = directory([
      { deviceId: "internal-device-a", displayName: "工作站", ready: true },
      { deviceId: "internal-device-b", displayName: "工作站", ready: true },
    ]);
    const unavailable = directory([
      {
        deviceId: "internal-device-c",
        displayName: "旅行本",
        ready: false,
        code: "unavailable" as const,
      },
    ]);

    const duplicateError = await selectDutyMigrationTarget(
      duplicate,
      "工作站",
      nonInteractive,
    ).catch((error) => error as Error);
    const unavailableError = await selectDutyMigrationTarget(
      unavailable,
      "旅行本",
      nonInteractive,
    ).catch((error) => error as Error);
    expect(duplicateError.message).toContain("唯一名称");
    expect(unavailableError.message).toContain("暂不可接班");
    expect(`${duplicateError.message} ${unavailableError.message}`).not.toContain("internal-device");
  });

  it("uses a numbered ready-only choice in TTY mode and requires a name otherwise", async () => {
    const management = directory([
      { deviceId: "internal-offline", displayName: "离线设备", ready: false },
      { deviceId: "internal-ready-a", displayName: "一号设备", ready: true },
      { deviceId: "internal-ready-b", displayName: "二号设备", ready: true },
    ]);
    const selectIndex = vi.fn(async () => 1);

    await expect(selectDutyMigrationTarget(management, undefined, {
      interactive: true,
      selectIndex,
    })).resolves.toMatchObject({ deviceId: "internal-ready-b" });
    expect(selectIndex.mock.calls[0]?.[0].map((target) => target.displayName)).toEqual([
      "一号设备",
      "二号设备",
    ]);
    await expect(selectDutyMigrationTarget(
      management,
      undefined,
      nonInteractive,
    )).rejects.toThrow("必须提供唯一的目标设备名称");
  });
});

const nonInteractive: DutyMigrationSelectionIO = {
  interactive: false,
  selectIndex: async () => {
    throw new Error("non-interactive selection must not prompt");
  },
};

function directory(targets: readonly {
  readonly deviceId: string;
  readonly displayName: string;
  readonly ready: boolean;
  readonly code?: "unavailable";
}[]) {
  return {
    dutyMigrationTargets: vi.fn(async () => [...targets]),
  };
}
