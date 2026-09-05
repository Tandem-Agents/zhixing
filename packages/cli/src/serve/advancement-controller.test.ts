import { describe, expect, it, vi } from "vitest";
import { createAdvancementModelProviderBinding } from "@zhixing/orchestrator/advancement";
import { createServeAdvancementApplications } from "./advancement-controller.js";

const sessionState = Object.freeze({
  readAdvancementState: vi.fn(async () => null),
  mutate: vi.fn(async () => ({ revision: 1 })),
}) as never;

describe("Serve Advancement application assembly", () => {
  it("publishes applications only after one finite model binding is available", async () => {
    const completion = { complete: vi.fn() };
    const reviewer = { review: vi.fn() };
    const create = vi.fn(() =>
      createAdvancementModelProviderBinding({ completion, reviewer }),
    );

    const applications = await createServeAdvancementApplications({
      modelProvider: { create },
      governor: () => undefined,
      sessionState,
      recentContext: Object.freeze({ read: async () => undefined }),
      rubricScope: "local",
    });

    expect(create).toHaveBeenCalledOnce();
    const request = create.mock.calls[0]?.[0];
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.keys(request ?? {})).toEqual(["resourceMeter"]);
    expect(applications.controller).toBeDefined();
    expect(applications.reviews).toBeDefined();
  });

  it("fails closed instead of publishing applications for a widened binding", async () => {
    const create = vi.fn(() =>
      Object.freeze({
        completion: { complete: vi.fn() },
        reviewer: { review: vi.fn() },
        config: {},
      }) as never,
    );

    await expect(createServeAdvancementApplications({
      modelProvider: { create },
      governor: () => undefined,
      sessionState,
      recentContext: Object.freeze({ read: async () => undefined }),
      rubricScope: "local",
    })).rejects.toThrow("finite and immutable");
  });

  it("fails during assembly when the recent-context dependency is missing", async () => {
    const create = vi.fn();

    await expect(createServeAdvancementApplications({
      modelProvider: { create },
      governor: () => undefined,
      sessionState,
      recentContext: undefined as never,
      rubricScope: "local",
    })).rejects.toThrow("direct recent-context port");
    expect(create).not.toHaveBeenCalled();
  });

  it("fails during assembly when the conversation state dependency is missing", async () => {
    const create = vi.fn();

    await expect(createServeAdvancementApplications({
      modelProvider: { create },
      governor: () => undefined,
      sessionState: undefined as never,
      recentContext: Object.freeze({ read: async () => undefined }),
      rubricScope: "local",
    })).rejects.toThrow("direct conversation session-state port");
    expect(create).not.toHaveBeenCalled();
  });
});
