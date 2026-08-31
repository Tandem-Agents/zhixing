import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import type { WorksceneDto } from "../contracts/state.js";
import { normalizeSceneName } from "./validation.js";

export interface WorksceneWorkspaceReference {
  readonly deviceId: string;
  readonly bindingRef: string;
}

export interface WorksceneWorkspaceMetadata extends WorksceneWorkspaceReference {
  readonly workspaceBindingRevision: number;
  readonly deviceName: string;
  readonly workspaceName: string;
}

export interface WorksceneManagementWriteResult {
  readonly scene: WorksceneDto;
  readonly workspaceWarning?: string;
}

/**
 * Correctness mechanism for the current Workscene authority generation.
 * It owns serialization, revision fences, cleanup and replay, but no product
 * validation or result projection.
 */
export interface WorksceneManagementPort {
  list(): Promise<readonly WorksceneDto[]>;
  create(input: {
    readonly name: string;
    readonly workspace?: WorksceneWorkspaceReference;
    readonly requestId: string;
  }): Promise<WorksceneManagementWriteResult>;
  rename(input: {
    readonly sceneId: string;
    readonly name: string;
    readonly requestId: string;
  }): Promise<WorksceneDto | null>;
  setWorkspace(input: {
    readonly sceneId: string;
    readonly workspace: WorksceneWorkspaceReference | null;
    readonly requestId: string;
  }): Promise<WorksceneManagementWriteResult | null>;
  delete(input: {
    readonly sceneId: string;
    readonly requestId: string;
  }): Promise<boolean>;
}

/** Path-free Workspace Administration read projection used for result enrichment. */
export interface WorksceneWorkspaceAdministrationReadPort {
  list(): Promise<readonly WorksceneWorkspaceMetadata[]>;
}

export interface WorksceneManagementSummary {
  readonly sceneId: string;
  readonly revision: number;
  readonly name: string;
  readonly workspace?: Readonly<
    WorksceneWorkspaceReference & {
      readonly workspaceBindingRevision?: number;
      readonly deviceName?: string;
      readonly workspaceName?: string;
    }
  >;
  readonly workspaceWarning?: string;
  readonly lastActiveAt?: string;
}

export interface WorksceneManagementListResult {
  readonly scenes: readonly WorksceneManagementSummary[];
}

export type WorksceneManagementQuery = { readonly kind: "list" };

export type WorksceneManagementCommand =
  | {
      readonly kind: "create";
      readonly name: string;
      readonly workspace?: WorksceneWorkspaceReference;
      readonly requestId: string;
    }
  | {
      readonly kind: "rename";
      readonly sceneId: string;
      readonly name: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "set-workspace";
      readonly sceneId: string;
      readonly workspace: WorksceneWorkspaceReference | null;
      readonly requestId: string;
    }
  | {
      readonly kind: "delete";
      readonly sceneId: string;
      readonly requestId: string;
    };

export type WorksceneManagementCommandResult =
  | { readonly kind: "created"; readonly scene: WorksceneManagementSummary }
  | { readonly kind: "renamed"; readonly scene: WorksceneManagementSummary }
  | { readonly kind: "workspace-set"; readonly scene: WorksceneManagementSummary }
  | { readonly kind: "deleted"; readonly sceneId: string };

export type WorksceneManagementErrorKind = "invalid-input" | "not-found" | "busy";

export class WorksceneManagementError extends Error {
  readonly code: "WORKSCENE_INPUT" | "WORKSCENE_NOT_FOUND" | "WORKSCENE_BUSY";

  constructor(
    readonly kind: WorksceneManagementErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorksceneManagementError";
    this.code = kind === "invalid-input"
      ? "WORKSCENE_INPUT"
      : kind === "not-found"
      ? "WORKSCENE_NOT_FOUND"
      : "WORKSCENE_BUSY";
  }
}

export interface WorksceneManagementApplication {
  query(query: WorksceneManagementQuery): Promise<WorksceneManagementListResult>;
  execute(command: WorksceneManagementCommand): Promise<WorksceneManagementCommandResult>;
}

export class WorksceneManagementApplicationService
  implements WorksceneManagementApplication
{
  constructor(
    private readonly management: WorksceneManagementPort,
    private readonly workspaces: WorksceneWorkspaceAdministrationReadPort,
  ) {}

  async query(query: WorksceneManagementQuery): Promise<WorksceneManagementListResult> {
    if (query.kind !== "list") throw invalid("Unsupported Workscene query");
    const scenes = await this.management.list();
    const metadata = scenes.some((scene) => scene.workspace)
      ? await this.workspaces.list()
      : [];
    return Object.freeze({
      scenes: Object.freeze(
        scenes.map((scene) => projectSummary(scene, metadata)),
      ),
    });
  }

  async execute(command: WorksceneManagementCommand): Promise<WorksceneManagementCommandResult> {
    assertRequestId(command.requestId);
    try {
      switch (command.kind) {
        case "create": {
          const result = await this.management.create({
            name: normalizeName(command.name),
            ...(command.workspace
              ? { workspace: assertWorkspace(command.workspace) }
              : {}),
            requestId: command.requestId,
          });
          return Object.freeze({
            kind: "created" as const,
            scene: await this.project(result.scene, result.workspaceWarning),
          });
        }
        case "rename": {
          const scene = await this.management.rename({
            sceneId: assertSceneId(command.sceneId),
            name: normalizeName(command.name),
            requestId: command.requestId,
          });
          if (!scene) throw notFound(command.sceneId);
          return Object.freeze({
            kind: "renamed" as const,
            scene: await this.project(scene),
          });
        }
        case "set-workspace": {
          const result = await this.management.setWorkspace({
            sceneId: assertSceneId(command.sceneId),
            workspace: command.workspace === null
              ? null
              : assertWorkspace(command.workspace),
            requestId: command.requestId,
          });
          if (!result) throw notFound(command.sceneId);
          return Object.freeze({
            kind: "workspace-set" as const,
            scene: await this.project(result.scene, result.workspaceWarning),
          });
        }
        case "delete": {
          const sceneId = assertSceneId(command.sceneId);
          if (!await this.management.delete({ sceneId, requestId: command.requestId })) {
            throw notFound(sceneId);
          }
          return Object.freeze({ kind: "deleted" as const, sceneId });
        }
        default:
          throw invalid("Unsupported Workscene command");
      }
    } catch (error) {
      throw translateMechanismError(error);
    }
  }

  private async project(
    scene: WorksceneDto,
    workspaceWarning?: string,
  ): Promise<WorksceneManagementSummary> {
    const metadata = scene.workspace ? await this.workspaces.list() : [];
    return projectSummary(scene, metadata, workspaceWarning);
  }
}

function normalizeName(name: string): string {
  try {
    return normalizeSceneName(name);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "工作场景名称无效", error);
  }
}

function assertRequestId(value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid("Workscene command requires a durable request identity");
  }
}

function assertSceneId(value: string): string {
  if (typeof value !== "string") {
    throw invalid("Workscene command requires a scene identity");
  }
  return value;
}

function assertWorkspace(value: WorksceneWorkspaceReference): WorksceneWorkspaceReference {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.deviceId !== "string" ||
    !value.deviceId ||
    typeof value.bindingRef !== "string" ||
    !value.bindingRef
  ) {
    throw invalid("Workscene command requires a workspace reference");
  }
  return Object.freeze({ deviceId: value.deviceId, bindingRef: value.bindingRef });
}

function projectSummary(
  scene: WorksceneDto,
  metadata: readonly WorksceneWorkspaceMetadata[],
  workspaceWarning?: string,
): WorksceneManagementSummary {
  const workspaceMetadata = scene.workspace
    ? metadata.find(
        (candidate) =>
          candidate.deviceId === scene.workspace!.deviceId &&
          candidate.bindingRef === scene.workspace!.bindingRef,
      )
    : undefined;
  return Object.freeze({
    sceneId: scene.id,
    revision: scene.revision,
    name: scene.name,
    ...(scene.workspace
      ? {
          workspace: Object.freeze({
            deviceId: scene.workspace.deviceId,
            bindingRef: scene.workspace.bindingRef,
            ...(workspaceMetadata
              ? {
                  workspaceBindingRevision: workspaceMetadata.workspaceBindingRevision,
                  deviceName: workspaceMetadata.deviceName,
                  workspaceName: workspaceMetadata.workspaceName,
                }
              : {}),
          }),
        }
      : {}),
    lastActiveAt: scene.lastActiveAt,
    ...(workspaceWarning ? { workspaceWarning } : {}),
  });
}

function invalid(message: string, cause?: unknown): WorksceneManagementError {
  return new WorksceneManagementError("invalid-input", message, cause === undefined ? undefined : { cause });
}

function notFound(sceneId: string): WorksceneManagementError {
  return new WorksceneManagementError("not-found", `Workscene not found: ${sceneId}`);
}

function translateMechanismError(error: unknown): unknown {
  if (error instanceof WorksceneManagementError) return error;
  if (hasCode(error, "WORKSCENE_INPUT")) {
    return invalid(error.message, error);
  }
  if (hasCode(error, "WORKSCENE_BUSY")) {
    return new WorksceneManagementError("busy", error.message, { cause: error });
  }
  return error;
}

function hasCode(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

export const WORKSCENE_MANAGEMENT_LIST_QUERY = defineProductApiQuery<
  "workscene-management.query.list",
  Extract<WorksceneManagementQuery, { readonly kind: "list" }>,
  WorksceneManagementListResult
>("workscene-management.query.list");

export const WORKSCENE_MANAGEMENT_CREATE_COMMAND = defineProductApiCommand<
  "workscene-management.command.create",
  Extract<WorksceneManagementCommand, { readonly kind: "create" }>,
  Extract<WorksceneManagementCommandResult, { readonly kind: "created" }>,
  never
>("workscene-management.command.create", []);

export const WORKSCENE_MANAGEMENT_RENAME_COMMAND = defineProductApiCommand<
  "workscene-management.command.rename",
  Extract<WorksceneManagementCommand, { readonly kind: "rename" }>,
  Extract<WorksceneManagementCommandResult, { readonly kind: "renamed" }>,
  never
>("workscene-management.command.rename", []);

export const WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND = defineProductApiCommand<
  "workscene-management.command.set-workspace",
  Extract<WorksceneManagementCommand, { readonly kind: "set-workspace" }>,
  Extract<WorksceneManagementCommandResult, { readonly kind: "workspace-set" }>,
  never
>("workscene-management.command.set-workspace", []);

export const WORKSCENE_MANAGEMENT_DELETE_COMMAND = defineProductApiCommand<
  "workscene-management.command.delete",
  Extract<WorksceneManagementCommand, { readonly kind: "delete" }>,
  Extract<WorksceneManagementCommandResult, { readonly kind: "deleted" }>,
  never
>("workscene-management.command.delete", []);

export const WORKSCENE_MANAGEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    WORKSCENE_MANAGEMENT_LIST_QUERY,
    WORKSCENE_MANAGEMENT_CREATE_COMMAND,
    WORKSCENE_MANAGEMENT_RENAME_COMMAND,
    WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND,
    WORKSCENE_MANAGEMENT_DELETE_COMMAND,
  ],
  factEvents: [],
});

export function createWorksceneManagementProductApiContribution(
  application: WorksceneManagementApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(WORKSCENE_MANAGEMENT_LIST_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_CREATE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneManagementCommandResult,
          { readonly kind: "created" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_RENAME_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneManagementCommandResult,
          { readonly kind: "renamed" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneManagementCommandResult,
          { readonly kind: "workspace-set" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_DELETE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneManagementCommandResult,
          { readonly kind: "deleted" }
        >,
        facts: [],
      })),
    ],
    factEvents: [],
  });
}
