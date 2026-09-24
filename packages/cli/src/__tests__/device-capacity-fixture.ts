import { onTestFinished } from "vitest";
import { createDeviceCapacityRuntime as createRuntime } from "../serve/device-capacity-runtime.js";

/** Test-scope ownership, matching the production entry's explicit close. */
export function createDeviceCapacityRuntime(...args: Parameters<typeof createRuntime>) {
  const runtime = createRuntime(...args);
  onTestFinished(() => runtime.close());
  return runtime;
}
