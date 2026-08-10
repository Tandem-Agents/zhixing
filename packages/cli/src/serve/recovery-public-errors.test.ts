import { describe, expect, it } from "vitest";
import { recoveryRootPublicError } from "./backup-command.js";
import { disasterRecoveryPublicError } from "./disaster-recovery-command.js";

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
});
