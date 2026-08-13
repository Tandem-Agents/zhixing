import type { DeviceRole, SecretStorePort } from "@zhixing/core/contracts";
import type { TrustProjection } from "./trust-chain.js";

export type DeviceReadinessState =
  | "unpaired"
  | "paired"
  | "configured"
  | "ready"
  | "degraded"
  | "revoked"
  | "pending-reenroll";

export type DeviceReadinessCheckKind =
  | "provider"
  | "mcp"
  | "channel"
  | "role-configuration"
  | "secret-store"
  | "protocol-version";

export interface DeviceReadinessCheck {
  readonly kind: DeviceReadinessCheckKind;
  readonly id: string;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly reason?: string;
}

export interface DeviceReadinessRequirement {
  readonly kind: "provider" | "mcp" | "channel";
  readonly id: string;
}

export interface DeviceReadinessProjection {
  readonly deviceId: string;
  readonly state: DeviceReadinessState;
  readonly roles: readonly DeviceRole[];
  readonly checks: readonly DeviceReadinessCheck[];
  readonly missing: readonly Pick<DeviceReadinessCheck, "kind" | "id" | "reason">[];
}

export async function evaluateDeviceReadiness(input: {
  readonly trust: TrustProjection;
  readonly deviceId: string;
  readonly previous?: DeviceReadinessProjection;
  readonly roleConfigurationComplete: boolean;
  readonly requirements: readonly DeviceReadinessRequirement[];
  readonly checks: readonly DeviceReadinessCheck[];
  readonly secretStore: SecretStorePort;
  readonly protocolVersionCompatible: boolean;
}): Promise<DeviceReadinessProjection> {
  if (!isCanonicalText(input.deviceId)) {
    throw new TypeError("Device readiness identity is invalid");
  }
  if (input.previous && input.previous.deviceId !== input.deviceId) {
    throw new TypeError("Device readiness history belongs to another device");
  }
  const member = input.trust.members.find((candidate) => candidate.device.deviceId === input.deviceId);
  if (input.previous?.state === "revoked" && member?.state !== "revoked") {
    throw new Error("A revoked device cannot return to another readiness state");
  }
  if (!member) {
    if (input.previous && input.previous.state !== "unpaired") {
      throw new Error("Trust projection lost an enrolled device without a terminal transition");
    }
    return freezeProjection(input.deviceId, "unpaired", [], []);
  }
  if (member.state === "revoked") {
    return freezeProjection(input.deviceId, "revoked", member.roles, []);
  }
  if (member.state === "pending-reenroll") {
    return freezeProjection(input.deviceId, "pending-reenroll", member.roles, []);
  }

  const secretStoreReady = (await input.secretStore.unlockState()) === "unlocked";
  const checks = normalizeChecks([
    ...resolveRoleChecks(input.requirements, input.checks),
    {
      kind: "role-configuration",
      id: "target-role",
      configured: input.roleConfigurationComplete,
      ready: input.roleConfigurationComplete,
      ...(!input.roleConfigurationComplete ? { reason: "目标角色配置尚未补齐" } : {}),
    },
    {
      kind: "secret-store",
      id: "device-local",
      configured: true,
      ready: secretStoreReady,
      ...(!secretStoreReady ? { reason: "设备秘密存储未解锁" } : {}),
    },
    {
      kind: "protocol-version",
      id: "mesh",
      configured: true,
      ready: input.protocolVersionCompatible,
      ...(!input.protocolVersionCompatible ? { reason: "协议版本不兼容" } : {}),
    },
  ]);
  const configured = checks.every((check) => check.configured);
  const allReady = configured && checks.every((check) => check.ready);
  let state: DeviceReadinessState;
  if (!configured) state = "paired";
  else if (allReady) state = "ready";
  else if (input.previous?.state === "ready" || input.previous?.state === "degraded") {
    state = "degraded";
  } else {
    state = "configured";
  }
  if (input.previous?.state === "configured" && state === "paired") {
    throw new Error("Configured readiness cannot roll back to paired without a trust transition");
  }
  return freezeProjection(input.deviceId, state, member.roles, checks);
}

export function assertDeviceReadyForRole(
  readiness: DeviceReadinessProjection,
  role: DeviceRole,
): void {
  if (readiness.state !== "ready" || !readiness.roles.includes(role)) {
    throw new Error(`Device ${readiness.deviceId} is not ready for role ${role}`);
  }
}

export type DeviceOnboardingStep =
  | { readonly kind: "pair"; readonly message: "添加这台设备" }
  | { readonly kind: "recovery-package"; readonly message: "保存恢复码并完成验证" }
  | {
      readonly kind: "configure";
      readonly message: "补齐这台设备需要的登录信息";
      readonly missing: DeviceReadinessProjection["missing"];
    }
  | { readonly kind: "select-duty"; readonly message: "选择哪台设备长期开机值班" }
  | { readonly kind: "complete"; readonly message: "这台设备已就绪" }
  | { readonly kind: "revoked"; readonly message: "这台设备已撤销" };

export function nextDeviceOnboardingStep(input: {
  readonly readiness: DeviceReadinessProjection;
  readonly recoveryReady: boolean;
  readonly dutySelected: boolean;
}): DeviceOnboardingStep {
  if (input.readiness.state === "unpaired" || input.readiness.state === "pending-reenroll") {
    return { kind: "pair", message: "添加这台设备" };
  }
  if (input.readiness.state === "revoked") {
    return { kind: "revoked", message: "这台设备已撤销" };
  }
  if (!input.recoveryReady) {
    return { kind: "recovery-package", message: "保存恢复码并完成验证" };
  }
  if (input.readiness.state !== "ready") {
    return {
      kind: "configure",
      message: "补齐这台设备需要的登录信息",
      missing: input.readiness.missing,
    };
  }
  if (!input.dutySelected) {
    return { kind: "select-duty", message: "选择哪台设备长期开机值班" };
  }
  return { kind: "complete", message: "这台设备已就绪" };
}

function normalizeChecks(checks: readonly DeviceReadinessCheck[]): DeviceReadinessCheck[] {
  const allowedKinds = new Set<DeviceReadinessCheckKind>([
    "provider",
    "mcp",
    "channel",
    "role-configuration",
    "secret-store",
    "protocol-version",
  ]);
  const seen = new Set<string>();
  return checks
    .map((check) => {
      const key = `${check.kind}/${check.id}`;
      if (
        !allowedKinds.has(check.kind) ||
        !isCanonicalText(check.id) ||
        typeof check.configured !== "boolean" ||
        typeof check.ready !== "boolean" ||
        (check.reason !== undefined && !isCanonicalText(check.reason)) ||
        seen.has(key)
      ) {
        throw new TypeError("Device readiness checks must be valid and unique");
      }
      if (check.ready && !check.configured) {
        throw new TypeError("An unconfigured readiness check cannot be ready");
      }
      if (check.ready && check.reason !== undefined) {
        throw new TypeError("A ready check cannot carry a failure reason");
      }
      if (!check.ready && check.reason === undefined) {
        throw new TypeError("A failing readiness check must carry an actionable reason");
      }
      seen.add(key);
      return Object.freeze({ ...check });
    })
    .sort((left, right) => `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`));
}

function resolveRoleChecks(
  requirements: readonly DeviceReadinessRequirement[],
  checks: readonly DeviceReadinessCheck[],
): DeviceReadinessCheck[] {
  const required = new Map<string, DeviceReadinessRequirement>();
  for (const requirement of requirements) {
    if (
      !["provider", "mcp", "channel"].includes(requirement.kind) ||
      !isCanonicalText(requirement.id)
    ) {
      throw new TypeError("Device readiness requirement is invalid");
    }
    const key = `${requirement.kind}/${requirement.id}`;
    if (required.has(key)) throw new TypeError("Device readiness requirements must be unique");
    required.set(key, requirement);
  }

  const supplied = new Map<string, DeviceReadinessCheck>();
  for (const check of checks) {
    if (!["provider", "mcp", "channel"].includes(check.kind)) {
      throw new TypeError("System readiness checks are owned by the readiness evaluator");
    }
    const key = `${check.kind}/${check.id}`;
    if (!required.has(key)) {
      throw new TypeError("Device readiness check has no matching role requirement");
    }
    if (supplied.has(key)) throw new TypeError("Device readiness checks must be unique");
    supplied.set(key, check);
  }

  return [...required.entries()].map(([key, requirement]) =>
    supplied.get(key) ?? {
      ...requirement,
      configured: false,
      ready: false,
      reason: "缺少目标角色就绪检查",
    },
  );
}

function freezeProjection(
  deviceId: string,
  state: DeviceReadinessState,
  roles: readonly DeviceRole[],
  checks: readonly DeviceReadinessCheck[],
): DeviceReadinessProjection {
  const missing = checks
    .filter((check) => !check.configured || !check.ready)
    .map(({ kind, id, reason }) => Object.freeze({ kind, id, ...(reason ? { reason } : {}) }));
  return Object.freeze({
    deviceId,
    state,
    roles: Object.freeze([...roles]),
    checks: Object.freeze([...checks]),
    missing: Object.freeze(missing),
  });
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
