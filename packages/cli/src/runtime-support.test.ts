import { describe, expect, it } from "vitest";
import { assertSupportedRuntime } from "./runtime-support.js";

describe("assertSupportedRuntime", () => {
  it("accepts the declared Windows x64 Node lower bound and later versions", () => {
    expect(() => assertSupportedRuntime({ platform: "win32", arch: "x64", nodeVersion: "24.0.0" })).not.toThrow();
    expect(() => assertSupportedRuntime({ platform: "win32", arch: "x64", nodeVersion: "30.1.0" })).not.toThrow();
  });

  it("rejects unsupported Node before any product state is touched", () => {
    expect(() => assertSupportedRuntime({ platform: "win32", arch: "x64", nodeVersion: "23.9.0" }))
      .toThrow("Node.js 24 或更高版本");
  });

  it.each([
    ["linux", "x64"],
    ["darwin", "arm64"],
    ["win32", "arm64"],
  ] as const)("rejects the unshipped %s/%s target", (platform, arch) => {
    expect(() => assertSupportedRuntime({ platform, arch, nodeVersion: "24.0.0" }))
      .toThrow("仅支持 Windows x64");
  });
});
