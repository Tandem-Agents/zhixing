import { describe, expect, it } from "vitest";
import {
  assertKernelWindowPromptProjection,
  assertKernelWindowPromptProjectionPort,
  createKernelWindowPromptProjection,
} from "../kernel-window-prompt.js";

describe("Kernel window prompt projection", () => {
  it("captures a finite immutable segment result without product metadata", () => {
    const projection = createKernelWindowPromptProjection({
      revision: 7,
      segment: "skill-index",
      content: "PRODUCT_PROMPT",
    });

    expect(projection).toEqual({
      revision: 7,
      segment: "skill-index",
      content: "PRODUCT_PROMPT",
    });
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("fails closed for unknown, mutable, extended or incomplete segment values", () => {
    for (const invalid of [
      Object.freeze({
        revision: 1,
        segment: "unknown",
        content: "x",
      }),
      Object.freeze({
        revision: 1,
        segment: "skill-index",
        content: "x",
        productMode: "main",
      }),
      { revision: 1, segment: "skill-index", content: "x" },
      Object.freeze({ revision: 1, segment: "skill-index", content: 7 }),
      Object.freeze({ revision: 1 }),
    ]) {
      expect(() =>
        assertKernelWindowPromptProjection(invalid as never),
      ).toThrow();
    }
  });

  it("requires the product projection port before runtime publication", () => {
    expect(() =>
      assertKernelWindowPromptProjectionPort({
        project: async () =>
          createKernelWindowPromptProjection({
            revision: -1,
            segment: "skill-index",
            content: null,
          }),
      }),
    ).toThrow("finite and immutable");
    expect(() =>
      assertKernelWindowPromptProjectionPort(
        Object.freeze({
          project: async () =>
            createKernelWindowPromptProjection({
              revision: -1,
              segment: "skill-index",
              content: null,
            }),
        }),
      ),
    ).not.toThrow();
  });
});
