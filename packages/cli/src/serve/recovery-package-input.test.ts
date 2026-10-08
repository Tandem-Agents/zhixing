import { describe, expect, it } from "vitest";
import { assertRecoveryPackageInputLimit, DEFAULT_MAX_RECOVERY_PACKAGE_BYTES, requireRecoveryPackageSurface } from "./recovery-package-input.js";
describe("managed recovery package input", () => {
  it("keeps the encoded 16 MiB boundary for dedicated input and counts UTF-8 bytes", () => {
    expect(DEFAULT_MAX_RECOVERY_PACKAGE_BYTES).toBe(16 * 1024 * 1024);
    const exact = "x".repeat(DEFAULT_MAX_RECOVERY_PACKAGE_BYTES);
    expect(() => assertRecoveryPackageInputLimit(exact)).not.toThrow();
    expect(() => assertRecoveryPackageInputLimit(`${exact}x`)).toThrow("超过允许长度");
    expect(() => assertRecoveryPackageInputLimit("密", 3)).not.toThrow();
    expect(() => assertRecoveryPackageInputLimit("密", 2)).toThrow("超过允许长度");
  });

  it("requires the dedicated surface without acquiring stdin or changing terminal modes", () => {
    const raw = process.stdin.isRaw, listeners = process.stdin.listenerCount("data");
    expect(() => requireRecoveryPackageSurface()).toThrow("交互式保密输入");
    expect(process.stdin.isRaw).toBe(raw);
    expect(process.stdin.listenerCount("data")).toBe(listeners);
  });
});
