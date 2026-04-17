/**
 * RPC 参数解析
 *
 * 三种参数源（按优先级）：
 * 1. --json '...' → 完整覆盖 params
 * 2. --key=value / --key value → 拼到 params 对象，支持 JSON 值（true/false/数字/数组）
 * 3. 位置参数 → 部分常用方法的简化形式（见 POSITIONAL_RULES）
 *
 * 设计要点：
 * - 纯函数：方便单元测试
 * - 不依赖 commander（rpc 命令本身用 program.allowUnknownOption() 收所有 token）
 * - 错误信息描述「应该怎么调用」而不是底层失败原因
 */

export interface ParsedArgs {
  /** 最终发送给 RPC 的 params（undefined = 不带 params） */
  params: unknown;
  /** 解析后的 flags */
  flags: {
    json?: string;
    watch?: boolean;
    raw?: boolean; // 输出原始 JSON 不格式化
  };
}

export class ArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgParseError";
  }
}

/**
 * 部分方法的位置参数到 params 的映射规则。
 *
 * 例：`zhixing rpc session.send "你好"` → params = { text: "你好" }
 * 例：`zhixing rpc schedule.delete task_xxx` → params = { id: "task_xxx" }
 *
 * 没有规则的方法走 --key value 或 --json。
 */
const POSITIONAL_RULES: Record<string, string[]> = {
  "session.send": ["text"],
  "session.history": ["sessionId"],
  "session.abort": ["sessionId"],
  "session.delete": ["sessionId"],
  "schedule.delete": ["id"],
  "schedule.run": ["id"],
};

/**
 * 解析 method 之后的所有 token（包括 flags 和位置参数）。
 *
 * @param method 方法名（用于位置参数规则匹配）
 * @param tokens method 之后的 argv 部分
 */
export function parseRpcArgs(method: string, tokens: string[]): ParsedArgs {
  const flags: ParsedArgs["flags"] = {};
  const positional: string[] = [];
  const kvParams: Record<string, unknown> = {};

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    // --watch / --raw（布尔 flag）
    if (t === "--watch") {
      flags.watch = true;
      continue;
    }
    if (t === "--raw") {
      flags.raw = true;
      continue;
    }

    // --json '...' / --json='...'
    if (t === "--json") {
      const next = tokens[++i];
      if (next === undefined) throw new ArgParseError("--json requires a value");
      flags.json = next;
      continue;
    }
    if (t.startsWith("--json=")) {
      flags.json = t.slice("--json=".length);
      continue;
    }

    // --key=value
    if (t.startsWith("--") && t.includes("=")) {
      const eq = t.indexOf("=");
      const key = t.slice(2, eq);
      const value = t.slice(eq + 1);
      kvParams[key] = parseScalar(value);
      continue;
    }

    // --key value
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const value = tokens[++i];
      if (value === undefined) {
        throw new ArgParseError(`Flag --${key} requires a value`);
      }
      kvParams[key] = parseScalar(value);
      continue;
    }

    // positional
    positional.push(t);
  }

  // 解析最终 params：--json 优先，其次 --key value，最后位置参数
  let params: unknown;

  if (flags.json !== undefined) {
    try {
      params = JSON.parse(flags.json);
    } catch (err) {
      throw new ArgParseError(
        `Invalid JSON in --json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (Object.keys(kvParams).length > 0) {
    params = kvParams;
  } else if (positional.length > 0) {
    const rule = POSITIONAL_RULES[method];
    if (!rule) {
      throw new ArgParseError(
        `Method '${method}' has no positional argument shortcut. ` +
          `Use --key=value or --json '{...}'.`,
      );
    }
    if (positional.length > rule.length) {
      throw new ArgParseError(
        `Method '${method}' accepts at most ${rule.length} positional arg(s); got ${positional.length}.`,
      );
    }
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < positional.length; i++) {
      obj[rule[i]!] = positional[i];
    }
    params = obj;
  }
  // else: 无 params，传 undefined（如 health / session.list）

  return { params, flags };
}

/**
 * 把 CLI 字符串转为标量：
 * - "true"/"false" → boolean
 * - 纯数字 → number
 * - 其余 → 原样字符串
 *
 * 不尝试 JSON 解析（避免 "[1,2]" 被歧义解析）。复杂值用 --json 显式指定。
 */
function parseScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}
