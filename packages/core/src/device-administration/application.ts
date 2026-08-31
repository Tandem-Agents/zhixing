import {
  bindProductApiOperation,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";

export interface DeviceAdministrationRelationship {
  readonly displayName: string;
  readonly reachable: boolean;
}

export interface DeviceAdministrationRemovalState {
  readonly phase:
    | "waiting-for-device"
    | "needs-conversation-decision"
    | "moving-conversations"
    | "revoking-access"
    | "cleaning-device"
    | "removed"
    | "cancelled";
  readonly conversations: readonly string[];
  readonly localData: "known" | "removed" | "unknown";
  readonly credentialActions: readonly string[];
}

export interface DeviceAdministrationDutyMigrationTarget {
  readonly deviceId: string;
  readonly displayName: string;
  readonly ready: boolean;
  readonly code?: "unavailable";
}

export interface DeviceAdministrationListQuery {
  readonly kind: "list-device-relationships";
}

export interface DeviceAdministrationStatusQuery {
  readonly kind: "read-device-removal-state";
  readonly targetName: string;
}

export interface DeviceAdministrationDutyMigrationTargetsQuery {
  readonly kind: "list-duty-migration-targets";
}

export type DeviceAdministrationQuery =
  | DeviceAdministrationListQuery
  | DeviceAdministrationStatusQuery
  | DeviceAdministrationDutyMigrationTargetsQuery;

export interface DeviceAdministrationListResult {
  readonly devices: readonly DeviceAdministrationRelationship[];
}

export interface DeviceAdministrationStatusResult {
  readonly state: DeviceAdministrationRemovalState | null;
}

export interface DeviceAdministrationDutyMigrationTargetsResult {
  readonly devices: readonly DeviceAdministrationDutyMigrationTarget[];
}

export type DeviceAdministrationResult =
  | DeviceAdministrationListResult
  | DeviceAdministrationStatusResult
  | DeviceAdministrationDutyMigrationTargetsResult;

/** Existing device relationship mechanism; product visibility stays in the application. */
export interface DeviceAdministrationRelationshipReadPort {
  list(): Promise<readonly DeviceAdministrationRelationship[]>;
}

/** Existing removal-state mechanism; it does not own the user-visible query contract. */
export interface DeviceAdministrationRemovalStateReadPort {
  read(targetName: string): Promise<DeviceAdministrationRemovalState | undefined>;
}

/** Existing successor-readiness mechanism; migration writes remain outside this slice. */
export interface DeviceAdministrationDutyMigrationTargetReadPort {
  list(): Promise<readonly DeviceAdministrationDutyMigrationTarget[]>;
}

export interface DeviceAdministrationApplicationOptions {
  readonly relationships: DeviceAdministrationRelationshipReadPort;
  readonly removalState: DeviceAdministrationRemovalStateReadPort;
  readonly dutyMigrationTargets: DeviceAdministrationDutyMigrationTargetReadPort;
}

export interface DeviceAdministrationApplication {
  query(query: DeviceAdministrationListQuery): Promise<DeviceAdministrationListResult>;
  query(query: DeviceAdministrationStatusQuery): Promise<DeviceAdministrationStatusResult>;
  query(
    query: DeviceAdministrationDutyMigrationTargetsQuery,
  ): Promise<DeviceAdministrationDutyMigrationTargetsResult>;
}

/** Sole application owner of current user-visible Device Administration reads. */
export class DeviceAdministrationApplicationService
  implements DeviceAdministrationApplication
{
  constructor(private readonly options: DeviceAdministrationApplicationOptions) {}

  query(query: DeviceAdministrationListQuery): Promise<DeviceAdministrationListResult>;
  query(query: DeviceAdministrationStatusQuery): Promise<DeviceAdministrationStatusResult>;
  query(
    query: DeviceAdministrationDutyMigrationTargetsQuery,
  ): Promise<DeviceAdministrationDutyMigrationTargetsResult>;
  async query(query: DeviceAdministrationQuery): Promise<DeviceAdministrationResult> {
    switch (query.kind) {
      case "list-device-relationships":
        return Object.freeze({
          devices: Object.freeze(
            (await this.options.relationships.list()).map(freezeRelationship),
          ),
        });
      case "read-device-removal-state": {
        const targetName = requireStableText(query.targetName, "Device name");
        const state = await this.options.removalState.read(targetName);
        return Object.freeze({
          state: state === undefined ? null : freezeRemovalState(state),
        });
      }
      case "list-duty-migration-targets":
        return Object.freeze({
          devices: Object.freeze(
            (await this.options.dutyMigrationTargets.list()).map(freezeDutyMigrationTarget),
          ),
        });
      default:
        throw new TypeError("Unsupported Device Administration query");
    }
  }
}

export const DEVICE_ADMINISTRATION_LIST_QUERY = defineProductApiQuery<
  "device-administration.query.list",
  DeviceAdministrationListQuery,
  DeviceAdministrationListResult
>("device-administration.query.list");

export const DEVICE_ADMINISTRATION_STATUS_QUERY = defineProductApiQuery<
  "device-administration.query.removal-status",
  DeviceAdministrationStatusQuery,
  DeviceAdministrationStatusResult
>("device-administration.query.removal-status");

export const DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY = defineProductApiQuery<
  "device-administration.query.duty-migration-targets",
  DeviceAdministrationDutyMigrationTargetsQuery,
  DeviceAdministrationDutyMigrationTargetsResult
>("device-administration.query.duty-migration-targets");

export const DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    DEVICE_ADMINISTRATION_LIST_QUERY,
    DEVICE_ADMINISTRATION_STATUS_QUERY,
    DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY,
  ],
  factEvents: [],
});

export function createDeviceAdministrationProductApiContribution(
  application: DeviceAdministrationApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(DEVICE_ADMINISTRATION_LIST_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(DEVICE_ADMINISTRATION_STATUS_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(
        DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY,
        async (query) => ({
          result: await application.query(query),
          facts: [],
        }),
      ),
    ],
    factEvents: [],
  });
}

function freezeRelationship(
  value: DeviceAdministrationRelationship,
): DeviceAdministrationRelationship {
  return Object.freeze({
    displayName: value.displayName,
    reachable: value.reachable,
  });
}

function freezeRemovalState(
  value: DeviceAdministrationRemovalState,
): DeviceAdministrationRemovalState {
  return Object.freeze({
    phase: value.phase,
    conversations: Object.freeze([...value.conversations]),
    localData: value.localData,
    credentialActions: Object.freeze([...value.credentialActions]),
  });
}

function freezeDutyMigrationTarget(
  value: DeviceAdministrationDutyMigrationTarget,
): DeviceAdministrationDutyMigrationTarget {
  return Object.freeze({
    deviceId: value.deviceId,
    displayName: value.displayName,
    ready: value.ready,
    ...(value.code === undefined ? {} : { code: value.code }),
  });
}

function requireStableText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
