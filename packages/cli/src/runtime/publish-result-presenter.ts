import {
  canonicalize,
  isProtocolIdentifier,
  validatePublishResultNotice,
} from "@zhixing/core/protocol";
import type { PublishResultNotice, WorksceneAppliedResult } from "@zhixing/core/contracts";
import { publishConflictProductCopy } from "@zhixing/owner-kernel";
import { SESSION_NOTIFICATIONS, type SessionEventEnvelope } from "@zhixing/rpc";
import type { CliWriter } from "../screen/index.js";
import type { CoreHostLink } from "./core-host-connection.js";

const MAX_SEEN_RESULTS = 1_024;

export interface PublishResultPresenterOptions {
  readonly link: CoreHostLink;
  readonly writer: Pick<CliWriter, "ensureSegmentBreak" | "line">;
  readonly filter?: (envelope: SessionEventEnvelope) => boolean;
  readonly flushOutput?: () => void;
}

/** Presents the durable owner result; it never reconstructs revisions or identities. */
export class PublishResultPresenter {
  readonly #seen = new Map<string, true>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(private readonly options: PublishResultPresenterOptions) {
    this.#unsubscribe = options.link.onNotification(
      SESSION_NOTIFICATIONS.event,
      (params) => this.#handle(params),
    );
  }

  #handle(candidate: unknown): void {
    if (
      this.#disposed ||
      !isRecord(candidate) ||
      candidate.scope !== "control" ||
      candidate.event !== "publish:result"
    ) {
      return;
    }
    const envelope = candidate as unknown as SessionEventEnvelope;
    if (
      isProtocolIdentifier(envelope.conversationId) &&
      this.options.filter &&
      !this.options.filter(envelope)
    ) {
      return;
    }
    let notice: PublishResultNotice;
    try {
      const identity = validatePublishResultEnvelope(envelope);
      notice = validatePublishResultNotice(envelope.payload);
      if (
        notice.conversationId !== identity.conversationId ||
        notice.runId !== identity.runId ||
        notice.seq !== identity.seq
      ) {
        throw new TypeError("Publish result does not bind its control envelope");
      }
    } catch {
      this.#presentOnce(
        invalidNoticeIdentity(envelope),
        "这次修改结果无法安全确认。请重新进入当前会话，或查询当前状态后再继续。",
      );
      return;
    }
    const identity = canonicalize({
      conversationId: notice.conversationId,
      runId: notice.runId,
      assignmentId: notice.assignmentId,
      seq: notice.seq,
      decision: notice.decision,
    });
    this.#presentOnce(identity, renderPublishResult(notice));
  }

  #presentOnce(identity: string, message: string): void {
    if (this.#seen.has(identity)) return;
    this.#seen.set(identity, true);
    if (this.#seen.size > MAX_SEEN_RESULTS) {
      this.#seen.delete(this.#seen.keys().next().value!);
    }
    this.options.flushOutput?.();
    this.options.writer.ensureSegmentBreak();
    this.options.writer.line(message);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#seen.clear();
  }
}

export function createPublishResultPresenter(
  options: PublishResultPresenterOptions,
): PublishResultPresenter {
  return new PublishResultPresenter(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderPublishResult(notice: PublishResultNotice): string {
  if (notice.decision.t === "conflicted") {
    const copy = publishConflictProductCopy(
      notice.mutation.kind,
      notice.decision.error.code,
    );
    return `这次未能完成“${copy.mutationLabel}”：${copy.reason}。${copy.actions.join("，")}。`;
  }
  return renderWorksceneResult(notice.decision.appliedResult);
}

function renderWorksceneResult(result: WorksceneAppliedResult): string {
  if (result.kind === "workscene-deleted") return "场景已删除。";
  switch (result.operation) {
    case "create":
      return `场景「${result.scene.name}」已创建。`;
    case "rename":
      return `场景已重命名为「${result.scene.name}」。`;
    case "set-workdir":
      return result.scene.workspace
        ? `场景「${result.scene.name}」的工作目录已更新。`
        : `场景「${result.scene.name}」已解除工作目录。`;
  }
}

function validatePublishResultEnvelope(envelope: SessionEventEnvelope): {
  readonly conversationId: string;
  readonly runId: string;
  readonly seq: number;
} {
  const expectedKeys = [
    "conversationId",
    "event",
    "meta",
    "payload",
    "runId",
    "scope",
    "seq",
    ...(Object.prototype.hasOwnProperty.call(envelope, "lifecycle")
      ? ["lifecycle"]
      : []),
  ].sort();
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(",") !== expectedKeys.join(",") ||
    envelope.scope !== "control" ||
    envelope.event !== "publish:result" ||
    (envelope.lifecycle !== undefined && envelope.lifecycle !== "event") ||
    !isProtocolIdentifier(envelope.conversationId) ||
    !isProtocolIdentifier(envelope.runId) ||
    !Number.isSafeInteger(envelope.seq) ||
    envelope.seq <= 0
  ) {
    throw new TypeError("Publish result control envelope is invalid");
  }
  if (
    typeof envelope.meta !== "object" ||
    envelope.meta === null ||
    Array.isArray(envelope.meta) ||
    Object.keys(envelope.meta).some((key) => key !== "lineage" && key !== "turnOrigin") ||
    (envelope.meta.lineage !== undefined && typeof envelope.meta.lineage !== "string") ||
    (envelope.meta.turnOrigin !== undefined && typeof envelope.meta.turnOrigin !== "string")
  ) {
    throw new TypeError("Publish result control envelope metadata is invalid");
  }
  return {
    conversationId: envelope.conversationId,
    runId: envelope.runId,
    seq: envelope.seq,
  };
}

function invalidNoticeIdentity(envelope: SessionEventEnvelope): string {
  const conversationId = isProtocolIdentifier(envelope.conversationId)
    ? envelope.conversationId
    : "fallback";
  const runId = isProtocolIdentifier(envelope.runId) ? envelope.runId : "fallback";
  const seq = Number.isSafeInteger(envelope.seq) && envelope.seq > 0
    ? envelope.seq
    : 0;
  return `invalid-publish-result:${conversationId}:${runId}:${seq}`;
}
