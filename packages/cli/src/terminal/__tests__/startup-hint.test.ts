import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writes: string[] = [];

describe("startup hint", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(((text: string) => { writes.push(text); return true; }) as typeof process.stdout.write);
  });
  afterEach(() => { writes.length = 0; vi.restoreAllMocks(); vi.resetModules(); });

  it("writes one hint line and clears it exactly once with plain overwrite", async () => {
    const { showStartupHint, clearStartupHint } = await import("../startup-hint.js");
    showStartupHint();
    showStartupHint();
    expect(writes).toEqual(["\r知行正在启动…"]);
    clearStartupHint();
    clearStartupHint();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatch(/^\r {14}\r$/u);
    expect(writes[1]).not.toContain("\x1b");
  });

  it("does nothing when no hint was shown", async () => {
    const { clearStartupHint } = await import("../startup-hint.js");
    clearStartupHint();
    expect(writes).toEqual([]);
  });

  it("clears on process exit when the screen was never handed over", async () => {
    const { showStartupHint } = await import("../startup-hint.js");
    const before = process.listeners("exit").length;
    showStartupHint();
    const added = process.listeners("exit").slice(before);
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(writes.at(-1)).toMatch(/^\r {14}\r$/u);
    process.removeListener("exit", added[0] as () => void);
  });
});
