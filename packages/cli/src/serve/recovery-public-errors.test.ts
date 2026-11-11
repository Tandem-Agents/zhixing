import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import type { SecretRef } from "@zhixing-ai/core/contracts";
import { RecoveryRootUserError, recoveryRootPublicError } from "./backup-command.js";
import { requireRecoveryPackageSurface } from "./recovery-package-input.js";

/** 只在内存里的秘密存储：新设备身份在这里生成，不碰平台存储。 */
function memorySecretStore() {
  const values = new Map<string, string>();
  const key = (ref: SecretRef) => `${ref.kind}/${ref.bindingId}`;
  return {
    unlockState: async () => "unlocked" as const,
    get: async (ref: SecretRef) => values.get(key(ref)) ?? null,
    getExisting: async (ref: SecretRef) => values.get(key(ref)) ?? null,
    put: async (ref: SecretRef, value: string) => { values.set(key(ref), value); },
    getOrCreate: async (ref: SecretRef, create: () => string) => {
      const existing = values.get(key(ref));
      if (existing !== undefined) return existing;
      const value = create();
      values.set(key(ref), value);
      return value;
    },
    delete: async (ref: SecretRef) => { values.delete(key(ref)); },
    list: async () => [],
  };
}
import {
  disasterRecoveryPublicError,
  runDisasterRecoveryCommand,
} from "./disaster-recovery-command.js";

describe("recovery public errors", () => {
  it("does not expose secret material or internal recovery identities", () => {
    const internal = "root-secret transfer-01 checkpoint-02 sha256:deadbeef C:\\private\\backup";

    const disaster = disasterRecoveryPublicError(new Error(internal)).message;
    const lifecycle = recoveryRootPublicError(new Error(internal)).message;

    for (const message of [disaster, lifecycle]) {
      expect(message).not.toContain("root-secret");
      expect(message).not.toContain("transfer-01");
      expect(message).not.toContain("checkpoint-02");
      expect(message).not.toContain("sha256:");
      expect(message).not.toContain("C:\\private");
    }
    expect(disaster).toContain("不会自动切换值班设备");
    expect(lifecycle).toContain("不会绕过共同确认");
  });

  it("统一说明下保留原错误供日志取首因；保密页取消如实说明未改变", () => {
    const internal = new Error("internal detail");
    expect(recoveryRootPublicError(internal).cause).toBe(internal);
    expect(disasterRecoveryPublicError(internal).cause).toBe(internal);
    const cancelled = Object.assign(new Error("保密输入已取消。"), { code: "SECRET_INPUT_CANCELLED" });
    const mapped = recoveryRootPublicError(cancelled);
    expect(mapped).toBeInstanceOf(RecoveryRootUserError);
    expect(mapped.message).toBe("已取消；恢复码没有改变。");
    // 需要交互式保密输入：两条恢复出口都原样给出可照做的说明
    let surface: unknown;
    try { requireRecoveryPackageSurface(); } catch (error) { surface = error; }
    expect(recoveryRootPublicError(surface).message).toBe("恢复包需要交互式保密输入；请在完整交互终端中重新运行原命令。");
    expect(disasterRecoveryPublicError(surface).message).toBe("恢复包需要交互式保密输入；请在完整交互终端中重新运行原命令。");
  });

  it("恢复码命令的逐项说明原样给出，不被统一说明替换", () => {
    const precise = new RecoveryRootUserError("请先确认立即停用当前恢复码");
    expect(recoveryRootPublicError(precise)).toBe(precise);
    expect(recoveryRootPublicError(new Error("请先确认立即停用当前恢复码")).message).toContain("恢复码操作未完成");
  });

  it("不属于任何家庭的新设备执行无源恢复时说出真实前提，公开出口原样给出、不笼统劝重试", async () => {
    const home = await createTempDir("recovery-fresh-home");
    const error = await runDisasterRecoveryCommand(
      { directory: path.join(home, "..", "recovery-fresh-backup") },
      { zhixingHome: home, secretStore: memorySecretStore() as never, writeLine: () => undefined },
    ).catch((caught: unknown) => caught as Error);
    expect(error.message).toBe(
      "这台设备还不属于任何家庭，不能执行无源恢复：恢复要在原家庭里另一台已配对、有效且可值班的设备上运行 zz backup recover；新设备目前不能直接从备份恢复",
    );
    expect(disasterRecoveryPublicError(error)).toBe(error);
    expect(disasterRecoveryPublicError(new Error("internal detail")).message).toContain("恢复未完成");
  });

  it("rejects conflicting disaster sources through the domain selection contract before IO", async () => {
    await expect(runDisasterRecoveryCommand({
      directory: "D:/backup",
      pairedDeviceName: "peer",
    })).rejects.toEqual(new TypeError("恢复时只能选择一个备份目录或一台备份设备"));
  });
});
