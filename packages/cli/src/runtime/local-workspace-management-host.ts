import { protocolDigest } from "@zhixing/core/protocol";
import path from "node:path";
import {
  WorkspaceAdministrationApplicationService,
  WorkspaceAdministrationDurableLifecycleApplicationService,
  WORKSPACE_CATALOG_RESET_IMPACT,
  type WorkspaceAdministrationCatalogStatus,
  type WorkspaceAdministrationDurableLifecycleApplication,
  type WorkspaceAdministrationDurableLifecycleStatus,
  type WorkspaceAdministrationDurableOperation,
  type WorkspaceAdministrationDurableOperationKey,
  type WorkspaceAdministrationDurableOperationRecord,
  type WorkspaceAdministrationDurableResult,
  type WorkspaceControlAuthorization,
  type WorkspaceAdministrationView,
  validateWorkspaceAdministrationDurableOperation,
  validateWorkspaceAdministrationDurableResult,
  validateWorkspaceAdministrationDurableValue,
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

const PAGE_SIZE = 64;

export interface LocalWorkspaceConsumptionCredential
  extends WorkspaceAdministrationDurableOperationKey {
  readonly outboxId: string;
  readonly resultDigest: string;
}

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

interface ConfirmationEntry extends WorkspaceAdministrationDurableOperationKey {
  readonly resultDigest: string;
}

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
  consumptionCredential(): LocalWorkspaceConsumptionCredential | undefined;
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

export class RecoveredLocalWorkspaceOperationsError extends Error {
  readonly code = "LOCAL_WORKSPACE_RESULTS_RECOVERED";
  readonly outboxId: string;
  readonly operations: readonly WorkspaceAdministrationDurableOperationRecord[];

  constructor(
    outboxId: string,
    operations: readonly WorkspaceAdministrationDurableOperationRecord[],
  ) {
    super("已恢复先前未确认的本机工作区操作结果，请查看后重试当前命令");
    this.name = "RecoveredLocalWorkspaceOperationsError";
    this.outboxId = outboxId;
    this.operations = operations.map((operation) => structuredClone(operation));
  }
}

export class CompletedLocalWorkspaceOperationError extends Error {
  readonly code: string;
  #deliveryConfirmed = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompletedLocalWorkspaceOperationError";
    this.code = code;
  }

  get deliveryConfirmed(): boolean {
    return this.#deliveryConfirmed;
  }

  markDeliveryConfirmed(): void {
    this.#deliveryConfirmed = true;
  }
}

export class LocalWorkspaceManagementHost {
  readonly #lifecycle: WorkspaceAdministrationDurableLifecycleApplication;
  readonly #delivery: Pick<
    LocalWorkspaceOperationOutbox,
    "pending" | "acknowledge"
  >;
  readonly #transport: LocalWorkspaceTransportServer;
  #started = false;
  #closed = false;

  constructor(input: {
    readonly lease: LocalWorkspaceOwnerLease;
    readonly lifecycle: WorkspaceAdministrationDurableLifecycleApplication;
    readonly delivery: Pick<
      LocalWorkspaceOperationOutbox,
      "pending" | "acknowledge"
    >;
  }) {
    this.#lifecycle = input.lifecycle;
    this.#delivery = input.delivery;
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
      return this.#delivery.pending(request.afterSeq, PAGE_SIZE);
    }
    if (request.kind === "acknowledge") {
      return this.#delivery.acknowledge(request);
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
    delivery: outbox,
  });
}

export function createLocalWorkspaceClient(zhixingHome: string): LocalWorkspaceClient {
  let pendingDelivery: PendingDelivery | undefined;
  let currentResult: WorkspaceAdministrationDurableOperationRecord | undefined;
  const recover = async (): Promise<PendingDelivery> => {
    pendingDelivery = await readPendingDelivery(zhixingHome);
    return pendingDelivery;
  };
  const read = (kind: "status" | "list") => async (): Promise<unknown> => {
    currentResult = undefined;
    const lifecycle = await readLocalWorkspaceHostStatus(zhixingHome);
    if (lifecycle.state !== "ready") {
      const result = await callLocalWorkspaceHost(zhixingHome, { kind });
      return kind === "status" ? validateStatus(result) : validateWorkspaceList(result);
    }
    const recovered = await recover();
    reportUnclaimedResults(recovered.outboxId, recovered.operations);
    const result = await callLocalWorkspaceHost(zhixingHome, { kind });
    return kind === "status" ? validateStatus(result) : validateWorkspaceList(result);
  };
  const viewByName = async (
    displayName: string,
  ): Promise<WorkspaceAdministrationView> => {
    const claimed = consumptionCredentialOf(pendingDelivery, currentResult);
    const lifecycle = await readLocalWorkspaceHostStatus(zhixingHome);
    if (lifecycle.state === "ready") {
      const recovered = await recover();
      reportUnclaimedResults(
        recovered.outboxId,
        claimed && recovered.outboxId === claimed.outboxId
          ? recovered.operations.filter(
              (operation) => !matchesConsumptionCredential(operation, claimed),
            )
          : recovered.operations,
      );
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
  ) => execute(zhixingHome, input, recover, confirmation).then((completed) => {
    currentResult = completed.operation;
    return resultValue(input, completed.result);
  });
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
      currentResult = undefined;
      const input = validateWorkspaceAdministrationDurableOperation({
        kind: "reset",
        expectedCatalogGeneration,
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      });
      const recovered = await recover();
      reportUnclaimedResults(recovered.outboxId, recovered.operations);
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
      const recovered = await recover();
      const claimed = recovered.operations.find(
        (operation) =>
          operation.state === "completed" &&
          operation.localSeq === preview.localSeq &&
          operation.operationId === preview.operationId &&
          operation.inputDigest === preview.inputDigest,
      );
      reportUnclaimedResults(
        recovered.outboxId,
        claimed
          ? recovered.operations.filter(
              (operation) => operation.operationId !== claimed.operationId,
            )
          : recovered.operations,
      );
      if (claimed) {
        currentResult = claimed;
        return resultValue(
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
      await recover();
      currentResult = completed;
      return resultValue(input, result) as WorkspaceBindingResetReceipt;
    },
    consumptionCredential: () => {
      return consumptionCredentialOf(pendingDelivery, currentResult);
    },
    confirmDelivered: async () => {
      const delivery = pendingDelivery;
      if (!delivery || delivery.operations.length === 0) return;
      await acknowledgeDelivery(zhixingHome, delivery);
      pendingDelivery = undefined;
      currentResult = undefined;
    },
  };
}

function consumptionCredentialOf(
  delivery: PendingDelivery | undefined,
  operation: WorkspaceAdministrationDurableOperationRecord | undefined,
): LocalWorkspaceConsumptionCredential | undefined {
  if (!delivery || !operation?.resultDigest) return undefined;
  const credential = {
    outboxId: delivery.outboxId,
    ...identityOf(operation),
    resultDigest: operation.resultDigest,
  };
  if (
    !delivery.operations.some((candidate) =>
      matchesConsumptionCredential(candidate, credential),
    )
  ) {
    throw new Error(
      "Local workspace result is not part of the recoverable delivery prefix",
    );
  }
  return credential;
}

function matchesConsumptionCredential(
  operation: WorkspaceAdministrationDurableOperationRecord,
  credential: LocalWorkspaceConsumptionCredential,
): boolean {
  return (
    operation.localSeq === credential.localSeq &&
    operation.operationId === credential.operationId &&
    operation.inputDigest === credential.inputDigest &&
    operation.resultDigest === credential.resultDigest
  );
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
  input: WorkspaceAdministrationDurableOperation,
  recover: () => Promise<PendingDelivery>,
  confirmation?: { readonly impact: string },
): Promise<{
  readonly result: WorkspaceAdministrationDurableResult;
  readonly operation: WorkspaceAdministrationDurableOperationRecord;
}> {
  const normalized = validateWorkspaceAdministrationDurableOperation(input);
  const inputDigest = protocolDigest("LocalWorkspaceOperationInput", 1, normalized);
  const recovered = await recover();
  const claimed = recovered.operations.find(
    (operation) => operation.state === "completed" && operation.inputDigest === inputDigest,
  );
  reportUnclaimedResults(
    recovered.outboxId,
    claimed
      ? recovered.operations.filter(
          (operation) => operation.operationId !== claimed.operationId,
        )
      : recovered.operations,
  );
  if (claimed) {
    return {
      result: validateWorkspaceAdministrationDurableResult(claimed.result),
      operation: claimed,
    };
  }

  const prepared = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(zhixingHome, { kind: "prepare", input: normalized }));
  const completed = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(zhixingHome, {
    kind: "commit",
    identity: identityOf(prepared),
    ...(confirmation ? { confirmation } : {}),
  }));
  const result = validateWorkspaceAdministrationDurableResult(completed.result);
  await recover();
  return { result, operation: completed };
}

function resultValue(
  input: WorkspaceAdministrationDurableOperation,
  result: WorkspaceAdministrationDurableResult,
): unknown {
  if (!result.ok) {
    throw new CompletedLocalWorkspaceOperationError(
      result.error.code,
      result.error.message,
    );
  }
  return validateWorkspaceAdministrationDurableValue(input, result.value);
}

interface PendingDelivery {
  readonly outboxId: string;
  readonly confirmation: { readonly throughSeq: number; readonly prefixDigest: string };
  readonly operations: readonly WorkspaceAdministrationDurableOperationRecord[];
}

async function readPendingDelivery(zhixingHome: string): Promise<PendingDelivery> {
  let afterSeq = 0;
  let outboxId: string | undefined;
  let confirmation: { throughSeq: number; prefixDigest: string } | undefined;
  const terminal: WorkspaceAdministrationDurableOperationRecord[] = [];
  for (;;) {
    const page = validatePendingPage(await callLocalWorkspaceHost(zhixingHome, {
      kind: "pending",
      afterSeq,
    }));
    outboxId ??= page.outboxId;
    if (outboxId !== page.outboxId) {
      throw new Error("Local workspace outbox identity changed during delivery recovery");
    }
    confirmation ??= page.confirmation;
    for (const operation of page.operations) {
      if (operation.localSeq !== (terminal.at(-1)?.localSeq ?? confirmation.throughSeq) + 1) break;
      if ((operation.state !== "completed" && operation.state !== "abandoned") || !operation.resultDigest) break;
      terminal.push(operation);
    }
    if (page.next === undefined) break;
    afterSeq = page.next;
  }
  if (!confirmation || terminal.length === 0) {
    return {
      outboxId: outboxId ?? "",
      confirmation: confirmation ?? {
        throughSeq: 0,
        prefixDigest: protocolDigest("LocalWorkspaceOperationPrefix", 1, null),
      },
      operations: [],
    };
  }
  return { outboxId: outboxId!, confirmation, operations: terminal };
}

async function acknowledgeDelivery(
  zhixingHome: string,
  delivery: PendingDelivery,
): Promise<void> {
  const { confirmation, operations: terminal } = delivery;
  let prefixDigest = confirmation.prefixDigest;
  const entries: ConfirmationEntry[] = terminal.map((operation) => {
    const entry = { ...identityOf(operation), resultDigest: operation.resultDigest! };
    prefixDigest = protocolDigest("LocalWorkspaceOperationPrefix", 1, {
      previous: prefixDigest,
      ...entry,
    });
    return entry;
  });
  const receipt = validateAcknowledgmentReceipt(await callLocalWorkspaceHost(zhixingHome, {
    kind: "acknowledge",
    outboxId: delivery.outboxId,
    throughSeq: terminal.at(-1)!.localSeq,
    prefixDigest,
    entries,
  }));
  if (
    receipt.outboxId !== delivery.outboxId ||
    receipt.throughSeq !== terminal.at(-1)!.localSeq ||
    receipt.prefixDigest !== prefixDigest
  ) {
    throw new Error("Local workspace acknowledgment receipt is bound to another delivery");
  }
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

function reportUnclaimedResults(
  outboxId: string,
  operations: readonly WorkspaceAdministrationDurableOperationRecord[],
): void {
  const completed = operations.filter((operation) => operation.state === "completed");
  if (completed.length > 0) {
    throw new RecoveredLocalWorkspaceOperationsError(outboxId, completed);
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
