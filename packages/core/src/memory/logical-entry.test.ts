import { describe, expect, it } from "vitest";
import {
  memoryLogicalEntryMatches,
  projectMemoryLogicalEntry,
} from "./logical-entry.js";

describe("memory logical entry projection", () => {
  it("binds domain into the digest while keeping authority time outside identity", () => {
    const shared = {
      scope: { kind: "personal" as const },
      content: "same content",
    };
    const memory = projectMemoryLogicalEntry({
      domain: "memory",
      ...shared,
      category: "profile",
      id: "profile",
      meta: { name: "A" },
    }, undefined, { revision: 1 });
    const people = projectMemoryLogicalEntry({
      domain: "people",
      ...shared,
      id: "same-id",
      meta: { name: "A", relation: "friend" },
    }, undefined, { revision: 1, updatedAt: "2026-08-05T00:00:00.000Z" });
    const timed = projectMemoryLogicalEntry({
      domain: "memory",
      ...shared,
      category: "profile",
      id: "profile",
      meta: { name: "A" },
    }, undefined, { revision: 1, updatedAt: "2026-08-05T00:00:00.000Z" });

    expect(memory.digest).not.toBe(people.digest);
    expect(timed.digest).toBe(memory.digest);
  });

  it("appends journal content and applies the same domain/query predicate as authority", () => {
    const first = projectMemoryLogicalEntry({
      domain: "journal",
      scope: { kind: "personal" },
      date: "2026-08-05",
      content: "alpha",
    }, undefined, { revision: 1 });
    const second = projectMemoryLogicalEntry({
      domain: "journal",
      scope: { kind: "personal" },
      date: "2026-08-05",
      content: "beta",
    }, first, { revision: 2 });

    expect(second.content).toBe("alpha\n\n---\n\nbeta");
    expect(memoryLogicalEntryMatches(second, {
      scope: { kind: "personal" },
      domain: "journal",
      query: "BETA",
    })).toBe(true);
    expect(memoryLogicalEntryMatches(second, {
      scope: { kind: "personal" },
      domain: "people",
      query: "beta",
    })).toBe(false);
  });
});
