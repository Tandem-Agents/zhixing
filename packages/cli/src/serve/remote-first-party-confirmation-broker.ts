import { randomUUID } from "node:crypto";
import type {
  BrokerSnapshot,
  BrokerUnsubscribe,
  CancelCause,
  ConfirmationDecision,
  ConfirmationOption,
  ConfirmationRequest,
  ConfirmationRequestId,
  DisplayBody,
  IConfirmationBroker,
  PendingSnapshot,
  RequestListener,
  ResolvedListener,
} from "@zhixing-ai/core/confirmation";
import type { OperationClass, RiskLevel } from "@zhixing-ai/core/security";
import type { TurnOrigin } from "@zhixing-ai/core";
import {
  canonicalize,
  type FirstPartyInteractionDecision,
  type InlineInteractionDisplay,
} from "@zhixing-ai/core/protocol";

export interface RemoteRequestedInteractionEvent {
  readonly requestId: string;
  readonly toolName: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface RemoteFinishedInteractionEvent {
  readonly requestId: string;
  readonly outcome: "allowed" | "denied" | "cancelled" | "expired";
}

export interface RemoteFirstPartyConfirmationBrokerOptions {
  readonly id?: string;
  readonly answer: (input: {
    readonly requestId: string;
    readonly decision: FirstPartyInteractionDecision;
  }) => Promise<void>;
  readonly now?: () => number;
}

interface RemotePendingEntry {
  readonly request: ConfirmationRequest;
  status: "queued" | "showing" | "resolving";
}

/**
 * Confirmation broker bridging remote executor interaction frames onto the
 * owner ConfirmationHub without duplicating authority on the anchor.
 */
export class RemoteFirstPartyConfirmationBroker implements IConfirmationBroker {
  readonly id: string;
  readonly #answer: RemoteFirstPartyConfirmationBrokerOptions["answer"];
  readonly #now: () => number;
  readonly #pending = new Map<ConfirmationRequestId, RemotePendingEntry>();
  readonly #queue: ConfirmationRequestId[] = [];
  readonly #finished = new Set<ConfirmationRequestId>();
  readonly #resolvedRecently: Array<{
    readonly id: ConfirmationRequestId;
    readonly decision: ConfirmationDecision;
    readonly resolvedAt: number;
  }> = [];
  readonly #requestListeners = new Set<RequestListener>();
  readonly #resolvedListeners = new Set<ResolvedListener>();
  readonly #invalidatedListeners = new Set<(requestId: string) => void>();

  constructor(options: RemoteFirstPartyConfirmationBrokerOptions) {
    this.id = options.id ?? `remote-first-party:${randomUUID()}`;
    this.#answer = options.answer;
    this.#now = options.now ?? (() => Date.now());
  }

  acceptRequested(
    event: RemoteRequestedInteractionEvent,
    renderedDisplay: InlineInteractionDisplay,
    turnOrigin?: TurnOrigin,
  ): void {
    if (this.#pending.has(event.requestId) || this.#finished.has(event.requestId)) {
      return;
    }
    const now = this.#now();
    const createdAt = parseIsoMs(event.issuedAt, now);
    const expiresAt = parseIsoMs(event.expiresAt, createdAt + 60_000);
    const wireMeta = parseRemoteConfirmationWireMeta(renderedDisplay.lines[1]);
    const defaultOptions: ConfirmationOption[] = [
      { kind: "allow-once", label: "仅本次允许" },
      { kind: "deny", label: "拒绝" },
    ];
    const options =
      wireMeta?.options && wireMeta.options.length > 0
        ? [...wireMeta.options]
        : defaultOptions;
    const request: ConfirmationRequest = {
      id: event.requestId,
      tool: event.toolName,
      toolInput: wireMeta?.toolMeta ? { ...wireMeta.toolMeta } : {},
      workingDirectory: wireMeta?.cwd ?? "",
      ...(wireMeta?.operationClass ? { operationClass: wireMeta.operationClass } : {}),
      ...(wireMeta?.riskLevel
        ? {
            decision: {
              action: "confirm",
              reason: wireMeta.stewardReason ?? renderedDisplay.title,
              riskLevel: wireMeta.riskLevel,
              matchedRules: [],
            },
          }
        : {}),
      display: {
        title: renderedDisplay.title,
        body: parseDisplayBody(renderedDisplay),
        cwd: wireMeta?.cwd ?? "",
        ...(wireMeta?.stewardReason ? { stewardReason: wireMeta.stewardReason } : {}),
        ...(wireMeta?.commandPreview ? { commandPreview: wireMeta.commandPreview } : {}),
        ...(wireMeta?.commandFull ? { commandFull: wireMeta.commandFull } : {}),
        ...(wireMeta?.envKeys ? { envKeys: [...wireMeta.envKeys] } : {}),
        ...(wireMeta?.resolvedPaths ? { resolvedPaths: [...wireMeta.resolvedPaths] } : {}),
      },
      options,
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt,
      expiresAt,
      ...(turnOrigin ? { turnOrigin } : {}),
    };
    const isHead = this.#queue.length === 0;
    this.#queue.push(event.requestId);
    this.#pending.set(event.requestId, {
      request,
      status: isHead ? "showing" : "queued",
    });
    if (isHead) {
      this.#notifyRequest(request);
    }
  }

  acceptFinished(event: RemoteFinishedInteractionEvent): void {
    const entry = this.#pending.get(event.requestId);
    if (!entry || this.#finished.has(event.requestId)) {
      return;
    }
    const decision = decisionForOutcome(event.outcome);
    this.#completeEntry(event.requestId, decision);
  }

  requestConfirmation(): Promise<ConfirmationDecision> {
    return Promise.reject(
      new Error("Remote confirmation bridge does not originate confirmation requests"),
    );
  }

  onRequest(listener: RequestListener): BrokerUnsubscribe {
    this.#requestListeners.add(listener);
    const headId = this.#queue[0];
    if (headId) {
      const head = this.#pending.get(headId);
      if (head && head.status === "showing") {
        listener(head.request);
      }
    }
    return () => {
      this.#requestListeners.delete(listener);
    };
  }

  onInvalidated(listener: (requestId: string) => void): BrokerUnsubscribe {
    this.#invalidatedListeners.add(listener);
    return () => {
      this.#invalidatedListeners.delete(listener);
    };
  }

  onResolved(listener: ResolvedListener): BrokerUnsubscribe {
    this.#resolvedListeners.add(listener);
    return () => {
      this.#resolvedListeners.delete(listener);
    };
  }

  resolve(requestId: ConfirmationRequestId, decision: ConfirmationDecision): boolean {
    const entry = this.#pending.get(requestId);
    if (!entry || entry.status === "resolving") return false;
    void this.resolveDurably(requestId, decision).catch(() => undefined);
    return true;
  }

  async resolveDurably(
    requestId: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): Promise<boolean> {
    const entry = this.#pending.get(requestId);
    if (!entry || entry.status === "resolving") return false;
    const wireDecision = toFirstPartyInteractionDecision(decision);
    const previousStatus = entry.status;
    entry.status = "resolving";
    try {
      await this.#answer({ requestId, decision: wireDecision });
    } catch (error) {
      if (this.#pending.get(requestId) === entry) {
        entry.status = previousStatus;
      }
      throw error;
    }
    this.#completeEntry(requestId, decision);
    return true;
  }

  cancel(requestId: ConfirmationRequestId, cause: CancelCause): boolean {
    const entry = this.#pending.get(requestId);
    if (!entry || entry.status === "resolving") return false;
    this.#completeEntry(requestId, { kind: "cancelled", cause });
    return true;
  }

  cancelAll(cause: CancelCause): number {
    const ids = [...this.#queue];
    let count = 0;
    for (const id of ids) {
      if (this.#pending.has(id)) {
        this.#completeEntry(id, { kind: "cancelled", cause });
        count += 1;
      }
    }
    return count;
  }

  listPending(): PendingSnapshot[] {
    const out: PendingSnapshot[] = [];
    for (const id of this.#queue) {
      const entry = this.#pending.get(id);
      if (entry) {
        out.push({ request: entry.request, status: entry.status });
      }
    }
    return out;
  }

  snapshot(): BrokerSnapshot {
    return {
      id: this.id,
      pending: this.listPending(),
      resolvedRecently: [...this.#resolvedRecently],
      listenerCount: this.#requestListeners.size,
      nonInteractiveResolver: "remote-first-party-bridge",
    };
  }

  #completeEntry(requestId: ConfirmationRequestId, decision: ConfirmationDecision): void {
    if (!this.#pending.delete(requestId)) return;
    this.#finished.add(requestId);
    const idx = this.#queue.indexOf(requestId);
    if (idx !== -1) this.#queue.splice(idx, 1);
    this.#resolvedRecently.push({
      id: requestId,
      decision,
      resolvedAt: this.#now(),
    });
    if (this.#resolvedRecently.length > 128) {
      this.#resolvedRecently.shift();
    }
    for (const listener of [...this.#resolvedListeners]) {
      listener(requestId, decision);
    }
    for (const listener of [...this.#invalidatedListeners]) {
      listener(requestId);
    }
    const nextId = this.#queue[0];
    if (nextId) {
      const next = this.#pending.get(nextId);
      if (next && next.status === "queued") {
        next.status = "showing";
        this.#notifyRequest(next.request);
      }
    }
  }

  #notifyRequest(request: ConfirmationRequest): void {
    for (const listener of [...this.#requestListeners]) {
      listener(request);
    }
  }
}

function parseIsoMs(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFirstPartyInteractionDecision(
  decision: ConfirmationDecision,
): FirstPartyInteractionDecision {
  switch (decision.kind) {
    case "allow-once":
      return {
        kind: "allow-once",
        ...(decision.note !== undefined ? { note: decision.note } : {}),
      };
    case "deny":
      return {
        kind: "deny",
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
    case "cancelled":
      return { kind: "deny", reason: "用户取消确认" };
    case "allow-session":
    case "allow-context":
    case "allow-global":
      throw new Error("当前执行端不支持持久授权，请改为仅本次允许");
    case "edit-then-allow":
    case "expired":
      throw new Error(`远端第一方确认不支持决定类型 ${decision.kind}`);
  }
}

function decisionForOutcome(
  outcome: RemoteFinishedInteractionEvent["outcome"],
): ConfirmationDecision {
  switch (outcome) {
    case "allowed":
      return { kind: "allow-once" };
    case "denied":
      return { kind: "deny" };
    case "cancelled":
      return { kind: "cancelled", cause: "aborted" };
    case "expired":
      return { kind: "expired" };
  }
}

function parseDisplayBody(display: InlineInteractionDisplay): DisplayBody {
  const firstLine = display.lines[0];
  if (typeof firstLine === "string" && firstLine.startsWith("{")) {
    try {
      const raw: unknown = JSON.parse(firstLine);
      const parsed = validateDisplayBody(raw);
      if (parsed) return parsed;
    } catch {
      // Fall back to generic summary below when the first line is not canonical JSON.
    }
  }
  return {
    kind: "generic",
    summary: (typeof firstLine === "string" && firstLine.length > 0 ? firstLine : undefined) ?? display.title,
  };
}

export type RemoteConfirmationWireOption = Extract<
  ConfirmationOption,
  {
    readonly kind:
      | "allow-once"
      | "allow-with-note"
      | "deny"
      | "deny-with-reason"
      | "show-full";
  }
>;

export interface RemoteConfirmationWireMeta {
  readonly v: 1;
  readonly options?: readonly RemoteConfirmationWireOption[];
  readonly stewardReason?: string;
  readonly cwd?: string;
  readonly commandPreview?: string;
  readonly commandFull?: string;
  readonly envKeys?: readonly string[];
  readonly resolvedPaths?: readonly string[];
  readonly operationClass?: OperationClass;
  readonly riskLevel?: RiskLevel;
  readonly toolMeta?: Readonly<Record<string, unknown>>;
}

const MAX_COMMAND_FULL_WIRE_CHARS = 16_384;
const VALID_RISK_LEVELS: ReadonlySet<RiskLevel> = new Set<RiskLevel>([
  "low",
  "medium",
  "high",
  "critical",
]);
const VALID_OPERATION_CLASSES: ReadonlySet<OperationClass> = new Set<OperationClass>([
  "observe",
  "internal",
  "external",
  "critical",
]);

export function encodeRemoteConfirmationWireMeta(
  request: ConfirmationRequest,
): string | undefined {
  const rawOptions = Array.isArray(request.options) ? request.options : [];
  const options = rawOptions.flatMap((opt): readonly RemoteConfirmationWireOption[] => {
    switch (opt.kind) {
      case "allow-once":
        return [
          {
            kind: "allow-once",
            label: opt.label,
            ...(opt.hotkey !== undefined ? { hotkey: opt.hotkey } : {}),
            ...(opt.note !== undefined ? { note: opt.note } : {}),
          },
        ];
      case "allow-with-note":
        return [
          {
            kind: "allow-with-note",
            label: opt.label,
            placeholder: opt.placeholder,
            ...(opt.hotkey !== undefined ? { hotkey: opt.hotkey } : {}),
          },
        ];
      case "deny":
        return [
          {
            kind: "deny",
            label: opt.label,
            ...(opt.hotkey !== undefined ? { hotkey: opt.hotkey } : {}),
          },
        ];
      case "deny-with-reason":
        return [
          {
            kind: "deny-with-reason",
            label: opt.label,
            placeholder: opt.placeholder,
            ...(opt.hotkey !== undefined ? { hotkey: opt.hotkey } : {}),
          },
        ];
      case "show-full":
        return [
          {
            kind: "show-full",
            label: opt.label,
            ...(opt.hotkey !== undefined ? { hotkey: opt.hotkey } : {}),
          },
        ];
      case "allow-session":
      case "allow-context":
      case "allow-global":
      case "edit-then-allow":
        return [];
    }
  });
  const toolMeta = extractBoundedToolMeta(request.toolInput);
  const payload: RemoteConfirmationWireMeta = {
    v: 1,
    ...(options.length > 0 ? { options } : {}),
    ...(request.display.stewardReason ? { stewardReason: request.display.stewardReason } : {}),
    ...(request.display.cwd ? { cwd: request.display.cwd } : {}),
    ...(request.display.commandPreview ? { commandPreview: request.display.commandPreview } : {}),
    ...(request.display.commandFull &&
    request.display.commandFull.length <= MAX_COMMAND_FULL_WIRE_CHARS
      ? { commandFull: request.display.commandFull }
      : {}),
    ...(request.display.envKeys && request.display.envKeys.length > 0
      ? { envKeys: [...request.display.envKeys] }
      : {}),
    ...(request.display.resolvedPaths && request.display.resolvedPaths.length > 0
      ? { resolvedPaths: [...request.display.resolvedPaths] }
      : {}),
    ...(request.operationClass ? { operationClass: request.operationClass } : {}),
    ...(request.decision?.riskLevel ? { riskLevel: request.decision.riskLevel } : {}),
    ...(toolMeta ? { toolMeta } : {}),
  };
  return Object.keys(payload).length > 1 ? canonicalize(payload) : undefined;
}

export function parseRemoteConfirmationWireMeta(
  line: string | undefined,
): RemoteConfirmationWireMeta | undefined {
  if (typeof line !== "string" || !line.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) return undefined;
  const options = Array.isArray(obj.options)
    ? obj.options.flatMap((item): readonly RemoteConfirmationWireOption[] => {
        const opt = validateWireOption(item);
        return opt ? [opt] : [];
      })
    : undefined;
  const envKeys =
    Array.isArray(obj.envKeys) && obj.envKeys.every((k): k is string => typeof k === "string")
      ? obj.envKeys
      : undefined;
  const resolvedPaths =
    Array.isArray(obj.resolvedPaths) &&
    obj.resolvedPaths.every((p): p is string => typeof p === "string")
      ? obj.resolvedPaths
      : undefined;
  const operationClass =
    typeof obj.operationClass === "string" &&
    VALID_OPERATION_CLASSES.has(obj.operationClass as OperationClass)
      ? (obj.operationClass as OperationClass)
      : undefined;
  const riskLevel =
    typeof obj.riskLevel === "string" && VALID_RISK_LEVELS.has(obj.riskLevel as RiskLevel)
      ? (obj.riskLevel as RiskLevel)
      : undefined;
  const toolMeta = validateBoundedToolMeta(obj.toolMeta);
  return {
    v: 1,
    ...(options && options.length > 0 ? { options } : {}),
    ...(typeof obj.stewardReason === "string" && obj.stewardReason.length > 0
      ? { stewardReason: obj.stewardReason }
      : {}),
    ...(typeof obj.cwd === "string" && obj.cwd.length > 0 ? { cwd: obj.cwd } : {}),
    ...(typeof obj.commandPreview === "string" && obj.commandPreview.length > 0
      ? { commandPreview: obj.commandPreview }
      : {}),
    ...(typeof obj.commandFull === "string" &&
    obj.commandFull.length > 0 &&
    obj.commandFull.length <= MAX_COMMAND_FULL_WIRE_CHARS
      ? { commandFull: obj.commandFull }
      : {}),
    ...(envKeys && envKeys.length > 0 ? { envKeys } : {}),
    ...(resolvedPaths && resolvedPaths.length > 0 ? { resolvedPaths } : {}),
    ...(operationClass ? { operationClass } : {}),
    ...(riskLevel ? { riskLevel } : {}),
    ...(toolMeta ? { toolMeta } : {}),
  };
}

function validateWireOption(value: unknown): RemoteConfirmationWireOption | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.label !== "string" || obj.label.length === 0) return undefined;
  const hotkey = typeof obj.hotkey === "string" && obj.hotkey.length > 0 ? obj.hotkey : undefined;
  switch (obj.kind) {
    case "allow-once": {
      const note = typeof obj.note === "string" ? obj.note : undefined;
      return {
        kind: "allow-once",
        label: obj.label,
        ...(hotkey ? { hotkey } : {}),
        ...(note !== undefined ? { note } : {}),
      };
    }
    case "allow-with-note":
      if (typeof obj.placeholder !== "string") return undefined;
      return {
        kind: "allow-with-note",
        label: obj.label,
        placeholder: obj.placeholder,
        ...(hotkey ? { hotkey } : {}),
      };
    case "deny":
      return {
        kind: "deny",
        label: obj.label,
        ...(hotkey ? { hotkey } : {}),
      };
    case "deny-with-reason":
      if (typeof obj.placeholder !== "string") return undefined;
      return {
        kind: "deny-with-reason",
        label: obj.label,
        placeholder: obj.placeholder,
        ...(hotkey ? { hotkey } : {}),
      };
    case "show-full":
      return {
        kind: "show-full",
        label: obj.label,
        ...(hotkey ? { hotkey } : {}),
      };
    default:
      return undefined;
  }
}

function extractBoundedToolMeta(
  toolInput: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  if (typeof toolInput.phase === "string" && toolInput.phase.length <= 128) {
    out.phase = toolInput.phase;
  }
  if (typeof toolInput.candidateDigest === "string" && toolInput.candidateDigest.length <= 256) {
    out.candidateDigest = toolInput.candidateDigest;
  }
  if (typeof toolInput.admissionToken === "string" && toolInput.admissionToken.length <= 256) {
    out.admissionToken = toolInput.admissionToken;
  }
  if (typeof toolInput.totalBytes === "number" && Number.isSafeInteger(toolInput.totalBytes)) {
    out.totalBytes = toolInput.totalBytes;
  }
  if (
    Array.isArray(toolInput.memberPaths) &&
    toolInput.memberPaths.length <= 64 &&
    toolInput.memberPaths.every((m): m is string => typeof m === "string" && m.length <= 512)
  ) {
    out.memberPaths = [...toolInput.memberPaths];
  }
  const referee = validateRefereeMeta(toolInput.referee);
  if (referee) {
    out.referee = referee;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateBoundedToolMeta(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return extractBoundedToolMeta(value as Record<string, unknown>);
}

function validateRefereeMeta(
  value: unknown,
): { readonly role: string; readonly providerId: string; readonly model: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (
    typeof ref.role === "string" &&
    ref.role.length > 0 &&
    ref.role.length <= 64 &&
    typeof ref.providerId === "string" &&
    ref.providerId.length > 0 &&
    ref.providerId.length <= 128 &&
    typeof ref.model === "string" &&
    ref.model.length > 0 &&
    ref.model.length <= 128
  ) {
    return { role: ref.role, providerId: ref.providerId, model: ref.model };
  }
  return undefined;
}

function validateDisplayBody(value: unknown): DisplayBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  switch (obj.kind) {
    case "bash":
      if (typeof obj.command === "string" && typeof obj.commandPreview === "string") {
        return { kind: "bash", command: obj.command, commandPreview: obj.commandPreview };
      }
      return undefined;
    case "file-edit":
      if (typeof obj.path === "string" && (obj.diff === undefined || typeof obj.diff === "string")) {
        return {
          kind: "file-edit",
          path: obj.path,
          ...(typeof obj.diff === "string" ? { diff: obj.diff } : {}),
        };
      }
      return undefined;
    case "file-write":
      if (typeof obj.path === "string" && (obj.preview === undefined || typeof obj.preview === "string")) {
        return {
          kind: "file-write",
          path: obj.path,
          ...(typeof obj.preview === "string" ? { preview: obj.preview } : {}),
        };
      }
      return undefined;
    case "file-read":
      if (typeof obj.path === "string") {
        return { kind: "file-read", path: obj.path };
      }
      return undefined;
    case "network":
      if (
        typeof obj.host === "string" &&
        (obj.direction === "inbound" || obj.direction === "outbound")
      ) {
        return { kind: "network", host: obj.host, direction: obj.direction };
      }
      return undefined;
    case "messaging":
      if (typeof obj.recipient === "string" && typeof obj.content === "string") {
        return { kind: "messaging", recipient: obj.recipient, content: obj.content };
      }
      return undefined;
    case "calendar":
      if (
        typeof obj.title === "string" &&
        Array.isArray(obj.invitees) &&
        obj.invitees.every((item): item is string => typeof item === "string")
      ) {
        return { kind: "calendar", title: obj.title, invitees: obj.invitees };
      }
      return undefined;
    case "generic":
      if (typeof obj.summary === "string") {
        const details = isStringRecord(obj.details) ? obj.details : undefined;
        return {
          kind: "generic",
          summary: obj.summary,
          ...(details ? { details } : {}),
        };
      }
      return undefined;
    default:
      return undefined;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}
