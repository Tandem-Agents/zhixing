import { describe, expect, it } from "vitest";
import { ForegroundActivity } from "../foreground-activity.js";

// 后台维护据此让路：请求在途或最近有推送时不安静，安静后才推进；取消时立即返回。
describe("ForegroundActivity", () => {
  it("is quiet without activity and stays busy while work is in flight", async () => {
    let now = 0;
    const activity = new ForegroundActivity(() => now);
    expect(activity.quiet(500)).toBe(true);
    const done = activity.enter();
    now = 10_000;
    expect(activity.quiet(500)).toBe(false);
    done();
    done();
    expect(activity.quiet(500)).toBe(false);
    now += 499;
    expect(activity.quiet(500)).toBe(false);
    now += 1;
    expect(activity.quiet(500)).toBe(true);
    activity.pulse();
    expect(activity.quiet(500)).toBe(false);
  });

  it("waits until in-flight work ends and the quiet period passes", async () => {
    const activity = new ForegroundActivity();
    const done = activity.enter();
    let resolved = false;
    const waiting = activity.whenQuiet(30).then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(resolved).toBe(false);
    const ended = performance.now();
    done();
    await waiting;
    expect(resolved).toBe(true);
    expect(performance.now() - ended).toBeGreaterThanOrEqual(29);
  });

  it("returns at once when the wait is cancelled", async () => {
    const activity = new ForegroundActivity();
    activity.enter();
    const controller = new AbortController();
    const waiting = activity.whenQuiet(10_000, controller.signal);
    controller.abort();
    await waiting;
    expect(activity.quiet(0)).toBe(false);
  });
});
