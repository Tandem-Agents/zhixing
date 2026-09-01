import type { ZhixingConfig } from "@zhixing/providers";

/**
 * The one validated public-configuration value published to a running process.
 * Runtime consumers receive this frozen value, never the loader-owned object.
 */
declare const runtimeConfigurationSnapshotBrand: unique symbol;

export type RuntimeConfigurationSnapshot = Readonly<ZhixingConfig> & {
  readonly [runtimeConfigurationSnapshotBrand]: true;
};

export function createRuntimeConfigurationSnapshot(
  configuration: ZhixingConfig,
): RuntimeConfigurationSnapshot {
  return deepFreeze(
    structuredClone(configuration),
  ) as RuntimeConfigurationSnapshot;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
