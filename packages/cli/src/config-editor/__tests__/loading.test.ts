/**
 * runLoadingAction 测试 —— 异步任务与取消键的 race 逻辑（无真实 stdin / 定时器，全可控）。
 *
 * 关键不变量：
 *   - task 先完成 → 返回其结果；并清理悬挂的按键等待（不吞后续按键）
 *   - Esc → pop 回上一面板 + abort 任务；Ctrl+C → exit + abort
 *   - 其它键被忽略、任务仍可完成
 */

import { describe, expect, it } from "vitest";
import { runLoadingAction } from "../loading.js";
import type { KeyEvent, PanelAction, WorkingState } from "../types.js";
import type { KeyEventStream } from "../ui/input.js";

type LoadingAction = Extract<PanelAction, { type: "loading" }>;

/** 可控假 KeyEventStream —— feed 喂按键、pending 观察悬挂等待数、支持 signal 取消。 */
function fakeStream() {
  const waiters: Array<{
    resolve: (k: KeyEvent) => void;
    reject: (e: unknown) => void;
  }> = [];
  const stream: KeyEventStream = {
    start() {},
    stop() {},
    next(signal?: AbortSignal): Promise<KeyEvent> {
      return new Promise<KeyEvent>((resolve, reject) => {
        const w = { resolve, reject };
        waiters.push(w);
        signal?.addEventListener(
          "abort",
          () => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  };
  return {
    stream,
    feed: (key: KeyEvent) => waiters.shift()?.resolve(key),
    pending: () => waiters.length,
  };
}

const SNAPSHOT = { tag: "snapshot" } as unknown as WorkingState;

function loadingAction(
  run: LoadingAction["run"],
  state: WorkingState = SNAPSHOT,
): LoadingAction {
  return { type: "loading", message: "正在处理…", state, run };
}

describe("runLoadingAction", () => {
  it("task 先完成 → 返回其 action，并清理悬挂的按键等待", async () => {
    const f = fakeStream();
    let resolveTask!: (a: PanelAction) => void;
    const action = loadingAction(
      () => new Promise<PanelAction>((r) => (resolveTask = r)),
    );

    const p = runLoadingAction(action, f.stream, () => {});
    // 已发起一次按键等待（与任务 race）
    expect(f.pending()).toBe(1);

    const next: PanelAction = { type: "navigate", state: SNAPSHOT, panel: { kind: "main" } };
    resolveTask(next);
    expect(await p).toEqual(next);
    // 悬挂的按键等待被 finally abort 摘除，不会吞后续按键
    expect(f.pending()).toBe(0);
  });

  it("Esc → pop 回上一面板，且 abort 任务", async () => {
    const f = fakeStream();
    let taskSignal: AbortSignal | undefined;
    const action = loadingAction((signal) => {
      taskSignal = signal;
      return new Promise<PanelAction>(() => {}); // 永不完成
    });

    const p = runLoadingAction(action, f.stream, () => {});
    f.feed({ type: "escape" });

    expect(await p).toEqual({ type: "pop", state: SNAPSHOT });
    expect(taskSignal?.aborted).toBe(true);
  });

  it("Ctrl+C → exit cancelled，且 abort 任务", async () => {
    const f = fakeStream();
    let taskSignal: AbortSignal | undefined;
    const action = loadingAction((signal) => {
      taskSignal = signal;
      return new Promise<PanelAction>(() => {});
    });

    const p = runLoadingAction(action, f.stream, () => {});
    f.feed({ type: "ctrl-c" });

    const result = await p;
    expect(result.type).toBe("exit");
    if (result.type === "exit") expect(result.result.kind).toBe("cancelled");
    expect(taskSignal?.aborted).toBe(true);
  });

  it("非取消键被忽略、重渲染，任务仍可完成", async () => {
    const f = fakeStream();
    let resolveTask!: (a: PanelAction) => void;
    let renders = 0;
    const action = loadingAction(
      () => new Promise<PanelAction>((r) => (resolveTask = r)),
    );

    const p = runLoadingAction(action, f.stream, () => {
      renders += 1;
    });
    f.feed({ type: "char", ch: "x" }); // 忽略
    // 排空微任务：让循环处理掉这个键、重渲染、重新发起按键等待（否则 task 一旦先 resolve
    // 会因 race 微任务更浅而直接赢，走不到忽略分支）
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(renders).toBeGreaterThanOrEqual(2); // 初始 + 忽略键后重渲染
    expect(f.pending()).toBe(1); // 已重新等待按键

    resolveTask({ type: "pop", state: SNAPSHOT });
    expect((await p).type).toBe("pop");
    expect(f.pending()).toBe(0);
  });

  it("run 经 report 更新当前步骤 → renderLoading 收到新文案（多阶段进度）", async () => {
    const f = fakeStream();
    const messages: string[] = [];
    let resolveTask!: (a: PanelAction) => void;
    const action = loadingAction((_signal, report) => {
      report("正在搜索…");
      report("正在读取…");
      return new Promise<PanelAction>((r) => (resolveTask = r));
    });

    const p = runLoadingAction(action, f.stream, (m) => messages.push(m));
    expect(messages).toEqual(["正在处理…", "正在搜索…", "正在读取…"]); // 初始 + 两次 report

    resolveTask({ type: "pop", state: SNAPSHOT });
    await p;
  });

  it("report 更新后，非取消键重渲染用当前步骤（不回退初始 message）", async () => {
    const f = fakeStream();
    const messages: string[] = [];
    let resolveTask!: (a: PanelAction) => void;
    const action = loadingAction((_signal, report) => {
      report("正在搜索…");
      return new Promise<PanelAction>((r) => (resolveTask = r));
    });

    const p = runLoadingAction(action, f.stream, (m) => messages.push(m));
    f.feed({ type: "char", ch: "x" }); // 忽略键 → 重渲染
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(messages[messages.length - 1]).toBe("正在搜索…"); // 用当前步骤，非初始

    resolveTask({ type: "pop", state: SNAPSHOT });
    await p;
  });
});
