export interface DurableSchemaCompatibility {
  readonly schemaId: string;
  readonly readMin: string;
  readonly readMax: string;
  readonly writeVersion: string;
}

/** Finite durable families written by the first stable distributed-runtime baseline. */
export const DURABLE_SCHEMA_INVENTORY = Object.freeze([
  row("AssignmentAuthorityRecord"),
  row("AuthorityCommitEnvelope"),
  row("CheckpointAuthorityRecord"),
  row("ConversationAuthorityRecord"),
  row("CredentialExposureRecord"),
  row("DeliveryAuthorityRecord"),
  row("DeviceLifecycleRecord"),
  row("FinalAuthorityRecord"),
  row("GlobalStateRecord"),
  row("HomeTrustRecord"),
  row("IntentAuthorityRecord"),
  row("ResourceLeaseRecord"),
  row("SchedulerAuthorityRecord"),
] as const satisfies readonly DurableSchemaCompatibility[]);

export type DurableSchemaId = (typeof DURABLE_SCHEMA_INVENTORY)[number]["schemaId"];

export interface DurableSchemaActivationRecord {
  readonly v: 1;
  readonly t: "schema-activated";
  readonly schemaId: DurableSchemaId;
  readonly writeVersion: string;
}

export function assertDurableSchemaInventory(input: readonly DurableSchemaCompatibility[]): void {
  if (input.length !== DURABLE_SCHEMA_INVENTORY.length) {
    throw new TypeError("Durable schema inventory does not match the production exact-set");
  }
  for (let index = 0; index < DURABLE_SCHEMA_INVENTORY.length; index += 1) {
    const expected = DURABLE_SCHEMA_INVENTORY[index]!;
    const actual = input[index];
    if (
      !actual || actual.schemaId !== expected.schemaId ||
      actual.readMin !== expected.readMin || actual.readMax !== expected.readMax ||
      actual.writeVersion !== expected.writeVersion
    ) throw new TypeError("Durable schema inventory does not match the production exact-set");
  }
}

export function createDurableSchemaActivation(
  schemaId: DurableSchemaId,
  writeVersion: string,
): DurableSchemaActivationRecord {
  const descriptor = DURABLE_SCHEMA_INVENTORY.find((row) => row.schemaId === schemaId);
  if (!descriptor || writeVersion !== descriptor.writeVersion) {
    throw new TypeError("Durable schema activation is outside the release writer policy");
  }
  return Object.freeze({ v: 1, t: "schema-activated", schemaId, writeVersion });
}

function row(schemaId: string) {
  return Object.freeze({ schemaId, readMin: "1", readMax: "1", writeVersion: "1" });
}
