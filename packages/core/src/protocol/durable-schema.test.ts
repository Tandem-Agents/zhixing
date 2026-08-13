import { describe, expect, it } from "vitest";
import {
  DURABLE_SCHEMA_INVENTORY,
  assertDurableSchemaInventory,
  createDurableSchemaActivation,
} from "./durable-schema.js";

describe("durable schema inventory", () => {
  it("accepts only the finite sorted production exact-set", () => {
    expect(() => assertDurableSchemaInventory(DURABLE_SCHEMA_INVENTORY)).not.toThrow();
    expect(() => assertDurableSchemaInventory(DURABLE_SCHEMA_INVENTORY.slice(1))).toThrow("exact-set");
    expect(() => assertDurableSchemaInventory([...DURABLE_SCHEMA_INVENTORY].reverse())).toThrow("exact-set");
  });

  it("allows activation only for the writer version frozen by this release", () => {
    expect(createDurableSchemaActivation("AuthorityCommitEnvelope", "1")).toEqual({
      v: 1,
      t: "schema-activated",
      schemaId: "AuthorityCommitEnvelope",
      writeVersion: "1",
    });
    expect(() => createDurableSchemaActivation("AuthorityCommitEnvelope", "2")).toThrow("writer policy");
  });
});
