/**
 * 基础配置编辑器类型定义。
 *
 * 三层抽象：
 *   - WorkingState：编辑期暂存的 config / credentials（事务性，仅 [完成] 时落盘）
 *   - Section：用户视角的配置块（"model" / "messaging"），由 caller 选择启用
 *   - Panel：UI 面板（main / list / entity / input），由状态机栈管理
 *
 * 入口无关：caller（初始配置 / serve 启动 / `/config` 等）按需求传 sections + title，
 * 编辑器自身不感知调用上下文。
 */

import type { RoleId, ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import type { McpServerSpec, McpServerStatus, ProbeResult } from "@zhixing/mcp";
import type { McpSetupCandidate, McpResolveResult } from "./mcp-setup.js";
import type { McpDiscoveryChoice } from "./mcp-discovery.js";

// ─── Section（用户视角的配置块） ───

export type SectionId = "model" | "messaging" | "mcp";

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
  /**
   * L5：model 选定后的思考控制步骤——由所选 model 的 ThinkingControl
   * 元数据驱动渲染（toggle/effort/budget），写 config.llm.<role>.thinking。
   */
  | { kind: "thinking-config"; role: ModelRole; providerId: string; model: string }
  /** L6：自定义思考预算（输入 token 数，budget 形态用） */
  | { kind: "thinking-budget"; role: ModelRole; providerId: string; model: string }
  /** L3 (messaging)：channel 配置（appId + appSecret + 启用按钮） */
  | { kind: "channel-config"; channelId: string }
  /** L3 (mcp)：已接入 server 详情（启停 / 删除 / 查看状态） */
  | { kind: "mcp-server"; serverId: string }
  /**
   * L3 (mcp)：统一输入接入——用户键入包名 / URL / 命令 / 预设名，经 runtime.mcpResolve
   * （预设命中 / 推断）解析成候选后 replace 为 mcp-add（接入成功即 pop 回主列表）。
   * error：上次解析失败 / 撞名提示。
   */
  | { kind: "mcp-add-input"; error?: string }
  /**
   * L3 (mcp)：接入候选 server——逐字段录入密钥 → 带密钥 discovery 验证。
   *
   * 以 `McpSetupCandidate` 为驱动：预设、输入标识推断等来源殊途同归到候选，本面板只管
   * "收集候选所需密钥 → 验证 → 落盘"，不感知来源。展示用的 label / description 放描述符
   * （UI 关注点），不污染候选模型。
   *
   * inputs：已逐字段累积的密钥（按 field.key）。fieldIndex：当前录入字段下标（指向
   * candidate.secretFields）。error：上次验证失败原因，原地回显。
   */
  | {
      kind: "mcp-add";
      candidate: McpSetupCandidate;
      label?: string;
      description?: string;
      inputs: Record<string, string>;
      fieldIndex: number;
      error?: string;
    }
  /**
   * L3 (mcp)：搜索引导出的候选列表——用户输入关键词后搜真实 npm 包挑出的 ≤5 个候选，
   * 上下选一个 → 阶段2 提取（runtime.mcpExtract）→ replace 为 mcp-add 填密钥。
   * selectedIndex：当前高亮项；error：提取失败原地回显。
   */
  | {
      kind: "mcp-choices";
      choices: McpDiscoveryChoice[];
      selectedIndex: number;
      error?: string;
    };

/** 模型角色 —— 单一事实源是 providers 的 ROLE_SPECS（main / light / power） */
export type ModelRole = RoleId;

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

// ─── 运行时只读快照（配置之外的状态） ───

/**
 * config-editor 的运行时只读访问器 —— 由 caller 注入，section 渲染时叠加配置之外的状态。
 *
 * 当前只有 MCP server 的连接状态：mcp section 列出 config 里的 server 后，按 serverId
 * 叠加 connected / connecting + 工具数。保持纯只读、与 WorkingState（事务暂存的配置）
 * 分离，避免运行时快照被 writers 误落盘。
 */
export interface ConfigEditorRuntime {
  /** 全部受管 server 的运行状态（缺省 = 无 hub 注入，section 仅显示配置态）。 */
  mcpServerStatuses?: () => readonly McpServerStatus[];
  /**
   * 一次性 discovery 探测（缺省 = 无法验证，接入向导不可用）—— 接入引导验证连接用，
   * 由 caller 注入（生产注 @zhixing/mcp 的 probeServer，测试注 mock）。
   */
  mcpProbe?: (spec: McpServerSpec, signal?: AbortSignal) => Promise<ProbeResult>;
  /**
   * 把用户输入（包名 / 关键词 / URL / 命令 / 预设名）解析为接入候选或候选列表（缺省 =
   * 统一输入接入不可用）—— 由 caller 注入（生产经 resolveMcpSetup + main LLM + 搜索，
   * 测试注 mock）。确定性输入直接出 candidate，裸输入经搜索引导出 choices。
   * `onStep` 回报当前步骤（已是人话）供 loading 显示。面板只调它、不感知 LLM / 搜索。
   */
  mcpResolve?: (
    input: string,
    signal?: AbortSignal,
    onStep?: (message: string) => void,
  ) => Promise<McpResolveResult>;
  /**
   * 阶段2 提取：从一个确定的真实包名（搜索引导选中的候选）读 README 提取启动配置为候选
   * （缺省 = 选择候选后无法接入）。**与 mcpResolve 分开**——选中的精确包名若回走 mcpResolve
   * 会被当关键词重新搜索；故由候选选择面板在选中时调此入口。
   */
  mcpExtract?: (packageName: string, signal?: AbortSignal) => Promise<McpResolveResult>;
}

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
  /**
   * 是否纯可选——无必填完成门槛。缺省 false = 含必填项，参与"全部就绪 / 待补充 N 项"
   * 完成度裁决。MCP 这类"可选增益"section 置 true：条目永不阻塞完成；主面板据此在
   * "全部 section 皆可选"时**隐藏就绪 pill**——无门槛处的"全部就绪"恒真、无信息且误导。
   */
  optional?: boolean;
  /**
   * L1 主面板显示的入口项列表（每项一行）。
   *
   * runtime（可选）携带配置之外的运行时只读快照（如 MCP server 连接状态）——由 runner
   * 渲染前从 ctx 取并传入；section 据 serverId 等叠加运行态。model / messaging 不需要、
   * 忽略该参数。
   */
  entries: (state: WorkingState, runtime?: ConfigEditorRuntime) => SectionEntry[];
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
  /** 替换栈顶面板（不 push）——原地更新当前面板（如把 mcp-add 换成带 error 的同款）。 */
  | { type: "replace"; state: WorkingState; panel: PanelDescriptor }
  | { type: "exit"; result: ConfigEditorResult }
  /**
   * loading：执行一个异步任务（如 discovery 验证 / LLM 推断），期间渲染 loading 态并可
   * 取消。runner 执行 `run(signal)` 得到下一步 PanelAction 后续跑（可再次 loading 以分阶段）。
   * 这是同步 handler 接入异步的唯一通路——只有需要异步的面板才产出它。
   */
  | {
      type: "loading";
      /** loading 期间展示的提示（如"正在验证连接…"）。 */
      message: string;
      /** 取消（Esc）时 pop 回上一面板的 state——task 不改 state，故用进入时的快照。 */
      state: WorkingState;
      /**
       * 异步任务：收 AbortSignal（取消时 abort），返回下一步 PanelAction。
       * `report(message)` 可在执行中更新 loading 显示的当前步骤（多阶段任务用，如搜索引导
       * 的"正在搜索…→正在读取…"）；不调则保持进入时的静态 message。
       */
      run: (signal: AbortSignal, report: (message: string) => void) => Promise<PanelAction>;
    };

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
  /** UI 顶部标题（如 "初始配置" / "服务模式初始化" / "基础配置"） */
  title: string;
  /**
   * 欢迎/导引文本（可选）——初始配置场景显示在 header 上方降低用户冷启动成本。
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
  /**
   * 运行时只读快照访问器（可选）—— /mcp 注入 hub 的 serverStatuses，让 mcp section 叠加
   * 连接状态；/config 等不注入时 section 仅显示配置态。
   */
  runtime?: ConfigEditorRuntime;
}

export interface ConfigEditorWriters {
  writeConfig: (config: ZhixingConfig) => Promise<void>;
  writeCredentials: (credentials: ZhixingCredentials) => Promise<void>;
}

export type ConfigEditorResult =
  | { kind: "completed"; config: ZhixingConfig; credentials: ZhixingCredentials }
  | { kind: "cancelled" }
  | { kind: "non-tty" };
