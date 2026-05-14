/**
 * Select 协议级类型 —— `SelectOption` / `SelectResult` / `SelectCancelCause`。
 *
 * **职责**：为 select 面板的「选项 / 结果 / 取消原因」提供 caller-renderer-stateMachine
 * 三方共享的类型契约。三层使用：
 *   - caller（譬如 `security/terminal-renderer.ts` 的 `buildSelectOptions`）：构造
 *     `SelectOption[]` 描述决策选项
 *   - 状态机（`tui/_internal/select-state.ts`）：以 `SelectOption[]` 作 reducer
 *     环境，产出 `SelectResult` 终止
 *   - 渲染器（`security/select-operation-region.ts`）：根据 `SelectOption.type` /
 *     `hotkey` 等字段渲染 chrome inline 面板
 *
 * **领域无关**：不耦合 confirmation 业务语义（reason / pattern / risk 等）。
 * 任何"select + 内嵌 input"语义的 modal 都可用同一套类型（未来 clarify / sudo /
 * secret 等扩展点）。
 *
 * **设计沿革**：原本与 selectWithInput（alt-screen modal 通用实现）同模块定义；
 * 该实现已废弃（confirmation 切到 chrome inline），类型抽离独立模块让协议层稳定，
 * 不与任何具体渲染实现绑定。
 */

/**
 * 选项 —— 判别式联合。
 * - `simple`: 标准选项，Enter 直接产生 decision
 * - `input`: 选中后 Enter 切换到 input 模式；再次 Enter 提交 note
 */
export type SelectOption =
  | {
      readonly type: "simple";
      readonly value: string;
      readonly label: string;
      /** 可选字母快捷键——按下即等于选中+Enter */
      readonly hotkey?: string;
    }
  | {
      readonly type: "input";
      readonly value: string;
      readonly label: string;
      readonly placeholder: string;
      /** 允许空 buffer 按 Enter 提交（默认 false：空时不响应 Enter） */
      readonly allowEmptySubmit?: boolean;
      readonly hotkey?: string;
    };

/**
 * 取消原因 —— 细分以便上层做差异化处理。
 *
 * - `ctrl-c` / `ctrl-d`: 用户中止（"中止这次对话"语义）
 * - `escape`: 用户主动取消（"对这个决策说 no"语义；caller 通常翻译为 deny）
 * - `aborted`: 外部 AbortSignal 触发（譬如父任务取消）
 */
export type SelectCancelCause = "ctrl-c" | "ctrl-d" | "escape" | "aborted";

/**
 * 状态机的最终结果。
 *
 * - `selected`: 用户选中某选项；input 类型选项含 `note` 字段
 * - `cancelled`: 用户取消（cause 区分语义）
 */
export type SelectResult =
  | { readonly kind: "selected"; readonly value: string; readonly note?: string }
  | { readonly kind: "cancelled"; readonly cause: SelectCancelCause };
