import type { SecretStorePort } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import {
  assertDeviceReadyForRole,
  evaluateDeviceReadiness,
  nextDeviceOnboardingStep,
} from "../device-readiness.js";
import type { TrustProjection } from "../trust-chain.js";

const store = (state: "unlocked" | "locked" = "unlocked") =>
  ({ unlockState: async () => state }) as SecretStorePort;

const trust = (memberState: "active" | "revoked" | "pending-reenroll" = "active") =>
  ({
    homeId: "home",
    trustEpoch: 1,
    chainHead: { seq: 1, eventDigest: "sha256:x" },
    issuer: { deviceId: "device", issuerKeyId: "device" },
    members: [
      {
        device: {
          deviceId: "device",
          publicKey: "ed25519:key",
          displayName: "Device",
          platform: "linux",
          enrolledAt: "2026-01-01T00:00:00.000Z",
        },
        roles: ["executor"],
        state: memberState,
      },
    ],
  }) as TrustProjection;

describe("device readiness", () => {
  it("moves paired through configured to ready and degrades after a ready check is lost", async () => {
    const configured = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      roleConfigurationComplete: true,
      requirements: [{ kind: "provider", id: "main" }],
      checks: [
        {
          kind: "provider",
          id: "main",
          configured: true,
          ready: false,
          reason: "模型服务凭据不可用",
        },
      ],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    expect(configured.state).toBe("configured");

    const ready = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      previous: configured,
      roleConfigurationComplete: true,
      requirements: [{ kind: "provider", id: "main" }],
      checks: [{ kind: "provider", id: "main", configured: true, ready: true }],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    expect(ready.state).toBe("ready");
    expect(ready.checks.every((check) => check.reason === undefined)).toBe(true);
    expect(() => assertDeviceReadyForRole(ready, "executor")).not.toThrow();

    const degraded = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      previous: ready,
      roleConfigurationComplete: true,
      requirements: [{ kind: "provider", id: "main" }],
      checks: [{ kind: "provider", id: "main", configured: true, ready: true }],
      secretStore: store("locked"),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    expect(degraded.state).toBe("degraded");
    expect(() => assertDeviceReadyForRole(degraded, "executor")).toThrow("not ready");
  });

  it("keeps onboarding linear and trust revocation terminal", async () => {
    const revoked = await evaluateDeviceReadiness({
      trust: trust("revoked"),
      deviceId: "device",
      roleConfigurationComplete: true,
      requirements: [],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    expect(nextDeviceOnboardingStep({ readiness: revoked, recoveryReady: true, dutySelected: true })).toEqual({
      kind: "revoked",
      message: "这台设备已撤销",
    });
  });

  it("fails closed when a declared role requirement has no readiness result", async () => {
    const result = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      roleConfigurationComplete: true,
      requirements: [{ kind: "mcp", id: "github" }],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    expect(result.state).toBe("paired");
    expect(result.missing).toContainEqual({
      kind: "mcp",
      id: "github",
      reason: "缺少目标角色就绪检查",
    });
  });

  it("exposes incomplete target-role configuration as an actionable missing check", async () => {
    const result = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      roleConfigurationComplete: false,
      requirements: [],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });

    expect(result.state).toBe("paired");
    expect(result.missing).toContainEqual({
      kind: "role-configuration",
      id: "target-role",
      reason: "目标角色配置尚未补齐",
    });
  });

  it("rejects a trust projection that silently drops a previously enrolled device", async () => {
    const previous = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      roleConfigurationComplete: false,
      requirements: [],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    await expect(
      evaluateDeviceReadiness({
        trust: { ...trust(), members: [] },
        deviceId: "device",
        previous,
        roleConfigurationComplete: false,
        requirements: [],
        checks: [],
        secretStore: store(),
        legacyPlaintextPresent: false,
        protocolVersionCompatible: true,
      }),
    ).rejects.toThrow("lost an enrolled device");
  });

  it("recovers degraded devices, keeps revocation terminal and exposes pending reenrollment", async () => {
    const ready = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      roleConfigurationComplete: true,
      requirements: [],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    const degraded = await evaluateDeviceReadiness({
      trust: trust(),
      deviceId: "device",
      previous: ready,
      roleConfigurationComplete: true,
      requirements: [],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: true,
      protocolVersionCompatible: true,
    });
    expect(degraded.state).toBe("degraded");
    expect(degraded.missing).toContainEqual({
      kind: "plaintext-credential",
      id: "legacy-file",
      reason: "旧明文凭据尚未清退",
    });
    await expect(
      evaluateDeviceReadiness({
        trust: trust(),
        deviceId: "device",
        previous: degraded,
        roleConfigurationComplete: true,
        requirements: [],
        checks: [],
        secretStore: store(),
        legacyPlaintextPresent: false,
        protocolVersionCompatible: true,
      }),
    ).resolves.toMatchObject({ state: "ready" });

    const revoked = await evaluateDeviceReadiness({
      trust: trust("revoked"),
      deviceId: "device",
      previous: ready,
      roleConfigurationComplete: true,
      requirements: [],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    await expect(
      evaluateDeviceReadiness({
        trust: trust(),
        deviceId: "device",
        previous: revoked,
        roleConfigurationComplete: true,
        requirements: [],
        checks: [],
        secretStore: store(),
        legacyPlaintextPresent: false,
        protocolVersionCompatible: true,
      }),
    ).rejects.toThrow("cannot return");

    const pending = await evaluateDeviceReadiness({
      trust: trust("pending-reenroll"),
      deviceId: "device",
      roleConfigurationComplete: true,
      requirements: [],
      checks: [],
      secretStore: store(),
      legacyPlaintextPresent: false,
      protocolVersionCompatible: true,
    });
    expect(pending.state).toBe("pending-reenroll");
    expect(
      nextDeviceOnboardingStep({
        readiness: pending,
        recoveryReady: true,
        dutySelected: true,
      }),
    ).toEqual({ kind: "pair", message: "添加这台设备" });
  });

  it("rejects ambiguous failure checks and noncanonical device identities", async () => {
    await expect(
      evaluateDeviceReadiness({
        trust: trust(),
        deviceId: "device",
        roleConfigurationComplete: true,
        requirements: [{ kind: "provider", id: "main" }],
        checks: [{ kind: "provider", id: "main", configured: true, ready: false }],
        secretStore: store(),
        legacyPlaintextPresent: false,
        protocolVersionCompatible: true,
      }),
    ).rejects.toThrow("actionable reason");
    await expect(
      evaluateDeviceReadiness({
        trust: trust(),
        deviceId: " ",
        roleConfigurationComplete: true,
        requirements: [],
        checks: [],
        secretStore: store(),
        legacyPlaintextPresent: false,
        protocolVersionCompatible: true,
      }),
    ).rejects.toThrow("identity is invalid");
  });
});
