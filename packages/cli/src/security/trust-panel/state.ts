/**
 * /trust 面板状态机 —— elm 风格 reducer。
 *
 * 设计要点：
 * - `reduce(state, action)` 是纯函数，返回新 state + 可选 Effect 描述符。
 * - 副作用（store.revoke / reload rules）由 controller 看 Effect 执行后回灌
 *   `rules-reloaded` action，state 始终不出 reducer 自己改。
 * - 双击 `d` 防误删：第一次 d 标 deletePendingRuleId、第二次 d on same id → commit。
 *   任意 ↑↓ 移动选中即清除 pending；切换到别的规则后再按 d 重新计数。
 * - 撤销后 selectedIndex 不变 = 自然指向"原来被撤销规则的下一条"（数组左移补位），
 *   末尾被撤销则 clamp 到新末尾。
 */

import type { PermissionRule } from "@zhixing/core";

export interface TrustPanelState {
  readonly rules: ReadonlyArray<PermissionRule>;
  /** 当前选中行索引。rules 为空时为 -1。 */
  readonly selectedIndex: number;
  /** 已按一次 d 等待二次确认的规则 id；null = 无 pending。 */
  readonly deletePendingRuleId: string | null;
}

export type TrustPanelAction =
  | { kind: "init"; rules: ReadonlyArray<PermissionRule> }
  | { kind: "move"; delta: number }
  | { kind: "request-delete" }
  | { kind: "rules-reloaded"; rules: ReadonlyArray<PermissionRule> }
  | { kind: "exit" };

/**
 * Reducer 返回的副作用描述符。
 * - `revoke` —— controller 应当调 store.revoke(ruleId)，成功后重新加载 rules
 *   并 dispatch `rules-reloaded`。
 * - `exit` —— controller 应当终止面板 lifecycle。
 */
export type TrustPanelEffect =
  | { kind: "revoke"; ruleId: string }
  | { kind: "exit" };

export interface ReduceResult {
  readonly state: TrustPanelState;
  readonly effect?: TrustPanelEffect;
}

export function createInitialState(): TrustPanelState {
  return { rules: [], selectedIndex: -1, deletePendingRuleId: null };
}

export function reduce(
  state: TrustPanelState,
  action: TrustPanelAction,
): ReduceResult {
  switch (action.kind) {
    case "init":
      return {
        state: {
          rules: action.rules,
          selectedIndex: action.rules.length > 0 ? 0 : -1,
          deletePendingRuleId: null,
        },
      };

    case "move": {
      if (state.rules.length === 0) return { state };
      const next = clampIndex(
        state.selectedIndex + action.delta,
        state.rules.length,
      );
      if (next === state.selectedIndex && state.deletePendingRuleId === null) {
        return { state };
      }
      return {
        state: {
          ...state,
          selectedIndex: next,
          deletePendingRuleId: null,
        },
      };
    }

    case "request-delete": {
      if (state.selectedIndex < 0) return { state };
      const selected = state.rules[state.selectedIndex];
      if (!selected) return { state };
      // 第二次按 d 在同一规则上 → commit 撤销。
      if (state.deletePendingRuleId === selected.id) {
        return {
          state: { ...state, deletePendingRuleId: null },
          effect: { kind: "revoke", ruleId: selected.id },
        };
      }
      // 第一次按 d（或在新规则上）→ 标 pending，等待二次确认。
      return {
        state: { ...state, deletePendingRuleId: selected.id },
      };
    }

    case "rules-reloaded": {
      // selectedIndex 保持原值再 clamp，自然指向原下一条；末尾退回末尾。
      const next =
        action.rules.length > 0
          ? clampIndex(state.selectedIndex, action.rules.length)
          : -1;
      return {
        state: {
          rules: action.rules,
          selectedIndex: next,
          deletePendingRuleId: null,
        },
      };
    }

    case "exit":
      return { state, effect: { kind: "exit" } };
  }
}

function clampIndex(idx: number, length: number): number {
  if (length === 0) return -1;
  if (idx < 0) return 0;
  if (idx >= length) return length - 1;
  return idx;
}
