import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreHostConnection } from "./core-host-connection.js";
import {
  createDutyMigrationTransferId,
  listDutyMigrationTargets,
  prepareDutyMigration,
  continueDutyMigration,
  cancelDutyMigration,
  selectDutyMigrationTarget,
  type DutyMigrationSelectionIO,
  type DutyMigrationManagement,
} from "./duty-migration-command.js";

afterEach(() => vi.restoreAllMocks());

describe("borrowed duty migration interaction", () => {
  it("uses the injected choice and connection through list, prepare, continue and cancel", async () => {
    const ensure = vi.spyOn(CoreHostConnection.prototype, "ensure").mockRejectedValue(new Error("unexpected Host"));
    const dispose = vi.spyOn(CoreHostConnection.prototype, "dispose").mockResolvedValue(undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const management = migrationManagement();
    const lines: string[] = [];
    const selectIndex = vi.fn(async () => 0);
    const options = { management, writeLine: (line: string) => lines.push(line),
      io: { interactive: true, selectIndex } };
    await listDutyMigrationTargets(options);
    await prepareDutyMigration(undefined, false, options);
    const prepared = management.dutyMigrationPrepare.mock.calls[0]![0];
    expect(prepared.targetDeviceId).toBe("device-ready");
    expect(lines).toContain(`继续：zz duty continue ${prepared.transferId}`);
    expect(lines).toContain(`取消：zz duty cancel ${prepared.transferId}`);
    await continueDutyMigration(prepared.transferId, options);
    await cancelDutyMigration(prepared.transferId, options);
    expect(management.dutyMigrationCommit).toHaveBeenCalledWith({
      requestId: prepared.requestId, transferId: prepared.transferId,
    });
    expect(management.dutyMigrationCancel).toHaveBeenCalledWith({
      requestId: prepared.requestId, transferId: prepared.transferId,
    });
    expect(selectIndex).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rejects a stale choice before prepare and preserves a prepared transfer on close", async () => {
    const abortedChoice = new AbortController();
    const beforePrepare = migrationManagement();
    await expect(prepareDutyMigration(undefined, true, {
      management: beforePrepare, signal: abortedChoice.signal, writeLine: () => undefined,
      io: { interactive: true, selectIndex: async () => { abortedChoice.abort(); return 0; } },
    })).rejects.toThrow();
    expect(beforePrepare.dutyMigrationPrepare).not.toHaveBeenCalled();

    const abortAfterPrepare = new AbortController();
    const management = migrationManagement();
    management.dutyMigrationPrepare.mockImplementation(async () => {
      abortAfterPrepare.abort(); return { stage: "ready" };
    });
    const lines: string[] = [];
    await expect(prepareDutyMigration("接班电脑", true, {
      management, signal: abortAfterPrepare.signal, writeLine: (line) => lines.push(line),
    })).rejects.toThrow();
    expect(management.dutyMigrationCommit).not.toHaveBeenCalled();
    expect(management.dutyMigrationCancel).not.toHaveBeenCalled();
    expect(lines.some((line) => line.startsWith("继续：zz duty continue "))).toBe(true);
    expect(lines.some((line) => line.startsWith("取消：zz duty cancel "))).toBe(true);
  });
});

function migrationManagement() {
  return {
    dutyMigrationTargets: vi.fn<DutyMigrationManagement["dutyMigrationTargets"]>(async () => [
      { deviceId: "device-ready", displayName: "接班电脑", ready: true },
    ]),
    dutyMigrationPrepare: vi.fn<DutyMigrationManagement["dutyMigrationPrepare"]>(async () => ({ stage: "ready" })),
    dutyMigrationCommit: vi.fn<DutyMigrationManagement["dutyMigrationCommit"]>(async () => ({ stage: "completed" })),
    dutyMigrationCancel: vi.fn<DutyMigrationManagement["dutyMigrationCancel"]>(async () => ({ stage: "cancelled" })),
  };
}

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
