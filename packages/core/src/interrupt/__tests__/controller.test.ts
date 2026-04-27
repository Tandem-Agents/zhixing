import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  abortWithReason,
  createInterruptController,
  forkController,
  getAbortReason,
} from "../controller.js";
import type { AbortReason } from "../types.js";

describe("createInterruptController", () => {
  it("返回原生 AbortController(可被任何接 AbortSignal 的库消费)", () => {
    const c = createInterruptController();
    expect(c).toBeInstanceOf(AbortController);
    expect(c.signal).toBeInstanceOf(AbortSignal);
    expect(c.signal.aborted).toBe(false);
  });

  it("无 externalSignals 时不会自动 abort", () => {
    const c = createInterruptController();
    expect(c.signal.aborted).toBe(false);
  });

  it("外部 signal 已 aborted → controller 同步 abort with kind=external", () => {
    const ext = new AbortController();
    ext.abort();
    const c = createInterruptController({ externalSignals: [ext.signal] });
    expect(c.signal.aborted).toBe(true);
    expect(getAbortReason(c.signal)?.kind).toBe("external");
  });

  it("外部 signal 后续裸 abort → controller fallback kind=external (无 typed reason)", async () => {
    const ext = new AbortController();
    const c = createInterruptController({ externalSignals: [ext.signal] });
    expect(c.signal.aborted).toBe(false);

    ext.abort();
    expect(c.signal.aborted).toBe(true);
    expect(getAbortReason(c.signal)?.kind).toBe("external");
  });

  it("外部 signal 已用 abortWithReason 触发 typed reason → controller 透传 reason 不覆盖", () => {
    // cli KeyboardSource 按 Esc 触发 user-cancel,signal 通过 RunParams.abortSignal
    // 跨层传到 agent-loop;agent-loop 内 createInterruptController 应透传原 typed reason,
    // 让下游 (REPL renderSummary 等) 能展示差异化中断原因 ("interrupted by user (esc)" 等),
    // 而不是被笼统覆盖为 "external signal"。
    const ext = new AbortController();
    abortWithReason(ext, { kind: "user-cancel", source: "esc", pressedAt: 100 });

    const c = createInterruptController({ externalSignals: [ext.signal] });
    expect(c.signal.aborted).toBe(true);
    const r = getAbortReason(c.signal);
    expect(r?.kind).toBe("user-cancel");
    if (r?.kind === "user-cancel") {
      expect(r.source).toBe("esc");
    }
  });

  it("外部 signal 后续用 abortWithReason 触发 typed reason → controller 异步透传", () => {
    const ext = new AbortController();
    const c = createInterruptController({ externalSignals: [ext.signal] });

    abortWithReason(ext, { kind: "user-cancel", source: "ctrl-c", pressedAt: 200 });
    expect(c.signal.aborted).toBe(true);
    const r = getAbortReason(c.signal);
    expect(r?.kind).toBe("user-cancel");
    if (r?.kind === "user-cancel") {
      expect(r.source).toBe("ctrl-c");
    }
  });

  it("多个外部 signal 任一 abort → controller abort", () => {
    const e1 = new AbortController();
    const e2 = new AbortController();
    const e3 = new AbortController();
    const c = createInterruptController({
      externalSignals: [e1.signal, e2.signal, e3.signal],
    });
    expect(c.signal.aborted).toBe(false);

    e2.abort();
    expect(c.signal.aborted).toBe(true);
  });

  it("多个外部 signal、首个已 aborted → controller 立即 abort,后续 ext 不挂 dead listener", () => {
    // 没有这个保护,后续 ext 上各挂 1 个 onExtAbort listener;触发只会走
    // abortWithReason 的 no-op 分支(controller 已 aborted),但 closure 引用
    // controller 让其无法被 GC,直到 ext 自己 abort(once:true 才移除)。
    // 在长生命周期 ext 场景下是真实的内存泄漏。
    const aborted = new AbortController();
    aborted.abort();

    const live2 = new AbortController();
    const live3 = new AbortController();

    const before2 = getEventListeners(live2.signal, "abort").length;
    const before3 = getEventListeners(live3.signal, "abort").length;

    const c = createInterruptController({
      externalSignals: [aborted.signal, live2.signal, live3.signal],
    });

    expect(c.signal.aborted).toBe(true);
    expect(getEventListeners(live2.signal, "abort").length).toBe(before2);
    expect(getEventListeners(live3.signal, "abort").length).toBe(before3);
  });

  it("parent signal abort → 创建的 controller 自动 abort with kind=parent-abort", () => {
    const parent = createInterruptController();
    const c = createInterruptController({ parent: parent.signal });
    expect(c.signal.aborted).toBe(false);

    abortWithReason(parent, { kind: "user-cancel", source: "esc", pressedAt: 100 });
    expect(c.signal.aborted).toBe(true);

    const r = getAbortReason(c.signal);
    expect(r?.kind).toBe("parent-abort");
    if (r?.kind === "parent-abort") {
      expect(r.parentReason?.kind).toBe("user-cancel");
    }
  });

  it("parent 已 aborted → 创建时立即 aborted", () => {
    const parent = createInterruptController();
    abortWithReason(parent, { kind: "external", origin: "scheduler" });

    const c = createInterruptController({ parent: parent.signal });
    expect(c.signal.aborted).toBe(true);
    expect(getAbortReason(c.signal)?.kind).toBe("parent-abort");
  });

  it("parent + externalSignals 同时传:任一触发都让子 abort", () => {
    const parent = createInterruptController();
    const ext = new AbortController();
    const c = createInterruptController({
      parent: parent.signal,
      externalSignals: [ext.signal],
    });
    expect(c.signal.aborted).toBe(false);

    // ext 先触发 → external reason 胜出 (first-wins, abortWithReason 幂等)
    ext.abort();
    expect(c.signal.aborted).toBe(true);
    expect(getAbortReason(c.signal)?.kind).toBe("external");

    // 后续 parent 触发不覆盖原 reason
    abortWithReason(parent, { kind: "user-cancel", source: "esc", pressedAt: 200 });
    expect(getAbortReason(c.signal)?.kind).toBe("external");
  });

  it("parent 已 aborted + externalSignals 后续 → 不挂 dead listener", () => {
    const parent = createInterruptController();
    abortWithReason(parent, { kind: "external", origin: "scheduler" });

    const live = new AbortController();
    const before = getEventListeners(live.signal, "abort").length;

    const c = createInterruptController({
      parent: parent.signal,
      externalSignals: [live.signal],
    });

    // parent 已 aborted → c 同步 aborted with parent-abort;后续 ext 不挂 listener
    expect(c.signal.aborted).toBe(true);
    expect(getAbortReason(c.signal)?.kind).toBe("parent-abort");
    expect(getEventListeners(live.signal, "abort").length).toBe(before);
  });

  it("setMaxListeners(50) 默认生效——挂 11 个 listener 不报警", () => {
    // 默认 EventEmitter 是 10,超过会触发 MaxListenersExceededWarning。
    // 这里通过捕获 process warning 间接验证;重点是不抛错。
    const c = createInterruptController();
    const warnings: unknown[] = [];
    const handler = (w: Error) => warnings.push(w);
    process.on("warning", handler);
    try {
      for (let i = 0; i < 11; i++) {
        c.signal.addEventListener("abort", () => {});
      }
    } finally {
      process.off("warning", handler);
    }
    expect(warnings.find((w) => String(w).includes("MaxListenersExceeded"))).toBeUndefined();
  });
});

describe("abortWithReason", () => {
  it("触发 abort 并附带 reason", () => {
    const c = createInterruptController();
    const reason: AbortReason = { kind: "user-cancel", source: "esc", pressedAt: 100 };
    abortWithReason(c, reason);
    expect(c.signal.aborted).toBe(true);
    expect(getAbortReason(c.signal)).toEqual(reason);
  });

  it("幂等:已 aborted 时 no-op,不覆盖原 reason", () => {
    const c = createInterruptController();
    const first: AbortReason = { kind: "user-cancel", source: "esc", pressedAt: 100 };
    const second: AbortReason = { kind: "external", origin: "later" };

    abortWithReason(c, first);
    abortWithReason(c, second);

    expect(getAbortReason(c.signal)).toEqual(first);
  });
});

describe("getAbortReason", () => {
  it("signal 未 aborted → null", () => {
    const c = createInterruptController();
    expect(getAbortReason(c.signal)).toBeNull();
  });

  it("通过 abortWithReason 触发 → 类型化 reason", () => {
    const c = createInterruptController();
    abortWithReason(c, { kind: "idle-timeout", timeoutMs: 60000, chunksReceived: 3, elapsedSinceLastChunkMs: 60100 });
    const r = getAbortReason(c.signal);
    expect(r?.kind).toBe("idle-timeout");
  });

  it("外部裸 abort()(reason 是 DOMException)→ getAbortReason 返回 null", () => {
    const ext = new AbortController();
    ext.abort();
    // ext.signal.reason 默认是 DOMException(AbortError);它不含 kind 字段,
    // 不符合本模块 AbortReason 形状 → 返回 null,下游做"未知中断源"分支处理
    expect(ext.signal.reason).toBeDefined();
    expect(getAbortReason(ext.signal)).toBeNull();
  });

  it("abort 传非对象(string)→ null", () => {
    const c = new AbortController();
    c.abort("custom string");
    expect(getAbortReason(c.signal)).toBeNull();
  });

  it("abort 传对象但缺 kind → null", () => {
    const c = new AbortController();
    c.abort({ foo: "bar" });
    expect(getAbortReason(c.signal)).toBeNull();
  });
});

describe("forkController", () => {
  it("父 abort → 子异步 abort with kind=parent-abort + parentReason", async () => {
    const parent = createInterruptController();
    const child = forkController(parent.signal);
    expect(child.signal.aborted).toBe(false);

    abortWithReason(parent, { kind: "user-cancel", source: "esc", pressedAt: 50 });
    expect(child.signal.aborted).toBe(true);

    const childReason = getAbortReason(child.signal);
    expect(childReason?.kind).toBe("parent-abort");
    if (childReason?.kind === "parent-abort") {
      expect(childReason.parentReason?.kind).toBe("user-cancel");
    }
  });

  it("父已 aborted → 子在创建时立即 aborted", () => {
    const parent = createInterruptController();
    abortWithReason(parent, { kind: "external", origin: "scheduler" });
    const child = forkController(parent.signal);

    expect(child.signal.aborted).toBe(true);
    const r = getAbortReason(child.signal);
    expect(r?.kind).toBe("parent-abort");
    if (r?.kind === "parent-abort") {
      expect(r.parentReason?.kind).toBe("external");
    }
  });

  it("子 abort → 父不受影响", () => {
    const parent = createInterruptController();
    const child = forkController(parent.signal);

    abortWithReason(child, { kind: "user-cancel", source: "esc", pressedAt: 1 });
    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it("多个子 + 任一子 abort → 父和其他兄弟不受影响", () => {
    const parent = createInterruptController();
    const c1 = forkController(parent.signal);
    const c2 = forkController(parent.signal);
    const c3 = forkController(parent.signal);

    abortWithReason(c2, { kind: "user-cancel", source: "esc", pressedAt: 1 });

    expect(c2.signal.aborted).toBe(true);
    expect(c1.signal.aborted).toBe(false);
    expect(c3.signal.aborted).toBe(false);
    expect(parent.signal.aborted).toBe(false);
  });

  it("嵌套 fork:父 abort → 子和孙都 abort", () => {
    const parent = createInterruptController();
    const child = forkController(parent.signal);
    const grand = forkController(child.signal);

    abortWithReason(parent, { kind: "user-cancel", source: "ctrl-c", pressedAt: 2 });

    expect(parent.signal.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(grand.signal.aborted).toBe(true);

    expect(getAbortReason(child.signal)?.kind).toBe("parent-abort");
    expect(getAbortReason(grand.signal)?.kind).toBe("parent-abort");
  });

  it("仅持有 signal 的方也能 fork(子 agent 收到 parentSignal 的常见路径)", () => {
    // 接 AbortSignal 而非 AbortController 的关键收益:任何持有 signal 的方都能 fork。
    // 这里模拟"子 agent 通过函数参数收到 parent.signal,自己 fork 出 childController"
    // 的典型链路——无需父把 controller 暴露出来,就能建立父子 abort 传播关系。
    const parent = createInterruptController();
    const parentSignalView: AbortSignal = parent.signal;

    const child = forkController(parentSignalView);
    expect(child).toBeInstanceOf(AbortController);
    expect(child.signal.aborted).toBe(false);

    abortWithReason(parent, { kind: "user-cancel", source: "esc", pressedAt: 1 });
    expect(child.signal.aborted).toBe(true);
  });

  it("父 reason 未识别(裸 abort)→ 子的 parentReason 为 null", () => {
    const parent = new AbortController();
    parent.abort();
    const child = forkController(parent.signal);

    expect(child.signal.aborted).toBe(true);
    const r = getAbortReason(child.signal);
    expect(r?.kind).toBe("parent-abort");
    if (r?.kind === "parent-abort") {
      expect(r.parentReason).toBeNull();
    }
  });
});
