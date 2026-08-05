import { describe, expect, it } from "vitest";
import { validateGlobalStagedMutation } from "./commit.js";

const scope = { kind: "personal" as const };
const digest = `sha256:${"a".repeat(64)}`;

describe("staged memory canonical identity", () => {
  it.each([
    {
      kind: "memory-append",
      payload: {
        domain: "memory",
        scope,
        category: "profile",
        id: "profile",
        meta: {},
        content: "profile",
      },
    },
    {
      kind: "memory-append",
      payload: {
        domain: "people",
        scope,
        id: "friend-alice",
        meta: { name: "Alice", relation: "friend" },
        content: "person",
      },
    },
    {
      kind: "memory-append",
      payload: { domain: "journal", scope, date: "2026-08-05", content: "day" },
    },
  ])("accepts a canonical staged mutation", (mutation) => {
    expect(() => validateGlobalStagedMutation(mutation as never)).not.toThrow();
  });

  it.each([
    {
      kind: "memory-append",
      payload: {
        domain: "memory",
        scope,
        category: "person",
        id: "friend-alice",
        meta: {},
        content: "wrong domain",
      },
    },
    {
      kind: "memory-append",
      payload: {
        domain: "people",
        scope,
        id: "../escape",
        meta: { name: "Alice", relation: "friend" },
        content: "unsafe",
      },
    },
    {
      kind: "memory-append",
      payload: { domain: "journal", scope, date: "2025-02-29", content: "bad day" },
    },
    {
      kind: "memory-append",
      payload: { domain: "journal", scope, date: "2026-08-05", content: " \n\t " },
    },
    {
      kind: "memory-delete",
      scope,
      domain: "memory",
      category: "person",
      id: "friend-alice",
      expectedDigest: digest,
    },
    {
      kind: "memory-delete",
      scope,
      domain: "journal",
      id: "2026-06",
      expectedDigest: digest,
    },
  ])("rejects a non-canonical staged mutation", (mutation) => {
    expect(() => validateGlobalStagedMutation(mutation as never)).toThrow();
  });
});
