/**
 * DefaultTypeaheadBroker 单元测试
 *
 * 覆盖点（spec §5.5 合约 + §6.5 零键执行不变量）：
 *   - 会话生命周期：begin / update / accept / cancel
 *   - 零键执行：suggestions 非空时 selectedIndex 自动 0
 *   - 同步 / 异步 provider 的正确处理
 *   - AbortController：旧 query 被取消，stale 结果不污染 state
 *   - Provider 优先级：priority 小的先匹配，首个命中胜出
 *   - Provider 异常：降级到空，不传染，发 provider-error 事件
 *   - Accept：SuggestionItem → AcceptResult（draft 替换 + cursor + execute）
 *   - MoveSelection：clamp 非循环
 *   - onSessionChange：state 变更通知
 *   - EventSink：事件发射序列
 *   - 重复 provider id 抛 Error
 *   - Timeout：query 超时自动 abort
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DefaultTypeaheadBroker } from "../broker.js";
import type { TypeaheadEvent, TypeaheadEventSink } from "../events.js";
import type {
  RuntimeContext,
  SuggestionItem,
  SuggestionProvider,
  TriggerContext,
  TriggerMatch,
  TypeaheadSessionState,
} from "../types.js";

// ─── 辅助 ───

function makeRuntime(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: "/tmp",
    target: "cli",
    features: {},
    now: 1_700_000_000_000,
    ...overrides,
  };
}

function makeCtx(
  draft: string,
  cursor = draft.length,
): TriggerContext {
  return {
    draft,
    cursor,
    mode: "prompt",
    runtime: makeRuntime(),
  };
}

function makeItem(
  id: string,
  overrides: Partial<SuggestionItem> = {},
): SuggestionItem {
  return {
    id,
    providerId: overrides.providerId ?? "test",
    displayText: overrides.displayText ?? `/${id}`,
    acceptPayload: {
      replacement: `/${id}`,
      execute: true,
      ...overrides.acceptPayload,
    },
    ...overrides,
  };
}

/** 构造一个同步 provider：按 prefix 触发 */
function makeSyncProvider(
  id: string,
  priority: number,
  triggerChar: string,
  items: SuggestionItem[] = [makeItem(`${id}-item`, { providerId: id })],
): SuggestionProvider {
  return {
    id,
    priority,
    matchTrigger: (ctx) => {
      if (!ctx.draft.includes(triggerChar)) return null;
      const idx = ctx.draft.indexOf(triggerChar);
      return {
        providerId: id,
        tokenStart: idx,
        tokenEnd: ctx.draft.length,
        token: ctx.draft.slice(idx),
        query: ctx.draft.slice(idx + 1),
        runtime: ctx.runtime,
      };
    },
    query: () => items,
  };
}

/** 构造一个异步 provider */
function makeAsyncProvider(
  id: string,
  priority: number,
  triggerChar: string,
  itemsFactory: () => Promise<SuggestionItem[]>,
): SuggestionProvider {
  return {
    id,
    priority,
    matchTrigger: (ctx) => {
      if (!ctx.draft.includes(triggerChar)) return null;
      const idx = ctx.draft.indexOf(triggerChar);
      return {
        providerId: id,
        tokenStart: idx,
        tokenEnd: ctx.draft.length,
        token: ctx.draft.slice(idx),
        query: ctx.draft.slice(idx + 1),
        runtime: ctx.runtime,
      };
    },
    query: async (_match, signal) => {
      const items = await itemsFactory();
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      return items;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

// ─── 会话生命周期 ───

describe("DefaultTypeaheadBroker — 会话生命周期", () => {
  it("beginSession 返回 handle，session 进入 map", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx(""));
    expect(handle.id).toMatch(/.+/);
    expect(broker.snapshot().activeSessions).toBe(1);
  });

  it("无 provider 时 state 为空", () => {
    const broker = new DefaultTypeaheadBroker();
    const handle = broker.beginSession(makeCtx("/"));
    const state = broker.getState(handle.id);
    expect(state?.suggestions).toEqual([]);
    expect(state?.selectedIndex).toBe(-1);
  });

  it("初始 ctx 包含 trigger 时 beginSession 直接匹配", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    const state = broker.getState(handle.id);
    expect(state?.activeProvider?.id).toBe("p");
    expect(state?.suggestions.length).toBe(1);
  });

  it("activeProvider 是 UI-facing 投影 —— 仅含 id，不暴露 provider 内部方法（封装边界）", () => {
    // 类型层契约：TypeaheadSessionState.activeProvider: ActiveProviderInfo | null
    // 仅含 { id }，不含 matchTrigger / query 等内部能力 —— 让 renderer 是被动观察者，
    // 同时让 state 天然可序列化（未来跨进程 / Web 推送零成本）
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    const state = broker.getState(handle.id);
    const ap = state?.activeProvider;
    expect(ap).not.toBeNull();
    expect(ap!.id).toBe("p");
    // 运行时层确认：暴露字段仅有 id（不应包含 matchTrigger / query / priority）
    expect(Object.keys(ap!)).toEqual(["id"]);
    // 可序列化校验：JSON 往返无信息损失（plain data 不变量）
    expect(JSON.parse(JSON.stringify(ap))).toEqual({ id: "p" });
  });

  it("cancelSession 删除 session 并发 session-ended 事件", () => {
    const events: TypeaheadEvent[] = [];
    const broker = new DefaultTypeaheadBroker({
      eventSink: (e) => events.push(e),
    });
    const handle = broker.beginSession(makeCtx(""));
    broker.cancelSession(handle.id);
    expect(broker.snapshot().activeSessions).toBe(0);
    expect(events.map((e) => e.type)).toContain("typeahead:session-ended");
  });

  it("cancelSession 不存在的 id 不 throw", () => {
    const broker = new DefaultTypeaheadBroker();
    expect(() => broker.cancelSession("nonexistent")).not.toThrow();
  });
});

// ─── Provider 注册 ───

describe("DefaultTypeaheadBroker — Provider 注册", () => {
  it("register 返回 unregister 函数", () => {
    const broker = new DefaultTypeaheadBroker();
    const unreg = broker.register(makeSyncProvider("p", 100, "/"));
    expect(broker.snapshot().providerCount).toBe(1);
    unreg();
    expect(broker.snapshot().providerCount).toBe(0);
  });

  it("多 provider 按 priority 升序排序（snapshot 反映顺序）", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("c", 300, "#"));
    broker.register(makeSyncProvider("a", 100, "/"));
    broker.register(makeSyncProvider("b", 200, "@"));
    const snap = broker.snapshot();
    expect(snap.providers.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("重复 provider id 抛 Error", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    expect(() =>
      broker.register(makeSyncProvider("p", 200, "@")),
    ).toThrow(/duplicate provider/);
  });
});

// ─── 优先级与 first match wins ───

describe("DefaultTypeaheadBroker — Provider 优先级", () => {
  it("priority 小的 provider 优先命中", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("low", 200, "/", [
        makeItem("low-item", { providerId: "low" }),
      ]),
    );
    broker.register(
      makeSyncProvider("high", 100, "/", [
        makeItem("high-item", { providerId: "high" }),
      ]),
    );
    const handle = broker.beginSession(makeCtx("/x"));
    const state = broker.getState(handle.id);
    expect(state?.activeProvider?.id).toBe("high");
    expect(state?.suggestions[0]!.id).toBe("high-item");
  });

  it("第一个返回非 null 的 provider 获胜（即使 priority 低）", () => {
    const broker = new DefaultTypeaheadBroker();
    // priority 100 但只响应 @ 触发
    broker.register(makeSyncProvider("at-provider", 100, "@"));
    // priority 200 响应 / 触发
    broker.register(makeSyncProvider("slash-provider", 200, "/"));
    const handle = broker.beginSession(makeCtx("/x"));
    // at-provider 的 matchTrigger 对 /x 返回 null，slash-provider 命中
    const state = broker.getState(handle.id);
    expect(state?.activeProvider?.id).toBe("slash-provider");
  });
});

// ─── 零键执行不变量 ───

describe("DefaultTypeaheadBroker — 零键执行不变量（spec §6.5）", () => {
  it("suggestions 非空时 selectedIndex 为 0", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        makeItem("a", { providerId: "p" }),
        makeItem("b", { providerId: "p" }),
        makeItem("c", { providerId: "p" }),
      ]),
    );
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.selectedIndex).toBe(0);
  });

  it("suggestions 为空时 selectedIndex 为 -1", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/", []));
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.selectedIndex).toBe(-1);
  });

  it("更新 input 且新结果非空 → index 重置到 0（即使用户之前导航过）", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        makeItem("a", { providerId: "p" }),
        makeItem("b", { providerId: "p" }),
      ]),
    );
    const handle = broker.beginSession(makeCtx("/"));
    broker.moveSelection(handle.id, 1); // 用户按了 ↓
    expect(broker.getState(handle.id)?.selectedIndex).toBe(1);
    // 用户继续打字，新一轮 query
    broker.updateInput(handle.id, makeCtx("/x"));
    expect(broker.getState(handle.id)?.selectedIndex).toBe(0); // 重置到 0
  });
});

// ─── MoveSelection: clamp 语义（非循环） ───

describe("DefaultTypeaheadBroker — moveSelection (clamp)", () => {
  function setup() {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        makeItem("a", { providerId: "p" }),
        makeItem("b", { providerId: "p" }),
        makeItem("c", { providerId: "p" }),
      ]),
    );
    const handle = broker.beginSession(makeCtx("/"));
    return { broker, handle };
  }

  it("向下移动", () => {
    const { broker, handle } = setup();
    broker.moveSelection(handle.id, 1);
    expect(broker.getState(handle.id)?.selectedIndex).toBe(1);
  });

  it("末尾再下移：停在末尾不动（非循环 clamp）", () => {
    const { broker, handle } = setup();
    broker.moveSelection(handle.id, 1);
    broker.moveSelection(handle.id, 1);
    broker.moveSelection(handle.id, 1); // 已到末尾
    broker.moveSelection(handle.id, 1); // 再按还是末尾
    expect(broker.getState(handle.id)?.selectedIndex).toBe(2);
  });

  it("首项再上移：停在首项不动（非循环 clamp）", () => {
    const { broker, handle } = setup();
    // 初始 index=0
    broker.moveSelection(handle.id, -1);
    expect(broker.getState(handle.id)?.selectedIndex).toBe(0);
  });

  it("末尾下移**不**触发 listener（clamp 无状态变化）", () => {
    const { broker, handle } = setup();
    broker.moveSelection(handle.id, 1);
    broker.moveSelection(handle.id, 1); // 到末尾 index=2
    let callCount = 0;
    broker.onSessionChange(handle.id, () => {
      callCount++;
    });
    broker.moveSelection(handle.id, 1); // 无变化
    expect(callCount).toBe(0);
  });

  it("空 suggestions 时 moveSelection no-op", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/", []));
    const handle = broker.beginSession(makeCtx(""));
    broker.moveSelection(handle.id, 1);
    expect(broker.getState(handle.id)?.selectedIndex).toBe(-1);
  });
});

// ─── Accept ───

describe("DefaultTypeaheadBroker — accept", () => {
  it("accept 替换 trigger token 并返回 AcceptResult", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        {
          id: "new",
          providerId: "p",
          displayText: "/new",
          acceptPayload: { replacement: "/new", execute: true },
        },
      ]),
    );
    const handle = broker.beginSession(makeCtx("/ne"));
    const state = broker.getState(handle.id)!;
    const result = broker.accept(
      handle.id,
      state.suggestions[0]!,
    );
    expect(result).toEqual(
      expect.objectContaining({
        newDraft: "/new",
        newCursor: 4,
        execute: true,
      }),
    );
  });

  it("accept 是 state-纯函数 —— 不动 session state（caller 通过 updateInput / cancelSession 驱动状态变更）", () => {
    // 架构契约：accept 仅 compute AcceptResult + emit telemetry，**不**触发任何 UI
    // 副作用。历史 drift（已修复 2026-05-13）：accept 内同步调 `setSessionState(makeEmptyState)`
    // 让 chrome 在 caller 写 buffer **之前**就用旧 buffer 重画一次 → TOCTOU。
    // 现在 accept 是 state-纯，caller 显式按"accept → setDraft → syncBroker/submit"
    // 顺序驱动状态机收敛。详见 broker.ts accept 方法的 docstring。
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        {
          id: "new",
          providerId: "p",
          displayText: "/new",
          acceptPayload: { replacement: "/new", execute: true },
        },
      ]),
    );
    const handle = broker.beginSession(makeCtx("/ne"));
    const beforeState = broker.getState(handle.id)!;
    expect(beforeState.trigger).not.toBeNull();
    expect(beforeState.suggestions.length).toBe(1);

    broker.accept(handle.id, beforeState.suggestions[0]!);

    // accept 后 session state 完全不变
    const afterState = broker.getState(handle.id)!;
    expect(afterState.trigger).toEqual(beforeState.trigger);
    expect(afterState.suggestions).toEqual(beforeState.suggestions);
    expect(afterState.selectedIndex).toBe(beforeState.selectedIndex);
  });

  it("accept 使用 acceptPayload.cursorOffset 显式位置", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        {
          id: "new",
          providerId: "p",
          displayText: "/new",
          acceptPayload: {
            replacement: "/new ",
            execute: false,
            cursorOffset: 5, // 落在空格后
          },
        },
      ]),
    );
    const handle = broker.beginSession(makeCtx("/ne"));
    const result = broker.accept(
      handle.id,
      broker.getState(handle.id)!.suggestions[0]!,
    );
    expect(result?.newDraft).toBe("/new ");
    expect(result?.newCursor).toBe(5);
    expect(result?.execute).toBe(false);
  });

  it("accept 中间插入 trigger：保留 draft 前后", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register({
      id: "p",
      priority: 100,
      matchTrigger: (ctx) => {
        // 模拟从 cursor 往前找 @ 触发
        const before = ctx.draft.slice(0, ctx.cursor);
        const atPos = before.lastIndexOf("@");
        if (atPos === -1) return null;
        const tokenEnd = ctx.cursor;
        return {
          providerId: "p",
          tokenStart: atPos,
          tokenEnd,
          token: ctx.draft.slice(atPos, tokenEnd),
          query: ctx.draft.slice(atPos + 1, tokenEnd),
          runtime: ctx.runtime,
        };
      },
      query: () => [
        {
          id: "file",
          providerId: "p",
          displayText: "@file.ts",
          acceptPayload: { replacement: "@file.ts", execute: false },
        },
      ],
    });
    const handle = broker.beginSession(makeCtx("look at @fi and run", 11));
    const result = broker.accept(
      handle.id,
      broker.getState(handle.id)!.suggestions[0]!,
    );
    expect(result?.newDraft).toBe("look at @file.ts and run");
  });

  it("accept 不存在的 session 返回 null", () => {
    const broker = new DefaultTypeaheadBroker();
    expect(broker.accept("ghost", makeItem("x"))).toBeNull();
  });
});

// ─── 异步 + Abort ───

describe("DefaultTypeaheadBroker — 异步 query 与 abort", () => {
  it("异步 provider：loading=true 先发，结果来后更新", async () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeAsyncProvider("async", 100, "/", async () => [
        makeItem("x", { providerId: "async" }),
      ]),
    );
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.loading).toBe(true);
    await tick();
    expect(broker.getState(handle.id)?.loading).toBe(false);
    expect(broker.getState(handle.id)?.suggestions).toHaveLength(1);
  });

  it("新 updateInput 到来时前次 query 被 abort，stale 结果丢弃", async () => {
    let firstResolve: (items: SuggestionItem[]) => void;
    let secondResolve: (items: SuggestionItem[]) => void;
    const firstPromise = new Promise<SuggestionItem[]>((r) => {
      firstResolve = r;
    });
    const secondPromise = new Promise<SuggestionItem[]>((r) => {
      secondResolve = r;
    });
    let callCount = 0;

    const broker = new DefaultTypeaheadBroker();
    broker.register({
      id: "p",
      priority: 100,
      matchTrigger: (ctx) =>
        ctx.draft.startsWith("/")
          ? {
              providerId: "p",
              tokenStart: 0,
              tokenEnd: ctx.draft.length,
              token: ctx.draft,
              query: ctx.draft.slice(1),
              runtime: ctx.runtime,
            }
          : null,
      query: () => {
        callCount++;
        return callCount === 1 ? firstPromise : secondPromise;
      },
    });

    const handle = broker.beginSession(makeCtx("/a"));
    // 第二次更新输入，第一次还没 resolve
    broker.updateInput(handle.id, makeCtx("/ab"));

    // 第一次迟到 resolve
    firstResolve!([makeItem("stale", { providerId: "p" })]);
    await tick();

    // 第二次结果
    secondResolve!([makeItem("fresh", { providerId: "p" })]);
    await tick();

    expect(broker.getState(handle.id)?.suggestions[0]!.id).toBe("fresh");
  });

  it("同 trigger 续 typing：emit trigger-refresh，canonical 保留前次（stale-while-revalidate）", async () => {
    // 架构契约：异步 provider 同 trigger 续 typing 时，broker emit 的 state 必须
    //   - trigger / activeProvider 字段：更新到新 match（accept 几何依赖）
    //   - suggestions / selectedIndex / ghostText / argumentHint：保留前次值
    //     （UI 在 query revalidate 期间展示稳定内容）
    //   - loading=false：不在 typing 期间闪烁 "loading…" title 污染候选展示
    //
    // 违反此契约则 panel 在 typing 期间显示 in-flight phase（empty + loading），
    // 与 resolve 后的 active state 高度不一致 → setChromeHeight transition=grew/shrunk
    // → DECSTBM 重排 → 视觉每键抖动一行。
    let firstResolve: (items: SuggestionItem[]) => void;
    let secondResolve: (items: SuggestionItem[]) => void;
    const firstPromise = new Promise<SuggestionItem[]>((r) => {
      firstResolve = r;
    });
    const secondPromise = new Promise<SuggestionItem[]>((r) => {
      secondResolve = r;
    });
    let callCount = 0;

    const broker = new DefaultTypeaheadBroker();
    broker.register({
      id: "p",
      priority: 100,
      matchTrigger: (ctx) =>
        ctx.draft.startsWith("/")
          ? {
              providerId: "p",
              tokenStart: 0,
              tokenEnd: ctx.draft.length,
              token: ctx.draft,
              query: ctx.draft.slice(1),
              runtime: ctx.runtime,
            }
          : null,
      query: () => {
        callCount++;
        return callCount === 1 ? firstPromise : secondPromise;
      },
    });

    const handle = broker.beginSession(makeCtx("/a"));
    // beginSession 触发 isNewTrigger=true → emit 初始 loading state
    expect(broker.getState(handle.id)?.loading).toBe(true);
    expect(broker.getState(handle.id)?.suggestions).toEqual([]);

    // 第一次 query resolve
    firstResolve!([
      makeItem("alpha", { providerId: "p" }),
      makeItem("beta", { providerId: "p" }),
      makeItem("gamma", { providerId: "p" }),
    ]);
    await tick();
    expect(broker.getState(handle.id)?.loading).toBe(false);
    expect(broker.getState(handle.id)?.suggestions).toHaveLength(3);
    expect(broker.getState(handle.id)?.selectedIndex).toBe(0);

    // 模拟用户移动选中到 idx=2，然后继续 typing
    broker.moveSelection(handle.id, 2);
    expect(broker.getState(handle.id)?.selectedIndex).toBe(2);

    // 续 typing：tokenStart 不变（都是 0），provider 不变 → isNewTrigger=false
    broker.updateInput(handle.id, makeCtx("/ab"));

    // 关键断言：trigger 几何已更新 + canonical 保留 + loading=false
    const afterTyping = broker.getState(handle.id)!;
    expect(afterTyping.trigger?.tokenEnd).toBe(3); // 新 trigger 几何
    expect(afterTyping.trigger?.query).toBe("ab");
    expect(afterTyping.suggestions).toHaveLength(3); // canonical 保留
    expect(afterTyping.suggestions[0]!.id).toBe("alpha");
    expect(afterTyping.selectedIndex).toBe(2); // 用户的选中位置保留
    expect(afterTyping.loading).toBe(false); // 不闪 "loading…"

    // 第二次 resolve 后才一次性 swap 为新 canonical
    secondResolve!([makeItem("delta", { providerId: "p" })]);
    await tick();
    expect(broker.getState(handle.id)?.suggestions).toHaveLength(1);
    expect(broker.getState(handle.id)?.suggestions[0]!.id).toBe("delta");
    expect(broker.getState(handle.id)?.selectedIndex).toBe(0); // resolve 时 spec §6.5 重置
  });

  it("续 typing 期间 listener 仅在状态变化的边界处 fire（无 in-flight 中间态污染）", async () => {
    // 架构契约：每次 updateInput 必有 1 次 emit（让 UI 重画输入框新字符 +
    // trigger 几何更新），每次 query resolve 多 1 次 emit。N 次 typing + 异步
    // provider → 总 emit 数 = N（trigger-refresh）+ 实际 resolve 次数。
    //
    // 关键：每次 typing 的 emit 不再走 "wipe-canonical-then-fill" 双 emit 模式
    // —— typing 1 次 ≠ listener fire 2 次。
    let resolveFn: (items: SuggestionItem[]) => void = () => {};
    const broker = new DefaultTypeaheadBroker();
    broker.register({
      id: "p",
      priority: 100,
      matchTrigger: (ctx) =>
        ctx.draft.startsWith("/")
          ? {
              providerId: "p",
              tokenStart: 0,
              tokenEnd: ctx.draft.length,
              token: ctx.draft,
              query: ctx.draft.slice(1),
              runtime: ctx.runtime,
            }
          : null,
      query: () =>
        new Promise<SuggestionItem[]>((r) => {
          resolveFn = r;
        }),
    });

    const handle = broker.beginSession(makeCtx("/a"));
    const fires: TypeaheadSessionState[] = [];
    broker.onSessionChange(handle.id, (s) => fires.push(s));

    // beginSession 已 emit 1 次（onSessionChange 订阅前），不计入 fires
    // 续 typing 5 次（同 trigger）
    broker.updateInput(handle.id, makeCtx("/ab"));
    broker.updateInput(handle.id, makeCtx("/abc"));
    broker.updateInput(handle.id, makeCtx("/abcd"));
    broker.updateInput(handle.id, makeCtx("/abcde"));
    broker.updateInput(handle.id, makeCtx("/abcdef"));

    // 5 次 trigger-refresh emit（同步触发）
    expect(fires).toHaveLength(5);
    // 全部 loading=false（不在 typing 期间闪 loading 中间态）
    expect(fires.every((s) => s.loading === false)).toBe(true);

    // 最后一次 query resolve
    resolveFn([makeItem("result", { providerId: "p" })]);
    await tick();

    // 再 1 次 emit（canonical swap），前面 5 次 query 都被 abort
    expect(fires).toHaveLength(6);
    expect(fires[5]!.suggestions).toHaveLength(1);
    expect(fires[5]!.loading).toBe(false);
  });

  it("续 typing 期间 accept 用新鲜 trigger 几何（不被 stale canonical 误导）", () => {
    // 架构契约：trigger 几何字段每次 updateInput 必须新鲜。即使 canonical
    // suggestions 是 stale 的（来自前次 query），accept() 计算 replacement
    // 几何用的是 **当前 trigger.tokenStart / tokenEnd**——保证替换永远落在
    // 用户当前 typed 的 token 边界，不会留尾巴或越界。
    let resolveFn: (items: SuggestionItem[]) => void = () => {};
    const broker = new DefaultTypeaheadBroker();
    broker.register({
      id: "p",
      priority: 100,
      matchTrigger: (ctx) =>
        ctx.draft.startsWith("/")
          ? {
              providerId: "p",
              tokenStart: 0,
              tokenEnd: ctx.draft.length,
              token: ctx.draft,
              query: ctx.draft.slice(1),
              runtime: ctx.runtime,
            }
          : null,
      query: () =>
        new Promise<SuggestionItem[]>((r) => {
          resolveFn = r;
        }),
    });

    const handle = broker.beginSession(makeCtx("/a"));
    // 让 /a 的 query resolve 一次拿到 canonical
    resolveFn([
      makeItem("foo", {
        providerId: "p",
        acceptPayload: { replacement: "/foo", execute: true },
      }),
    ]);
    return tick().then(() => {
      // 续 typing 到 /abcdef（同 trigger，token 边界从 2 变到 7）
      broker.updateInput(handle.id, makeCtx("/abcdef"));

      // 此时 suggestions 仍是 stale /a 的（foo），但 trigger 几何已新鲜
      const state = broker.getState(handle.id)!;
      expect(state.suggestions).toHaveLength(1);
      expect(state.trigger?.tokenEnd).toBe(7);

      // 用户 accept stale 候选 foo —— replacement 应替换 /abcdef 全部（tokenStart=0
      // 到 tokenEnd=7），不留尾巴
      const result = broker.accept(handle.id, state.suggestions[0]!);
      expect(result?.newDraft).toBe("/foo"); // /abcdef 整段被 /foo 替换
      expect(result?.newCursor).toBe(4); // /foo 末尾
    });
  });

  it("Provider 同步抛异常：降级到空 + 发 provider-error 事件", () => {
    const events: TypeaheadEvent[] = [];
    const broker = new DefaultTypeaheadBroker({
      eventSink: (e) => events.push(e),
    });
    broker.register({
      id: "broken",
      priority: 100,
      matchTrigger: (ctx) =>
        ctx.draft.startsWith("/")
          ? {
              providerId: "broken",
              tokenStart: 0,
              tokenEnd: 1,
              token: "/",
              query: "",
              runtime: ctx.runtime,
            }
          : null,
      query: () => {
        throw new Error("boom");
      },
    });
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.suggestions).toEqual([]);
    const errorEvents = events.filter(
      (e) => e.type === "typeahead:provider-error",
    );
    expect(errorEvents).toHaveLength(1);
    expect(handle).toBeDefined();
  });

  it("Provider 异步 reject：降级到空 + 发 provider-error 事件", async () => {
    const events: TypeaheadEvent[] = [];
    const broker = new DefaultTypeaheadBroker({
      eventSink: (e) => events.push(e),
    });
    broker.register(
      makeAsyncProvider("async-broken", 100, "/", async () => {
        throw new Error("async boom");
      }),
    );
    broker.beginSession(makeCtx("/"));
    await tick();
    expect(
      events.some((e) => e.type === "typeahead:provider-error"),
    ).toBe(true);
  });

  it("provider.matchTrigger 抛异常不阻塞后续 provider", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register({
      id: "broken-match",
      priority: 100,
      matchTrigger: () => {
        throw new Error("match boom");
      },
      query: () => [],
    });
    broker.register(
      makeSyncProvider("backup", 200, "/", [
        makeItem("backup-item", { providerId: "backup" }),
      ]),
    );
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.activeProvider?.id).toBe("backup");
  });
});

// ─── onSessionChange ───

describe("DefaultTypeaheadBroker — onSessionChange", () => {
  it("订阅后 state 变化会被通知", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        makeItem("a", { providerId: "p" }),
      ]),
    );
    const handle = broker.beginSession(makeCtx(""));
    const states: TypeaheadSessionState[] = [];
    broker.onSessionChange(handle.id, (s) => states.push(s));
    broker.updateInput(handle.id, makeCtx("/"));
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[states.length - 1]!.suggestions).toHaveLength(1);
  });

  it("unsubscribe 后停止通知", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx(""));
    const states: TypeaheadSessionState[] = [];
    const unsub = broker.onSessionChange(handle.id, (s) => states.push(s));
    broker.updateInput(handle.id, makeCtx("/"));
    const countAfterFirst = states.length;
    unsub();
    broker.updateInput(handle.id, makeCtx("/x"));
    expect(states.length).toBe(countAfterFirst);
  });
});

// ─── EventSink 时序 ───

describe("DefaultTypeaheadBroker — 事件发射", () => {
  it("完整一轮的事件序列包含 started / trigger-detected / query-started / query-completed", () => {
    const events: TypeaheadEvent[] = [];
    const broker = new DefaultTypeaheadBroker({
      eventSink: (e) => events.push(e),
    });
    broker.register(
      makeSyncProvider("p", 100, "/", [
        makeItem("a", { providerId: "p" }),
      ]),
    );
    broker.beginSession(makeCtx("/"));
    const types = events.map((e) => e.type);
    expect(types).toContain("typeahead:session-started");
    expect(types).toContain("typeahead:trigger-detected");
    expect(types).toContain("typeahead:query-started");
    expect(types).toContain("typeahead:query-completed");
  });

  it("trigger 从有变无时发 trigger-cleared", () => {
    const events: TypeaheadEvent[] = [];
    const broker = new DefaultTypeaheadBroker({
      eventSink: (e) => events.push(e),
    });
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    events.length = 0; // 清空前半段
    broker.updateInput(handle.id, makeCtx("no-trigger"));
    expect(
      events.some((e) => e.type === "typeahead:trigger-cleared"),
    ).toBe(true);
  });

  it("accept 发 suggestion-accepted 事件", () => {
    const events: TypeaheadEvent[] = [];
    const broker = new DefaultTypeaheadBroker({
      eventSink: (e) => events.push(e),
    });
    broker.register(
      makeSyncProvider("p", 100, "/", [
        {
          id: "x",
          providerId: "p",
          displayText: "/x",
          acceptPayload: { replacement: "/x", execute: true },
        },
      ]),
    );
    const handle = broker.beginSession(makeCtx("/"));
    broker.accept(handle.id, broker.getState(handle.id)!.suggestions[0]!);
    expect(
      events.some((e) => e.type === "typeahead:suggestion-accepted"),
    ).toBe(true);
  });
});

// ─── deletable / deletePending / refresh ───

describe("DefaultTypeaheadBroker — deletable / deletePending / refresh", () => {
  it("provider 实现 computeDeletable=true → state.deletable=true", () => {
    const broker = new DefaultTypeaheadBroker();
    const provider: SuggestionProvider = {
      ...makeSyncProvider("p", 100, "/"),
      computeDeletable: () => true,
    };
    broker.register(provider);
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.deletable).toBe(true);
  });

  it("provider 未实现 computeDeletable → state.deletable=false", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.deletable).toBe(false);
  });

  it("provider.computeDeletable 抛错 → 降级 false + 不传染", () => {
    const broker = new DefaultTypeaheadBroker();
    const provider: SuggestionProvider = {
      ...makeSyncProvider("p", 100, "/"),
      computeDeletable: () => {
        throw new Error("boom");
      },
    };
    broker.register(provider);
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.deletable).toBe(false);
    expect(broker.getState(handle.id)?.suggestions.length).toBeGreaterThan(0);
  });

  it("初始 state.deletePending === null", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.deletePending).toBeNull();
  });

  it("markDeletePending 设置后 state.deletePending 反映 + emit listener", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    const states: TypeaheadSessionState[] = [];
    broker.onSessionChange(handle.id, (s) => states.push(s));
    broker.markDeletePending(handle.id, "candidate-id-1");
    expect(broker.getState(handle.id)?.deletePending).toBe("candidate-id-1");
    expect(states.at(-1)?.deletePending).toBe("candidate-id-1");
  });

  it("markDeletePending(null) 清空准备态", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    broker.markDeletePending(handle.id, "x");
    broker.markDeletePending(handle.id, null);
    expect(broker.getState(handle.id)?.deletePending).toBeNull();
  });

  it("单源不变量:markDeletePending 设置后 → moveSelection 自动 reset", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(
      makeSyncProvider("p", 100, "/", [
        makeItem("a"),
        makeItem("b"),
      ]),
    );
    const handle = broker.beginSession(makeCtx("/"));
    broker.markDeletePending(handle.id, "a");
    expect(broker.getState(handle.id)?.deletePending).toBe("a");
    broker.moveSelection(handle.id, 1);
    expect(broker.getState(handle.id)?.deletePending).toBeNull();
  });

  it("单源不变量:markDeletePending 设置后 → updateInput 自动 reset", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    broker.markDeletePending(handle.id, "x");
    broker.updateInput(handle.id, makeCtx("/foo"));
    expect(broker.getState(handle.id)?.deletePending).toBeNull();
  });

  it("单源不变量:cancelSession → deletePending 清空", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    broker.markDeletePending(handle.id, "x");
    broker.cancelSession(handle.id);
    // cancelSession 之后 session 仍可读(state 已重置为空)
    expect(broker.getState(handle.id)?.deletePending ?? null).toBeNull();
  });

  it("refresh: trigger 仍命中 → canonical 重置 + 重新 query", async () => {
    let queryCount = 0;
    const broker = new DefaultTypeaheadBroker();
    broker.register({
      id: "p",
      priority: 100,
      matchTrigger: (ctx) => {
        if (!ctx.draft.startsWith("/")) return null;
        return {
          providerId: "p",
          tokenStart: 0,
          tokenEnd: ctx.draft.length,
          token: ctx.draft,
          query: ctx.draft.slice(1),
          runtime: ctx.runtime,
        };
      },
      query: () => {
        queryCount++;
        return [makeItem(`v${queryCount}`, { providerId: "p" })];
      },
    });
    const handle = broker.beginSession(makeCtx("/"));
    expect(queryCount).toBe(1);
    broker.refresh(handle.id);
    expect(queryCount).toBe(2);
    expect(broker.getState(handle.id)?.suggestions[0]?.id).toBe("v2");
  });

  it("refresh: trigger 已 gone(用户清空 draft)→ 退化清空 state", () => {
    const broker = new DefaultTypeaheadBroker();
    broker.register(makeSyncProvider("p", 100, "/"));
    const handle = broker.beginSession(makeCtx("/"));
    expect(broker.getState(handle.id)?.activeProvider).not.toBeNull();
    // 模拟用户清空 draft
    broker.updateInput(handle.id, makeCtx(""));
    broker.refresh(handle.id);
    expect(broker.getState(handle.id)?.activeProvider).toBeNull();
    expect(broker.getState(handle.id)?.suggestions).toEqual([]);
  });

  it("refresh: 不存在 sessionId → no-op 不抛", () => {
    const broker = new DefaultTypeaheadBroker();
    expect(() => broker.refresh("ghost")).not.toThrow();
  });

  it("markDeletePending: 不存在 sessionId → no-op 不抛", () => {
    const broker = new DefaultTypeaheadBroker();
    expect(() => broker.markDeletePending("ghost", "x")).not.toThrow();
  });
});
