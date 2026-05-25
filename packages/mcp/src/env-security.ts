/**
 * stdio MCP server 的显式 env 安全过滤。
 *
 * 连接层从 SDK `getDefaultEnvironment()` 的白名单基线起 spawn（不继承整个 `process.env`），
 * 这挡住了父进程里已有的危险变量。但 server 配置 / 用户输入可**显式**提供 env（用于注入
 * 凭证等）——这些显式 env 必须再过一道黑名单：否则一份 server 配置就能借"解释器 / 动态
 * 加载器启动型"变量在 spawn 时往子进程注入任意代码 / 库，把"连接一个工具 server"悄悄
 * 升级成本机代码执行。
 *
 * 黑名单只针对这一类"启动即生效、能改变进程行为"的变量；普通配置 env（API base、开关、
 * 业务 token 等）照常透传。
 */

/**
 * 精确匹配的危险变量名（大小写不敏感）——解释器 / shell 启动时读取并能注入代码或改变
 * 加载行为的变量。
 */
const BLOCKED_ENV_NAMES: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "SHELLOPTS",
  "BASHOPTS",
  "BASH_ENV",
  "ENV",
  "PS4",
  "LUA_INIT",
  "LUA_PATH",
  "LUA_CPATH",
  "GIT_SSH_COMMAND",
]);

/**
 * 前缀匹配的危险变量族（大小写不敏感）——动态链接器（`LD_*` / `DYLD_*`）与 bash 导出
 * 函数（`BASH_FUNC_*`）整族都能在进程启动时注入。
 */
const BLOCKED_ENV_PREFIXES: readonly string[] = ["LD_", "DYLD_", "BASH_FUNC_"];

/** 判断一个 env 变量名是否属于"启动型注入"危险变量。 */
export function isDangerousEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (BLOCKED_ENV_NAMES.has(upper)) return true;
  return BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * 过滤显式 env：剔除"启动型注入"危险变量，保留其余。
 *
 * 返回剔除清单（`removed`）供调用方按需提示用户"已忽略某变量"——过滤本身静默生效，
 * 不阻断连接（安全默认 > 配置完整性）。
 */
export function filterDangerousEnv(env: Record<string, string>): {
  safe: Record<string, string>;
  removed: string[];
} {
  const safe: Record<string, string> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isDangerousEnvName(key)) {
      removed.push(key);
    } else {
      safe[key] = value;
    }
  }
  return { safe, removed };
}
