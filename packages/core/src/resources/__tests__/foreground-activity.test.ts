import { describe, expect, it } from "vitest";
import { ForegroundActivity, holdForegroundObligation } from "../foreground-activity.js";

// 运行尝试的前台义务：可让出、可重入，关闭后迟到的让出与重入都不再改变登记
describe("holdForegroundObligation", () => {
  it("pauses and resumes exactly once per phase and ignores calls after close", () => {
    let now = 0;
    const activity = new ForegroundActivity(() => now);
    const obligation = holdForegroundObligation(activity);
    now = 10_000;
    expect(activity.quiet(500)).toBe(false);
    obligation.pause();
    obligation.pause();
    now += 500;
    expect(activity.quiet(500)).toBe(true);
    obligation.resume();
    obligation.resume();
    expect(activity.quiet(500)).toBe(false);
    obligation.pause();
    now += 500;
    expect(activity.quiet(500)).toBe(true);
    obligation.close();
    obligation.resume();
    obligation.close();
    now += 500;
    expect(activity.quiet(500)).toBe(true);
    // 同时持有两份义务：一份关闭不影响另一份
    const first = holdForegroundObligation(activity), second = holdForegroundObligation(activity);
    first.close();
    now += 500;
    expect(activity.quiet(500)).toBe(false);
    second.close();
    now += 500;
    expect(activity.quiet(500)).toBe(true);
  });
});

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
