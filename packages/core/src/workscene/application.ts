import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import type {
  WorksceneDto,
  WorksceneWriteMutation,
} from "../contracts/state.js";
import { parseConversationId } from "../conversation/scope-id.js";
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

/**
 * Correctness mechanism for Workscene-scoped conversation ownership.
 * It owns atomic lookup/create, observer claims, activity facts and replay;
 * the domain application owns validation, product terminal and projection.
 */
export interface WorksceneEntryPort {
  enter(input: {
    readonly sceneId: string;
    readonly observerId: string;
    readonly requestId: string;
  }): Promise<{ readonly conversationId: string; readonly scene: WorksceneDto } | null>;
  exit(input: {
    readonly sceneId: string;
    readonly conversationId: string;
    readonly observerId: string;
    readonly requestId: string;
  }): Promise<void>;
}

/**
 * Path-free read mechanism for projecting the current conversation runtime.
 * The application owns conversation routing and the finite scene projection;
 * the adapter only reads the current authority snapshot.
 */
export interface WorksceneRuntimeProjectionReadPort {
  get(sceneId: string): Promise<WorksceneDto | null>;
}

export interface WorksceneAssignmentMutationRecord {
  readonly recordSeq: number;
  readonly mutation: WorksceneWriteMutation;
}

/**
 * Correctness port for Workscene tools running inside one durable assignment.
 * It exposes only path-free Workscene reads and staged writes; the application
 * owns overlay folding, revision selection, validation and operation identity.
 */
export interface WorksceneAssignmentToolPort {
  get(sceneId: string): Promise<WorksceneDto | null>;
  list(): Promise<readonly WorksceneDto[]>;
  readOverlay(): Promise<readonly WorksceneAssignmentMutationRecord[]>;
  stage(input: Readonly<{
    operationId: string;
    mutation: WorksceneWriteMutation;
  }>): Promise<void>;
}

export interface WorksceneAssignmentToolApplication {
  normalizeName(name: string): string;
  get(sceneId: string): Promise<WorksceneDto | null>;
  list(): Promise<readonly WorksceneDto[]>;
  create(input: Readonly<{
    name: string;
    workspace?: WorksceneWorkspaceReference;
    toolCallId?: string;
  }>): Promise<Readonly<{ name: string }>>;
  rename(input: Readonly<{
    sceneId: string;
    name: string;
    toolCallId?: string;
  }>): Promise<Readonly<{ previous: WorksceneDto; name: string }> | null>;
  setWorkspace(input: Readonly<{
    sceneId: string;
    workspace: WorksceneWorkspaceReference | null;
    toolCallId?: string;
  }>): Promise<Readonly<{ previous: WorksceneDto }> | null>;
  delete(input: Readonly<{
    sceneId: string;
    toolCallId?: string;
  }>): Promise<Readonly<{ previous: WorksceneDto }> | null>;
}

/** Workscene-owned application behavior for the seven agent-facing tools. */
export class WorksceneAssignmentToolApplicationService
  implements WorksceneAssignmentToolApplication
{
  constructor(private readonly port: WorksceneAssignmentToolPort) {}

  normalizeName(name: string): string {
    return normalizeName(name);
  }

  async get(sceneId: string): Promise<WorksceneDto | null> {
    const current = await this.port.get(sceneId);
    return current
      ? applyAssignmentOverlay(current, await this.port.readOverlay())
      : null;
  }

  async list(): Promise<readonly WorksceneDto[]> {
    const records = await this.port.readOverlay();
    return Object.freeze(
      (await this.port.list())
        .map((scene) => applyAssignmentOverlay(scene, records))
        .filter((scene): scene is WorksceneDto => scene !== null),
    );
  }

  async create(input: Readonly<{
    name: string;
    workspace?: WorksceneWorkspaceReference;
    toolCallId?: string;
  }>): Promise<Readonly<{ name: string }>> {
    const name = normalizeName(input.name);
    await this.port.stage({
      operationId: assignmentToolOperationId(input.toolCallId, "workscene-create"),
      mutation: {
        kind: "workscene-create",
        name,
        ...(input.workspace
          ? { workspace: assertWorkspace(input.workspace) }
          : {}),
      },
    });
    return Object.freeze({ name });
  }

  async rename(input: Readonly<{
    sceneId: string;
    name: string;
    toolCallId?: string;
  }>): Promise<Readonly<{ previous: WorksceneDto; name: string }> | null> {
    const name = normalizeName(input.name);
    const previous = await this.get(input.sceneId);
    if (!previous) return null;
    await this.port.stage({
      operationId: assignmentToolOperationId(input.toolCallId, "workscene-rename"),
      mutation: {
        kind: "workscene-rename",
        sceneId: input.sceneId,
        name,
        expectedRevision: previous.revision,
      },
    });
    return Object.freeze({ previous, name });
  }

  async setWorkspace(input: Readonly<{
    sceneId: string;
    workspace: WorksceneWorkspaceReference | null;
    toolCallId?: string;
  }>): Promise<Readonly<{ previous: WorksceneDto }> | null> {
    const previous = await this.get(input.sceneId);
    if (!previous) return null;
    await this.port.stage({
      operationId: assignmentToolOperationId(
        input.toolCallId,
        "workscene-set-workdir",
      ),
      mutation: {
        kind: "workscene-set-workdir",
        sceneId: input.sceneId,
        workspace: input.workspace === null
          ? null
          : assertWorkspace(input.workspace),
        expectedRevision: previous.revision,
      },
    });
    return Object.freeze({ previous });
  }

  async delete(input: Readonly<{
    sceneId: string;
    toolCallId?: string;
  }>): Promise<Readonly<{ previous: WorksceneDto }> | null> {
    const previous = await this.get(input.sceneId);
    if (!previous) return null;
    await this.port.stage({
      operationId: assignmentToolOperationId(input.toolCallId, "workscene-delete"),
      mutation: {
        kind: "workscene-delete",
        sceneId: input.sceneId,
        expectedRevision: previous.revision,
      },
    });
    return Object.freeze({ previous });
  }
}

function assignmentToolOperationId(
  toolCallId: string | undefined,
  action: WorksceneWriteMutation["kind"],
): string {
  if (!toolCallId?.trim()) {
    throw invalid(`${action} 缺少耐久工具调用身份`);
  }
  return `workscene:${toolCallId}`;
}

function applyAssignmentOverlay(
  scene: WorksceneDto,
  records: readonly WorksceneAssignmentMutationRecord[],
): WorksceneDto | null {
  let current: WorksceneDto | null = { ...scene };
  for (const record of [...records].sort(
    (left, right) => left.recordSeq - right.recordSeq,
  )) {
    const mutation = record.mutation;
    if (!current || mutation.kind === "workscene-create") continue;
    if (mutation.sceneId !== current.id) continue;
    if (mutation.expectedRevision !== current.revision) {
      throw invalid(`工作场景 ${current.id} 的当前任务内版本链不连续`);
    }
    if (mutation.kind === "workscene-delete") {
      current = null;
      continue;
    }
    current = {
      ...current,
      revision: current.revision + 1,
      ...(mutation.kind === "workscene-rename"
        ? { name: mutation.name }
        : mutation.workspace
          ? { workspace: mutation.workspace }
          : { workspace: undefined }),
    };
  }
  return current;
}

/**
 * Workscene-owned demand for removing a Conversation physical projection
 * after the Workscene session deletion fact has committed. It carries no
 * Conversation delete admission, product terminal, Fact or notification.
 */
export interface WorksceneConversationStorageProjectionCleanupPort {
  removeCommittedProjection(input: Readonly<{
    sceneId: string;
    conversationId: string;
  }>): Promise<void>;
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

export interface WorksceneEntryResult {
  readonly conversationId: string;
  readonly scene: WorksceneManagementSummary;
}

export interface WorksceneConversationRuntimeQuery {
  readonly conversationId: string;
}

export type WorksceneConversationRuntimeProjection =
  | { readonly kind: "main" }
  | {
      readonly kind: "scene";
      readonly scene: Readonly<{
        readonly sceneId: string;
        readonly name: string;
      }>;
      readonly workspace: WorksceneWorkspaceReference | null;
    };

export type WorksceneManagementQuery = { readonly kind: "list" };

export type WorksceneCommand =
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
    }
  | {
      readonly kind: "enter";
      readonly sceneId: string;
      readonly observerId: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "exit";
      readonly sceneId: string;
      readonly conversationId: string;
      readonly observerId: string;
      readonly requestId: string;
    };

export type WorksceneCommandResult =
  | { readonly kind: "created"; readonly scene: WorksceneManagementSummary }
  | { readonly kind: "renamed"; readonly scene: WorksceneManagementSummary }
  | { readonly kind: "workspace-set"; readonly scene: WorksceneManagementSummary }
  | { readonly kind: "deleted"; readonly sceneId: string }
  | ({ readonly kind: "entered" } & WorksceneEntryResult)
  | { readonly kind: "exited"; readonly ok: true };

export type WorksceneApplicationErrorKind = "invalid-input" | "not-found" | "busy";

export class WorksceneApplicationError extends Error {
  readonly code: "WORKSCENE_INPUT" | "WORKSCENE_NOT_FOUND" | "WORKSCENE_BUSY";

  constructor(
    readonly kind: WorksceneApplicationErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorksceneApplicationError";
    this.code = kind === "invalid-input"
      ? "WORKSCENE_INPUT"
      : kind === "not-found"
      ? "WORKSCENE_NOT_FOUND"
      : "WORKSCENE_BUSY";
  }
}

export interface WorksceneApplication {
  query(query: WorksceneManagementQuery): Promise<WorksceneManagementListResult>;
  execute(command: WorksceneCommand): Promise<WorksceneCommandResult>;
  projectConversationRuntime(
    query: WorksceneConversationRuntimeQuery,
  ): Promise<WorksceneConversationRuntimeProjection>;
}

export class WorksceneApplicationService
  implements WorksceneApplication
{
  constructor(
    private readonly management: WorksceneManagementPort,
    private readonly workspaces: WorksceneWorkspaceAdministrationReadPort,
    private readonly entry: WorksceneEntryPort,
    private readonly runtime: WorksceneRuntimeProjectionReadPort,
  ) {}

  async projectConversationRuntime(
    query: WorksceneConversationRuntimeQuery,
  ): Promise<WorksceneConversationRuntimeProjection> {
    if (
      !query ||
      typeof query !== "object" ||
      typeof query.conversationId !== "string"
    ) {
      throw invalid("Workscene runtime projection requires a conversation identity");
    }
    const { scope } = parseConversationId(query.conversationId);
    if (scope.kind !== "workscene") {
      return Object.freeze({ kind: "main" as const });
    }
    const scene = await this.runtime.get(scope.sceneId);
    if (!scene) {
      throw new WorksceneApplicationError(
        "not-found",
        `工作场景 "${scope.sceneId}" 不存在,无法装配会话`,
      );
    }
    return Object.freeze({
      kind: "scene" as const,
      scene: Object.freeze({ sceneId: scene.id, name: scene.name }),
      workspace: scene.workspace
        ? Object.freeze({
            deviceId: scene.workspace.deviceId,
            bindingRef: scene.workspace.bindingRef,
          })
        : null,
    });
  }

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

  async execute(command: WorksceneCommand): Promise<WorksceneCommandResult> {
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
        case "enter": {
          const sceneId = assertSceneId(command.sceneId);
          const entered = await this.entry.enter({
            sceneId,
            observerId: assertIdentity(command.observerId, "observer"),
            requestId: command.requestId,
          });
          if (!entered) throw notFound(sceneId);
          return Object.freeze({
            kind: "entered" as const,
            conversationId: assertSceneConversation(
              sceneId,
              entered.conversationId,
            ),
            scene: await this.project(entered.scene),
          });
        }
        case "exit": {
          await this.entry.exit({
            sceneId: assertSceneId(command.sceneId),
            conversationId: assertSceneConversation(
              command.sceneId,
              command.conversationId,
            ),
            observerId: assertIdentity(command.observerId, "observer"),
            requestId: command.requestId,
          });
          return Object.freeze({ kind: "exited" as const, ok: true as const });
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

function assertIdentity(value: string, label: string): string {
  if (typeof value !== "string" || !value) {
    throw invalid(`Workscene command requires a ${label} identity`);
  }
  return value;
}

function assertSceneConversation(sceneId: string, conversationId: string): string {
  const identity = assertIdentity(conversationId, "conversation");
  const parsed = parseConversationId(identity);
  if (
    parsed.scope.kind !== "workscene" ||
    parsed.scope.sceneId !== sceneId
  ) {
    throw invalid("Conversation does not belong to the workscene");
  }
  return identity;
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

function invalid(message: string, cause?: unknown): WorksceneApplicationError {
  return new WorksceneApplicationError("invalid-input", message, cause === undefined ? undefined : { cause });
}

function notFound(sceneId: string): WorksceneApplicationError {
  return new WorksceneApplicationError("not-found", `Workscene not found: ${sceneId}`);
}

function translateMechanismError(error: unknown): unknown {
  if (error instanceof WorksceneApplicationError) return error;
  if (hasCode(error, "WORKSCENE_INPUT")) {
    return invalid(error.message, error);
  }
  if (hasCode(error, "WORKSCENE_BUSY")) {
    return new WorksceneApplicationError("busy", error.message, { cause: error });
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
  Extract<WorksceneCommand, { readonly kind: "create" }>,
  Extract<WorksceneCommandResult, { readonly kind: "created" }>,
  never
>("workscene-management.command.create", []);

export const WORKSCENE_MANAGEMENT_RENAME_COMMAND = defineProductApiCommand<
  "workscene-management.command.rename",
  Extract<WorksceneCommand, { readonly kind: "rename" }>,
  Extract<WorksceneCommandResult, { readonly kind: "renamed" }>,
  never
>("workscene-management.command.rename", []);

export const WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND = defineProductApiCommand<
  "workscene-management.command.set-workspace",
  Extract<WorksceneCommand, { readonly kind: "set-workspace" }>,
  Extract<WorksceneCommandResult, { readonly kind: "workspace-set" }>,
  never
>("workscene-management.command.set-workspace", []);

export const WORKSCENE_MANAGEMENT_DELETE_COMMAND = defineProductApiCommand<
  "workscene-management.command.delete",
  Extract<WorksceneCommand, { readonly kind: "delete" }>,
  Extract<WorksceneCommandResult, { readonly kind: "deleted" }>,
  never
>("workscene-management.command.delete", []);

export const WORKSCENE_ENTRY_ENTER_COMMAND = defineProductApiCommand<
  "workscene-entry.command.enter",
  Extract<WorksceneCommand, { readonly kind: "enter" }>,
  Extract<WorksceneCommandResult, { readonly kind: "entered" }>,
  never
>("workscene-entry.command.enter", []);

export const WORKSCENE_ENTRY_EXIT_COMMAND = defineProductApiCommand<
  "workscene-entry.command.exit",
  Extract<WorksceneCommand, { readonly kind: "exit" }>,
  Extract<WorksceneCommandResult, { readonly kind: "exited" }>,
  never
>("workscene-entry.command.exit", []);

export const WORKSCENE_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    WORKSCENE_MANAGEMENT_LIST_QUERY,
    WORKSCENE_MANAGEMENT_CREATE_COMMAND,
    WORKSCENE_MANAGEMENT_RENAME_COMMAND,
    WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND,
    WORKSCENE_MANAGEMENT_DELETE_COMMAND,
    WORKSCENE_ENTRY_ENTER_COMMAND,
    WORKSCENE_ENTRY_EXIT_COMMAND,
  ],
  factEvents: [],
});

export function createWorksceneProductApiContribution(
  application: WorksceneApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(WORKSCENE_MANAGEMENT_LIST_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_CREATE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneCommandResult,
          { readonly kind: "created" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_RENAME_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneCommandResult,
          { readonly kind: "renamed" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_SET_WORKSPACE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneCommandResult,
          { readonly kind: "workspace-set" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_MANAGEMENT_DELETE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneCommandResult,
          { readonly kind: "deleted" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_ENTRY_ENTER_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneCommandResult,
          { readonly kind: "entered" }
        >,
        facts: [],
      })),
      bindProductApiOperation(WORKSCENE_ENTRY_EXIT_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          WorksceneCommandResult,
          { readonly kind: "exited" }
        >,
        facts: [],
      })),
    ],
    factEvents: [],
  });
}
