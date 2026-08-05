import { describe, expect, it } from "vitest";
import {
  assertMemoryStorageIdentity,
  canonicalMemoryIdentity,
  isCalendarDay,
} from "./canonical-identity.js";

describe("canonical memory identity", () => {
  it("accepts the one product identity for each public memory category", () => {
    expect(canonicalMemoryIdentity({
      domain: "memory",
      category: "profile",
      id: "profile",
    })).toEqual({ domain: "memory", category: "profile", id: "profile" });
    expect(canonicalMemoryIdentity({ domain: "people", id: "friend-alice" }))
      .toEqual({ domain: "people", id: "friend-alice" });
    expect(canonicalMemoryIdentity({ domain: "journal", id: "2026-08-05" }))
      .toEqual({ domain: "journal", id: "2026-08-05" });
  });

  it.each([
    { domain: "memory", category: "person", id: "friend-alice" },
    { domain: "memory", category: "journal", id: "2026-08-05" },
    { domain: "people", category: "person", id: "friend-alice" },
    { domain: "journal", category: "journal", id: "2026-08-05" },
    { domain: "people", id: "../escape" },
    { domain: "people", id: "CON" },
    { domain: "journal", id: "2025-02-29" },
    { domain: "journal", id: "2026-08" },
  ])("rejects a non-canonical public identity: $domain/$id", (input) => {
    expect(() => canonicalMemoryIdentity(input as never)).toThrow();
  });

  it("admits monthly journal identities only at the internal storage boundary", () => {
    expect(() => canonicalMemoryIdentity({ domain: "journal", id: "2026-08" }))
      .toThrow();
    expect(canonicalMemoryIdentity(
      { domain: "journal", id: "2026-08" },
      { allowJournalMonth: true },
    )).toEqual({ domain: "journal", id: "2026-08" });
    expect(() => assertMemoryStorageIdentity("journal", "2026-08"))
      .not.toThrow();
  });

  it("validates real calendar days instead of accepting a date-shaped string", () => {
    expect(isCalendarDay("2024-02-29")).toBe(true);
    expect(isCalendarDay("2025-02-29")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
  });
});
