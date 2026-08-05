import type { SchedulerUserNotice } from "@zhixing/core/contracts";
import type { CliWriter } from "../screen/index.js";
import type { CoreHostLink } from "./core-host-connection.js";

const MAX_SEEN_REVISIONS = 1_024;

export interface JournalMaintenancePresenterOptions {
  readonly link: CoreHostLink;
  readonly writer: Pick<CliWriter, "ensureSegmentBreak" | "line">;
  readonly flushOutput?: () => void;
}

/** Presents only the durable scheduler notice; retry state is never inferred locally. */
export class JournalMaintenancePresenter {
  readonly #seen = new Set<number>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(private readonly options: JournalMaintenancePresenterOptions) {
    this.#unsubscribe = options.link.onNotification(
      "scheduler.notice",
      (candidate) => this.#handle(candidate),
    );
  }

  #handle(candidate: unknown): void {
    if (this.#disposed || !isJournalMaintenanceNotice(candidate)) return;
    if (this.#seen.has(candidate.revision)) return;
    this.#seen.add(candidate.revision);
    if (this.#seen.size > MAX_SEEN_REVISIONS) {
      this.#seen.delete(this.#seen.values().next().value!);
    }
    this.options.flushOutput?.();
    this.options.writer.ensureSegmentBreak();
    this.options.writer.line(`日志凝练：${candidate.reason}`);
    for (const action of candidate.actions) this.options.writer.line(`  ${action}`);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#seen.clear();
  }
}

export function createJournalMaintenancePresenter(
  options: JournalMaintenancePresenterOptions,
): JournalMaintenancePresenter {
  return new JournalMaintenancePresenter(options);
}

function isJournalMaintenanceNotice(
  value: unknown,
): value is SchedulerUserNotice & {
  readonly kind: "journal-maintenance";
  readonly ref: Extract<
    SchedulerUserNotice["ref"],
    { readonly kind: "journal-maintenance" }
  >;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const notice = value as Partial<SchedulerUserNotice>;
  return notice.kind === "journal-maintenance" &&
    notice.ref?.kind === "journal-maintenance" &&
    typeof notice.noticeId === "string" && notice.noticeId.length > 0 &&
    Number.isSafeInteger(notice.revision) && (notice.revision as number) > 0 &&
    ["prepared", "open", "updated", "closed"].includes(notice.state ?? "") &&
    typeof notice.reason === "string" && notice.reason.length > 0 &&
    Array.isArray(notice.actions) &&
    notice.actions.every((action) => typeof action === "string") &&
    Number.isSafeInteger(notice.ref.attempt) && notice.ref.attempt >= 0 &&
    Number.isSafeInteger(notice.ref.completed) && notice.ref.completed >= 0 &&
    Number.isSafeInteger(notice.ref.monthCount) && notice.ref.monthCount > 0 &&
    notice.ref.completed <= notice.ref.monthCount;
}
