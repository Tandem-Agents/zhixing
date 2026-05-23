/**
 * stdio MCP server 子进程的环境变量过滤 —— 移除"解释器启动型"危险变量。
 *
 * 这些变量能让被 spawn 的解释器（node / python）或动态链接器在启动时加载攻击者
 * 指定的代码 / 库，是 stdio MCP server 的已知注入面。采用拒绝名单：明确危险的剔除，
 * 其余继承父进程 env —— MCP server 常依赖 PATH / HOME 等正常变量，白名单会误伤。
 */

/** 解释器 / 动态链接器的代码注入入口变量。 */
const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
]);

/** macOS 动态链接器全家桶都以 `DYLD_` 前缀注入，整族剔除。 */
function isDangerousEnvKey(key: string): boolean {
  return DANGEROUS_ENV_KEYS.has(key) || key.startsWith("DYLD_");
}

/**
 * 过滤掉危险变量、丢弃 undefined 值，返回可直接交给子进程 spawn 的 env。
 * 输入通常是 `process.env`（值类型 `string | undefined`）。
 */
export function filterSpawnEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isDangerousEnvKey(key)) continue;
    result[key] = value;
  }
  return result;
}
