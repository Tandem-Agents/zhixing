import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  issuerDeviceId: "lost-issuer",
  installation: undefined as undefined | {
    installation: {
      transferId: string;
      trustRecord: { issuer: { deviceId: string } };
    };
    generation: { transferId: string };
  },
  admission: {
    requestId: "recover:request",
    transferId: "xfer-current",
    checkpointTargetId: "target-1",
    checkpointEnvelopeDigest: "sha256:checkpoint",
    recoveryRoot: "recovery-root",
    prepare: "signed-prepare",
    checkpoint: "checkpoint-package",
  },
  signAbort: vi.fn((input: unknown) => ({ signedAbort: input })),
}));

vi.mock("@zhixing/core/protocol", async () => {
  const actual = await vi.importActual<typeof import("@zhixing/core/protocol")>(
    "@zhixing/core/protocol",
  );
  return { ...actual, createSignedDisasterRecoveryAbort: fixture.signAbort };
});

vi.mock("@zhixing/core/backup-recovery/application", async () => {
  const actual = await vi.importActual<typeof import(
    "@zhixing/core/backup-recovery/application"
  )>("@zhixing/core/backup-recovery/application");
  return {
    ...actual,
    BackupRecoveryDisasterAdmissionApplicationService: class {
      async admit(): Promise<typeof fixture.admission> {
        fixture.calls.push("admit");
        return fixture.admission;
      }
    },
  };
});

vi.mock("@zhixing/providers", () => ({
  loadConfig: () => ({}),
  loadCredentialSnapshot: vi.fn(),
}));

vi.mock("./mesh-device-key.js", () => ({
  loadOrCreateDeviceKey: async () => ({ deviceId: "target" }),
}));

vi.mock("./mesh-bootstrap-store.js", () => ({
  FileMeshBootstrapStore: class {
    async loadTrustRecord() {
      return {
        homeId: "home-1",
        issuer: { deviceId: fixture.issuerDeviceId },
        members: [{
          device: { deviceId: "target", displayName: "target" },
          state: "active",
          roles: ["anchor"],
        }],
      };
    }

    authorityLog() {
      return { id: "authority-log" };
    }
  },
}));

vi.mock("./disaster-recovery-trust-evidence.js", () => ({
  collectDisasterRecoveryTrustEvidence: async () => {
    fixture.calls.push("evidence");
    return { digest: "sha256:evidence" };
  },
}));

vi.mock("./disaster-recovery-installation.js", () => ({
  loadCurrentDisasterRecoveryInstallation: async () => {
    fixture.calls.push("installation");
    return fixture.installation;
  },
  waitForDisasterRecoveryPostInstallReceipt: async () => {
    fixture.calls.push("receipt");
  },
}));

vi.mock("./credential-exposure-authority.js", () => ({
  CredentialExposureAuthority: class {
    async rotationRequired() {
      fixture.calls.push("credentials");
      return [{ service: "github" }];
    }
  },
}));

import {
  runDisasterRecoveryCommand,
  runDisasterRecoveryFinishCommand,
  type DisasterRecoveryCommandOptions,
} from "./disaster-recovery-command.js";

function options(target: {
  prepareAndImport?: (input: unknown) => Promise<unknown>;
  commit?: (input: unknown) => Promise<unknown>;
  abort?: (input: unknown) => Promise<unknown>;
  tombstone?: (input: unknown) => Promise<unknown>;
}, lines: string[]): DisasterRecoveryCommandOptions {
  return {
    zhixingHome: "X:/isolated-home",
    secretStore: {
      unlockState: async () => "unlocked",
    } as DisasterRecoveryCommandOptions["secretStore"],
    storageMaintenance: {} as NonNullable<DisasterRecoveryCommandOptions["storageMaintenance"]>,
    target: target as DisasterRecoveryCommandOptions["target"],
    writeLine: (line) => lines.push(line),
  };
}

describe("disaster recovery command lifecycle adapter", () => {
  beforeEach(() => {
    fixture.calls.length = 0;
    fixture.issuerDeviceId = "lost-issuer";
    fixture.installation = undefined;
    fixture.signAbort.mockClear();
  });

  it("binds fresh admission, prepare, commit, receipt and typed presentation to one application", async () => {
    const lines: string[] = [];
    const target = {
      prepareAndImport: vi.fn(async () => fixture.calls.push("prepare")),
      commit: vi.fn(async () => {
        fixture.calls.push("commit");
        fixture.installation = {
          installation: {
            transferId: "xfer-current",
            trustRecord: { issuer: { deviceId: "target" } },
          },
          generation: { transferId: "xfer-current" },
        };
      }),
      abort: vi.fn(),
      tombstone: vi.fn(),
    };

    await runDisasterRecoveryCommand({ directory: "X:/backup" }, options(target, lines));

    expect(fixture.calls).toEqual([
      "admit",
      "evidence",
      "prepare",
      "commit",
      "installation",
      "receipt",
      "credentials",
    ]);
    expect(target.prepareAndImport).toHaveBeenCalledWith({
      prepare: "signed-prepare",
      checkpoint: "checkpoint-package",
      recoveryRoot: "recovery-root",
      trustEvidence: { digest: "sha256:evidence" },
      signal: expect.any(AbortSignal),
    });
    expect(target.commit).toHaveBeenCalledWith({
      transferId: "xfer-current",
      recoveryRoot: "recovery-root",
      signal: expect.any(AbortSignal),
    });
    expect(lines).toEqual([
      "备份验证完成，正在恢复数据并接管值班……",
      "恢复数据已安全提交；旧值班设备已失权。",
      "请处理以下受旧设备影响的第三方账号：",
      "- github：在对应服务中撤销旧凭据并发布新凭据",
      "确认旧设备已隔离或擦除后，运行 zz backup recover-finish。",
    ]);
  });

  it("continues the current installation without reopening fresh admission", async () => {
    const lines: string[] = [];
    fixture.issuerDeviceId = "target";
    fixture.installation = {
      installation: {
        transferId: "xfer-current",
        trustRecord: { issuer: { deviceId: "target" } },
      },
      generation: { transferId: "xfer-current" },
    };
    const target = { tombstone: vi.fn() };

    await runDisasterRecoveryCommand({}, options(target, lines));

    expect(fixture.calls).toEqual(["installation", "receipt", "credentials"]);
    expect(lines[0]).toBe("恢复数据已安全提交；旧值班设备已失权。");
  });

  it("signs the domain-owned abort identity and preserves the install failure", async () => {
    const primary = new Error("prepare-failed");
    const target = {
      prepareAndImport: vi.fn(async () => {
        throw primary;
      }),
      commit: vi.fn(),
      abort: vi.fn(async () => undefined),
      tombstone: vi.fn(),
    };

    await expect(runDisasterRecoveryCommand(
      { directory: "X:/backup" },
      { ...options(target, []), now: () => Date.parse("2026-09-01T00:00:00.000Z") },
    )).rejects.toBe(primary);
    expect(fixture.signAbort).toHaveBeenCalledWith({
      v: 1,
      mode: "disaster-recovery",
      requestId: "recover:request",
      transferId: "xfer-current",
      targetDeviceId: "target",
      checkpointTargetId: "target-1",
      checkpointEnvelopeDigest: "sha256:checkpoint",
      reason: "operator-cancelled",
      at: "2026-09-01T00:00:00.000Z",
    }, "recovery-root");
    expect(target.abort).toHaveBeenCalledWith({
      abort: { signedAbort: expect.any(Object) },
      recoveryRoot: "recovery-root",
    });
    expect(target.commit).not.toHaveBeenCalled();
  });

  it("checks finish confirmation before context IO and forwards the installed identity", async () => {
    const lines: string[] = [];
    const target = {
      tombstoneDisposition: vi.fn(async () => "eligible" as const),
      tombstone: vi.fn(async () => undefined),
    };
    await expect(runDisasterRecoveryFinishCommand({
      userConfirmedOldDeviceIsolated: false,
    }, options(target, lines))).rejects.toThrow("请先确认旧值班设备已经隔离或擦除");
    expect(fixture.calls).toEqual([]);

    fixture.installation = {
      installation: {
        transferId: "xfer-current",
        trustRecord: { issuer: { deviceId: "target" } },
      },
      generation: { transferId: "xfer-current" },
    };
    await runDisasterRecoveryFinishCommand({
      userConfirmedOldDeviceIsolated: true,
    }, options(target, lines));
    expect(target.tombstoneDisposition).toHaveBeenCalledWith("xfer-current");
    expect(target.tombstone).toHaveBeenCalledWith({
      transferId: "xfer-current",
      userConfirmedOldDeviceIsolated: true,
    });
    expect(lines).toEqual(["旧设备隔离已确认，恢复流程完成。"]);
  });
});
