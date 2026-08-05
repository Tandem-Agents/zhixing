import { describe, expect, it, vi } from "vitest";
import type {
  GlobalControlMutation,
  GlobalStatePort,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type {
  JournalMaintenanceNoticeState,
  SchedulerNoticeDraft,
} from "@zhixing/owner-kernel";
import { createAnchorJournalMaintenance } from "./journal-maintenance.js";
import path from "node:path";
import { DeliveryAuthority } from "@zhixing/core";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { OwnerDeliveryParticipant, SchedulerUserNoticeJournal } from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

describe("createAnchorJournalMaintenance", () => {
  it("emits no notice and makes no paid call when no maintenance is planned", async () => {
    const state = {
      read: vi.fn(async () => ({ kind: "memory-list" as const, entries: [] })),
      mutate: vi.fn(),
    };
    const noticeHarness = createNoticeHarness();
    const callText = vi.fn();
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    maintenance.bind({ notices: noticeHarness.notices, callText });

    await maintenance.start();
    await maintenance.stop();

    expect(noticeHarness.drafts).toEqual([]);
    expect(callText).not.toHaveBeenCalled();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("deletes blank daily and monthly facts without a paid call or notice", async () => {
    const mutations: GlobalControlMutation[] = [];
    const state = {
      read: vi.fn(async () => ({
        kind: "memory-list" as const,
        entries: [
          journal("2026-06-01", " \n\t ", digest("1")),
          journal("2026-06", "", digest("2"), true),
        ],
      })),
      mutate: vi.fn(async (mutation: GlobalControlMutation) => {
        mutations.push(structuredClone(mutation));
        return { revision: 1 };
      }),
    };
    const noticeHarness = createNoticeHarness();
    const callText = vi.fn();
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    maintenance.bind({ notices: noticeHarness.notices, callText });

    await maintenance.start();
    await maintenance.stop();

    expect(callText).not.toHaveBeenCalled();
    expect(noticeHarness.drafts).toEqual([]);
    expect(mutations).toMatchObject([
      { kind: "memory-delete", domain: "journal", id: "2026-06" },
      { kind: "memory-delete", domain: "journal", id: "2026-06-01" },
    ]);
  });

  it("keeps source journals retryable when a paid summary is blank", async () => {
    const entries = [
      journal("2026-06-01", "first", digest("1")),
      journal("2026-06-02", "second", digest("2")),
    ];
    const state = {
      read: vi.fn(async () => ({ kind: "memory-list" as const, entries })),
      mutate: vi.fn(async (mutation: GlobalControlMutation) => {
        if (
          mutation.kind === "memory-journal-condense" &&
          mutation.summary.trim().length === 0
        ) {
          throw new TypeError("Journal content must contain non-whitespace text");
        }
        return { revision: 1 };
      }),
    };
    const noticeHarness = createNoticeHarness();
    const failure = vi.fn();
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
      onError: failure,
    });
    maintenance.bind({
      notices: noticeHarness.notices,
      callText: vi.fn(async () => " \n\t "),
    });

    await maintenance.start();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    await maintenance.stop();

    expect(state.mutate).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(2);
    expect(noticeHarness.drafts.at(-1)).toMatchObject({
      state: "updated",
      ref: { completed: 0 },
    });
    expect(noticeHarness.drafts.some((draft) => draft.state === "closed")).toBe(false);
  });

  it("persists paid-call intent before invoking the model and shares one lifecycle run", async () => {
    const mutations: GlobalControlMutation[] = [];
    const state = {
      read: vi.fn(async () => ({
        kind: "memory-list" as const,
        entries: [
          journal("2026-06-01", "first", digest("1")),
          journal("2026-06-02", "second", digest("2")),
          journal("2024-01", "old summary", digest("3"), true),
        ],
      })),
      mutate: vi.fn(async (mutation: GlobalControlMutation) => {
        mutations.push(structuredClone(mutation));
        return { revision: 1 };
      }),
    };
    const noticeHarness = createNoticeHarness();
    const callText = vi.fn(async () => {
      expect(noticeHarness.drafts.map((draft) => draft.state)).toEqual([
        "prepared",
        "open",
      ]);
      return "monthly summary";
    });
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    maintenance.bind({ notices: noticeHarness.notices, callText });

    await maintenance.start();
    const [first, second] = await Promise.all([
      maintenance.wake(),
      maintenance.wake(),
    ]);

    expect(first).toEqual({ condensed: 1, expired: 1 });
    expect(second).toEqual(first);
    expect(callText).toHaveBeenCalledOnce();
    expect(noticeHarness.drafts.map((draft) => draft.state)).toEqual([
      "prepared",
      "open",
      "updated",
      "closed",
    ]);
    expect(await maintenance.latestNotice()).toMatchObject({
      state: "closed",
      ref: { kind: "journal-maintenance", attempt: 1, completed: 1 },
    });
    expect(mutations).toMatchObject([
      {
        kind: "memory-journal-condense",
        scope: { kind: "personal" },
        month: "2026-06",
        sources: [
          { id: "2026-06-01", expectedDigest: digest("1") },
          { id: "2026-06-02", expectedDigest: digest("2") },
        ],
        summary: "monthly summary",
      },
      {
        kind: "memory-delete",
        scope: { kind: "personal" },
        domain: "journal",
        id: "2024-01",
        expectedDigest: digest("3"),
      },
    ]);
    await maintenance.stop();
  });

  it("rejects new wakes during stop and waits for the paid call already in flight", async () => {
    let releaseCall!: (value: string) => void;
    let enteredCall!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredCall = resolve;
    });
    const release = new Promise<string>((resolve) => {
      releaseCall = resolve;
    });
    const state = {
      read: vi.fn(async () => ({
        kind: "memory-list" as const,
        entries: [
          journal("2026-06-01", "first", digest("1")),
          journal("2026-06-02", "second", digest("2")),
        ],
      })),
      mutate: vi.fn(async () => ({ revision: 1 })),
    };
    const noticeHarness = createNoticeHarness();
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    maintenance.bind({
      notices: noticeHarness.notices,
      callText: vi.fn(async () => {
        enteredCall();
        return release;
      }),
    });

    await maintenance.start();
    await entered;
    const stopping = maintenance.stop();
    expect(() => maintenance.wake()).toThrow(/not running/);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseCall("monthly summary");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("keeps one durable notice across failure, retry, and service restart recovery", async () => {
    let applied = false;
    const state = {
      read: vi.fn(async () => ({
        kind: "memory-list" as const,
        entries: applied
          ? [journal("2026-06", "summary", digest("9"), true)]
          : [
              journal("2026-06-01", "first", digest("1")),
              journal("2026-06-02", "second", digest("2")),
            ],
      })),
      mutate: vi.fn(async () => {
        applied = true;
        return { revision: 1 };
      }),
    };
    const noticeHarness = createNoticeHarness();
    const failure = vi.fn();
    const callText = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce("retry summary");
    const first = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
      onError: failure,
    });
    first.bind({ notices: noticeHarness.notices, callText });
    await first.start();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(state.mutate).not.toHaveBeenCalled();
    expect(noticeHarness.drafts.at(-1)).toMatchObject({
      state: "updated",
      ref: { attempt: 1, completed: 0 },
    });

    await expect(first.wake()).resolves.toEqual({ condensed: 1, expired: 0 });
    await first.stop();
    const reopened = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    reopened.bind({ notices: noticeHarness.notices, callText });
    await reopened.start();
    await reopened.stop();

    expect(callText).toHaveBeenCalledTimes(2);
    expect(noticeHarness.drafts.at(-1)).toMatchObject({
      state: "closed",
      ref: { attempt: 2, completed: 1 },
    });
  });

  it("resumes the remaining months under the original notice after restart", async () => {
    let entries = [
      journal("2026-05-01", "may one", digest("1")),
      journal("2026-05-02", "may two", digest("2")),
      journal("2026-06-01", "june one", digest("3")),
      journal("2026-06-02", "june two", digest("4")),
    ];
    const state = {
      read: vi.fn(async () => ({ kind: "memory-list" as const, entries })),
      mutate: vi.fn(async (mutation: GlobalControlMutation) => {
        if (mutation.kind !== "memory-journal-condense") throw new Error("unexpected mutation");
        entries = [
          ...entries.filter((entry) =>
            !mutation.sources.some((source) => source.id === entry.id)),
          journal(mutation.month, mutation.summary, digest(mutation.month === "2026-05" ? "5" : "6"), true),
        ];
        return { revision: 1 };
      }),
    };
    const noticeHarness = createNoticeHarness();
    const failure = vi.fn();
    const callText = vi.fn()
      .mockResolvedValueOnce("may summary")
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("june summary");
    const first = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
      onError: failure,
    });
    first.bind({ notices: noticeHarness.notices, callText });
    await first.start();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    await first.stop();

    const reopened = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    reopened.bind({ notices: noticeHarness.notices, callText });
    await reopened.start();
    await reopened.wake();
    await reopened.stop();

    expect(callText).toHaveBeenCalledTimes(3);
    expect(noticeHarness.drafts.filter((draft) => draft.state === "prepared")).toHaveLength(1);
    expect(new Set(noticeHarness.drafts.map((draft) => draft.noticeId)).size).toBe(1);
    expect(noticeHarness.drafts.at(-1)).toMatchObject({
      state: "closed",
      ref: { completed: 2, monthCount: 2 },
    });
  });

  it("recovers an applied prefix under the same notice when mutation acknowledgement is lost", async () => {
    let entries = [
      journal("2026-05-01", "may one", digest("1")),
      journal("2026-05-02", "may two", digest("2")),
      journal("2026-06-01", "june one", digest("3")),
      journal("2026-06-02", "june two", digest("4")),
    ];
    let loseFirstAcknowledgement = true;
    const state = {
      read: vi.fn(async () => ({ kind: "memory-list" as const, entries })),
      mutate: vi.fn(async (mutation: GlobalControlMutation) => {
        if (mutation.kind !== "memory-journal-condense") throw new Error("unexpected mutation");
        entries = [
          ...entries.filter((entry) =>
            !mutation.sources.some((source) => source.id === entry.id)),
          journal(mutation.month, mutation.summary, digest(mutation.month === "2026-05" ? "5" : "6"), true),
        ];
        if (loseFirstAcknowledgement) {
          loseFirstAcknowledgement = false;
          throw new Error("response lost");
        }
        return { revision: 1 };
      }),
    };
    const noticeHarness = createNoticeHarness();
    const failure = vi.fn();
    const callText = vi.fn()
      .mockResolvedValueOnce("may summary")
      .mockResolvedValueOnce("june summary");
    const first = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
      onError: failure,
    });
    first.bind({ notices: noticeHarness.notices, callText });
    await first.start();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    await first.stop();

    const reopened = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    reopened.bind({ notices: noticeHarness.notices, callText });
    await reopened.start();
    await reopened.wake();
    await reopened.stop();

    expect(callText).toHaveBeenCalledTimes(2);
    expect(noticeHarness.drafts.filter((draft) => draft.state === "prepared")).toHaveLength(1);
    expect(new Set(noticeHarness.drafts.map((draft) => draft.noticeId)).size).toBe(1);
    expect(noticeHarness.drafts).toContainEqual(expect.objectContaining({
      state: "updated",
      ref: expect.objectContaining({ completed: 1 }),
    }));
    expect(noticeHarness.drafts.at(-1)).toMatchObject({
      state: "closed",
      ref: { completed: 2, monthCount: 2 },
    });
  });

  it("publishes prepared-to-closed progress through the real scheduler notice authority", async () => {
    const root = await createTempDir("journal-maintenance-notice");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    });
    const noticeAuthority = new SchedulerUserNoticeJournal({
      log,
      delivery: new OwnerDeliveryParticipant({
        authority: new DeliveryAuthority({ log, anchorEpoch: 7 }),
      }),
    });
    await noticeAuthority.initializeLiveCursor();
    let applied = false;
    const state = {
      read: vi.fn(async () => ({
        kind: "memory-list" as const,
        entries: applied
          ? [journal("2026-06", "summary", digest("9"), true)]
          : [
              journal("2026-06-01", "first", digest("1")),
              journal("2026-06-02", "second", digest("2")),
            ],
      })),
      mutate: vi.fn(async () => {
        applied = true;
        return { revision: 1 };
      }),
    };
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    maintenance.bind({ notices: noticeAuthority, callText: async () => "summary" });
    await maintenance.start();
    await maintenance.wake();
    await maintenance.stop();

    expect((await noticeAuthority.history(0)).map((notice) => notice.state)).toEqual([
      "prepared",
      "open",
      "updated",
      "closed",
    ]);
    expect(await noticeAuthority.journalMaintenanceStates()).toEqual([
      expect.objectContaining({
        notice: expect.objectContaining({
          kind: "journal-maintenance",
          state: "closed",
          ref: expect.objectContaining({ completed: 1, attempt: 1 }),
        }),
      }),
    ]);
  });
});

function createNoticeHarness() {
  const drafts: SchedulerNoticeDraft[] = [];
  const states = new Map<string, JournalMaintenanceNoticeState>();
  let revision = 0;
  const notices = {
    async recordJournalMaintenance(draft: SchedulerNoticeDraft) {
      drafts.push(structuredClone(draft));
      revision++;
      states.set(draft.noticeId, {
        notice: {
          noticeId: draft.noticeId,
          revision,
          kind: draft.kind,
          state: draft.state,
          ref: structuredClone(draft.ref),
          reason: draft.reason,
          actions: [...draft.actions],
          at: draft.at,
        } as SchedulerUserNotice,
        plan: structuredClone(draft.journalPlan!),
      });
    },
    async journalMaintenanceStates() {
      return [...states.values()];
    },
  } as unknown as SchedulerUserNoticeJournal;
  return { drafts, notices };
}

function journal(
  id: string,
  content: string,
  entryDigest: string,
  condensed = false,
) {
  return {
    domain: "journal" as const,
    scope: { kind: "personal" as const },
    id,
    meta: { date: id, ...(condensed ? { condensed: true } : {}) },
    content,
    revision: 1,
    digest: entryDigest,
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}
