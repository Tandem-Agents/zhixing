import { protocolDigest } from "@zhixing/core/protocol";
import path from "node:path";
import {
  LocalWorkspaceFacade,
  type LocalWorkspaceFacadeOptions,
} from "./local-workspace-facade.js";
import type {
  LocalWorkspaceCatalogStatus,
  LocalWorkspaceView,
} from "./local-workspace-facade.js";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { WorkspaceBindingResetReceipt } from "@zhixing/core/contracts";
import {
  LocalWorkspaceOperationOutbox,
  type LocalWorkspaceOperation,
  type LocalWorkspaceWriteOperation,
  validateLocalWorkspaceOperation,
  validateLocalWorkspaceWriteOperation,
} from "./local-workspace-operation-outbox.js";
import {
  LocalWorkspaceTransportServer,
  callLocalWorkspaceHost,
  type LocalWorkspaceOwnerLease,
} from "./local-workspace-owner.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

const PAGE_SIZE = 64;

export interface OperationIdentity {
  readonly localSeq: number;
  readonly operationId: string;
  readonly inputDigest: string;
}

export interface LocalWorkspaceConsumptionCredential extends OperationIdentity {
  readonly outboxId: string;
  readonly resultDigest: string;
}

type HostRequest =
  | { readonly kind: "status" }
  | { readonly kind: "list" }
  | { readonly kind: "prepare"; readonly input: LocalWorkspaceWriteOperation }
  | {
      readonly kind: "commit";
      readonly identity: OperationIdentity;
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

interface ConfirmationEntry extends OperationIdentity {
  readonly resultDigest: string;
}

interface OperationResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

type LocalWorkspaceHostFacade = Pick<
  LocalWorkspaceFacade,
  "status" | "list" | "create" | "authorizeForControl" | "rename" | "repath" | "remove" | "reset"
>;

export interface LocalWorkspaceClient {
  status(): Promise<LocalWorkspaceCatalogStatus>;
  list(): Promise<LocalWorkspaceView[]>;
  create(displayName: string, absolutePath: string): Promise<LocalWorkspaceView>;
  authorizeForControl(displayName: string, absolutePath: string): Promise<{ deviceId: string; bindingRef: string }>;
  rename(currentName: string, displayName: string, expectedRevision: number): Promise<LocalWorkspaceView>;
  repath(name: string, absolutePath: string, expectedRevision: number): Promise<LocalWorkspaceView>;
  remove(name: string, expectedRevision: number): Promise<void>;
  previewReset(expectedCatalogGeneration: string): Promise<LocalWorkspaceResetPreview>;
  confirmReset(
    preview: LocalWorkspaceResetPreview,
    confirmedImpact: string,
  ): Promise<WorkspaceBindingResetReceipt>;
  consumptionCredential(): LocalWorkspaceConsumptionCredential | undefined;
  confirmDelivered(): Promise<void>;
}

export interface LocalWorkspaceResetPreview extends OperationIdentity {
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
  readonly operations: readonly LocalWorkspaceOperation[];

  constructor(outboxId: string, operations: readonly LocalWorkspaceOperation[]) {
    super("已恢复先前未确认的本机工作区操作结果，请查看后重试当前命令");
    this.name = "RecoveredLocalWorkspaceOperationsError";
    this.outboxId = outboxId;
    this.operations = operations.map((operation) => structuredClone(operation));
  }
}

export class LocalWorkspaceManagementHost {
  readonly #facade: LocalWorkspaceHostFacade;
  readonly #outbox: LocalWorkspaceOperationOutbox;
  readonly #transport: LocalWorkspaceTransportServer;
  #started = false;
  #tail = Promise.resolve();

  constructor(input: {
    readonly lease: LocalWorkspaceOwnerLease;
    readonly facade: LocalWorkspaceHostFacade;
    readonly outbox: LocalWorkspaceOperationOutbox;
  }) {
    this.#facade = input.facade;
    this.#outbox = input.outbox;
    this.#transport = new LocalWorkspaceTransportServer(input.lease, (request) =>
      this.#handle(validateHostRequest(request)),
    );
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.#outbox.initialize();
    await this.#recoverCommitted();
    await this.#transport.start();
    this.#started = true;
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    await this.#transport.close();
    await this.#tail;
  }

  async #handle(request: HostRequest): Promise<unknown> {
    if (!this.#started) {
      throw new Error("Local workspace management host is shutting down");
    }
    if (request.kind === "status") return this.#facade.status();
    if (request.kind === "list") return this.#facade.list();
    if (request.kind === "pending") return this.#outbox.pending(request.afterSeq, PAGE_SIZE);
    if (request.kind === "acknowledge") return this.#outbox.acknowledge(request);
    if (request.kind === "prepare") {
      if (request.input.kind === "reset") {
        const status = await this.#facade.status();
        if (status.catalogGeneration !== request.input.expectedCatalogGeneration) {
          throw new Error("工作区目录世代已经变化，请重新查看恢复影响");
        }
      }
      return this.#outbox.prepare(request.input);
    }
    const committed = await this.#outbox.commit(
      request.identity,
      request.confirmation,
    );
    const completed = await this.#drive(committed);
    return completed;
  }

  async #recoverCommitted(): Promise<void> {
    let afterSeq = 0;
    for (;;) {
      const page = await this.#outbox.pending(afterSeq, PAGE_SIZE);
      for (const operation of page.operations) {
        if (operation.state === "committed") await this.#drive(operation);
      }
      if (page.next === undefined) return;
      afterSeq = page.next;
    }
  }

  #drive(operation: LocalWorkspaceOperation): Promise<LocalWorkspaceOperation> {
    const run = this.#tail.then(async () => {
      const current = this.#outbox.operation(operation);
      if (current.state === "completed") return current;
      if (current.state !== "committed") throw new Error("Local workspace operation is not committed");
      let result: OperationResult;
      try {
        result = { ok: true, value: (await this.#execute(current)) ?? null };
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: stableErrorCode(error),
            message: error instanceof Error ? error.message : "Local workspace operation failed",
          },
        };
      }
      return this.#outbox.complete(current, result);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #execute(operation: LocalWorkspaceOperation): Promise<unknown> {
    const requestNonce = [
      "workspace-operation",
      this.#outbox.outboxId,
      operation.localSeq,
      operation.operationId,
      operation.inputDigest,
    ].join(":");
    const authority = {
      requestNonce,
      ...(operation.confirmationToken
        ? { confirmationToken: operation.confirmationToken }
        : {}),
    };
    const input = operation.input;
    switch (input.kind) {
      case "create":
        return input.purpose === "control"
          ? this.#facade.authorizeForControl(input.displayName, input.absolutePath, authority)
          : this.#facade.create(input.displayName, input.absolutePath, authority);
      case "rename":
        return this.#facade.rename(input.currentName, input.displayName, input.expectedRevision, authority);
      case "repath":
        return this.#facade.repath(input.name, input.absolutePath, input.expectedRevision, authority);
      case "remove":
        await this.#facade.remove(input.name, input.expectedRevision, authority);
        return null;
      case "reset":
        return this.#facade.reset(
          input.expectedCatalogGeneration,
          input.impact,
          authority,
        );
    }
  }
}

export function createLocalWorkspaceManagementHost(input: {
  readonly lease: LocalWorkspaceOwnerLease;
  readonly zhixingHome: string;
  readonly facade: LocalWorkspaceFacadeOptions;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}): LocalWorkspaceManagementHost {
  return new LocalWorkspaceManagementHost({
    lease: input.lease,
    facade: new LocalWorkspaceFacade(input.facade),
    outbox: new LocalWorkspaceOperationOutbox({
      rootDir: path.join(
        input.zhixingHome,
        "runtime",
        "local-workspace-operation-outbox",
      ),
      storageMaintenance: input.storageMaintenance,
    }),
  });
}

export function createLocalWorkspaceClient(zhixingHome: string): LocalWorkspaceClient {
  let pendingDelivery: PendingDelivery | undefined;
  let currentResult: LocalWorkspaceOperation | undefined;
  const recover = async (): Promise<PendingDelivery> => {
    pendingDelivery = await readPendingDelivery(zhixingHome);
    return pendingDelivery;
  };
  const read = (kind: "status" | "list") => async (): Promise<unknown> => {
    currentResult = undefined;
    const recovered = await recover();
    reportUnclaimedResults(recovered.outboxId, recovered.operations);
    const result = await callLocalWorkspaceHost(zhixingHome, { kind });
    return kind === "status" ? validateStatus(result) : validateWorkspaceList(result);
  };
  const write = (
    input: LocalWorkspaceWriteOperation,
    confirmation?: { readonly impact: string },
  ) => execute(zhixingHome, input, recover, confirmation).then((completed) => {
    currentResult = completed.operation;
    return completed.value;
  });
  return {
    status: read("status") as () => Promise<LocalWorkspaceCatalogStatus>,
    list: read("list") as () => Promise<LocalWorkspaceView[]>,
    create: (displayName, absolutePath) => write({ kind: "create", purpose: "settings", displayName, absolutePath }) as Promise<LocalWorkspaceView>,
    authorizeForControl: async (displayName, absolutePath) => {
      const view = await write({ kind: "create", purpose: "control", displayName, absolutePath }) as { bindingRef?: string; deviceId?: string };
      return view as { deviceId: string; bindingRef: string };
    },
    rename: (currentName, displayName, expectedRevision) =>
      write({ kind: "rename", currentName, displayName, expectedRevision }) as Promise<LocalWorkspaceView>,
    repath: (name, absolutePath, expectedRevision) =>
      write({ kind: "repath", name, absolutePath, expectedRevision }) as Promise<LocalWorkspaceView>,
    remove: async (name, expectedRevision) => {
      await write({ kind: "remove", name, expectedRevision });
    },
    previewReset: async (expectedCatalogGeneration) => {
      currentResult = undefined;
      const input = validateLocalWorkspaceWriteOperation({
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
      const input = validateLocalWorkspaceWriteOperation({
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
        return resultValue(input, validateOperationResult(claimed.result)) as WorkspaceBindingResetReceipt;
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
      const result = validateOperationResult(completed.result);
      await recover();
      currentResult = completed;
      return resultValue(input, result) as WorkspaceBindingResetReceipt;
    },
    consumptionCredential: () => {
      const delivery = pendingDelivery;
      const operation = currentResult;
      if (!delivery || !operation?.resultDigest) return undefined;
      if (!delivery.operations.some((candidate) =>
        candidate.localSeq === operation.localSeq &&
        candidate.operationId === operation.operationId &&
        candidate.inputDigest === operation.inputDigest &&
        candidate.resultDigest === operation.resultDigest)) {
        throw new Error("Local workspace result is not part of the recoverable delivery prefix");
      }
      return {
        outboxId: delivery.outboxId,
        ...identityOf(operation),
        resultDigest: operation.resultDigest,
      };
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

export async function localWorkspaceHostIsReachable(zhixingHome: string): Promise<boolean> {
  try {
    validateStatus(await callLocalWorkspaceHost(zhixingHome, { kind: "status" }));
    return true;
  } catch {
    return false;
  }
}

async function execute(
  zhixingHome: string,
  input: LocalWorkspaceWriteOperation,
  recover: () => Promise<PendingDelivery>,
  confirmation?: { readonly impact: string },
): Promise<{ readonly value: unknown; readonly operation: LocalWorkspaceOperation }> {
  const normalized = validateLocalWorkspaceWriteOperation(input);
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
      value: resultValue(normalized, validateOperationResult(claimed.result)),
      operation: claimed,
    };
  }

  const prepared = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(zhixingHome, { kind: "prepare", input: normalized }));
  const completed = validateLocalWorkspaceOperation(await callLocalWorkspaceHost(zhixingHome, {
    kind: "commit",
    identity: identityOf(prepared),
    ...(confirmation ? { confirmation } : {}),
  }));
  const result = validateOperationResult(completed.result);
  await recover();
  return { value: resultValue(normalized, result), operation: completed };
}

function resultValue(input: LocalWorkspaceWriteOperation, result: OperationResult): unknown {
  if (!result.ok) {
    const error = new Error(result.error?.message ?? "Local workspace operation failed") as Error & { code?: string };
    error.code = result.error?.code;
    throw error;
  }
  return validateOperationValue(input, result.value);
}

function validateOperationResult(value: unknown): OperationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Local workspace operation result is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) {
    const record = exactRecord(value, ["ok", "value"], "operation result");
    return { ok: true, value: record.value };
  }
  if (candidate.ok === false) {
    const record = exactRecord(value, ["error", "ok"], "operation result");
    const error = exactRecord(record.error, ["code", "message"], "operation error");
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      throw new TypeError("Local workspace operation error is invalid");
    }
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  throw new TypeError("Local workspace operation result is invalid");
}

interface PendingDelivery {
  readonly outboxId: string;
  readonly confirmation: { readonly throughSeq: number; readonly prefixDigest: string };
  readonly operations: readonly LocalWorkspaceOperation[];
}

async function readPendingDelivery(zhixingHome: string): Promise<PendingDelivery> {
  let afterSeq = 0;
  let outboxId: string | undefined;
  let confirmation: { throughSeq: number; prefixDigest: string } | undefined;
  const terminal: LocalWorkspaceOperation[] = [];
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

function resetPreviewOf(operation: LocalWorkspaceOperation): LocalWorkspaceResetPreview {
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
  operations: readonly LocalWorkspaceOperation[],
): void {
  const completed = operations.filter((operation) => operation.state === "completed");
  if (completed.length > 0) {
    throw new RecoveredLocalWorkspaceOperationsError(outboxId, completed);
  }
}

function identityOf(operation: LocalWorkspaceOperation): OperationIdentity {
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
    status: ["kind"],
    list: ["kind"],
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
    case "status":
    case "list":
      return { kind: request.kind };
    case "prepare":
      return { kind: "prepare", input: validateLocalWorkspaceWriteOperation(request.input) };
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

function validateIdentity(value: unknown): OperationIdentity {
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
  return record as unknown as OperationIdentity;
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
  operations: LocalWorkspaceOperation[];
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

function validateWorkspaceList(value: unknown): LocalWorkspaceView[] {
  if (!Array.isArray(value)) throw new TypeError("Local workspace list is invalid");
  return value.map((item) => {
    const record = exactRecord(item, ["name", "path", "revision", "workspaceBindingRevision"], "workspace view");
    if (
      typeof record.name !== "string" ||
      typeof record.path !== "string" ||
      !Number.isSafeInteger(record.revision) ||
      !Number.isSafeInteger(record.workspaceBindingRevision)
    ) throw new TypeError("Local workspace view is invalid");
    return record as unknown as LocalWorkspaceView;
  });
}

function validateOperationValue(
  input: LocalWorkspaceWriteOperation,
  value: unknown,
): unknown {
  if (input.kind === "remove") {
    if (value !== null) throw new TypeError("Local workspace remove result is invalid");
    return null;
  }
  if (input.kind === "create" && input.purpose === "control") {
    const record = exactRecord(value, ["bindingRef", "deviceId"], "control authorization");
    if (typeof record.bindingRef !== "string" || typeof record.deviceId !== "string") {
      throw new TypeError("Local workspace control authorization is invalid");
    }
    return record;
  }
  if (input.kind === "reset") {
    const record = exactRecord(
      value,
      [
        "capabilityRevision",
        "catalogGeneration",
        "confirmationDigest",
        "logId",
        "preparedAt",
        "previousCatalogGeneration",
        "requestId",
      ],
      "reset receipt",
    );
    if (
      typeof record.requestId !== "string" ||
      typeof record.confirmationDigest !== "string" ||
      typeof record.previousCatalogGeneration !== "string" ||
      typeof record.catalogGeneration !== "string" ||
      typeof record.logId !== "string" ||
      !Number.isSafeInteger(record.capabilityRevision) ||
      typeof record.preparedAt !== "string"
    ) throw new TypeError("Local workspace reset receipt is invalid");
    return record;
  }
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

function stableErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "LOCAL_WORKSPACE_OPERATION_FAILED";
}
