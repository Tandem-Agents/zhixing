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
  /** L2 (messaging)：选 channel */
  | { kind: "channel-list" }
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
 *   - 在 L1 主面板显示的入口项 + 已配状态
 *   - 进入后的导航树（panel 跳转目标）
 *   - 完成时的校验逻辑
 */
export interface Section {
  id: SectionId;
  /** L1 主面板显示的标题 */
  title: string;
  /** L1 主面板显示的入口项列表（每项一行） */
  entries: (state: WorkingState) => SectionEntry[];
  /**
   * 必填项是否齐全——L1 完成按钮触发时校验。
   * 返回缺失字段的人类可读描述列表（空数组表示通过）。
   */
  validate: (state: WorkingState) => string[];
}

export interface SectionEntry {
  /** 显示标签（含 "（必选）" / "（建议配置...）" 等说明） */
  label: string;
  /** 当前状态的右侧描述（如 "未配置" / "硅基流动 · Pro/MiniMaxAI/MiniMax-M2.5"） */
  status: string;
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
