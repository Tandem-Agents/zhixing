import { describe, expect, it, vi } from "vitest";
import { createJournalMaintenancePresenter } from "../journal-maintenance-presenter.js";

describe("JournalMaintenancePresenter", () => {
  it("presents each durable revision once and ignores unrelated notices", () => {
    let listener: ((value: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const line = vi.fn();
    const presenter = createJournalMaintenancePresenter({
      link: {
        onNotification: vi.fn((method: string, next: (value: unknown) => void) => {
          expect(method).toBe("scheduler.notice");
          listener = next;
          return unsubscribe;
        }),
      } as never,
      writer: { ensureSegmentBreak: vi.fn(), line },
    });
    const notice = {
      noticeId: "journal-maintenance:plan",
      revision: 7,
      kind: "journal-maintenance",
      state: "open",
      ref: {
        kind: "journal-maintenance",
        planDigest: `sha256:${"1".repeat(64)}`,
        monthCount: 1,
        fileCount: 2,
        attempt: 1,
        completed: 0,
      },
      reason: "正在凝练 2026-06 的日志（1/1）。",
      actions: ["系统会在失败后按同一计划重试"],
      at: "2026-08-05T00:00:00.000Z",
    };

    listener?.(notice);
    listener?.(notice);
    listener?.({ ...notice, revision: 8, kind: "missed-summary" });

    expect(line).toHaveBeenCalledTimes(2);
    expect(line).toHaveBeenNthCalledWith(1, `日志凝练：${notice.reason}`);
    presenter.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
