/**
 * SelectState —— select + 内嵌 input 面板的纯状态机。
 *
 * **职责**：把按键事件抽象为 SelectAction，由 reducer 推进 state 转换 / 产出 result。
 * 纯函数：零 I/O、零副作用，可独立单测。
 *
 * **当前 client**：
 *   `SelectOperationRegion`（chrome inline，通过 InputRegion.renderLines 接入 ScreenController）
 *
 * **抽离价值**（即使单 client 也成立）：
 *   - pure function 易测——状态机所有 action 路径独立单测，无 I/O 依赖
 *   - 状态机 / 渲染解耦——渲染层（chrome inline 形态）可独立演进
 *   - 未来扩展点——若有其他 select 语义 modal（clarify / sudo / secret 等）可直接复用
 *
 * **历史**：原本设计为双 client 共享（selectWithInput + SelectOperationRegion），
 * 后 selectWithInput 因无生产 caller 删除（详见 postmortem 2026-05-14）。reducer
 * 本身设计独立于 client 数量，单 client 时仍服务于上述三个抽离价值。
 *
 * **状态机**：
 *   - select 模式（inputMode=false）：导航 selected，Enter 激活选项（type=simple → 提交；
 *     type=input → 切到 input 模式）；Esc 取消整个面板；hotkey 匹配等价 navigate + Enter
 *   - input 模式（inputMode=true）：仅在 caller 选了 type=input 的选项后进入；按键 append 到
 *     inputBuffer；Enter 提交（buffer 非空或 allowEmptySubmit=true）；Esc 退回 select 模式
 *     不取消整个面板；backspace 删字符
 *
 * **cancel 语义切分**（cause 由 caller 决定）：
 *   reducer 仅产出 `{ kind: "cancelled", cause: "escape" }`（Esc 用户主动取消）。
 *   ctrl-c / ctrl-d / aborted 由 caller 在 reducer 入口前直接产生 result——这些 cause
 *   不需要进入状态机（它们是"中止"语义，与"主动选 esc 拒绝"语义不同）。
 */

import type { SelectOption, SelectResult } from "../select-types.js";

/**
 * 状态机的可变状态（不含 options 列表——options 是 reducer 的环境，构造时固定）。
 */
export interface SelectState {
  readonly selected: number;
  readonly inputMode: boolean;
  readonly inputBuffer: string;
}

/**
 * 状态机的输入动作——caller 把按键事件翻译为 action 喂给 reducer。
 *
 * char/hotkey 的 ch/key 已由 caller 过滤控制字符 + 大小写归一化等预处理——
 * reducer 直接 trust。
 */
export type SelectAction =
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  /** Enter —— select 模式激活当前选项；input 模式提交 */
  | { readonly kind: "enter" }
  /** Esc —— select 模式取消整个面板；input 模式退回 select 模式 */
  | { readonly kind: "escape" }
  | { readonly kind: "backspace" }
  /** 字符输入（仅 input 模式有效——select 模式忽略） */
  | { readonly kind: "char"; readonly ch: string }
  /** Hotkey 匹配（caller 已小写归一化）—— 仅 select 模式有效 */
  | { readonly kind: "hotkey"; readonly key: string };

/**
 * Reducer 输出——newState（持续）或 result（终止）。
 * result 存在表示状态机产出最终结果，caller 应停止派发后续 action。
 */
export interface SelectReduceResult {
  readonly state: SelectState;
  readonly result?: SelectResult;
}

/** 构造初始 state——caller 一次性调，之后 reduceSelect 推进。 */
export function makeInitialSelectState(
  options: readonly SelectOption[],
  initialSelected = 0,
): SelectState {
  return {
    selected: Math.max(0, Math.min(options.length - 1, initialSelected)),
    inputMode: false,
    inputBuffer: "",
  };
}

/**
 * 推进 state —— 纯函数。
 *
 * 不变量：
 *   - reducer 不修改 options（readonly 入参）
 *   - state 是 immutable，所有变化返回新对象
 *   - result 存在 ⇒ 状态机终止（caller 不再派发 action）
 *
 * 边界（reducer 视角不变量）：
 *   - 空 options：caller 必须保证至少 1 个 option，否则行为未定义（SelectOperationRegion 构造时拦截）
 *   - 越界 selected：reducer 用 Math.min/Math.max clamp，永远不抛错
 */
export function reduceSelect(
  state: SelectState,
  action: SelectAction,
  options: readonly SelectOption[],
): SelectReduceResult {
  if (state.inputMode) {
    return reduceInputMode(state, action, options);
  }
  return reduceSelectMode(state, action, options);
}

function reduceSelectMode(
  state: SelectState,
  action: SelectAction,
  options: readonly SelectOption[],
): SelectReduceResult {
  switch (action.kind) {
    case "up":
      if (state.selected > 0) {
        return { state: { ...state, selected: state.selected - 1 } };
      }
      return { state };

    case "down":
      if (state.selected < options.length - 1) {
        return { state: { ...state, selected: state.selected + 1 } };
      }
      return { state };

    case "enter": {
      const current = options[state.selected];
      if (!current) return { state };
      if (current.type === "input") {
        // 切换到 input 模式 —— 清空 buffer 让用户起手输入
        return {
          state: { ...state, inputMode: true, inputBuffer: "" },
        };
      }
      // type === "simple" —— 直接提交
      return {
        state,
        result: { kind: "selected", value: current.value },
      };
    }

    case "escape":
      // select 模式 Esc 等价"我不要做这个" —— 取消整个面板
      return { state, result: { kind: "cancelled", cause: "escape" } };

    case "hotkey": {
      const matchIdx = options.findIndex(
        (o) => o.hotkey && o.hotkey.toLowerCase() === action.key,
      );
      if (matchIdx === -1) return { state };
      const match = options[matchIdx]!;
      if (match.type === "input") {
        return {
          state: { ...state, selected: matchIdx, inputMode: true, inputBuffer: "" },
        };
      }
      return {
        state: { ...state, selected: matchIdx },
        result: { kind: "selected", value: match.value },
      };
    }

    // input 模式专属 action 在 select 模式无效
    case "char":
    case "backspace":
      return { state };
  }
}

function reduceInputMode(
  state: SelectState,
  action: SelectAction,
  options: readonly SelectOption[],
): SelectReduceResult {
  const current = options[state.selected];
  // 防御：input 模式但 current 不是 input 类型——异常态，回到 select 模式
  if (!current || current.type !== "input") {
    return { state: { ...state, inputMode: false, inputBuffer: "" } };
  }

  switch (action.kind) {
    case "enter":
      // 空 buffer + allowEmptySubmit !== true —— 吃掉这次按键，保持 input 模式
      if (!state.inputBuffer && !current.allowEmptySubmit) {
        return { state };
      }
      return {
        state,
        result: {
          kind: "selected",
          value: current.value,
          note: state.inputBuffer || undefined,
        },
      };

    case "escape":
      // input 模式 Esc 退回 select 模式 —— 不取消整个面板（与 select 模式 Esc 语义区分）
      return { state: { ...state, inputMode: false, inputBuffer: "" } };

    case "backspace": {
      if (state.inputBuffer.length === 0) return { state };
      // 按 code point 删（代理对安全）
      const chars = Array.from(state.inputBuffer);
      chars.pop();
      return { state: { ...state, inputBuffer: chars.join("") } };
    }

    case "char":
      return {
        state: { ...state, inputBuffer: state.inputBuffer + action.ch },
      };

    // 导航 / hotkey 在 input 模式无效
    case "up":
    case "down":
    case "hotkey":
      return { state };
  }
}
