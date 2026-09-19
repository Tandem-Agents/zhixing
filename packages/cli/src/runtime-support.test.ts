import { describe, expect, it } from "vitest";
import { assertSupportedRuntime } from "./runtime-support.js";

describe("assertSupportedRuntime", () => {
  it.each([
    ["win32", "x64"], ["darwin", "x64"], ["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"],
  ] as const)("accepts %s/%s on the Node lower bound and later versions", (platform, arch) => {
    for (const nodeVersion of ["24.0.0", "30.1.0"]) {
      expect(() => assertSupportedRuntime({ platform, arch, nodeVersion, glibcVersion: "2.35" })).not.toThrow();
    }
  });

  it("rejects unsupported Node before any product state is touched", () => {
    expect(() => assertSupportedRuntime({ platform: "win32", arch: "x64", nodeVersion: "23.9.0" }))
      .toThrow("Node.js 24 或更高版本");
  });

  it.each([
    ["linux", "ia32"],
    ["freebsd", "x64"],
    ["win32", "arm64"],
  ] as const)("rejects the unshipped %s/%s target", (platform, arch) => {
    expect(() => assertSupportedRuntime({ platform, arch, nodeVersion: "24.0.0" }))
      .toThrow("尚未提供");
  });
  it("rejects incompatible Linux libc before any product state is touched", () => {
    expect(() => assertSupportedRuntime({ platform: "linux", arch: "x64", nodeVersion: "24.0.0", glibcVersion: "2.31" }))
      .toThrow("glibc 2.35");
  });
});
