import { canonicalize } from "@zhixing/core/protocol";
import type { PublishResultNotice, WorksceneAppliedResult } from "@zhixing/core/contracts";
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
      (params) => this.#handle(params as SessionEventEnvelope),
    );
  }

  #handle(envelope: SessionEventEnvelope): void {
    if (
      this.#disposed ||
      envelope.scope !== "control" ||
      envelope.event !== "publish:result" ||
      (this.options.filter && !this.options.filter(envelope)) ||
      !isPublishResultNotice(envelope.payload)
    ) {
      return;
    }
    const notice = envelope.payload;
    const identity = canonicalize({
      assignmentId: notice.assignmentId,
      seq: notice.seq,
      decision: notice.decision,
    });
    if (this.#seen.has(identity)) return;
    this.#seen.set(identity, true);
    if (this.#seen.size > MAX_SEEN_RESULTS) {
      this.#seen.delete(this.#seen.keys().next().value!);
    }
    this.options.flushOutput?.();
    this.options.writer.ensureSegmentBreak();
    this.options.writer.line(renderPublishResult(notice));
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

function renderPublishResult(notice: PublishResultNotice): string {
  if (notice.decision.t === "conflicted") {
    return `这次未能保存“${mutationLabel(notice.mutation.kind)}”：${notice.decision.error.message}。请检查当前内容后重试，或放弃这项修改。`;
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

function mutationLabel(kind: PublishResultNotice["mutation"]["kind"]): string {
  if (kind.startsWith("workscene-")) return "场景修改";
  if (kind.startsWith("memory-")) return "记忆修改";
  if (kind.startsWith("skill-")) return "技能修改";
  if (kind.startsWith("schedule-")) return "定时任务修改";
  return "本轮修改";
}

function isPublishResultNotice(value: unknown): value is PublishResultNotice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const notice = value as Partial<PublishResultNotice>;
  return typeof notice.conversationId === "string" &&
    typeof notice.runId === "string" &&
    typeof notice.assignmentId === "string" &&
    Number.isSafeInteger(notice.commitRevision) &&
    Number.isSafeInteger(notice.seq) &&
    !!notice.mutation &&
    typeof notice.mutation === "object" &&
    !!notice.decision &&
    typeof notice.decision === "object" &&
    (notice.decision.t === "conflicted" || notice.decision.t === "granted");
}
