/**
 * TypeaheadPanel 单元测试
 *
 * 覆盖点（spec §7 + §6.4 护栏回归）：
 *   纯函数：
 *     - computeWindow 的 8 类边界（空/全装下/居中/贴头/贴尾/滚动标志）
 *     - renderSessionLines 的 inactive / empty / loading / active / CJK 分支
 *   有状态：
 *     - attach/detach 资源生命周期
 *     - session state 变更驱动 rerender（帧 diff 恒等）
 *     - ↑↓ 委派 broker.moveSelection（panel 不 mutate state）
 *     - Enter / Tab 触发 onAccept 传递 selected item
 *     - Esc / Ctrl+C 触发 onCancel
 *     - Active ↔ Inactive 态切换时 clear 无残留
 *     - §6.4 护栏：rerender 次数恒等式（K 次 render N 行 → K*N 次 clearLine）
 *     - stdin-ownership 在 attach 时摘除 saved listeners、detach 时恢复
 *     - raw-mode 引用计数正确增减
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ITypeaheadBroker,
  SuggestionItem,
  SuggestionProvider,
  TriggerMatch,
  TypeaheadSessionHandle,
  TypeaheadSessionState,
  Unsubscribe,
} from "@zhixing/core";

import { stripAnsi } from "../ansi.js";
import {
  _getRawModeRefcount,
  _resetRawModeRefcountForTests,
} from "../_internal/raw-mode.js";
import {
  computeWindow,
  createTypeaheadPanel,
  defaultTypeaheadTheme,
  renderSessionLines,
  type RenderOptions,
} from "../typeahead-panel.js";

// ─── 测试辅助 ───

function makeStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;

  let captured = "";
  stdout.on("data", (chunk: Buffer | string) => {
    captured += chunk.toString("utf8");
  });

  return {
    stdin,
    stdout,
    getCaptured: () => captured,
    clearCaptured: () => {
      captured = "";
    },
  };
}

async function sendSyntheticKey(
  stdin: NodeJS.ReadableStream,
  key: { name: string; ctrl?: boolean; meta?: boolean; sequence?: string },
): Promise<void> {
  (stdin as unknown as EventEmitter).emit("keypress", key.sequence ?? "", {
    name: key.name,
    ctrl: key.ctrl ?? false,
    meta: key.meta ?? false,
    shift: false,
    sequence: key.sequence ?? "",
  });
  await new Promise((resolve) => setImmediate(resolve));
}

function makeSuggestion(
  id: string,
  displayText: string,
  description?: string,
): SuggestionItem {
  return {
    id,
    providerId: "command",
    displayText,
    description,
    acceptPayload: {
      replacement: displayText,
      execute: true,
      executionHint: "local",
      metadata: { commandId: id },
    },
  };
}

function makeTrigger(token = "/", query = ""): TriggerMatch {
  return {
    providerId: "command",
    tokenStart: 0,
    tokenEnd: token.length,
    token,
    query,
    runtime: {
      sessionBusy: false,
      workspaceId: null,
      cwd: "/tmp",
      target: "cli",
      features: {},
      now: 0,
    },
  };
}

const dummyProvider: SuggestionProvider = {
  id: "command",
  priority: 100,
  matchTrigger: () => null,
  query: () => [],
};

function makeState(
  partial: Partial<TypeaheadSessionState> = {},
): TypeaheadSessionState {
  return {
    sessionId: "test-session",
    activeProvider: { id: dummyProvider.id },
    trigger: makeTrigger(),
    suggestions: [],
    selectedIndex: -1,
    loading: false,
    ghostText: null,
    argumentHint: null,
    ...partial,
  };
}

/**
 * 一个最小的 broker stub：持有 state + 一个监听器，moveSelection 更新 state
 * 并通知监听器。不参与 provider 注册或 query —— 测试只关注 panel ↔ broker
 * 的交互契约。
 */
function makeBrokerStub(initial: TypeaheadSessionState) {
  let state: TypeaheadSessionState = initial;
  const listeners = new Set<(state: TypeaheadSessionState) => void>();
  const moveSelectionSpy = vi.fn<(delta: number) => void>();
  const acceptSpy = vi.fn();
  const cancelSessionSpy = vi.fn();

  const broker: ITypeaheadBroker = {
    register: () => () => {},
    listProviders: () => [],
    beginSession: (): TypeaheadSessionHandle => ({ id: "test-session" }),
    updateInput: () => {},
    accept: (_sessionId, _item) => {
      acceptSpy(_sessionId, _item);
      return null;
    },
    moveSelection: (_sessionId, delta) => {
      moveSelectionSpy(delta);
      const len = state.suggestions.length;
      if (len === 0) return;
      const next = ((state.selectedIndex + delta) % len + len) % len;
      state = { ...state, selectedIndex: next };
      for (const l of Array.from(listeners)) l(state);
    },
    cancelSession: () => {
      cancelSessionSpy();
    },
    getState: () => state,
    onSessionChange: (_sessionId, listener): Unsubscribe => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => ({
      activeSessions: 1,
      providerCount: 0,
      providers: [],
    }),
  };

  return {
    broker,
    setState: (next: TypeaheadSessionState) => {
      state = next;
      for (const l of Array.from(listeners)) l(state);
    },
    moveSelectionSpy,
    acceptSpy,
    cancelSessionSpy,
    get currentState() {
      return state;
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

const defaultRenderOpts: RenderOptions = {
  theme: defaultTypeaheadTheme,
  frameWidth: 60,
  innerWidth: 58,
  maxVisibleItems: 8,
};

beforeEach(() => {
  _resetRawModeRefcountForTests();
});

afterEach(() => {
  _resetRawModeRefcountForTests();
});

// ─── computeWindow 纯函数 ───

describe("computeWindow", () => {
  it("空列表返回空窗口 + isScrollable=false", () => {
    expect(computeWindow(0, 0, 8)).toEqual({
      start: 0,
      end: 0,
      showTopScroll: false,
      showBottomScroll: false,
      isScrollable: false,
    });
  });

  it("maxVisible 为 0 返回空窗口", () => {
    expect(computeWindow(10, 5, 0)).toEqual({
      start: 0,
      end: 0,
      showTopScroll: false,
      showBottomScroll: false,
      isScrollable: false,
    });
  });

  it("total <= maxVisible 时返回全部 + isScrollable=false", () => {
    expect(computeWindow(5, 2, 8)).toEqual({
      start: 0,
      end: 5,
      showTopScroll: false,
      showBottomScroll: false,
      isScrollable: false,
    });
  });

  it("total > maxVisible 时 isScrollable=true（任何选中位置）", () => {
    for (const sel of [0, 5, 10, 19]) {
      expect(computeWindow(20, sel, 5).isScrollable).toBe(true);
    }
  });

  it("选中项在开头时贴顶（底部 more...）", () => {
    const w = computeWindow(20, 0, 5);
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
    expect(w.showTopScroll).toBe(false);
    expect(w.showBottomScroll).toBe(true);
  });

  it("选中项在末尾时贴底（顶部 more...）", () => {
    const w = computeWindow(20, 19, 5);
    expect(w.start).toBe(15);
    expect(w.end).toBe(20);
    expect(w.showTopScroll).toBe(true);
    expect(w.showBottomScroll).toBe(false);
  });

  it("选中项在中间时尝试居中", () => {
    // maxVisible=5 → before=2，selected=10 → start=8, end=13
    const w = computeWindow(20, 10, 5);
    expect(w.start).toBe(8);
    expect(w.end).toBe(13);
    expect(w.showTopScroll).toBe(true);
    expect(w.showBottomScroll).toBe(true);
  });

  it("maxVisible=1 时窗口总是 1 个元素", () => {
    const w = computeWindow(100, 42, 1);
    expect(w.end - w.start).toBe(1);
    expect(w.start).toBe(42);
  });

  it("选中项超出 total 被 clamp", () => {
    const w = computeWindow(5, 999, 3);
    expect(w.start).toBe(2);
    expect(w.end).toBe(5);
  });
});

// ─── renderSessionLines 纯函数 ───

describe("renderSessionLines", () => {
  it("无 trigger 时返回空数组（inactive 态不占行）", () => {
    const state = makeState({ trigger: null, activeProvider: null });
    expect(renderSessionLines(state, defaultRenderOpts)).toEqual([]);
  });

  it("trigger 有但 activeProvider 为 null 时返回空数组", () => {
    const state = makeState({ activeProvider: null });
    expect(renderSessionLines(state, defaultRenderOpts)).toEqual([]);
  });

  it("loading 态渲染 loading 标题 + 占位行", () => {
    const state = makeState({ loading: true, suggestions: [] });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("loading");
    expect(joined).toContain("正在加载候选");
  });

  it("空结果态显示 no matches + 未找到提示", () => {
    const state = makeState({ suggestions: [], selectedIndex: -1 });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("no matches");
    expect(joined).toContain("未找到匹配项");
  });

  it("非空结果显示 Commands · N matches 标题", () => {
    const state = makeState({
      suggestions: [
        makeSuggestion("new:b", "/new", "Start new session"),
        makeSuggestion("reset:b", "/reset"),
      ],
      selectedIndex: 0,
    });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("Commands · 2 matches");
    expect(joined).toContain("/new");
    expect(joined).toContain("Start new session");
  });

  it("单个匹配用 '1 match' 单数形式", () => {
    const state = makeState({
      suggestions: [makeSuggestion("new:b", "/new")],
      selectedIndex: 0,
    });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("1 match");
    expect(joined).not.toContain("1 matches");
  });

  it("选中项用 selectedArrow ▸（design token icon.cursor）", () => {
    const state = makeState({
      suggestions: [
        makeSuggestion("a:b", "/a"),
        makeSuggestion("b:b", "/b"),
      ],
      selectedIndex: 1,
    });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const stripped = lines.map(stripAnsi);
    // 第一个候选行用 unselectedArrow "  "，第二个用 "▸ "（与 config-editor 等其他面板共享）
    const bLine = stripped.find((l) => l.includes("/b"))!;
    expect(bLine).toContain("▸");
    const aLine = stripped.find((l) => l.includes("/a"))!;
    expect(aLine).not.toContain("▸");
  });

  it("底部有快捷键提示条", () => {
    const state = makeState({
      suggestions: [makeSuggestion("a:b", "/a")],
      selectedIndex: 0,
    });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toMatch(/↑↓.*Enter.*Esc/);
  });

  it("suggestions 多于 maxVisibleItems 时显示 more... 滚动标志", () => {
    const suggestions = Array.from({ length: 20 }, (_, i) =>
      makeSuggestion(`cmd${i}:b`, `/cmd${i}`),
    );
    const state = makeState({
      suggestions,
      selectedIndex: 10,
    });
    const opts: RenderOptions = { ...defaultRenderOpts, maxVisibleItems: 5 };
    const lines = renderSessionLines(state, opts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toMatch(/↑ 上方还有 \d+ 条/);
    expect(joined).toMatch(/↓ 下方还有 \d+ 条/);
  });

  it("CJK 命令名正常显示（不破坏行宽）", () => {
    const state = makeState({
      suggestions: [makeSuggestion("提交:b", "/提交", "创建一个 commit")],
      selectedIndex: 0,
    });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("/提交");
    expect(joined).toContain("创建一个 commit");
  });

  it("scrollable 列表：顶/中/底三个选中位置的总行数相等（视觉稳定性）", () => {
    // 真实 bug 回归：total > maxVisible 时，顶部 showTop=false，中部两个都 true，
    // 底部 showBottom=false。旧实现"有则渲染"导致总行数在三种状态间跳变
    // (N+1, N+2, N+1)，用户按 ↓ 导航时整个面板抖动。
    //
    // 修复：isScrollable 恒定预留 2 个 slot，slot 无内容时空白渲染，
    // 三种状态总行数相等。
    const suggestions = Array.from({ length: 20 }, (_, i) =>
      makeSuggestion(`cmd${i}:b`, `/cmd${i}`),
    );
    const opts: RenderOptions = { ...defaultRenderOpts, maxVisibleItems: 5 };

    const topState = makeState({ suggestions, selectedIndex: 0 });
    const midState = makeState({ suggestions, selectedIndex: 10 });
    const bottomState = makeState({ suggestions, selectedIndex: 19 });

    const topLines = renderSessionLines(topState, opts);
    const midLines = renderSessionLines(midState, opts);
    const bottomLines = renderSessionLines(bottomState, opts);

    // 三个状态的总行数必须完全相等（顶框 + 2 指示行 slot + maxVisible 候选 + 底框 + hint）
    expect(topLines.length).toBe(midLines.length);
    expect(midLines.length).toBe(bottomLines.length);

    // 顶部状态：top slot 是"顶部"边界标记（到顶了），bottom slot 量化下方
    const topJoined = stripAnsi(topLines.join("\n"));
    expect(topJoined).toContain("顶部");
    expect(topJoined).toMatch(/↓ 下方还有 \d+ 条/);
    // 中部：两个 slot 都是量化内容
    const midJoined = stripAnsi(midLines.join("\n"));
    expect(midJoined).toMatch(/↑ 上方还有 \d+ 条/);
    expect(midJoined).toMatch(/↓ 下方还有 \d+ 条/);
    // 底部：top 量化上方，bottom "到底啦"
    const bottomJoined = stripAnsi(bottomLines.join("\n"));
    expect(bottomJoined).toMatch(/↑ 上方还有 \d+ 条/);
    expect(bottomJoined).toContain("到底啦");
  });

  it("非 scrollable 列表：不渲染滚动量化文案（只占空 slot）", () => {
    const suggestions = Array.from({ length: 3 }, (_, i) =>
      makeSuggestion(`cmd${i}:b`, `/cmd${i}`),
    );
    const opts: RenderOptions = { ...defaultRenderOpts, maxVisibleItems: 8 };
    const lines = renderSessionLines(
      makeState({ suggestions, selectedIndex: 0 }),
      opts,
    );
    const joined = stripAnsi(lines.join("\n"));
    // 不 scrollable → 不显示"上方还有 / 下方还有"量化文案，也无边界标记
    expect(joined).not.toMatch(/上方还有|下方还有/);
    expect(joined).not.toContain("顶部");
    expect(joined).not.toContain("到底啦");
  });

  it("active chrome 总行数恒定 —— 候选数 1 / 中等 / maxVisibleItems / 超出 全部相等（消除高度抖动）", () => {
    // 用户输入 / 后边打字过滤候选，候选数 N 随字符变化（1→5→2→8→0...）。
    // 旧实现 N 跨过 maxVisibleItems 阈值时 chrome 高度跳变；阈值内 N 变化时
    // 逐行抖动。新实现保证：N > 0 的 active 态总行数严格恒定，与 N 无关。
    const opts: RenderOptions = { ...defaultRenderOpts, maxVisibleItems: 8 };
    const makeN = (n: number): TypeaheadSessionState =>
      makeState({
        suggestions: Array.from({ length: n }, (_, i) =>
          makeSuggestion(`cmd${i}:b`, `/cmd${i}`),
        ),
        selectedIndex: 0,
      });

    const len1 = renderSessionLines(makeN(1), opts).length;
    const len5 = renderSessionLines(makeN(5), opts).length;
    const len8 = renderSessionLines(makeN(8), opts).length; // = maxVisibleItems
    const len9 = renderSessionLines(makeN(9), opts).length; // 跨阈值
    const len20 = renderSessionLines(makeN(20), opts).length;

    expect(len5).toBe(len1);
    expect(len8).toBe(len1);
    expect(len9).toBe(len1);
    expect(len20).toBe(len1);
  });

  it("argHint=null 场景下全 visible state panel 总行数恒等 —— typing 期间零高度抖动的核心契约", () => {
    // 架构契约（与 broker 契约对偶）：FileProvider / CommandProvider 等
    // argHint=null 场景下，panel 在所有 visible state（loading / empty no-match /
    // argHint empty / active 任意 count）下总行数（chrome 行数 + meta 行数）严格
    // 相等。这与 broker "trigger 续 typing emit trigger-refresh，canonical 保留"
    // 共同消除 typing 期间的 ±1 行震荡。
    //
    // 这是 @ panel 抖动 bug 的回归屏障 —— 任何让 empty 路径与 active 路径行数
    // 偏离的修改必须显式权衡（如未来 argHint 信息架构重构）。
    const opts: RenderOptions = { ...defaultRenderOpts, maxVisibleItems: 8 };

    // 全 6 个 visible state（argHint=null 场景）
    const states = {
      "empty loading": makeState({
        suggestions: [],
        selectedIndex: -1,
        loading: true,
      }),
      "empty no-match": makeState({
        suggestions: [],
        selectedIndex: -1,
        loading: false,
      }),
      "active 1 候选": makeState({
        suggestions: [makeSuggestion("a:b", "/a")],
        selectedIndex: 0,
      }),
      "active maxVis 候选（恰满，不滚动）": makeState({
        suggestions: Array.from({ length: 8 }, (_, i) =>
          makeSuggestion(`c${i}:b`, `/c${i}`),
        ),
        selectedIndex: 0,
      }),
      "active maxVis+1 候选（首项选中，下滚指示）": makeState({
        suggestions: Array.from({ length: 9 }, (_, i) =>
          makeSuggestion(`c${i}:b`, `/c${i}`),
        ),
        selectedIndex: 0,
      }),
      "active maxVis+1 候选（中部选中，双向指示）": makeState({
        suggestions: Array.from({ length: 9 }, (_, i) =>
          makeSuggestion(`c${i}:b`, `/c${i}`),
        ),
        selectedIndex: 4,
      }),
    };

    const lineCounts = Object.fromEntries(
      Object.entries(states).map(([name, state]) => [
        name,
        renderSessionLines(state, opts).length,
      ]),
    );

    // 全部 6 个 state 总行数严格相等
    const counts = Object.values(lineCounts);
    const referenceCount = counts[0]!;
    for (const [name, count] of Object.entries(lineCounts)) {
      expect(count, `${name} 总行数 ${count} 应等于参考 ${referenceCount}`).toBe(
        referenceCount,
      );
    }
  });

  it("empty chrome 体内行数与 active chrome 对齐 —— 候选 0 → N → 0 切换无 chrome body 跳变", () => {
    // 真实场景：用户输入 /xxx，无任何前缀匹配 → 候选 0 → emptyChrome；
    // 退一个字符回到 /xx → 命中候选 → activeChrome。两态切换时 chrome body
    // 必须恒定行数，否则视觉抖动。
    //
    // 本测试聚焦 chrome body（顶/底框线之间）恒定；总行数（含 meta）恒等的
    // 强契约见上方 "argHint=null 场景下全 visible state panel 总行数恒等" 测试。
    const opts: RenderOptions = { ...defaultRenderOpts, maxVisibleItems: 8 };

    // active 态参考：N=5 候选
    const activeLines = renderSessionLines(
      makeState({
        suggestions: Array.from({ length: 5 }, (_, i) =>
          makeSuggestion(`cmd${i}:b`, `/cmd${i}`),
        ),
        selectedIndex: 0,
      }),
      opts,
    );
    // empty 态：N=0 + 无 argumentHint/loading → "未找到匹配项"
    const emptyLines = renderSessionLines(
      makeState({ suggestions: [], selectedIndex: -1 }),
      opts,
    );

    // 计算每个面板的 chrome 框行数（顶框 ╭ 到底框 ╰ 之间，包含两条框线）
    const countChromeRows = (lines: string[]): number => {
      const stripped = lines.map(stripAnsi);
      const topIdx = stripped.findIndex((l) => l.includes("╭"));
      const botIdx = stripped.findIndex((l) => l.includes("╰"));
      expect(topIdx).toBeGreaterThanOrEqual(0);
      expect(botIdx).toBeGreaterThan(topIdx);
      return botIdx - topIdx + 1;
    };

    expect(countChromeRows(emptyLines)).toBe(countChromeRows(activeLines));
  });

  it("同一 state 重复调用产生相同输出（确定性）", () => {
    const state = makeState({
      suggestions: [
        makeSuggestion("a:b", "/a", "desc a"),
        makeSuggestion("b:b", "/b", "desc b"),
      ],
      selectedIndex: 0,
    });
    const a = renderSessionLines(state, defaultRenderOpts);
    const b = renderSessionLines(state, defaultRenderOpts);
    expect(a).toEqual(b);
  });
});

// ─── createTypeaheadPanel — 生命周期与交互 ───

describe("createTypeaheadPanel — 生命周期", () => {
  it("attach 前 lastRenderHeight 为 0", () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(makeState());
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    expect(panel.lastRenderHeight).toBe(0);
  });

  it("attach 幂等：二次调用不重复订阅", () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(makeState());
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    panel.attach();
    panel.attach();
    expect(stub.listenerCount).toBe(1);
    panel.detach();
  });

  it("detach 幂等：二次调用安全", () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(makeState());
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    panel.attach();
    panel.detach();
    expect(() => panel.detach()).not.toThrow();
    expect(stub.listenerCount).toBe(0);
  });

  it("attach 后 broker 有监听器", () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(makeState());
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    expect(stub.listenerCount).toBe(0);
    panel.attach();
    expect(stub.listenerCount).toBe(1);
    panel.detach();
    expect(stub.listenerCount).toBe(0);
  });

  it("初始 state 带 suggestions 时 attach 立刻渲染", () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const initial = makeState({
      suggestions: [makeSuggestion("new:b", "/new")],
      selectedIndex: 0,
    });
    const stub = makeBrokerStub(initial);
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
      columns: 80,
    });
    panel.attach();
    const captured = stripAnsi(getCaptured());
    expect(captured).toContain("/new");
    expect(panel.lastRenderHeight).toBeGreaterThan(0);
    panel.detach();
  });
});

// ─── createTypeaheadPanel — state 驱动渲染 ───

describe("createTypeaheadPanel — state 驱动", () => {
  it("broker session state 变化触发 rerender", () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const stub = makeBrokerStub(makeState());
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
      columns: 80,
    });
    panel.attach();
    clearCaptured();

    stub.setState(
      makeState({
        suggestions: [makeSuggestion("new:b", "/new", "new session")],
        selectedIndex: 0,
      }),
    );
    const captured = stripAnsi(getCaptured());
    expect(captured).toContain("/new");
    panel.detach();
  });

  it("active → inactive 切换时 panel 被擦除（clearBelow 写出）", () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [makeSuggestion("a:b", "/a")],
        selectedIndex: 0,
      }),
    );
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
      columns: 80,
    });
    panel.attach();
    const heightBefore = panel.lastRenderHeight;
    expect(heightBefore).toBeGreaterThan(0);

    clearCaptured();
    // trigger 清掉 → activeProvider=null → inactive
    stub.setState(
      makeState({ trigger: null, activeProvider: null, suggestions: [] }),
    );
    const captured = getCaptured();
    // clearBelow "\x1b[J" 应在输出里
    expect(captured).toContain("\x1b[J");
    expect(panel.lastRenderHeight).toBe(0);
    panel.detach();
  });

  it("§6.4 护栏：同一 state 连续 rerender 产生相等帧输出", () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const state = makeState({
      suggestions: [
        makeSuggestion("a:b", "/a", "first"),
        makeSuggestion("b:b", "/b", "second"),
      ],
      selectedIndex: 0,
    });
    const stub = makeBrokerStub(state);
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
      columns: 80,
    });
    panel.attach();

    // 首帧（attach 就渲染一次）
    const firstFrame = getCaptured();
    clearCaptured();

    // 用同一个 state 对象触发一次 rerender —— 内部会产生"上移 + 逐行覆盖"
    stub.setState(state);
    const secondFrame = getCaptured();

    // 第二帧应包含 moveUp（上移 lastHeight 行）+ 相同条目
    expect(secondFrame).toMatch(/\x1b\[\d+A/);
    // 两帧的 stripAnsi 内容应相同
    expect(stripAnsi(firstFrame)).toContain(stripAnsi(secondFrame).replace(/^\r*/, ""));
    panel.detach();
  });

  it("§6.4 护栏：K 次 rerender N 行 → K*N 次 clearLine", () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const state = makeState({
      suggestions: [
        makeSuggestion("a:b", "/a"),
        makeSuggestion("b:b", "/b"),
        makeSuggestion("c:b", "/c"),
      ],
      selectedIndex: 0,
    });
    const stub = makeBrokerStub(state);
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
      columns: 80,
    });
    panel.attach();
    const N = panel.lastRenderHeight;
    clearCaptured();

    const K = 3;
    for (let i = 0; i < K; i++) {
      stub.setState(state);
    }
    const captured = getCaptured();
    expect(countOccurrences(captured, "\x1b[2K")).toBe(K * N);
    panel.detach();
  });
});

// ─── createTypeaheadPanel — 键盘交互 ───

describe("createTypeaheadPanel — 键盘", () => {
  it("↓ 委派 broker.moveSelection(+1)", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [
          makeSuggestion("a:b", "/a"),
          makeSuggestion("b:b", "/b"),
        ],
        selectedIndex: 0,
      }),
    );
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "down", sequence: "\x1b[B" });
    expect(stub.moveSelectionSpy).toHaveBeenCalledWith(1);
    panel.detach();
  });

  it("↑ 委派 broker.moveSelection(-1)", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [
          makeSuggestion("a:b", "/a"),
          makeSuggestion("b:b", "/b"),
        ],
        selectedIndex: 1,
      }),
    );
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "up", sequence: "\x1b[A" });
    expect(stub.moveSelectionSpy).toHaveBeenCalledWith(-1);
    panel.detach();
  });

  it("moveSelection 后 panel 重绘（选中箭头位置变化）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [
          makeSuggestion("a:b", "/a"),
          makeSuggestion("b:b", "/b"),
        ],
        selectedIndex: 0,
      }),
    );
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
      columns: 80,
    });
    panel.attach();
    clearCaptured();
    await sendSyntheticKey(stdin, { name: "down", sequence: "\x1b[B" });
    expect(stub.currentState.selectedIndex).toBe(1);
    // 重绘应包含 moveUp + clearLine
    expect(getCaptured()).toMatch(/\x1b\[\d+A/);
    panel.detach();
  });

  it("Enter 触发 onAccept，传递当前 selectedIndex 对应 item", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [
          makeSuggestion("a:b", "/a"),
          makeSuggestion("b:b", "/b"),
        ],
        selectedIndex: 1,
      }),
    );
    const onAccept = vi.fn();
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept,
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0]![0].id).toBe("b:b");
    panel.detach();
  });

  it("Tab 等同于 Enter 触发 onAccept", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [makeSuggestion("a:b", "/a")],
        selectedIndex: 0,
      }),
    );
    const onAccept = vi.fn();
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept,
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "tab", sequence: "\t" });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0]![0].id).toBe("a:b");
    panel.detach();
  });

  it("Enter 在空 suggestions 时被 swallow（不调 onAccept）", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({ suggestions: [], selectedIndex: -1 }),
    );
    const onAccept = vi.fn();
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept,
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(onAccept).not.toHaveBeenCalled();
    panel.detach();
  });

  it("Esc 触发 onCancel", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [makeSuggestion("a:b", "/a")],
        selectedIndex: 0,
      }),
    );
    const onCancel = vi.fn();
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      onCancel,
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "escape", sequence: "\x1b" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    panel.detach();
  });

  it("Ctrl+C 触发 onCancel", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [makeSuggestion("a:b", "/a")],
        selectedIndex: 0,
      }),
    );
    const onCancel = vi.fn();
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      onCancel,
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "c", ctrl: true, sequence: "\x03" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    panel.detach();
  });

  it("按键在 inactive 态（无 trigger）被忽略 —— 不调 broker", async () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(
      makeState({ trigger: null, activeProvider: null, suggestions: [] }),
    );
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept,
      onCancel,
      stdin,
      stdout,
    });
    panel.attach();
    await sendSyntheticKey(stdin, { name: "down", sequence: "\x1b[B" });
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(stub.moveSelectionSpy).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
    panel.detach();
  });
});

// ─── stdin-ownership / raw-mode 护栏 ───

describe("createTypeaheadPanel — stdin / raw-mode", () => {
  it("非 TTY 流 attach/detach 不增减 raw-mode 计数", () => {
    const { stdin, stdout } = makeStreams();
    const stub = makeBrokerStub(makeState());
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    expect(_getRawModeRefcount()).toBe(0);
    panel.attach();
    // PassThrough 非 TTY → no-op lease
    expect(_getRawModeRefcount()).toBe(0);
    panel.detach();
    expect(_getRawModeRefcount()).toBe(0);
  });

  it("attach 时摘除 stdin 上的 saved keypress listeners，detach 恢复", () => {
    const { stdin, stdout } = makeStreams();
    const savedListener = vi.fn();
    (stdin as unknown as EventEmitter).on("keypress", savedListener);
    expect((stdin as unknown as EventEmitter).listenerCount("keypress")).toBe(1);

    const stub = makeBrokerStub(
      makeState({
        suggestions: [makeSuggestion("a:b", "/a")],
        selectedIndex: 0,
      }),
    );
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    panel.attach();

    // Attached：saved listener 被摘除，panel 自己的 listener 在
    // 触发时 savedListener 不应收到按键
    void sendSyntheticKey(stdin, { name: "down", sequence: "\x1b[B" });
    expect(savedListener).not.toHaveBeenCalled();

    panel.detach();
    // Detach 后 saved listener 应被恢复
    expect(
      (stdin as unknown as EventEmitter).listenerCount("keypress"),
    ).toBeGreaterThanOrEqual(1);
  });
});

// ─── rerender（resize 场景） ───

describe("createTypeaheadPanel — rerender", () => {
  it("rerender() 在 attached 状态下重绘最后的 state", () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const stub = makeBrokerStub(
      makeState({
        suggestions: [makeSuggestion("a:b", "/a", "desc")],
        selectedIndex: 0,
      }),
    );
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
      columns: 80,
    });
    panel.attach();
    clearCaptured();
    panel.rerender();
    const captured = stripAnsi(getCaptured());
    expect(captured).toContain("/a");
    panel.detach();
  });

  it("rerender() 在未 attach 时是 no-op", () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const stub = makeBrokerStub(makeState());
    const panel = createTypeaheadPanel({
      broker: stub.broker,
      sessionId: "test-session",
      onAccept: () => {},
      stdin,
      stdout,
    });
    panel.rerender();
    expect(getCaptured()).toBe("");
  });
});
