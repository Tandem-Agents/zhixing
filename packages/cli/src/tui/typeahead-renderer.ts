/**
 * TerminalTypeaheadRenderer —— `TypeaheadRenderer` 的 TTY 实现
 *
 * spec §5.6 的接口契约：任何渲染器（TTY / Web / 微信 / ...）实现 `TypeaheadRenderer`
 * 就能接到 broker 上。本文件是 CLI/TTY 的具体实现 —— 薄薄一层 adapter，
 * 真正干活的是 `TypeaheadPanel`（光标不变量 / 重绘 / keypress）。
 *
 * 分层的原因（和 confirmation 的 renderer 一样）：
 *   - `TypeaheadPanel` 关心"怎么画、怎么抓键"，和 broker 耦合度中等
 *   - `TerminalTypeaheadRenderer` 关心"能力声明 + attach/detach"，broker 插拔
 *
 * 用途：
 *   - Step 5（REPL 接入）会注册一个 `TerminalTypeaheadRenderer` 实例到 broker
 *   - 未来的 WebTypeaheadRenderer 走同样的接口 —— 零 CLI 代码改动
 */

import type {
  ITypeaheadBroker,
  SuggestionItem,
  TypeaheadRenderer,
  TypeaheadRendererCapabilities,
  Unsubscribe,
} from "@zhixing/core";

import {
  createTypeaheadPanel,
  type TypeaheadPanelHandle,
  type TypeaheadTheme,
} from "./typeahead-panel.js";

// ─── 能力声明 ───

/**
 * TTY 渲染器能力 —— 和 `TypeaheadPanel` 的实际能力对齐。
 *
 * 当前（Step 4）实现的是 dropdown + loading + multi-column，**暂不支持** ghost
 * text 和 argument hint（Phase 2 Step 7/8 会补）。broker 收到能力声明后对
 * 这两类 state 字段会跳过计算。
 */
export const TERMINAL_TYPEAHEAD_CAPABILITIES: TypeaheadRendererCapabilities = {
  supportsGhostText: false,
  supportsDropdown: true,
  supportsArgumentHint: false,
  supportsLoadingState: true,
  supportsRichItem: true,
  supportsMultiColumn: true,
  maxVisibleItems: 12,
};

// ─── Renderer 选项 ───

export interface TerminalTypeaheadRendererOptions {
  readonly broker: ITypeaheadBroker;

  /**
   * Accept 处理回调 —— renderer 本身不知道 draft 该怎么更新。上层（Step 5
   * 的 InputBuffer）拿到 item 后会调 `broker.accept(sessionId, item)` 得到
   * `AcceptResult`，再用它更新自己的 draft/cursor 并决定是否立即 submit。
   *
   * Panel 把这个回调直接透传给 handle —— renderer 只做 session 注入。
   */
  readonly onAccept: (sessionId: string, item: SuggestionItem) => void;

  /** Esc 回调 —— 上层决定清 trigger token 还是整行 draft */
  readonly onCancel?: (sessionId: string) => void;

  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly theme?: Partial<TypeaheadTheme>;
  readonly maxVisibleItems?: number;
  readonly columns?: number;
}

// ─── Renderer 接口 ───

export interface TerminalTypeaheadRenderer extends TypeaheadRenderer {
  /** 当前活跃面板的渲染高度（0 表示 inactive 或未 attach） */
  readonly lastRenderHeight: number;
  /** 手动触发重绘（终端 resize 时用） */
  rerender(): void;
}

// ─── 实现 ───

export function createTerminalTypeaheadRenderer(
  options: TerminalTypeaheadRendererOptions,
): TerminalTypeaheadRenderer {
  let activePanel: TypeaheadPanelHandle | null = null;
  let activeSessionId: string | null = null;

  return {
    name: "terminal",
    capabilities: {
      ...TERMINAL_TYPEAHEAD_CAPABILITIES,
      maxVisibleItems: options.maxVisibleItems ?? TERMINAL_TYPEAHEAD_CAPABILITIES.maxVisibleItems,
    },

    attach(sessionId: string): Unsubscribe {
      // 同一 session 重复 attach：no-op（不重建 panel）
      if (activeSessionId === sessionId && activePanel) {
        return () => {
          if (activeSessionId === sessionId) this.detach();
        };
      }

      // 换 session：先 detach 旧的
      if (activePanel) {
        activePanel.detach();
        activePanel = null;
      }

      activeSessionId = sessionId;
      activePanel = createTypeaheadPanel({
        broker: options.broker,
        sessionId,
        stdin: options.stdin,
        stdout: options.stdout,
        theme: options.theme,
        maxVisibleItems: options.maxVisibleItems,
        columns: options.columns,
        onAccept: (item) => options.onAccept(sessionId, item),
        onCancel: options.onCancel
          ? () => options.onCancel?.(sessionId)
          : undefined,
      });
      activePanel.attach();

      return () => {
        if (activeSessionId === sessionId) this.detach();
      };
    },

    detach(): void {
      if (activePanel) {
        activePanel.detach();
        activePanel = null;
      }
      activeSessionId = null;
    },

    rerender(): void {
      activePanel?.rerender();
    },

    get lastRenderHeight(): number {
      return activePanel?.lastRenderHeight ?? 0;
    },
  };
}
