import type {
  ConversationStatusNotice,
  DeliveryStatusNotice,
  ExecutionStatusNotice,
  FinalFrame,
  JobStatusNotice,
  SealedBundle,
  StreamFrame,
} from "../contracts/index.js";
import { canonicalize } from "./canonical.js";
import { validateSealedBundle } from "./commit.js";
import { assertStreamFinalReconciliation, validateStreamFrame } from "./stream.js";

type ConversationRef = Extract<
  ConversationStatusNotice["ref"],
  { readonly execution: "conversation" }
>;
type JobRef = Extract<
  JobStatusNotice["ref"],
  { readonly execution: "job" }
>;

export type ExecutionProjectionSubject =
  | ConversationRef
  | JobRef
  | DeliveryStatusNotice["ref"];

export interface ExecutionFinalityProjectionOptions {
  readonly afterStatusRevision?: ReadonlyMap<string, number>;
  readonly onStatus?: (notice: ExecutionStatusNotice) => void | Promise<void>;
  readonly onConversationFinal?: (frame: FinalFrame) => void | Promise<void>;
  readonly onJobResult?: (input: {
    readonly ref: JobRef;
    readonly itemId: string;
    readonly statusRevision: number;
  }) => void | Promise<void>;
}

/**
 * Merges the three independent status clocks and the conversation stream/final
 * pair without creating a second authority source.
 */
export class ExecutionFinalityProjection {
  readonly #revisions = new Map<string, number>();
  readonly #pendingStatuses = new Map<
    string,
    Map<number, ExecutionStatusNotice>
  >();
  readonly #provisionalFinals = new Map<string, StreamFrame>();
  readonly #pendingConversationFinals = new Map<
    string,
    { readonly frame: FinalFrame; readonly bundle: SealedBundle }
  >();
  readonly #confirmedFinals = new Map<string, string>();
  readonly #jobResults = new Map<
    string,
    { itemId: string; statusRevision: number }
  >();
  readonly #onStatus: ExecutionFinalityProjectionOptions["onStatus"];
  readonly #onConversationFinal:
    ExecutionFinalityProjectionOptions["onConversationFinal"];
  readonly #onJobResult: ExecutionFinalityProjectionOptions["onJobResult"];

  constructor(options: ExecutionFinalityProjectionOptions = {}) {
    for (const [key, revision] of options.afterStatusRevision ?? []) {
      assertRevision(revision, "Last-seen status revision", true);
      this.#revisions.set(key, revision);
    }
    this.#onStatus = options.onStatus;
    this.#onConversationFinal = options.onConversationFinal;
    this.#onJobResult = options.onJobResult;
  }

  static subjectKey(subject: ExecutionProjectionSubject): string {
    switch (subject.execution) {
      case "conversation":
        return `conversation:${subject.conversationId}:${subject.runId}`;
      case "job":
        return `job:${subject.taskId}:${subject.jobRunId}`;
      case "delivery":
        return `delivery:${subject.itemId}`;
    }
  }

  statusRevision(subject: ExecutionProjectionSubject): number {
    return this.#revisions.get(ExecutionFinalityProjection.subjectKey(subject)) ?? 0;
  }

  async acceptStatus(
    notice: ExecutionStatusNotice,
  ): Promise<"accepted" | "buffered" | "duplicate"> {
    const key = ExecutionFinalityProjection.subjectKey(notice.ref);
    const current = this.#revisions.get(key) ?? 0;
    assertRevision(notice.statusRevision, "Execution status revision");
    if (notice.statusRevision <= current) return "duplicate";

    let pending = this.#pendingStatuses.get(key);
    if (!pending) {
      pending = new Map();
      this.#pendingStatuses.set(key, pending);
    }
    const existing = pending.get(notice.statusRevision);
    if (existing) {
      if (canonicalize(existing) !== canonicalize(notice)) {
        throw new TypeError("Execution status revision has conflicting notices");
      }
      return "duplicate";
    }
    pending.set(notice.statusRevision, structuredClone(notice));
    if (notice.statusRevision !== current + 1) return "buffered";

    let next = current + 1;
    while (pending.has(next)) {
      const accepted = pending.get(next)!;
      pending.delete(next);
      this.#revisions.set(key, next);
      await this.#onStatus?.(structuredClone(accepted));
      next += 1;
    }
    if (pending.size === 0) this.#pendingStatuses.delete(key);
    return "accepted";
  }

  async acceptProvisionalFinal(
    frameInput: StreamFrame,
  ): Promise<"accepted" | "duplicate"> {
    const frame = validateStreamFrame(frameInput);
    if (
      frame.ref.execution !== "conversation" ||
      frame.payload.kind !== "provisional-final"
    ) {
      throw new TypeError(
        "Conversation finality projection requires a provisional conversation final",
      );
    }
    const key = conversationKey(frame.ref.conversationId, frame.ref.runId);
    const existing = this.#provisionalFinals.get(key);
    if (existing) {
      if (canonicalize(existing) !== canonicalize(frame)) {
        throw new TypeError("Conversation provisional final changed for one run");
      }
      return "duplicate";
    }
    this.#provisionalFinals.set(key, structuredClone(frame));
    const pending = this.#pendingConversationFinals.get(key);
    if (pending) {
      this.#pendingConversationFinals.delete(key);
      await this.#commitConversationFinal(key, frame, pending);
    }
    return "accepted";
  }

  async confirmConversationFinal(input: {
    readonly frame: FinalFrame;
    readonly bundle: SealedBundle;
  }): Promise<"accepted" | "buffered" | "duplicate"> {
    const bundle = validateSealedBundle(input.bundle);
    const frame = structuredClone(input.frame);
    if (
      bundle.body.t !== "conversation" ||
      frame.conversationId !== bundle.body.conversationId ||
      frame.runId !== bundle.body.runId ||
      frame.digest !== bundle.digest
    ) {
      throw new TypeError("Committed final does not bind the sealed conversation bundle");
    }
    const key = conversationKey(frame.conversationId, frame.runId);
    const identity = canonicalize(frame);
    const confirmed = this.#confirmedFinals.get(key);
    if (confirmed !== undefined) {
      if (confirmed !== identity) {
        throw new TypeError("Conversation run has conflicting committed finals");
      }
      return "duplicate";
    }
    const provisional = this.#provisionalFinals.get(key);
    if (!provisional) {
      const pending = this.#pendingConversationFinals.get(key);
      if (pending) {
        if (
          canonicalize(pending.frame) !== identity ||
          canonicalize(pending.bundle) !== canonicalize(bundle)
        ) {
          throw new TypeError("Conversation run has conflicting committed finals");
        }
        return "duplicate";
      }
      this.#pendingConversationFinals.set(key, {
        frame,
        bundle: structuredClone(bundle),
      });
      return "buffered";
    }
    await this.#commitConversationFinal(key, provisional, { frame, bundle });
    return "accepted";
  }

  async acceptJobResult(input: {
    readonly ref: JobRef;
    readonly itemId: string;
    readonly statusRevision: number;
  }): Promise<"accepted" | "duplicate"> {
    if (input.ref.execution !== "job" || input.itemId.length === 0) {
      throw new TypeError("Job result delivery identity is invalid");
    }
    assertRevision(input.statusRevision, "Job result delivery revision");
    const key = ExecutionFinalityProjection.subjectKey(input.ref);
    const existing = this.#jobResults.get(key);
    if (existing) {
      if (
        existing.itemId !== input.itemId ||
        existing.statusRevision !== input.statusRevision
      ) {
        throw new TypeError("Job run has conflicting committed result deliveries");
      }
      return "duplicate";
    }
    this.#jobResults.set(key, {
      itemId: input.itemId,
      statusRevision: input.statusRevision,
    });
    await this.#onJobResult?.({
      ref: structuredClone(input.ref),
      itemId: input.itemId,
      statusRevision: input.statusRevision,
    });
    return "accepted";
  }

  isConversationFinalConfirmed(conversationId: string, runId: string): boolean {
    return this.#confirmedFinals.has(conversationKey(conversationId, runId));
  }

  async #commitConversationFinal(
    key: string,
    provisional: StreamFrame,
    input: {
      readonly frame: FinalFrame;
      readonly bundle: SealedBundle;
    },
  ): Promise<void> {
    assertStreamFinalReconciliation(provisional, input.bundle.streamFinal);
    const identity = canonicalize(input.frame);
    const existing = this.#confirmedFinals.get(key);
    if (existing !== undefined) {
      if (existing !== identity) {
        throw new TypeError("Conversation run has conflicting committed finals");
      }
      return;
    }
    this.#confirmedFinals.set(key, identity);
    await this.#onConversationFinal?.(structuredClone(input.frame));
  }
}

function conversationKey(conversationId: string, runId: string): string {
  return `${conversationId}\u0000${runId}`;
}

function assertRevision(
  value: number,
  label: string,
  allowZero = false,
): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${label} is invalid`);
  }
}
