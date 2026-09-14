import { createTempDir } from "@zhixing/test-utils";
import { expect, it } from "vitest";
import { createCoreS7DurableScenarios } from "./s7-durable.js";
import { withS7TemporaryDirectoryRoot } from "./s7-durable-harness.js";

it("keeps invalid reset genesis fail-closed with a valid local control context", async () => {
  const root = await createTempDir("invalid-reset-genesis");
  const scenario = [...createCoreS7DurableScenarios()].find(([key]) =>
    key.endsWith(":corruption:invalid-reset-genesis"),
  )?.[1];
  if (!scenario) throw new Error("invalid reset genesis scenario is absent");
  const result = await withS7TemporaryDirectoryRoot(root, scenario);
  expect(result).toMatchObject({ kind: "corruption", caseKey: "invalid-reset-genesis" });
}, 120_000);
