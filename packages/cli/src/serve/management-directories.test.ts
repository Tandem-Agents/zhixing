import type {
  GlobalQuery,
  GlobalReadCallContext,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { JournalMaintenance } from "./journal-maintenance.js";
import { createMemoryDirectory } from "./management-directories.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

describe("createMemoryDirectory", () => {
  it("serves profile, people, and journal status from personal authority DTOs", async () => {
    const reads: Array<{ query: GlobalQuery; context: GlobalReadCallContext }> = [];
    const profile = entry("memory", "profile", "Ada", digest("1"), "profile");
    const person = entry("people", "ada", "Friend", digest("2"));
    const state = {
      read: vi.fn(async (query: GlobalQuery, context: GlobalReadCallContext) => {
        reads.push({ query: structuredClone(query), context: structuredClone(context) });
        return {
          kind: "memory-list" as const,
          entries: query.kind === "memory-list" && query.domain === "memory"
            ? [profile]
            : [person],
        };
      }),
    };
    const journal = {
      scan: vi.fn(async () => ({
        expired: [entry("journal", "2024-01", "old", digest("3"))],
        condense: [{
          month: "2026-06",
          sources: [entry("journal", "2026-06-01", "daily", digest("4"))],
        }],
        stats: { hotCount: 2, warmCount: 1, condensedCount: 3, totalFiles: 6 },
      })),
    };
    const directory = createMemoryDirectory({
      globalState: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 9,
      journal: journal as unknown as JournalMaintenance,
    });

    await expect(directory.profileGet()).resolves.toEqual(profile);
    await expect(directory.peopleList()).resolves.toEqual([person]);
    await expect(directory.journalStats()).resolves.toEqual({
      stats: { hotCount: 2, warmCount: 1, condensedCount: 3, totalFiles: 6 },
      condense: { months: 1, files: 1 },
      expiredCount: 1,
    });
    expect(reads.map(({ query }) => query)).toEqual([
      {
        kind: "memory-list",
        scope: { kind: "personal" },
        domain: "memory",
        category: "profile",
      },
      {
        kind: "memory-list",
        scope: { kind: "personal" },
        domain: "people",
      },
    ]);
    for (const { context } of reads) {
      expect(context).toMatchObject({
        principal: { kind: "host", component: "memory-management" },
        authority: { domain: "global", anchorEpoch: 9 },
      });
    }
  });

  it("rejects duplicate authority profiles instead of choosing one", async () => {
    const profile = entry("memory", "profile", "Ada", digest("1"), "profile");
    const state = {
      read: vi.fn(async () => ({ kind: "memory-list" as const, entries: [profile, profile] })),
    };
    const directory = createMemoryDirectory({
      globalState: () => state as unknown as GlobalStatePort,
      anchorEpoch: () => 1,
      journal: { scan: vi.fn() } as unknown as JournalMaintenance,
    });
    await expect(directory.profileGet()).rejects.toThrow("duplicate profiles");
  });

  it("keeps legacy file readers and lifecycle writers out of production surfaces", async () => {
    const sources = await Promise.all([
      "../commands/info-commands.ts",
      "./management-directories.ts",
      "./turn-maintenance.ts",
      "./command.ts",
    ].map((relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8")));
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:JournalStore|PeopleStore|loadProfile)\b/u);
    }
  });
});

function entry(
  domain: "memory" | "journal" | "people",
  id: string,
  content: string,
  entryDigest: string,
  category?: "profile",
) {
  return {
    domain,
    scope: { kind: "personal" as const },
    ...(category ? { category } : {}),
    id,
    meta: domain === "journal" ? { date: id } : {},
    content,
    revision: 1,
    digest: entryDigest,
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}
