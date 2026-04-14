/**
 * 智能体身份（Agent Identity）— 应用级单例
 *
 * 知行定位为"个人助手"，有名字的助手比"智能体"更有人格感（Siri / Jarvis 模式）。
 * 默认显示名是 `"知行"`；用户可以在 `zhixing.config.json` 里通过
 * `agent.displayName` 字段改成 `"小助"` / `"管家"` 等，品牌选择权交还给用户。
 *
 * 设计决策：
 *   - **模块级可变状态**：agent identity 是应用全局常量，启动时设一次，运行时
 *     不变。匹配 `console` / 日志等级等模式——比把 identity 在所有函数签名
 *     里穿针引线干净得多。测试里可以用 `setAgentIdentity` 注入自定义值，
 *     `resetAgentIdentityForTests()` 恢复默认。
 *   - **第三人称而非第一人称**：user-facing 字符串统一用 `"${displayName} 想要
 *     执行 X"`，不用 `"我想要执行 X"`。声音一致（同一个叙述者从头到尾），
 *     与 Claude Code 在大规模验证过的 "Claude wants to..." 模式对齐。
 *
 * 使用方式：
 *   - **应用启动时**（run-agent 里）：
 *     `setAgentIdentity(resolveAgentIdentity(config.agent))`
 *   - **任意 user-facing 字符串**：
 *     `const { displayName } = getAgentIdentity();`
 *     `console.log(\`${displayName} 想要执行 X\`)`
 */

// ─── 常量 ───

/**
 * 默认显示名 —— 未配置时使用。
 * 两个汉字："知" + "行" = 王阳明的"知行合一"，有哲学感、有记忆点、
 * 不会和任何主流产品重名。
 */
export const DEFAULT_AGENT_DISPLAY_NAME = "知行";

// ─── 类型 ───

/**
 * 智能体身份的运行时表示。
 * 目前只有 displayName 一个字段；未来可扩展 avatar / persona 等。
 */
export interface AgentIdentity {
  /** 显示名——出现在面板标题、prompt、对话框等 user-facing 位置 */
  displayName: string;
}

/**
 * 从配置中解析的身份片段（与 zhixing.config.json 的 `agent` 字段对应）。
 * 所有字段都是可选的；缺省值在 resolveAgentIdentity 中填入。
 */
export interface AgentIdentityConfig {
  displayName?: string;
}

// ─── 解析 ───

/**
 * 从配置片段解析一个完整的 AgentIdentity。
 * 空字符串、纯空白、undefined 都回退到默认值，防止用户把自己锁在
 * "无名助手" 的奇怪状态。
 */
export function resolveAgentIdentity(
  partial?: AgentIdentityConfig | null,
): AgentIdentity {
  const raw = partial?.displayName?.trim();
  return {
    displayName: raw && raw.length > 0 ? raw : DEFAULT_AGENT_DISPLAY_NAME,
  };
}

// ─── 运行时单例 ───

let currentIdentity: AgentIdentity = {
  displayName: DEFAULT_AGENT_DISPLAY_NAME,
};

/**
 * 在应用启动时设置当前身份。
 * 调用一次即可；重复调用会覆盖。
 */
export function setAgentIdentity(identity: AgentIdentity): void {
  // 防御：传入 displayName 为空时回退默认，避免把 "" 写进去
  currentIdentity = {
    displayName:
      identity.displayName?.trim() || DEFAULT_AGENT_DISPLAY_NAME,
  };
}

/**
 * 获取当前身份。任何 user-facing 字符串需要引用"智能体名字"时通过此函数。
 */
export function getAgentIdentity(): AgentIdentity {
  return currentIdentity;
}

/**
 * 仅供测试用：恢复默认身份。
 * 生产代码不应调用。
 */
export function resetAgentIdentityForTests(): void {
  currentIdentity = { displayName: DEFAULT_AGENT_DISPLAY_NAME };
}
