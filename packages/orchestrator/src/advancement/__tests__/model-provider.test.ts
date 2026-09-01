import { describe, expect, it, vi } from "vitest";
import {
  assertAdvancementModelProviderBinding,
  createAdvancementModelProviderBinding,
} from "../model-provider.js";

describe("Advancement model provider binding", () => {
  it("freezes the finite demand-side port set", () => {
    const binding = createAdvancementModelProviderBinding({
      completion: { complete: vi.fn() },
      reviewer: { review: vi.fn() },
      sessionTokenBudget: 42_000,
    });

    expect(Object.keys(binding).sort()).toEqual([
      "completion",
      "reviewer",
      "sessionTokenBudget",
    ]);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => assertAdvancementModelProviderBinding(binding)).not.toThrow();
    expect("config" in binding).toBe(false);
    expect("credentials" in binding).toBe(false);
    expect("capability" in binding).toBe(false);
  });

  it("rejects mutable, widened, or invalid bindings", () => {
    const completion = { complete: vi.fn() };
    const reviewer = { review: vi.fn() };

    expect(() =>
      assertAdvancementModelProviderBinding({ completion, reviewer }),
    ).toThrow("finite and immutable");
    expect(() =>
      assertAdvancementModelProviderBinding(
        Object.freeze({ completion, reviewer, config: {} }) as never,
      ),
    ).toThrow("finite and immutable");
    expect(() =>
      createAdvancementModelProviderBinding({
        completion,
        reviewer,
        sessionTokenBudget: 0,
      }),
    ).toThrow("finite and immutable");
  });
});
