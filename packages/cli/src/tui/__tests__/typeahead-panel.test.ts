/**
 * typeahead-panel 渲染纯函数单元测试
 *
 * 覆盖点（spec §7）：
 *   - computeWindow 的 8 类边界（空/全装下/居中/贴头/贴尾/滚动标志）
 *   - renderSessionLines 的 inactive / empty / loading / active / CJK 分支，
 *     inlineActions / nav hint（含 ghostText 驱动的 Tab）与高度恒等不变量
 *
 * 面板的有状态宿主（broker 订阅、keypress、stdin / raw-mode 生命周期）由生产
 * 输入区 InputController 承担，其行为在 typeahead-input 测试中覆盖；本文件只验
 * 证 state → lines 的纯渲染。
 */

import { describe, expect, it } from "vitest";

import type {
  SuggestionItem,
  SuggestionProvider,
  TriggerMatch,
  TypeaheadSessionState,
} from "@zhixing/core";

import { stripAnsi } from "../ansi.js";
import {
  computeWindow,
  defaultTypeaheadTheme,
  renderSessionLines,
  type RenderOptions,
} from "../typeahead-panel.js";

// ─── 测试辅助 ───

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
    inlineActions: {},
    panelMode: "picker",
    deletePending: null,
    ...partial,
  };
}

const defaultRenderOpts: RenderOptions = {
  theme: defaultTypeaheadTheme,
  frameWidth: 60,
  innerWidth: 58,
  maxVisibleItems: 8,
};

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

  it("多操作 inlineActions 拼成单行(动作词 + 按键,空格分隔)", () => {
    const state = makeState({
      suggestions: [makeSuggestion("a:b", "/a"), makeSuggestion("c:d", "/c")],
      selectedIndex: 0,
      inlineActions: { delete: true, rename: true, create: true },
    });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("delete ctrl+d   rename ctrl+r   new ctrl+n");
  });

  it("第二行 nav hint:无 ghostText 不含 Tab,有 ghostText 插入 Tab", () => {
    const base = {
      suggestions: [makeSuggestion("a:b", "/a")],
      selectedIndex: 0,
    };
    const noGhost = stripAnsi(
      renderSessionLines(makeState(base), defaultRenderOpts).join("\n"),
    );
    expect(noGhost).toMatch(/↑↓ · Enter · Esc/);
    expect(noGhost).not.toContain("Tab");

    const withGhost = stripAnsi(
      renderSessionLines(
        makeState({
          ...base,
          ghostText: { suffix: "ear", fullValue: "/clear" },
        }),
        defaultRenderOpts,
      ).join("\n"),
    );
    expect(withGhost).toContain("↑↓ · Enter · Tab · Esc");
  });

  // management 模式 footer 不显 Enter —— /trust 等"管理面板"语义。锁住"Enter 在
  // management 面板内 no-op"的契约：任何回退到把 Enter 写死进 navKeys 的改动
  // 立即在此 fail。
  it("panelMode='management' 时 footer 不含 Enter（仅 picker 显 Enter）", () => {
    const state = makeState({
      suggestions: [makeSuggestion("a:b", "/a")],
      selectedIndex: 0,
      panelMode: "management",
    });
    const out = stripAnsi(renderSessionLines(state, defaultRenderOpts).join("\n"));
    expect(out).toMatch(/↑↓ · Esc/);
    expect(out).not.toContain("Enter");
  });

  it("deletePending 态 hint 切到确认文案,覆盖其他操作提示", () => {
    const state = makeState({
      suggestions: [makeSuggestion("a:b", "/a")],
      selectedIndex: 0,
      inlineActions: { delete: true, rename: true, create: true },
      deletePending: "a:b",
    });
    const lines = renderSessionLines(state, defaultRenderOpts);
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("再按一次 ctrl+d 确认删除");
    expect(joined).not.toContain("rename ctrl+r");
  });

  it("inlineActions 单操作与多操作渲染行数恒等(单行拼接不增高)", () => {
    const suggestions = [makeSuggestion("a:b", "/a"), makeSuggestion("c:d", "/c")];
    const oneAction = renderSessionLines(
      makeState({
        suggestions,
        selectedIndex: 0,
        inlineActions: { delete: true },
      }),
      defaultRenderOpts,
    );
    const threeActions = renderSessionLines(
      makeState({
        suggestions,
        selectedIndex: 0,
        inlineActions: { delete: true, rename: true, create: true },
      }),
      defaultRenderOpts,
    );
    expect(threeActions.length).toBe(oneAction.length);
  });

  it("空候选 + create 能力 → empty 态提示 new ctrl+n", () => {
    const lines = renderSessionLines(
      makeState({
        suggestions: [],
        selectedIndex: -1,
        inlineActions: { delete: true, rename: true, create: true },
      }),
      defaultRenderOpts,
    );
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("new ctrl+n");
  });

  it("空候选无 create 能力 → empty 态仅 Esc 清空", () => {
    const lines = renderSessionLines(
      makeState({
        suggestions: [],
        selectedIndex: -1,
        inlineActions: { delete: true },
      }),
      defaultRenderOpts,
    );
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).not.toContain("new ctrl+n");
    expect(joined).toContain("Esc 清空");
  });

  it("空候选 + provider emptyHint → body 显引导替代技术占位", () => {
    const lines = renderSessionLines(
      makeState({
        suggestions: [],
        selectedIndex: -1,
        argumentHint: {
          argIndex: 0,
          renderedHint: "[scene: …]",
          currentArg: {
            kind: "text",
            name: "scene",
            description: "",
            required: true,
          },
          emptyHint: "暂无工作场景，Ctrl+N 新建一个",
        },
      }),
      defaultRenderOpts,
    );
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("暂无工作场景");
    expect(joined).not.toContain("[scene: …]");
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
