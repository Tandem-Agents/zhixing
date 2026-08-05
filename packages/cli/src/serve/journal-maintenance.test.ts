import { describe, expect, it, vi } from "vitest";
import type {
  GlobalControlMutation,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import { createAnchorJournalMaintenance } from "./journal-maintenance.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

describe("createAnchorJournalMaintenance", () => {
  it("shares one anchor-only run and emits digest-bound expire and atomic condense mutations", async () => {
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
      mutate: vi.fn(async (mutation: GlobalControlMutation, _context: unknown) => {
        mutations.push(structuredClone(mutation));
        return { revision: 1 };
      }),
    };
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });
    const callText = vi.fn(async () => "monthly summary");

    const [first, second] = await Promise.all([
      maintenance.run(callText),
      maintenance.run(callText),
    ]);

    expect(first).toEqual({ condensed: 1, expired: 1 });
    expect(second).toEqual(first);
    expect(callText).toHaveBeenCalledOnce();
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
    expect(state.read).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledTimes(2);
    for (const [, context] of state.mutate.mock.calls) {
      expect(context).toMatchObject({
        principal: { kind: "host", component: "memory-journal-maintenance" },
        authority: { domain: "global", anchorEpoch: 7 },
      });
    }
  });

  it("keeps authority unchanged on LLM failure and allows the next trigger to retry", async () => {
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
    const maintenance = createAnchorJournalMaintenance({
      state: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 7,
      clock: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    await expect(maintenance.run(async () => {
      throw new Error("provider unavailable");
    })).rejects.toThrow("provider unavailable");
    expect(state.mutate).not.toHaveBeenCalled();
    await expect(maintenance.run(async () => "retry summary")).resolves.toEqual({
      condensed: 1,
      expired: 0,
    });
    expect(state.mutate).toHaveBeenCalledOnce();
  });
});

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
