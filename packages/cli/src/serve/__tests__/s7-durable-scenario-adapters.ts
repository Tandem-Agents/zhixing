import {
  createCoreS7DurableScenarios,
} from "@zhixing/core/test-support/s7-durable";
import type {
  S7ExecutableScenario,
} from "@zhixing/core/test-support/s7-durable-harness";
import {
  createOwnerKernelS7DurableScenarios,
} from "@zhixing/owner-kernel/test-support/s7-durable";
import { createCliS7DurableScenarios } from "./s7-durable-runtime-witness.js";

type ScenarioMap = ReadonlyMap<string, S7ExecutableScenario>;

export function createS7DurableScenarioAdapters(): ScenarioMap {
  return mergeScenarioMaps(
    createCoreS7DurableScenarios(),
    createOwnerKernelS7DurableScenarios(),
    createCliS7DurableScenarios(),
  );
}

function mergeScenarioMaps(...sources: readonly ScenarioMap[]): ScenarioMap {
  const scenarios = new Map<string, S7ExecutableScenario>();
  for (const source of sources) {
    for (const [key, execute] of source) {
      if (scenarios.has(key)) throw new TypeError(`Duplicate S7 scenario: ${key}`);
      scenarios.set(key, execute);
    }
  }
  return scenarios;
}
