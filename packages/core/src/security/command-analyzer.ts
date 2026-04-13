/**
 * Shell 命令启发式预解析器 — Phase 2
 *
 * 不是完整 AST 解析器。用 ~300 行代码覆盖 ~80% 常见命令模式。
 * 剩余 ~20% 边缘情况（复杂嵌套 subshell、heredoc、process substitution）
 * 由执行守卫兜底——未覆盖模式会保守分类为 external。
 *
 * 三段式处理：
 *   1. tokenize(cmd)           —— quote-aware 词元化
 *   2. splitByChains(tokens)   —— 按顶层 chain 操作符切分
 *   3. analyzeSub(tokens)      —— 单条子命令提取 executable / 路径 / 主机 / env var
 *
 * 产出 CommandAnalysis 喂给：
 *   A. SecurityRequest.resolvedAccess 让 policy 引擎的 path/network/env_var 规则
 *      能匹配 bash 命令内部的资源（真正的纵深防御）
 *   B. ShellClassifier 做精准的 chain 检测（quote-aware，避免把文件名含 `|` 误报）
 */

import type {
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "./types.js";

// ─── 公共类型 ───

export interface CommandAnalysis {
  /** 原始命令字符串 */
  raw: string;
  /** 每段被 chain 操作符分隔的子命令 */
  subcommands: SubcommandInfo[];
  /** 顶层 chain 操作符序列（与 subcommands 相邻数对应） */
  chainOperators: string[];
  /** 是否含任何 chain 操作符（忽略引号内的） */
  hasChain: boolean;
  /** 重定向目标（`>` `>>` `<` `2>` 等） */
  redirects: RedirectSpec[];
  /** 所有命令段涉及的文件路径 */
  accessedPaths: string[];
  /** 所有命令段涉及的主机名 */
  accessedHosts: string[];
  /** 所有命令段涉及的环境变量名 */
  usedEnvVars: string[];
  /** 是否含命令替换 `$(...)` 或反引号 */
  hasCommandSubstitution: boolean;
  /** 是否含解释器动态求值（python -c / node -e / bash -c） */
  hasInterpreterEval: boolean;
}

export interface SubcommandInfo {
  executable: string;
  arguments: string[];
  /** parts[1] 如果看起来像子命令（如 git status 中的 status） */
  subcommand?: string;
  /** 是否是解释器的 -c/-e 动态求值 */
  isInterpreterEval: boolean;
}

export interface RedirectSpec {
  operator: string;
  target: string;
}

// ─── Tokenizer ───

type Token =
  | { type: "word"; value: string }
  | { type: "op"; value: string };

/**
 * Quote-aware 词元化。
 * 支持单引号字面量、双引号（含 `\"`/`\\` 转义）、反斜杠 escape。
 * 识别操作符：`|` `||` `&` `&&` `;` `>` `>>` `<` `<<` `\`` `$(` `(` `)`
 */
function tokenize(cmd: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let state: "normal" | "single" | "double" = "normal";

  const flush = () => {
    if (current.length > 0) {
      tokens.push({ type: "word", value: current });
      current = "";
    }
  };

  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;

    if (state === "single") {
      if (c === "'") {
        state = "normal";
      } else {
        current += c;
      }
      i++;
      continue;
    }

    if (state === "double") {
      if (c === '"') {
        state = "normal";
      } else if (c === "\\" && i + 1 < cmd.length) {
        // 双引号内只对特定字符 escape（bash 标准）：$ " \ 反引号
        // 其他情况（如 "\Windows"）保留反斜杠——这对 Windows 路径正确
        const nextCh = cmd[i + 1];
        if (
          nextCh === '"' ||
          nextCh === "\\" ||
          nextCh === "$" ||
          nextCh === "`"
        ) {
          current += nextCh;
          i += 2;
          continue;
        }
        current += c;
      } else {
        current += c;
      }
      i++;
      continue;
    }

    // normal
    if (c === " " || c === "\t" || c === "\n") {
      flush();
      i++;
      continue;
    }
    if (c === "'") {
      state = "single";
      i++;
      continue;
    }
    if (c === '"') {
      state = "double";
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      current += cmd[i + 1];
      i += 2;
      continue;
    }

    // 两字符操作符优先
    const next = cmd[i + 1];
    if (c === "|" && next === "|") {
      flush();
      tokens.push({ type: "op", value: "||" });
      i += 2;
      continue;
    }
    if (c === "&" && next === "&") {
      flush();
      tokens.push({ type: "op", value: "&&" });
      i += 2;
      continue;
    }
    if (c === ">" && next === ">") {
      flush();
      tokens.push({ type: "op", value: ">>" });
      i += 2;
      continue;
    }
    if (c === "<" && next === "<") {
      flush();
      tokens.push({ type: "op", value: "<<" });
      i += 2;
      continue;
    }
    if (c === "$" && next === "(") {
      flush();
      tokens.push({ type: "op", value: "$(" });
      i += 2;
      continue;
    }
    if (c === "2" && next === ">") {
      flush();
      tokens.push({ type: "op", value: "2>" });
      i += 2;
      continue;
    }

    if ("|&;><()`".includes(c)) {
      flush();
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }

    current += c;
    i++;
  }

  flush();
  return tokens;
}

// ─── Chain splitter ───

const CHAIN_OPS = new Set(["|", "||", "&&", ";", "&"]);

/**
 * 按顶层 chain 操作符切分 token 流。
 * 跟踪 `(...)` 和 `$(...)` 的深度，内部的操作符不算顶层。
 */
function splitByChains(tokens: Token[]): {
  pieces: Token[][];
  chainOps: string[];
} {
  const pieces: Token[][] = [];
  const chainOps: string[] = [];
  let current: Token[] = [];
  let depth = 0;

  for (const tok of tokens) {
    if (tok.type === "op" && (tok.value === "(" || tok.value === "$(")) {
      depth++;
      current.push(tok);
      continue;
    }
    if (tok.type === "op" && tok.value === ")") {
      depth = Math.max(0, depth - 1);
      current.push(tok);
      continue;
    }

    if (depth === 0 && tok.type === "op" && CHAIN_OPS.has(tok.value)) {
      if (current.length > 0) {
        pieces.push(current);
        chainOps.push(tok.value);
        current = [];
      }
      continue;
    }

    current.push(tok);
  }

  if (current.length > 0) pieces.push(current);
  return { pieces, chainOps };
}

// ─── 单条子命令分析 ───

const INTERPRETERS = new Set([
  "python", "python2", "python3", "py",
  "node", "nodejs",
  "ruby", "perl", "php",
  "sh", "bash", "zsh", "fish", "dash",
  "lua", "tcl",
]);

const EVAL_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--command"]);

const SUBCOMMAND_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/i;

/** 归一化 executable 为 basename 小写，去掉版本号后缀 */
function normalizeExecutable(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return base.toLowerCase();
}

function isInterpreter(exe: string): boolean {
  const norm = normalizeExecutable(exe);
  if (INTERPRETERS.has(norm)) return true;
  const stripped = norm.replace(/[0-9](?:\.[0-9]+)*$/, "");
  return INTERPRETERS.has(stripped);
}

/**
 * 路径启发式：必须有明确的路径特征，避免误判 flag/字面量。
 */
function looksLikePath(token: string): boolean {
  if (!token) return false;
  // flags 和 VAR=value 前缀不是路径
  if (token.startsWith("-")) return false;
  if (/^[A-Z_][A-Z0-9_]*=/.test(token)) return false;
  // 绝对路径 / 主目录 / 相对显式
  if (
    token.startsWith("/") ||
    token.startsWith("~/") ||
    token.startsWith("~") && token.length === 1 ||
    token.startsWith("./") ||
    token.startsWith("../")
  ) {
    return true;
  }
  // Windows 盘符
  if (/^[a-zA-Z]:[\\/]/.test(token)) return true;
  // 含 / 但不是 URL
  if (token.includes("/") && !token.includes("://")) return true;
  return false;
}

/** 从单个 token 中提取 URL 的主机 */
function extractHost(token: string): string | null {
  const m = token.match(
    /^(?:https?|ftp|ftps|ssh|git|ws|wss|rsync):\/\/(?:[^@\/]+@)?([^\/:?#]+)/i,
  );
  return m ? m[1]!.toLowerCase() : null;
}

/** 提取 token 中的 `$VAR` / `${VAR}` 引用 */
function extractEnvRefs(token: string): string[] {
  const refs: string[] = [];
  const re = /\$\{?([A-Z_][A-Z0-9_]*)\}?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(token)) !== null) {
    refs.push(m[1]!);
  }
  return refs;
}

/**
 * 分析单条子命令 tokens。
 * 识别：VAR=value 前缀、executable、参数、重定向、路径、主机、env var、子命令。
 */
function analyzeSub(tokens: Token[]): {
  sub: SubcommandInfo;
  redirects: RedirectSpec[];
  paths: string[];
  hosts: string[];
  envVars: string[];
} {
  const paths: string[] = [];
  const hosts: string[] = [];
  const envVars: string[] = [];
  const redirects: RedirectSpec[] = [];

  let execIdx = -1;
  const words: string[] = tokens
    .filter((t): t is { type: "word"; value: string } => t.type === "word")
    .map((t) => t.value);

  // 剥离开头的 `VAR=value` 前缀：executable 是第一个非赋值 token
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const assignMatch = w.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (assignMatch && execIdx === -1) {
      envVars.push(assignMatch[1]!);
      continue;
    }
    execIdx = i;
    break;
  }

  if (execIdx === -1) {
    return {
      sub: {
        executable: "",
        arguments: [],
        isInterpreterEval: false,
      },
      redirects,
      paths,
      hosts,
      envVars,
    };
  }

  const execRaw = words[execIdx]!;
  const executable = normalizeExecutable(execRaw);
  const args = words.slice(execIdx + 1);

  // 重定向：扫 tokens 中的 op 和后面紧跟的 word
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok?.type !== "op") continue;
    if (["<", ">", ">>", "<<", "2>"].includes(tok.value)) {
      const next = tokens[i + 1];
      if (next?.type === "word") {
        redirects.push({ operator: tok.value, target: next.value });
        paths.push(next.value); // 重定向目标也是被访问的路径
      }
    }
  }

  // 路径 / 主机 / env var 提取
  for (const arg of args) {
    const host = extractHost(arg);
    if (host) {
      hosts.push(host);
      continue;
    }
    if (looksLikePath(arg)) {
      paths.push(arg);
    }
    for (const ref of extractEnvRefs(arg)) {
      envVars.push(ref);
    }
  }

  // 子命令识别
  const first = args[0];
  const subcommand =
    first && SUBCOMMAND_PATTERN.test(first) ? first : undefined;

  // 解释器 eval 检测
  const isInterpreterEval =
    isInterpreter(execRaw) && args.some((a) => EVAL_FLAGS.has(a));

  return {
    sub: {
      executable,
      arguments: args,
      subcommand,
      isInterpreterEval,
    },
    redirects,
    paths,
    hosts,
    envVars,
  };
}

// ─── 主分析函数 ───

export function analyzeCommand(rawCmd: string): CommandAnalysis {
  const cmd = (rawCmd ?? "").trim();
  if (!cmd) {
    return emptyAnalysis(rawCmd ?? "");
  }

  const tokens = tokenize(cmd);
  const { pieces, chainOps } = splitByChains(tokens);

  const subcommands: SubcommandInfo[] = [];
  const redirects: RedirectSpec[] = [];
  const paths = new Set<string>();
  const hosts = new Set<string>();
  const envVars = new Set<string>();
  let hasCommandSubstitution = false;
  let hasInterpreterEval = false;

  // 检测命令替换（$(...) 或反引号），无论在哪一段
  for (const tok of tokens) {
    if (tok.type === "op" && (tok.value === "$(" || tok.value === "`")) {
      hasCommandSubstitution = true;
      break;
    }
  }

  for (const piece of pieces) {
    const analyzed = analyzeSub(piece);
    subcommands.push(analyzed.sub);
    redirects.push(...analyzed.redirects);
    for (const p of analyzed.paths) paths.add(p);
    for (const h of analyzed.hosts) hosts.add(h);
    for (const e of analyzed.envVars) envVars.add(e);
    if (analyzed.sub.isInterpreterEval) hasInterpreterEval = true;
  }

  return {
    raw: cmd,
    subcommands,
    chainOperators: chainOps,
    hasChain: chainOps.length > 0 || hasCommandSubstitution,
    redirects,
    accessedPaths: [...paths],
    accessedHosts: [...hosts],
    usedEnvVars: [...envVars],
    hasCommandSubstitution,
    hasInterpreterEval,
  };
}

function emptyAnalysis(raw: string): CommandAnalysis {
  return {
    raw,
    subcommands: [],
    chainOperators: [],
    hasChain: false,
    redirects: [],
    accessedPaths: [],
    accessedHosts: [],
    usedEnvVars: [],
    hasCommandSubstitution: false,
    hasInterpreterEval: false,
  };
}

// ─── Middleware ───

/**
 * CommandAnalyzer 中间件——authorize 阶段最外层（order=-10）。
 *
 * 在 PolicyEvaluator 之前运行，从 bash/shell 工具的 command 参数提取：
 *   - 路径  → request.resolvedAccess.paths
 *   - 主机  → request.resolvedAccess.hosts
 *   - env var → request.resolvedAccess.envVars
 *   - 完整分析 → request.resolvedAccess.commandAnalysis
 *
 * 这让 policy 引擎的 path / network / env_var 规则自动对 bash 命令内的
 * 资源生效，形成真正的纵深防御。
 */
export class CommandAnalyzerMiddleware implements SecurityMiddleware {
  readonly name = "CommandAnalyzer";
  readonly phase = "authorize" as const;
  readonly order = -10;

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const tool = ctx.toolName.toLowerCase();
    if (tool !== "bash" && tool !== "shell") {
      return next();
    }

    const command =
      typeof ctx.toolInput["command"] === "string"
        ? ctx.toolInput["command"]
        : "";
    if (!command) return next();

    const analysis = analyzeCommand(command);

    // 填充 resolvedAccess（合并而非替换现有数据）
    const existing = ctx.request.resolvedAccess ?? {};
    ctx.request.resolvedAccess = {
      ...existing,
      paths: mergeUnique(existing.paths, analysis.accessedPaths),
      hosts: mergeUnique(existing.hosts, analysis.accessedHosts),
      envVars: mergeUnique(existing.envVars, analysis.usedEnvVars),
      commands: existing.commands ?? [command],
      commandAnalysis: analysis,
    };

    return next();
  }
}

function mergeUnique(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] {
  const set = new Set<string>();
  for (const x of a ?? []) set.add(x);
  for (const x of b ?? []) set.add(x);
  return [...set];
}
