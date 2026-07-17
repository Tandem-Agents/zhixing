import {
  AuthorityStorageError,
  type ArtifactStore,
} from "../authority/index.js";
import type {
  DeliveryEndpointDto,
  DeliveryFailure,
} from "../contracts/index.js";
import type { IEventBus } from "../events/index.js";
import { byteDigest, canonicalize } from "../protocol/index.js";
import {
  DeliveryAuthority,
} from "./authority.js";
import { validateOutboundContentDto } from "./content-schema.js";
import { AuthorityDeliveryQueue } from "./authority-queue.js";
import type {
  AuthorityDeliveryEventMap,
  AuthorityDeliveryItem,
  AuthorityDeliveryStats,
  AuthorityDeliveryLogger,
  DeliverySender,
  DeliveryTransport,
  DeliveryEndpointTransport,
} from "./types.js";
import {
  normalizeDeliveryOutcomePolicy,
  normalizeDeliveryResult,
  requireDeliveryEndpointTransport,
  requireDeliveryReadiness,
} from "./transport-contract.js";

export interface AuthorityDeliveryPipelineConfig {
  readonly baseRetryDelayMs: number;
  readonly flushIntervalMs: number;
}

export const DEFAULT_AUTHORITY_DELIVERY_CONFIG: AuthorityDeliveryPipelineConfig = {
  baseRetryDelayMs: 5_000,
  flushIntervalMs: 30_000,
};

export interface AuthorityDeliveryPipelineDeps {
  readonly authority: DeliveryAuthority;
  readonly artifacts: ArtifactStore;
  readonly eventBus: IEventBus<AuthorityDeliveryEventMap>;
  readonly config: AuthorityDeliveryPipelineConfig;
  readonly transport?: DeliveryTransport;
  readonly sender?: DeliverySender;
  readonly now?: () => Date;
  readonly logger?: AuthorityDeliveryLogger;
  readonly materializeContent?: (
    content: AuthorityDeliveryItem["content"],
    artifacts: ArtifactStore,
  ) => Promise<import("../channels/types.js").OutboundContent>;
}

const PRIORITY_ORDER: Record<AuthorityDeliveryItem["priority"], number> = {
  high: 3,
  normal: 2,
  low: 1,
};
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

type PipelineState = "unstarted" | "running" | "stopped";

/** Drains authority facts; it cannot create, delete, or rewrite delivery items. */
export class AuthorityDeliveryPipeline {
  readonly #authority: DeliveryAuthority;
  readonly #artifacts: ArtifactStore;
  readonly #queue: AuthorityDeliveryQueue;
  readonly #transport: DeliveryTransport;
  readonly #eventBus: IEventBus<AuthorityDeliveryEventMap>;
  readonly #config: AuthorityDeliveryPipelineConfig;
  readonly #now: () => Date;
  readonly #logger: AuthorityDeliveryLogger;
  readonly #materializeContent: NonNullable<AuthorityDeliveryPipelineDeps["materializeContent"]>;
  #state: PipelineState = "unstarted";
  #flushTimer: ReturnType<typeof setInterval> | undefined;
  #activeFlush: Promise<void> | undefined;

  constructor(deps: AuthorityDeliveryPipelineDeps) {
    if (deps.transport && deps.sender) {
      throw new TypeError("Delivery pipeline accepts one transport adapter");
    }
    if (!deps.transport && !deps.sender) {
      throw new TypeError("Delivery pipeline requires a transport adapter");
    }
    assertNonNegativeMs(deps.config.baseRetryDelayMs, "Delivery retry delay");
    assertTimerIntervalMs(deps.config.flushIntervalMs);
    this.#authority = deps.authority;
    this.#artifacts = deps.artifacts;
    this.#queue = new AuthorityDeliveryQueue({ authority: deps.authority });
    this.#transport = deps.transport ?? singleDeliveryTransport(
      channelAuthorityDeliveryTransport(deps.sender!),
    );
    this.#eventBus = deps.eventBus;
    this.#config = deps.config;
    this.#now = deps.now ?? (() => new Date());
    this.#logger = deps.logger ?? noopLogger();
    this.#materializeContent = deps.materializeContent ?? defaultMaterializeContent;
  }

  async start(): Promise<void> {
    if (this.#state !== "unstarted") {
      throw new Error(`Pipeline.start: illegal transition from state="${this.#state}"`);
    }
    const pending = await this.#queue.load();
    this.#state = "running";
    if (pending > 0) {
      try {
        await this.flush();
      } catch (error) {
        this.#logger.warn("Recovery drain failed; the durable facts remain pending", {
          code: safePipelineFailureCode(error),
        });
      }
    }
    if (this.#config.flushIntervalMs > 0) {
      this.#flushTimer = setInterval(() => {
        if (this.#state !== "running") return;
        void this.flush().catch((error) => {
          this.#logger.error("Delivery drain failed", {
            code: safePipelineFailureCode(error),
          });
        });
      }, this.#config.flushIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state !== "running") {
      throw new Error(`Pipeline.stop: illegal transition from state="${this.#state}"`);
    }
    this.#state = "stopped";
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    this.#flushTimer = undefined;
    await this.#activeFlush?.catch(() => undefined);
  }

  async flush(): Promise<void> {
    this.#assertRunning("flush");
    if (this.#activeFlush) return this.#activeFlush;
    this.#activeFlush = this.#drain().finally(() => {
      this.#activeFlush = undefined;
    });
    return this.#activeFlush;
  }

  stats(): AuthorityDeliveryStats {
    const items = this.#authority.snapshot();
    return {
      pending: items.filter((item) =>
        item.state === "queued" ||
        item.state === "retry-wait" ||
        item.state === "attempting" ||
        item.state === "uncertain",
      ).length,
      queued: items.filter((item) => item.state === "queued").length,
      attempting: items.filter((item) => item.state === "attempting").length,
      retrying: items.filter((item) => item.state === "retry-wait").length,
      uncertain: items.filter((item) => item.state === "uncertain").length,
      delivered: items.filter(
        (item) => item.state === "sent" || item.state === "verified-sent",
      ).length,
      failed: items.filter(
        (item) => item.state === "failed" || item.state === "abandoned",
      ).length,
    };
  }

  async #drain(): Promise<void> {
    await this.#queue.refresh();
    const ready = this.#queue.getReady(this.#now());
    ready.sort((left, right) => PRIORITY_ORDER[right.priority] - PRIORITY_ORDER[left.priority]);
    for (const item of ready) {
      try {
        await this.#process(item);
      } catch (error) {
        this.#logger.error("Unexpected delivery processing failure", {
          itemId: item.id,
          code: safePipelineFailureCode(error),
        });
      }
    }
    await this.#queue.refresh();
  }

  async #process(item: AuthorityDeliveryItem): Promise<void> {
    let transport: DeliveryEndpointTransport | undefined;
    try {
      transport = this.#transport.resolve(item.endpoint);
      if (transport) requireDeliveryEndpointTransport(transport, item.endpoint.kind);
    } catch {
      this.#logger.warn("Delivery transport readiness check failed", { itemId: item.id });
    }
    const startingAttempt = item.state === "queued" || item.state === "retry-wait";
    if (startingAttempt && !transport) return;

    let content: import("../channels/types.js").OutboundContent | undefined;
    let permanentContentFailure = false;
    if (startingAttempt) {
      try {
        content = await this.#materializeContent(item.content, this.#artifacts);
      } catch (error) {
        if (!isPermanentContentMaterializationError(error)) {
          this.#logger.warn("Delivery content is temporarily unavailable", { itemId: item.id });
          return;
        }
        permanentContentFailure = true;
      }
    }

    let outcomePolicy: ReturnType<DeliveryEndpointTransport["outcomePolicy"]> | undefined;
    if (startingAttempt && transport) {
      try {
        outcomePolicy = normalizeDeliveryOutcomePolicy(
          transport.outcomePolicy(item.endpoint),
        );
      } catch {
        this.#logger.warn("Delivery transport policy check failed", { itemId: item.id });
        return;
      }
    }
    if (permanentContentFailure) {
      const error = contentFailure();
      const result = await this.#authority.recordPreflightFailure({
        itemId: item.id,
        outcomePolicy: outcomePolicy!,
        error,
      });
      if (result.accepted) {
        await this.#eventBus.emit("delivery:failed", {
          itemId: item.id,
          endpoint: item.endpoint,
          error: error.message,
          attempts: result.attempt,
          statusRevision: result.statusRevision,
        });
        await this.#eventBus.emit("delivery:notice", { notice: result.notice });
      }
      return;
    }
    const claim = await this.#authority.claim({
      itemId: item.id,
      ...(outcomePolicy ? { outcomePolicy } : {}),
    });
    if (claim.kind === "skip") return;
    if (claim.kind === "uncertain") {
      const open = claim.item.openFact;
      if (!open) throw new Error("Uncertain delivery projection lacks its open fact");
      await this.#eventBus.emit("delivery:uncertain", {
        itemId: claim.item.id,
        endpoint: claim.item.endpoint,
        attempt: claim.item.currentAttempt,
        openFactDigest: open.openFactDigest,
        statusRevision: claim.item.statusRevision,
      });
      await this.#eventBus.emit("delivery:notice", { notice: claim.notice });
      return;
    }
    if (!transport) return;

    if (!content) {
      try {
        content = await this.#materializeContent(claim.item.content, this.#artifacts);
      } catch (error) {
        if (isPermanentContentMaterializationError(error) && !claim.redrive) {
          await this.#recordFailure(claim, contentFailure());
        } else {
          this.#logger.warn("Delivery content is unavailable for the current send", {
            itemId: claim.item.id,
          });
        }
        return;
      }
    }

    try {
      const result = normalizeDeliveryResult(
        await transport.send(claim.item.endpoint, content, {
          ...(claim.item.source ? { source: claim.item.source } : {}),
          itemId: claim.item.id,
          idempotencyKey: claim.item.idempotencyKey,
          attempt: claim.attempt,
        }),
      );
      if (result.success) {
        const receipt = result.receiptBytes
          ? {
              digest: byteDigest(result.receiptBytes),
              ...(result.messageId && claim.item.endpoint.kind === "channel"
                ? {
                    platformMessage: {
                      channelId: claim.item.endpoint.target.channelId,
                      messageId: result.messageId,
                      ...(claim.item.endpoint.target.threadId
                        ? { threadId: claim.item.endpoint.target.threadId }
                        : {}),
                    },
                  }
                : {}),
            }
          : undefined;
        const decision = await this.#authority.recordOutcome({
          itemId: claim.item.id,
          attempt: claim.attempt,
          responseBindingDigest: claim.responseBindingDigest,
          outcome: {
            kind: "sent",
            ...(receipt ? { receipt } : {}),
          },
        });
        if (decision.accepted) {
          await this.#eventBus.emit("delivery:success", {
            itemId: claim.item.id,
            endpoint: claim.item.endpoint,
            attempts: claim.attempt,
          });
          if (decision.notice) {
            await this.#eventBus.emit("delivery:notice", { notice: decision.notice });
          }
        }
        return;
      }
      await this.#recordFailure(claim, {
        code: "transport-rejected",
        message: "Delivery transport rejected the request",
        retryable: result.retryable === true,
      });
    } catch {
      this.#logger.warn("Delivery transport outcome is unknown; recovery policy will decide", {
        itemId: claim.item.id,
        attempt: claim.attempt,
      });
    }
  }

  async #recordFailure(
    claim: import("./authority.js").DeliveryAttemptClaim,
    error: DeliveryFailure,
  ): Promise<void> {
    const decision = await this.#authority.recordOutcome({
      itemId: claim.item.id,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: { kind: "failed", error },
      ...(error.retryable ? { retryDelayMs: this.#config.baseRetryDelayMs } : {}),
    });
    if (!decision.accepted) return;
    if (decision.retryAt) {
      await this.#eventBus.emit("delivery:retry", {
        itemId: claim.item.id,
        endpoint: claim.item.endpoint,
        attempt: claim.attempt,
        nextAttemptAt: decision.retryAt,
      });
    } else {
      await this.#eventBus.emit("delivery:failed", {
        itemId: claim.item.id,
        endpoint: claim.item.endpoint,
        error: error.message,
        attempts: claim.attempt,
        statusRevision: decision.statusRevision,
      });
    }
    if (decision.notice) {
      await this.#eventBus.emit("delivery:notice", { notice: decision.notice });
    }
  }

  #assertRunning(operation: string): void {
    if (this.#state !== "running") {
      throw new Error(`Pipeline.${operation}: pipeline not running (state="${this.#state}")`);
    }
  }
}

export function channelAuthorityDeliveryTransport(sender: DeliverySender): DeliveryEndpointTransport {
  return {
    endpointKind: "channel",
    isReady(endpoint: DeliveryEndpointDto): boolean {
      return endpoint.kind === "channel" && sender.isReady(endpoint.target.channelId);
    },
    outcomePolicy(): { readonly kind: "manual-resolution" } {
      return { kind: "manual-resolution" };
    },
    async send(endpoint, content, meta) {
      if (endpoint.kind !== "channel") {
        throw new TypeError("Channel delivery transport received another endpoint kind");
      }
      const result = normalizeDeliveryResult(
        await sender.send(endpoint.target, content, meta),
      );
      if (result.success && result.receiptBytes === undefined && result.messageId) {
        return { ...result, receiptBytes: Buffer.from(result.messageId, "utf8") };
      }
      return result;
    },
  };
}

function singleDeliveryTransport(
  transport: DeliveryEndpointTransport,
): DeliveryTransport {
  return {
    resolve(endpoint) {
      return endpoint.kind === transport.endpointKind &&
        requireDeliveryReadiness(transport.isReady(endpoint))
        ? transport
        : undefined;
    },
  };
}

async function defaultMaterializeContent(
  content: AuthorityDeliveryItem["content"],
  artifacts: ArtifactStore,
): Promise<import("../channels/types.js").OutboundContent> {
  if ("ref" in content) {
    const bytes = await artifacts.get(content.ref);
    const text = Buffer.from(bytes).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    validateOutboundContentDto(parsed);
    if (canonicalize(parsed) !== text) {
      throw new TypeError("Referenced delivery content is not canonical JSON");
    }
    return materializeOutboundContent(parsed, artifacts);
  }
  validateOutboundContentDto(content);
  return materializeOutboundContent(content, artifacts);
}

async function materializeOutboundContent(
  content: import("../channels/types.js").OutboundContentDto,
  artifacts: ArtifactStore,
): Promise<import("../channels/types.js").OutboundContent> {
  const media = content.media
    ? await Promise.all(
        content.media.map(async (item) => {
          const bytes = await artifacts.get(item.ref);
          return {
            type: item.type,
            url: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`,
          };
        }),
      )
    : undefined;
  return {
    text: content.text,
    ...(content.markdown !== undefined ? { markdown: content.markdown } : {}),
    ...(media ? { media } : {}),
  };
}

function assertNonNegativeMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertTimerIntervalMs(value: number): void {
  assertNonNegativeMs(value, "Delivery flush interval");
  if (value > MAX_TIMER_INTERVAL_MS) {
    throw new TypeError(
      `Delivery flush interval must not exceed ${MAX_TIMER_INTERVAL_MS}ms`,
    );
  }
}

function isPermanentContentMaterializationError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    (error instanceof AuthorityStorageError &&
      (error.code === "artifact-missing" || error.code === "artifact-corrupt"))
  );
}

function contentFailure(): DeliveryFailure {
  return {
    code: "content-invalid",
    message: "Delivery content could not be materialized",
    retryable: false,
  };
}

function safePipelineFailureCode(error: unknown): string {
  return error instanceof AuthorityStorageError ? error.code : "delivery-internal";
}

function noopLogger(): AuthorityDeliveryLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}
