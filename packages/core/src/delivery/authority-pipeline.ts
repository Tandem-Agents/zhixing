import {
  AuthorityStorageError,
  type ArtifactStore,
} from "../authority/index.js";
import type { DeliveryFailure } from "../contracts/index.js";
import type { IEventBus } from "../events/index.js";
import { byteDigest, canonicalize } from "../protocol/index.js";
import { validateOutboundContentDto } from "./content-schema.js";
import { AuthorityDeliveryQueue } from "./authority-queue.js";
import type {
  DeliveryAttemptClaim,
  DeliveryLifecycleApplication,
  DeliveryLifecycleEffectPort,
  DeliveryLifecycleProjectionPort,
} from "./application.js";
import { decideDeliveryAttemptOutcomePolicy } from "./application.js";
import type {
  AuthorityDeliveryEventMap,
  AuthorityDeliveryItem,
  AuthorityDeliveryStats,
  AuthorityDeliveryLogger,
  DeliveryTransport,
  DeliveryEndpointTransport,
  DeliveryStatusProjectionPort,
} from "./types.js";
import {
  normalizeDeliveryResponseLossEvidence,
  normalizeDeliveryResult,
  requireDeliveryEndpointTransport,
} from "./transport-contract.js";

export interface AuthorityDeliveryPipelineConfig {
  readonly flushIntervalMs: number;
}

export const DEFAULT_AUTHORITY_DELIVERY_CONFIG: AuthorityDeliveryPipelineConfig = {
  flushIntervalMs: 30_000,
};

export interface AuthorityDeliveryPipelineDeps {
  readonly application: DeliveryLifecycleApplication;
  readonly projection: DeliveryLifecycleProjectionPort & DeliveryStatusProjectionPort;
  readonly artifacts: ArtifactStore;
  readonly eventBus: IEventBus<AuthorityDeliveryEventMap>;
  readonly config: AuthorityDeliveryPipelineConfig;
  readonly transport: DeliveryTransport;
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

type PipelineState = "unstarted" | "prepared" | "running" | "quiesced" | "stopped";

/** Drains authority facts; it cannot create, delete, or rewrite delivery items. */
export class AuthorityDeliveryPipeline implements DeliveryLifecycleEffectPort {
  readonly #application: DeliveryLifecycleApplication;
  readonly #projection: DeliveryLifecycleProjectionPort & DeliveryStatusProjectionPort;
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
    assertTimerIntervalMs(deps.config.flushIntervalMs);
    this.#application = deps.application;
    this.#projection = deps.projection;
    this.#artifacts = deps.artifacts;
    this.#queue = new AuthorityDeliveryQueue({ source: deps.projection });
    this.#transport = deps.transport;
    this.#eventBus = deps.eventBus;
    this.#config = deps.config;
    this.#now = deps.now ?? (() => new Date());
    this.#logger = deps.logger ?? noopLogger();
    this.#materializeContent = deps.materializeContent ?? defaultMaterializeContent;
  }

  async start(): Promise<void> {
    await this.prepare();
    this.activate();
    await this.#activeFlush;
  }

  async prepare(): Promise<void> {
    if (this.#state !== "unstarted") {
      throw new Error(`Pipeline.prepare: illegal transition from state="${this.#state}"`);
    }
    await this.#queue.load();
    this.#state = "prepared";
  }

  activate(): void {
    if (this.#state !== "prepared") {
      throw new Error(`Pipeline.activate: illegal transition from state="${this.#state}"`);
    }
    this.#state = "running";
    void this.flush().catch((error) => {
      this.#logger.warn("Recovery drain failed; the durable facts remain pending", {
        code: safePipelineFailureCode(error),
      });
    });
    this.#startFlushTimer();
  }

  /** Effect only: stop new transport attempts without deciding lifecycle policy. */
  closeAdmission(): void {
    if (this.#state === "quiesced") return;
    if (this.#state !== "running") {
      throw new Error(`Pipeline.closeAdmission: illegal transition from state="${this.#state}"`);
    }
    this.#state = "quiesced";
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  async quiesceForAuthorityTransfer(): Promise<void> {
    if (this.#state === "quiesced") {
      await this.#activeFlush?.catch(() => undefined);
      return;
    }
    if (this.#state !== "running") {
      throw new Error(`Pipeline.quiesceForAuthorityTransfer: illegal transition from state="${this.#state}"`);
    }
    this.closeAdmission();
    await this.waitForQuiescedEffects();
  }

  async waitForQuiescedEffects(): Promise<void> {
    if (this.#state === "running") this.closeAdmission();
    if (this.#state !== "quiesced") {
      throw new Error(
        `Pipeline.waitForQuiescedEffects: illegal transition from state="${this.#state}"`,
      );
    }
    await this.#activeFlush?.catch(() => undefined);
  }

  async flushQuiescedOnce(): Promise<void> {
    if (this.#state !== "quiesced") {
      throw new Error(
        `Pipeline.flushQuiescedOnce: illegal transition from state="${this.#state}"`,
      );
    }
    this.#state = "running";
    try {
      await this.flush();
    } finally {
      this.#state = "quiesced";
      if (this.#flushTimer) clearInterval(this.#flushTimer);
      this.#flushTimer = undefined;
    }
  }

  async resumeAfterAuthorityTransfer(): Promise<void> {
    await this.resume();
  }

  async resume(): Promise<void> {
    if (this.#state === "running") return;
    if (this.#state !== "quiesced") {
      throw new Error(`Pipeline.resume: illegal transition from state="${this.#state}"`);
    }
    this.#state = "running";
    this.#startFlushTimer();
    await this.flush();
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    if (
      this.#state !== "running" &&
      this.#state !== "prepared" &&
      this.#state !== "quiesced"
    ) {
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
    const items = this.#projection.snapshot();
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

  #startFlushTimer(): void {
    if (this.#config.flushIntervalMs <= 0 || this.#flushTimer) return;
    this.#flushTimer = setInterval(() => {
      if (this.#state !== "running") return;
      void this.flush().catch((error) => {
        this.#logger.error("Delivery drain failed", {
          code: safePipelineFailureCode(error),
        });
      });
    }, this.#config.flushIntervalMs);
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

    let outcomePolicy: Parameters<DeliveryLifecycleApplication["claim"]>[0]["outcomePolicy"];
    if (startingAttempt && transport) {
      try {
        outcomePolicy = decideDeliveryAttemptOutcomePolicy(
          normalizeDeliveryResponseLossEvidence(
            transport.responseLossEvidence(item.endpoint),
          ),
        );
      } catch {
        this.#logger.warn("Delivery response-loss evidence check failed", { itemId: item.id });
        return;
      }
    }
    if (permanentContentFailure) {
      const error = contentFailure();
      const result = await this.#application.recordPreflightFailure({
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
        await this.#emitStatusNotice(item.id, result.statusRevision);
      }
      return;
    }
    const claim = await this.#application.claim({
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
      await this.#emitStatusNotice(claim.item.id, claim.item.statusRevision);
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
        const receiptBytes = result.receiptBytes ??
          (result.messageId ? Buffer.from(result.messageId, "utf8") : undefined);
        const receipt = receiptBytes
          ? {
              digest: byteDigest(receiptBytes),
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
        const decision = await this.#application.recordOutcome({
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
          await this.#emitStatusNotice(claim.item.id, decision.statusRevision, true);
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
    claim: DeliveryAttemptClaim,
    error: DeliveryFailure,
  ): Promise<void> {
    const decision = await this.#application.recordOutcome({
      itemId: claim.item.id,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: { kind: "failed", error },
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
    await this.#emitStatusNotice(
      claim.item.id,
      decision.statusRevision,
      decision.retryAt !== undefined,
    );
  }

  async #emitStatusNotice(
    itemId: string,
    statusRevision: number,
    optional = false,
  ): Promise<void> {
    const notice = await this.#projection.statusNotice(itemId, statusRevision);
    if (!notice) {
      if (optional) return;
      throw new Error("Committed delivery transition has no status notice");
    }
    await this.#eventBus.emit("delivery:notice", { notice });
  }

  #assertRunning(operation: string): void {
    if (this.#state !== "running") {
      throw new Error(`Pipeline.${operation}: pipeline not running (state="${this.#state}")`);
    }
  }
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
