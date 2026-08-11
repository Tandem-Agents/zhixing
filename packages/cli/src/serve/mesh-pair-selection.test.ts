import { describe, expect, it, vi } from "vitest";
import { resolveExecutorAutoStartSelection } from "./mesh-pair-command.js";

describe("executor automatic-online selection", () => {
  it.each([true, false])("uses an explicit non-interactive choice: %s", async (explicit) => {
    const prompt = vi.fn(async () => !explicit);
    await expect(resolveExecutorAutoStartSelection({
      explicit,
      isolated: false,
      interactive: false,
      prompt,
    })).resolves.toBe(explicit);
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves a durable choice on pairing replay: %s", async (persisted) => {
    const prompt = vi.fn(async () => !persisted);
    await expect(resolveExecutorAutoStartSelection({
      persisted,
      isolated: false,
      interactive: true,
      prompt,
    })).resolves.toBe(persisted);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts once for an interactive fresh joiner", async () => {
    const prompt = vi.fn(async () => true);
    await expect(resolveExecutorAutoStartSelection({
      isolated: false,
      interactive: true,
      prompt,
    })).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("requires an explicit choice for a non-interactive fresh joiner", async () => {
    const prompt = vi.fn(async () => false);
    await expect(resolveExecutorAutoStartSelection({
      isolated: false,
      interactive: false,
      prompt,
    })).rejects.toThrow("--executor-auto-start yes|no");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps embedded pairing deterministic without creating a product preference", async () => {
    const prompt = vi.fn(async () => true);
    await expect(resolveExecutorAutoStartSelection({
      isolated: true,
      interactive: false,
      prompt,
    })).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
});
