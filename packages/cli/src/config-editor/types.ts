/**
 * 基础配置编辑器类型定义。
 *
 * 三层抽象：
 *   - WorkingState：编辑期暂存的 config / credentials（事务性，仅 [完成] 时落盘）
 *   - Section：用户视角的配置块（"model" / "messaging"），由 caller 选择启用
 *   - Panel：UI 面板（main / list / entity / input），由状态机栈管理
 *
 * 入口无关：caller（首次配置 / serve 启动 / 未来 slash 命令）按需求传 sections + title，
 * 编辑器自身不感知调用上下文。
 */

import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";

// ─── Section（用户视角的配置块） ───

export type SectionId = "model" | "messaging";

// ─── Panel（UI 面板状态描述） ───

/**
 * Panel 描述符——纯数据结构，可序列化、可栈管理。
 *
 * 每个 panel 通过查询 ctx + WorkingState 渲染自己，不持有外部引用——
 * 让 panel 状态机的 `handleKey(state, key)` 是纯函数，便于单测。
 */
export type PanelDescriptor =
  /** L1：sections 列表 + 操作按钮 */
  | { kind: "main" }
  /** L2：选服务商（model role） */
  | { kind: "provider-list"; role: ModelRole }
  /** L3：服务商配置（API Key + 选模型 + 确认按钮） */
  | { kind: "provider-config"; role: ModelRole; providerId: string }
  /** L4a：单行输入（API Key 等敏感字段） */
  | { kind: "input"; fieldId: string }
  /** L4b：选模型 + 添加自定义入口 */
  | { kind: "model-list"; role: ModelRole; providerId: string }
  /** L5：添加自定义模型（输入 model id） */
  | { kind: "add-model"; role: ModelRole; providerId: string }
  /** L3 (messaging)：channel 配置（appId + appSecret + 启用按钮） */
  | { kind: "channel-config"; channelId: string };

export type ModelRole = "main" | "secondary";

// ─── KeyEvent（标准化按键） ───

/**
 * 标准化键盘事件——chunk → KeyEvent 由 ui/key-decoder 完成。
 *
 * Panel handleKey 只关心高层语义（enter / arrow / char），不处理原始字符或 ANSI 序列。
 */
export type KeyEvent =
  | { type: "char"; ch: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "escape" }
  | { type: "ctrl-c" }
  | { type: "arrow-up" }
  | { type: "arrow-down" }
  | { type: "arrow-left" }
  | { type: "arrow-right" };

// ─── 状态层 ───

/**
 * 编辑期暂存——不直接写文件，所有改动累积到这里。
 *
 * 事务性：[完成] 触发 caller 提供的 writers 一次性落盘；Ctrl+C / 取消则全部丢弃。
 * 防止两文件半致状态（如 apiKey 写了但 main.provider 没写）。
 */
export interface WorkingState {
  config: ZhixingConfig;
  credentials: ZhixingCredentials;
  /**
   * 输入面板的当前 buffer——由 input/add-model panel 累积字符；保存时写入对应字段。
   *
   * 不属于 config/credentials——是 UI 临时状态，提交时清空。
   */
  inputBuffer: string;
}

// ─── 字段定义（统一 config + credentials 读写） ───

/**
 * 单个配置字段——UI 视为单字段，底层可能跨文件读写。
 *
 * read：从 WorkingState 读出当前值（用于显示）
 * write：把用户输入应用到 WorkingState（不直接写文件）
 *
 * 这层抽象隐藏了"哪个字段在 config / 哪个在 credentials"——UI 与文件结构解耦。
 */
export interface FieldSpec {
  id: string;
  /** UI 显示标签（不含括号说明） */
  label: string;
  /** 进入字段编辑面板时显示的多行说明 */
  hint?: string;
  /** 输入提示的格式示例 */
  example?: string;
  /** 是否敏感字段——决定输入态 mask 与列表态显示策略 */
  sensitive: boolean;
  /** 必填字段——校验时缺失视为错误 */
  required: boolean;
  read: (state: WorkingState) => string | undefined;
  write: (state: WorkingState, value: string) => WorkingState;
}

// ─── Section 接口 ───

/**
 * 一个 Section 是用户视角的配置块（"主/辅模型" / "消息通道"）。
 *
 * Section 提供：
 *   - 在 L1 主面板显示的入口项 + 已配状态 + 阻塞 issues
 *   - 进入后的导航树（panel 跳转目标）
 *
 * 校验逻辑不再在 Section 上——每个 entry 自带 `issues`，作为 progress 计数与
 * 完成校验的单一数据源（避免"按 entry 数 vs 按字段数"的粒度错配）。
 */
export interface Section {
  id: SectionId;
  /** L1 主面板显示的标题 */
  title: string;
  /**
   * 标题下方的副标题（可选）——一句话说明此 section 的作用。
   *
   * 给首次接触的用户解释"这一组配置是干嘛的"。比如"消息通道"对开发者一目了然，
   * 但产品用户不知与对话模型并列的意义；副标题"用于接收外部消息触发 agent"消除歧义。
   */
  description?: string;
  /** L1 主面板显示的入口项列表（每项一行） */
  entries: (state: WorkingState) => SectionEntry[];
}

/**
 * 配置项的就绪级别——驱动 UI 状态的视觉染色（绿/黄/灰）：
 *   - ready：已配齐，可用（绿）
 *   - pending：必填但未完成，需用户操作（黄）
 *   - disabled：当前不需要（如未启用的 channel、有 fallback 的可选项），灰显
 */
export type StatusLevel = "ready" | "pending" | "disabled";

/**
 * 状态二元组——文本 + 等级一体。供已派生场景（entity row / 派生后 entry）使用。
 *
 * `SectionEntry` 不直接 carry Status，而是声明底层事实（discriminated `EntryState`），
 * 由 `deriveEntryStatus`（位于 entry.ts）派生 Status。
 */
export interface Status {
  level: StatusLevel;
  /** 当前状态的人类可读描述（如 "硅基流动 · GPT-4" / "待填"） */
  text: string;
}

/**
 * Entry 的状态——discriminated union 强制三态互斥：
 *
 *   - `ready`：已配齐
 *   - `disabled`：未启用 / 有 fallback 的可选项（不阻塞完成；不可有 issues）
 *   - `blocked`：必填未完成（必须有 issues；不可同时声明 disabled）
 *
 * 这层 union 让 caller **类型层面无法**写出"ready 但有 issues"或"disabled 同时
 * 有 issues"的矛盾——把 `ready/disabled/blocked` 与 `issues` 的耦合关系编译期固化。
 */
export type EntryState =
  | { kind: "ready"; statusText: string }
  | { kind: "disabled"; statusText: string }
  | { kind: "blocked"; statusText: string; issues: readonly string[] };

export interface SectionEntry {
  /** 显示标签（保持简洁，不塞括号说明；解释挪到 statusText 或独立 hint） */
  label: string;
  /** 状态——三态 discriminated union；issues 仅 blocked 态可声明 */
  state: EntryState;
  /** Enter 时跳转的目标 panel；未提供 = 该项不可进入 */
  enterTarget?: PanelDescriptor;
}

// ─── 事件循环 action ───

/**
 * Panel handleKey 的返回值——交给 runner 应用到 panel stack / state。
 *
 * - stay：状态更新但保持当前 panel
 * - navigate：push 新 panel
 * - pop：返回上一级
 * - exit：退出整个编辑器（completed / cancelled）
 */
export type PanelAction =
  | { type: "stay"; state: WorkingState }
  | { type: "navigate"; state: WorkingState; panel: PanelDescriptor }
  | { type: "pop"; state: WorkingState }
  | { type: "exit"; result: ConfigEditorResult };

// ─── 主入口 Context / Result ───

export interface ConfigEditorContext {
  /** 初始 config（从文件加载） */
  initialConfig: ZhixingConfig;
  /** 初始 credentials（从文件加载） */
  initialCredentials: ZhixingCredentials;
  /** 落盘接口——caller 控制（生产用 providers writer，测试用 mock） */
  writers: ConfigEditorWriters;
  /** 启用哪些 sections——caller 按入口需求决定 */
  sections: SectionId[];
  /** UI 顶部标题（如 "首次配置" / "服务模式初始化" / "基础配置"） */
  title: string;
  /**
   * 欢迎/导引文本（可选）——首次配置场景显示在 header 上方降低用户冷启动成本。
   *
   * `/config` 等复编场景不传——避免老用户每次打开都看一遍欢迎语。
   */
  welcomeText?: string;
  /** 头部展示信息（如 workspace 路径） */
  header?: { workspaceRoot?: string; configPath: string; credentialsPath: string };
  /** I/O 注入点 */
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
  /** 是否 TTY——非 TTY 时编辑器直接返回 cancelled，caller 走 fail-fast 路径 */
  isTTY: boolean;
}

export interface ConfigEditorWriters {
  writeConfig: (config: ZhixingConfig) => Promise<void>;
  writeCredentials: (credentials: ZhixingCredentials) => Promise<void>;
}

export type ConfigEditorResult =
  | { kind: "completed"; config: ZhixingConfig; credentials: ZhixingCredentials }
  | { kind: "cancelled" }
  | { kind: "non-tty" };
