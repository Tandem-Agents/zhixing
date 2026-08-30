import path from "node:path";
import {
  WorkspaceAdministrationApplicationService,
  WorkspaceAdministrationDurableLifecycleApplicationService,
  WorkspaceAdministrationResultDeliveryApplicationService,
  WORKSPACE_CATALOG_RESET_IMPACT,
  type WorkspaceAdministrationCatalogStatus,
  type WorkspaceAdministrationDurableLifecycleApplication,
  type WorkspaceAdministrationDurableLifecycleStatus,
  type WorkspaceAdministrationDurableOperation,
  type WorkspaceAdministrationDurableOperationKey,
  type WorkspaceAdministrationDurableOperationRecord,
  type WorkspaceAdministrationDurableResult,
  type WorkspaceAdministrationConsumptionCredential,
  type WorkspaceAdministrationDeliveryAcknowledgment,
  type WorkspaceAdministrationPendingDeliveryPage,
  type WorkspaceAdministrationResultDeliveryApplication,
  type WorkspaceAdministrationResultDeliveryMechanismPort,
  type WorkspaceControlAuthorization,
  type WorkspaceAdministrationView,
  validateWorkspaceAdministrationDurableOperation,
  validateWorkspaceAdministrationDurableResult,
  workspaceAdministrationResultValue,
} from "@zhixing/core/environment/workspace-administration";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { WorkspaceBindingResetReceipt } from "@zhixing/core/contracts";
import {
  LocalWorkspaceOperationOutbox,
  validateLocalWorkspaceOperation,
} from "./local-workspace-operation-outbox.js";
import {
  LocalWorkspaceTransportServer,
  callLocalWorkspaceHost,
  type LocalWorkspaceOwnerLease,
} from "./local-workspace-owner.js";
import { ExecutorWorkspaceAdministrationControl } from "./local-workspace-control.js";
import { observeLocalWorkspaceDurableInfrastructureFailure } from "./local-workspace-durable-lifecycle-adapter.js";

type HostRequest =
  | { readonly kind: "host-status" }
  | { readonly kind: "status" }
  | { readonly kind: "list" }
  | { readonly kind: "view"; readonly displayName: string }
  | {
      readonly kind: "prepare";
      readonly input: WorkspaceAdministrationDurableOperation;
    }
  | {
      readonly kind: "commit";
      readonly identity: WorkspaceAdministrationDurableOperationKey;
      readonly confirmation?: { readonly impact: string };
    }
  | { readonly kind: "pending"; readonly afterSeq: number }
  | {
      readonly kind: "acknowledge";
      readonly outboxId: string;
      readonly throughSeq: number;
      readonly prefixDigest: string;
      readonly entries: readonly ConfirmationEntry[];
    };

type ConfirmationEntry = WorkspaceAdministrationDeliveryAcknowledgment["entries"][number];

export type LocalWorkspaceCatalogStatus = WorkspaceAdministrationCatalogStatus;

export interface LocalWorkspaceClient {
  status(): Promise<LocalWorkspaceCatalogStatus>;
  list(): Promise<readonly WorkspaceAdministrationView[]>;
  viewByName(displayName: string): Promise<WorkspaceAdministrationView>;
  create(displayName: string, absolutePath: string): Promise<WorkspaceAdministrationView>;
  authorizeForControl(
    displayName: string,
    absolutePath: string,
  ): Promise<WorkspaceControlAuthorization>;
  rename(currentName: string, displayName: string, expectedRevision: number): Promise<WorkspaceAdministrationView>;
  repath(name: string, absolutePath: string, expectedRevision: number): Promise<WorkspaceAdministrationView>;
  remove(name: string, expectedRevision: number): Promise<void>;
  previewReset(expectedCatalogGeneration: string): Promise<LocalWorkspaceResetPreview>;
  confirmReset(
    preview: LocalWorkspaceResetPreview,
    confirmedImpact: string,
  ): Promise<WorkspaceBindingResetReceipt>;
  consumptionCredential(): WorkspaceAdministrationConsumptionCredential | undefined;
  confirmDelivered(): Promise<void>;
}

export interface LocalWorkspaceResetPreview
  extends WorkspaceAdministrationDurableOperationKey {
  readonly expectedCatalogGeneration: string;
  readonly impact: string;
  readonly expiresAt: string;
}

export function encodeLocalWorkspaceResetPreview(
  preview: LocalWorkspaceResetPreview,
): string {
  validateResetPreview(preview);
  return Buffer.from(JSON.stringify(preview), "utf8").toString("base64url");
}

export function decodeLocalWorkspaceResetPreview(
  encoded: string,
): LocalWorkspaceResetPreview {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new TypeError("Local workspace reset confirmation is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Local workspace reset confirmation is invalid");
  }
  const record = exactRecord(
    value,
    [
      "expectedCatalogGeneration",
      "expiresAt",
      "impact",
      "inputDigest",
      "localSeq",
      "operationId",
    ],
    "reset confirmation",
  ) as unknown as LocalWorkspaceResetPreview;
  validateResetPreview(record);
  return structuredClone(record);
}

export class LocalWorkspaceManagementHost {
  readonly #lifecycle: WorkspaceAdministrationDurableLifecycleApplication;
  readonly #transport: LocalWorkspaceTransportServer;
  #started = false;
  #closed = false;

  constructor(input: {
    readonly lease: LocalWorkspaceOwnerLease;
    readonly lifecycle: WorkspaceAdministrationDurableLifecycleApplication;
  }) {
    this.#lifecycle = input.lifecycle;
    this.#transport = new LocalWorkspaceTransportServer(input.lease, (request) =>
      this.#handle(validateHostRequest(request)),
    );
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) return;
    try {
      await this.#transport.start();
      this.#started = true;
      await this.#lifecycle.start();
    } catch (error) {
      this.#closed = true;
      const lifecycleClose = this.#lifecycle.close();
      await this.#transport.close().catch(() => undefined);
      await lifecycleClose;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const lifecycleClose = this.#lifecycle.close();
    if (!this.#started) {
      await this.#transport.close();
      await lifecycleClose;
      return;
    }
    await this.#transport.unpublish();
    await this.#transport.close();
    await lifecycleClose;
  }

  async #handle(request: HostRequest): Promise<unknown> {
    if (!this.#started || this.#closed) {
      throw new Error("Local workspace management host is shutting down");
    }
    if (request.kind === "host-status") return this.#lifecycle.hostStatus();
    if (request.kind === "status") return this.#lifecycle.catalogStatus();
    if (request.kind === "list") return this.#lifecycle.list();
    if (request.kind === "view") {
      return this.#lifecycle.viewByName(request.displayName);
    }
    this.#lifecycle.assertDeliveryMechanismReady();
    if (request.kind === "pending") {
      return this.#lifecycle.pending(request.afterSeq);
    }
    if (request.kind === "acknowledge") {
      return this.#lifecycle.acknowledge(request);
    }
    if (request.kind === "prepare") {
      return this.#lifecycle.prepare(request.input);
    }
    return this.#lifecycle.commit(request.identity, request.confirmation);
  }
}

export function createLocalWorkspaceManagementHost(input: {
  readonly lease: LocalWorkspaceOwnerLease;
  readonly zhixingHome: string;
  readonly management: {
    readonly deviceId: string;
    readonly executorId: string;
    readonly admin: import("@zhixing/core/contracts").WorkspaceBindingAdminPort;
    readonly recovery: import("@zhixing/core/contracts").WorkspaceBindingRecoveryPort;
    readonly resources: import("@zhixing/executor").ExecutorResourceGovernor;
  };
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}): LocalWorkspaceManagementHost {
  const control = new ExecutorWorkspaceAdministrationControl({
    executorId: input.management.executorId,
    resources: input.management.resources,
  });
  const workspace = new WorkspaceAdministrationApplicationService({
    deviceId: input.management.deviceId,
    admin: input.management.admin,
    recovery: input.management.recovery,
    control,
  });
  const outbox = new LocalWorkspaceOperationOutbox({
    rootDir: path.join(
      input.zhixingHome,
      "runtime",
      "local-workspace-operation-outbox",
    ),
    storageMaintenance: input.storageMaintenance,
  });
  const lifecycle = new WorkspaceAdministrationDurableLifecycleApplicationService({
    application: workspace,
    mechanism: outbox,
    observeInfrastructureFailure:
      observeLocalWorkspaceDurableInfrastructureFailure,
  });
  return new LocalWorkspaceManagementHost({
    lease: input.lease,
    lifecycle,
  });
}

export function createLocalWorkspaceClient(zhixingHome: string): LocalWorkspaceClient {
  const delivery = new WorkspaceAdministrationResultDeliveryApplicationService({
    mechanism: createWorkspaceAdministrationResultDeliveryMechanism(
      zhixingHome,
    ),
  });
  const read = (kind: "status" | "list") => async (): Promise<unknown> => {
    delivery.forgetCurrentClaim();
    const lifecycle = await readLocalWorkspaceHostStatus(zhixingHome);
    if (lifecycle.state !== "ready") {
      const result = await callLocalWorkspaceHost(zhixingHome, { kind });
      return kind === "status" ? validateStatus(result) : validateWorkspaceList(result);
    }
    await delivery.recover({ kind: "none" });
    const result = await callLocalWorkspaceHost(zhixingHome, { kind });
    return kind === "status" ? validateStatus(result) : validateWorkspaceList(result);
  };
  const viewByName = async (
    displayName: string,
  ): Promise<WorkspaceAdministrationView> => {
    const lifecycle = await readLocalWorkspaceHostStatus(zhixingHome);
    if (lifecycle.state === "ready") {
      await delivery.recover({ kind: "current" });
    }
    return validateWorkspaceView(
      await callLocalWorkspaceHost(zhixingHome, {
        kind: "view",
        displayName,
      }),
    );
  };
  const write = (
    input: WorkspaceAdministrationDurableOperation,
    confirmation?: { readonly impact: string },
  ) => execute(zhixingHome, delivery, input, confirmation).then((completed) =>
    workspaceAdministrationResultValue(input, completed.result),
  );
  return {
    status: read("status") as () => Promise<LocalWorkspaceCatalogStatus>,
    list: read("list") as () => Promise<readonly WorkspaceAdministrationView[]>,
    viewByName,
    create: (displayName, absolutePath) => write({ kind: "create", purpose: "settings", displayName, absolutePath }) as Promise<WorkspaceAdministrationView>,
    authorizeForControl: async (displayName, absolutePath) => {
      return write({
        kind: "create",
        purpose: "control",
        displayName,
        absolutePath,
      }) as Promise<WorkspaceControlAuthorization>;
    },
    rename: (currentName, displayName, expectedRevision) =>
      write({ kind: "rename", currentName, displayName, expectedRevision }) as Promise<WorkspaceAdministrationView>,
    repath: (name, absolutePath, expectedRevision) =>
      write({ kind: "repath", name, absolutePath, expectedRevision }) as Promise<WorkspaceAdministrationView>,
    remove: async (name, expectedRevision) => {
      await write({ kind: "remove", name, expectedRevision });
    },
    previewReset: async (expectedCatalogGeneration) => {
      delivery.forgetCurrentClaim();
      const input = validateWorkspaceAdministrationDurableOperation({
        kind: "reset",
        expectedCatalogGeneration,
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      });
      await delivery.recover({ kind: "none" });
      const prepared = validateLocalWorkspaceOperation(
        await callLocalWorkspaceHost(zhixingHome, { kind: "prepare", input }),
      );
      return resetPreviewOf(prepared);
    },
    confirmReset: async (preview, confirmedImpact) => {
      validateResetPreview(preview);
      if (confirmedImpact !== preview.impact) {
        throw new TypeError("工作区目录恢复确认内容不完整");
      }
      const input = validateWorkspaceAdministrationDurableOperation({
        kind: "reset",
        expectedCatalogGeneration: preview.expectedCatalogGeneration,
        impact: preview.impact,
      });
      const claimed = await delivery.recover({
        kind: "operation",
        identity: preview,
      });
      if (claimed) {
        return workspaceAdministrationResultValue(
          input,
          validateWorkspaceAdministrationDurableResult(claimed.result),
        ) as WorkspaceBindingResetReceipt;
      }
      const completed = validateLocalWorkspaceOperation(
        await callLocalWorkspaceHost(zhixingHome, {
          kind: "commit",
          identity: {
            localSeq: preview.localSeq,
            operationId: preview.operationId,
            inputDigest: preview.inputDigest,
          },
          confirmation: { impact: confirmedImpact },
        }),
      );
      const result = validateWorkspaceAdministrationDurableResult(
        completed.result,
      );
      await delivery.capture(completed);
      return workspaceAdministrationResultValue(
        input,
        result,
      ) as WorkspaceBindingResetReceipt;
    },
    consumptionCredential: () => delivery.consumptionCredential(),
    confirmDelivered: () => delivery.confirmDelivered(),
  };
}

export async function localWorkspaceHostIsReachable(zhixingHome: string): Promise<boolean> {
  try {
    validateHostStatus(
      await callLocalWorkspaceHost(zhixingHome, { kind: "host-status" }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function readLocalWorkspaceHostStatus(
  zhixingHome: string,
): Promise<WorkspaceAdministrationDurableLifecycleStatus> {
  return validateHostStatus(
    await callLocalWorkspaceHost(zhixingHome, { kind: "host-status" }),
  );
}

async function execute(
  zhixingHome: string,
  delivery: WorkspaceAdministrationResultDeliveryApplication,
  input: WorkspaceAdministrationDurableOperation,
  confirmation?: { readonly impact: string },
): Promise<{
  readonly result: WorkspaceAdministrationDurableResult;
  readonly operation: WorkspaceAdministrationDurableOperationRecord;
}> {
  const normalized = validateWorkspaceAdministrationDurableOperation(input);
  const claimed = await delivery.recover({
    kind: "operation-input",
    input: normalized,
  });
  if (claimed) {
    return {
      result: validateWorkspaceAdministrationDurableResult(claimed.result),
      operation: claimed,
    };
  }
  const prepared = validateLocalWorkspaceOperation(
    await callLocalWorkspaceHost(zhixingHome, {
      kind: "prepare",
      input: normalized,
    }),
  );
  const completed = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(zhixingHome, {
    kind: "commit",
    identity: identityOf(prepared),
    ...(confirmation ? { confirmation } : {}),
  }));
  const result = validateWorkspaceAdministrationDurableResult(completed.result);
  await delivery.capture(completed);
  return { result, operation: completed };
}

function createWorkspaceAdministrationResultDeliveryMechanism(
  zhixingHome: string,
): WorkspaceAdministrationResultDeliveryMechanismPort {
  return Object.freeze({
    async pending(
      afterSeq: number,
    ): Promise<WorkspaceAdministrationPendingDeliveryPage> {
      return validatePendingPage(
        await callLocalWorkspaceHost(zhixingHome, {
          kind: "pending",
          afterSeq,
        }),
      );
    },
    async acknowledge(input: WorkspaceAdministrationDeliveryAcknowledgment) {
      return validateAcknowledgmentReceipt(
        await callLocalWorkspaceHost(zhixingHome, {
          kind: "acknowledge",
          ...input,
        }),
      );
    },
  });
}

function resetPreviewOf(
  operation: WorkspaceAdministrationDurableOperationRecord,
): LocalWorkspaceResetPreview {
  if (operation.input.kind !== "reset" || !operation.expiresAt) {
    throw new TypeError("Local workspace reset preview is invalid");
  }
  return {
    ...identityOf(operation),
    expectedCatalogGeneration: operation.input.expectedCatalogGeneration,
    impact: operation.input.impact,
    expiresAt: operation.expiresAt,
  };
}

function validateResetPreview(value: LocalWorkspaceResetPreview): void {
  if (
    !Number.isSafeInteger(value.localSeq) ||
    value.localSeq < 1 ||
    typeof value.operationId !== "string" ||
    typeof value.inputDigest !== "string" ||
    typeof value.expectedCatalogGeneration !== "string" ||
    value.expectedCatalogGeneration.length === 0 ||
    value.impact !== WORKSPACE_CATALOG_RESET_IMPACT ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new TypeError("Local workspace reset preview is invalid");
  }
}

function identityOf(
  operation: WorkspaceAdministrationDurableOperationRecord,
): WorkspaceAdministrationDurableOperationKey {
  return {
    localSeq: operation.localSeq,
    operationId: operation.operationId,
    inputDigest: operation.inputDigest,
  };
}

function validateHostRequest(value: unknown): HostRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Local workspace host request is invalid");
  const request = value as Record<string, unknown>;
  const allowed: Record<string, readonly string[]> = {
    "host-status": ["kind"],
    status: ["kind"],
    list: ["kind"],
    view: ["displayName", "kind"],
    prepare: ["input", "kind"],
    commit: "confirmation" in request
      ? ["confirmation", "identity", "kind"]
      : ["identity", "kind"],
    pending: ["afterSeq", "kind"],
    acknowledge: ["entries", "kind", "outboxId", "prefixDigest", "throughSeq"],
  };
  if (typeof request.kind !== "string" || !(request.kind in allowed)) throw new TypeError("Local workspace host request kind is invalid");
  if (Object.keys(request).sort().join(",") !== [...allowed[request.kind]!].sort().join(",")) {
    throw new TypeError("Local workspace host request fields are invalid");
  }
  switch (request.kind) {
    case "host-status":
    case "status":
    case "list":
      return { kind: request.kind };
    case "view":
      if (
        typeof request.displayName !== "string" ||
        request.displayName.length === 0 ||
        request.displayName.length > 4096 ||
        request.displayName.includes("\0")
      ) {
        throw new TypeError("Local workspace view name is invalid");
      }
      return { kind: "view", displayName: request.displayName };
    case "prepare":
      return {
        kind: "prepare",
        input: validateWorkspaceAdministrationDurableOperation(request.input),
      };
    case "commit": {
      const confirmation = request.confirmation === undefined
        ? undefined
        : exactRecord(request.confirmation, ["impact"], "operation confirmation");
      if (
        confirmation !== undefined &&
        confirmation.impact !== WORKSPACE_CATALOG_RESET_IMPACT
      ) {
        throw new TypeError("Local workspace reset confirmation is invalid");
      }
      return {
        kind: "commit",
        identity: validateIdentity(request.identity),
        ...(confirmation
          ? { confirmation: { impact: confirmation.impact as string } }
          : {}),
      };
    }
    case "pending":
      if (!Number.isSafeInteger(request.afterSeq) || (request.afterSeq as number) < 0) {
        throw new TypeError("Local workspace pending cursor is invalid");
      }
      return { kind: "pending", afterSeq: request.afterSeq as number };
    case "acknowledge": {
      if (
        typeof request.outboxId !== "string" ||
        !/^outbox-[A-Za-z0-9_-]{32}$/u.test(request.outboxId) ||
        !Number.isSafeInteger(request.throughSeq) ||
        (request.throughSeq as number) < 1 ||
        typeof request.prefixDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(request.prefixDigest) ||
        !Array.isArray(request.entries)
      ) {
        throw new TypeError("Local workspace acknowledgment is invalid");
      }
      return {
        kind: "acknowledge",
        outboxId: request.outboxId,
        throughSeq: request.throughSeq as number,
        prefixDigest: request.prefixDigest,
        entries: request.entries.map(validateConfirmationEntry),
      };
    }
  }
  throw new TypeError("Local workspace host request kind is invalid");
}

function validateHostStatus(
  value: unknown,
): WorkspaceAdministrationDurableLifecycleStatus {
  const record = exactRecord(
    value,
    value && typeof value === "object" && "diagnostic" in value
      ? ["diagnostic", "state"]
      : ["state"],
    "host status",
  );
  if (
    record.state !== "recovering" &&
    record.state !== "ready" &&
    record.state !== "degraded" &&
    record.state !== "draining" &&
    record.state !== "closed"
  ) {
    throw new TypeError("Local workspace host state is invalid");
  }
  if (record.diagnostic !== undefined) {
    const diagnostic = exactRecord(
      record.diagnostic,
      record.diagnostic &&
          typeof record.diagnostic === "object" &&
          "localSeq" in record.diagnostic
        ? ["code", "localSeq", "message"]
        : ["code", "message"],
      "host diagnostic",
    );
    if (
      typeof diagnostic.code !== "string" ||
      typeof diagnostic.message !== "string" ||
      (diagnostic.localSeq !== undefined &&
        (!Number.isSafeInteger(diagnostic.localSeq) ||
          (diagnostic.localSeq as number) < 1))
    ) {
      throw new TypeError("Local workspace host diagnostic is invalid");
    }
  }
  return structuredClone(
    value,
  ) as WorkspaceAdministrationDurableLifecycleStatus;
}

function validateAcknowledgmentReceipt(value: unknown): {
  readonly outboxId: string;
  readonly throughSeq: number;
  readonly prefixDigest: string;
} {
  const record = exactRecord(
    value,
    ["outboxId", "prefixDigest", "throughSeq"],
    "acknowledgment receipt",
  );
  if (
    typeof record.outboxId !== "string" ||
    !/^outbox-[A-Za-z0-9_-]{32}$/u.test(record.outboxId) ||
    !Number.isSafeInteger(record.throughSeq) ||
    (record.throughSeq as number) < 1 ||
    typeof record.prefixDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.prefixDigest)
  ) {
    throw new TypeError("Local workspace acknowledgment receipt is invalid");
  }
  return record as {
    readonly outboxId: string;
    readonly throughSeq: number;
    readonly prefixDigest: string;
  };
}

function validateIdentity(
  value: unknown,
): WorkspaceAdministrationDurableOperationKey {
  const record = exactRecord(value, ["inputDigest", "localSeq", "operationId"], "operation identity");
  if (
    !Number.isSafeInteger(record.localSeq) ||
    (record.localSeq as number) < 1 ||
    typeof record.operationId !== "string" ||
    !record.operationId.startsWith("workspace-operation-") ||
    typeof record.inputDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.inputDigest)
  ) {
    throw new TypeError("Local workspace operation identity is invalid");
  }
  return record as unknown as WorkspaceAdministrationDurableOperationKey;
}

function validateConfirmationEntry(value: unknown): ConfirmationEntry {
  const record = exactRecord(
    value,
    ["inputDigest", "localSeq", "operationId", "resultDigest"],
    "confirmation entry",
  );
  const identity = validateIdentity({
    localSeq: record.localSeq,
    operationId: record.operationId,
    inputDigest: record.inputDigest,
  });
  if (typeof record.resultDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.resultDigest)) {
    throw new TypeError("Local workspace confirmation result digest is invalid");
  }
  return { ...identity, resultDigest: record.resultDigest };
}

function validatePendingPage(value: unknown): {
  outboxId: string;
  operations: WorkspaceAdministrationDurableOperationRecord[];
  next?: number;
  confirmation: { throughSeq: number; prefixDigest: string };
} {
  const record = exactRecord(
    value,
    value && typeof value === "object" && "next" in value
      ? ["confirmation", "next", "operations", "outboxId"]
      : ["confirmation", "operations", "outboxId"],
    "pending page",
  );
  if (!Array.isArray(record.operations)) throw new TypeError("Local workspace pending operations are invalid");
  const confirmation = exactRecord(record.confirmation, ["prefixDigest", "throughSeq"], "confirmation watermark");
  if (
    !Number.isSafeInteger(confirmation.throughSeq) ||
    (confirmation.throughSeq as number) < 0 ||
    typeof confirmation.prefixDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(confirmation.prefixDigest) ||
    (record.next !== undefined && (!Number.isSafeInteger(record.next) || (record.next as number) < 1)) ||
    typeof record.outboxId !== "string" ||
    !/^outbox-[A-Za-z0-9_-]{32}$/u.test(record.outboxId)
  ) {
    throw new TypeError("Local workspace pending page is invalid");
  }
  return {
    outboxId: record.outboxId as string,
    operations: record.operations.map(validateLocalWorkspaceOperation),
    ...(record.next === undefined ? {} : { next: record.next as number }),
    confirmation: {
      throughSeq: confirmation.throughSeq as number,
      prefixDigest: confirmation.prefixDigest,
    },
  };
}

function validateStatus(value: unknown): LocalWorkspaceCatalogStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Local workspace catalog status is invalid");
  }
  const exact = value as Record<string, unknown>;
  const allowed = new Set(["catalogGeneration", "reason", "resetImpact", "state"]);
  if (
    Object.keys(exact).some((key) => !allowed.has(key)) ||
    (exact.state !== "healthy" && exact.state !== "degraded") ||
    typeof exact.catalogGeneration !== "string" ||
    (exact.reason !== undefined && typeof exact.reason !== "string") ||
    (exact.state === "degraded" && typeof exact.resetImpact !== "string") ||
    (exact.state === "healthy" && (exact.reason !== undefined || exact.resetImpact !== undefined))
  ) throw new TypeError("Local workspace catalog status is invalid");
  return exact as unknown as LocalWorkspaceCatalogStatus;
}

function validateWorkspaceList(value: unknown): WorkspaceAdministrationView[] {
  if (!Array.isArray(value)) throw new TypeError("Local workspace list is invalid");
  return value.map((item) => {
    const record = exactRecord(item, ["name", "path", "revision", "workspaceBindingRevision"], "workspace view");
    if (
      typeof record.name !== "string" ||
      typeof record.path !== "string" ||
      !Number.isSafeInteger(record.revision) ||
      !Number.isSafeInteger(record.workspaceBindingRevision)
    ) throw new TypeError("Local workspace view is invalid");
    return record as unknown as WorkspaceAdministrationView;
  });
}

function validateWorkspaceView(value: unknown): WorkspaceAdministrationView {
  return validateWorkspaceList([value])[0]!;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Local workspace ${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError(`Local workspace ${label} fields are invalid`);
  }
  return record;
}
