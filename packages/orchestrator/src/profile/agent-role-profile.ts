/**
 * Agent 角色 profile —— 描述一个 agent 实例的身份 / 指令 / 约束 / 能力。
 *
 * 主 agent 与子 agent 共用同一类型,通过不同的 profile 实例区分:
 *   - mainProfile():用户面向、可派生子 agent
 *   - subAgentProfile():任务专注、不可再派生
 *
 * profile 是纯数据,渲染由 system-prompt 模块的 renderIdentity 完成。
 */

export interface AgentRoleProfile {
  /** 显示名,用于 system prompt 与状态条。e.g. "知行" / "Sub-Agent #a3f" */
  name: string;
  /** 角色标识。当前 "main" | "sub";未来可扩 "researcher" | "critic" 等 */
  role: string;
  /**
   * 身份段主体文本 —— 直接出现在 system prompt 的身份段。
   *
   * 主 agent 通常是简短的产品身份介绍;子 agent 通常包含任务描述与边界。
   * 渲染层按需在文本前后添加 markdown 头 / Constraints 段。
   */
  instructions: string;
  /** 硬约束(逐条注入到身份段后的 Constraints 列表)。空数组表示无额外约束 */
  constraints: readonly string[];
  /** 语气 / 风格指引(可选,默认中性) */
  tone?: string;
  /**
   * 启用的内置工具与派生工具名列表 —— 内置工具装配的权威源。
   *
   * session 创建时按此列表从 `BUILTIN_TOOL_FACTORIES` 实例化工具，一次 freeze
   * 不变。命名约定：与 ToolDefinition.name 一致。
   *
   * 子 agent 装配时按此列表过滤 parent tools[]，未在列表的工具不进入子集；
   * 由此实现 sub-agent 工具集与 main agent 解耦。
   *
   * 常见值：
   *   - 内置：read / write / edit / glob / grep / bash / memory / web_fetch
   *   - 派生：Task（主 agent 启用子任务派发；create-agent-runtime 后置装配）
   *
   * **不含外部依赖型工具**——如 schedule 需要 scheduler ref 在 cli 层实例化，
   * 通过 `options.extraTools` 注入；profile 声明 builtin / 派生，extraTools
   * 提供外部依赖实例，二者协同装配 tools[]。
   */
  enabledTools: readonly string[];
  /**
   * 能力声明(forward-looking 元数据)。
   *
   * **当前阶段:未被任何代码消费** —— 即未参与:
   *   - system prompt 渲染分支
   *   - 调度 / 路由判断
   *
   * 仅作为 profile 自描述,供未来 RoleTask 等高级场景按"能力"分类
   * 注册角色(researcher / critic / executor 等)时使用,避免后续引入
   * 时再回头扩主/子 default profile。
   */
  capabilities?: ProfileCapabilities;
}

/**
 * Agent 能力声明(预留接口,见 AgentRoleProfile.capabilities JSDoc)。
 *
 * @reserved 当前实现未消费此结构 —— 字段语义先行定型,实际生效在未来引入 RoleTask 时。
 */
export interface ProfileCapabilities {
  /**
   * 是否能派生子 agent。
   *
   * 当前由 `AgentRoleProfile.enabledTools` 是否包含 "Task" 隐式表达 —— 此字段
   * 为后续基于 profile 的"能力路由"分类预留显式入口。
   */
  canSpawnSubAgents: boolean;
  /**
   * 输出是否给最终用户看。
   *
   * 当前子 agent 输出回写父 tool_result 是固定形态 ——
   * 此字段为后续区分对话型 / 委派型 / 通知型角色预留。
   */
  userFacing: boolean;
}
