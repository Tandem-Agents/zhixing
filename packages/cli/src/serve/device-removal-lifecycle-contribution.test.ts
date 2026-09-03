import { describe, expect, it, vi } from "vitest";
import type { DeviceRemovalLifecycleContribution } from "./device-removal-lifecycle-contribution.js";
import {
  DEVICE_REMOVAL_LIFECYCLE_EFFECTS,
  defineDeviceRemovalLifecycleContribution,
} from "./device-removal-lifecycle-contribution.js";

function createContribution(): DeviceRemovalLifecycleContribution {
  return {
    closeAdmission: vi.fn(async () => undefined),
    captureAcceptedWork: vi.fn(async () => []),
    settleAcceptedWork: vi.fn(async () => undefined),
    releaseAdmission: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => []),
    finalizeDeviceKey: vi.fn(async () => []),
    onRemoved: vi.fn(async () => undefined),
  };
}

describe("device removal lifecycle contribution", () => {
  it("freezes the exact seven-effect contribution without replacing its handles", () => {
    const input = createContribution();
    const contribution = defineDeviceRemovalLifecycleContribution(input);

    expect(Object.keys(contribution)).toEqual([...DEVICE_REMOVAL_LIFECYCLE_EFFECTS]);
    expect(Object.isFrozen(contribution)).toBe(true);
    for (const effect of DEVICE_REMOVAL_LIFECYCLE_EFFECTS) {
      expect(contribution[effect]).toBe(input[effect]);
    }
  });

  it("rejects missing, extra, and non-callable effects at the runtime boundary", () => {
    const input = createContribution();
    const { onRemoved: _missing, ...missing } = input;
    expect(() => defineDeviceRemovalLifecycleContribution(
      missing as DeviceRemovalLifecycleContribution,
    )).toThrow(/exact effect set/u);
    expect(() => defineDeviceRemovalLifecycleContribution({
      ...input,
      secondOwner: async () => undefined,
    } as DeviceRemovalLifecycleContribution)).toThrow(/exact effect set/u);
    expect(() => defineDeviceRemovalLifecycleContribution({
      ...input,
      cleanup: undefined,
    } as unknown as DeviceRemovalLifecycleContribution)).toThrow(/effect is invalid: cleanup/u);
  });
});
