/**
 * 操作分类器 — 按影响范围分类
 *
 * 这是 Phase 2 安全系统的核心判断器。它不拦截也不确认，
 * 只回答一个问题："这个操作的影响范围多大？"
 *
 * 四级分类：
 *   observe   — 只读取信息，无副作用（自动放行）
 *   internal  — 只影响本地工作区（自动放行）
 *   external  — 影响外部系统或他人（需要权限）
 *   critical  — 不可逆 / 高危（始终确认或 bypassImmune 阻止）
 *
 * 两种机制：
 *   1. 上下文分类器 — 影响等级取决于运行时上下文
 *      (FileSystemClassifier / ShellClassifier)
 *   2. 边界影响分类器 — 影响等级由工具的边界声明确定
 *      (BoundaryImpactClassifier)
 *
 * CompositeClassifier 根据工具名分发到具体分类器。
 * 未注册的工具落入边界分类器；未声明边界的工具一律 critical（fail-to-confirm）。
 */

import { PathGuard } from "./path-guard.js";
import type {
  BoundaryCrossing,
  BoundaryType,
  OperationClass,
  OperationClassifier,
  SecurityRequest,
  ToolBoundaryRegistry,
} from "./types.js";

// ─── 工具方法 ───

const CLASS_ORDER: OperationClass[] = [
  "observe",
  "internal",
  "external",
  "critical",
];

function maxClass(a: OperationClass, b: OperationClass): OperationClass {
  return CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b) ? a : b;
}

// ─── FileSystemClassifier ───

/**
 * 文件系统分类器。
 * 影响等级取决于目标路径是否在工作区内：
 * - 读取 → observe（始终）
 * - 写入工作区内 → internal
 * - 写入工作区外 → external
 * - 无工作区上下文 → 所有写操作都是 external
 *
 * 符号链接攻击防护：通过 PathGuard.isWithinWorkspace 的 realpath 解析，
 * 防止工作区内的 symlink 指向外部敏感文件。
 */
const FS_READ_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "file_read",
  "readfile",
]);

const FS_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "file_write",
  "writefile",
]);

export class FileSystemClassifier implements OperationClassifier {
  classify(request: SecurityRequest): OperationClass {
    const tool = request.tool.toLowerCase();

    if (FS_READ_TOOLS.has(tool)) return "observe";

    if (FS_WRITE_TOOLS.has(tool)) {
      const paths = this.extractPaths(request);
      if (paths.length === 0) return "external";

      const workspace = request.context.workspace;
      if (!workspace) return "external";

      // 任一目标路径逃出工作区即升级为 external——
      // 防止通过多路径参数绕过边界检查
      const allInside = paths.every((p) =>
        PathGuard.isWithinWorkspace(p, workspace, request.context.cwd),
      );
      return allInside ? "internal" : "external";
    }

    return "external";
  }

  private extractPaths(request: SecurityRequest): string[] {
    if (
      request.resolvedAccess?.paths &&
      request.resolvedAccess.paths.length > 0
    ) {
      return request.resolvedAccess.paths;
    }
    const paths: string[] = [];
    const args = request.arguments;
    for (const key of ["path", "file_path", "target", "destination"]) {
      const val = args[key];
      if (typeof val === "string") paths.push(val);
    }
    return paths;
  }
}

// ─── ShellClassifier ───

/**
 * 安全只读命令——精确匹配可执行文件名。
 * 严格对齐规格 §3.3：echo 不在列表中（副作用取决于重定向，不值得开白名单）。
 * cat 保留：纯只读操作，敏感路径由策略引擎的 bypassImmune 规则先拦截。
 */
const SAFE_READ_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "dir",
  "pwd",
  "wc",
  "date",
  "whoami",
  "hostname",
  "cat",
  "head",
  "tail",
  "less",
  "file",
  "stat",
]);

/**
 * 安全子命令——executable + subcommand 的只读查询。
 * 规格 §3.3 定义：git 系列只读子命令。
 */
const SAFE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set([
    "status",
    "log",
    "diff",
    "branch",
    "show",
    "remote",
  ]),
};

/**
 * 本地作用域命令——包管理器、构建工具、测试运行器。
 * 这些命令修改本地项目状态但通常不触及外部系统（哪怕拉 npm 包，用户意图就是如此）。
 */
const LOCAL_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "cargo",
  "go",
  "mvn",
  "gradle",
  "make",
  "cmake",
  "ninja",
  "pip",
  "poetry",
  "pipenv",
  "uv",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "eslint",
  "prettier",
]);

/**
 * 破坏性命令正则表达式——对齐策略引擎的 cf-destructive-commands 规则，
 * 作为 ShellClassifier 的独立纵深防御（策略引擎是第一道，分类器是第二道）。
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  /\bdd\s+/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bshred\b/i,
];

export class ShellClassifier implements OperationClassifier {
  classify(request: SecurityRequest): OperationClass {
    const command = this.extractCommand(request);
    if (!command) return "external";

    const trimmed = command.trim();
    if (trimmed.length === 0) return "external";

    // 破坏性命令优先判定——无论是否含链式操作符都是 critical
    if (this.isDestructive(trimmed)) return "critical";

    // 含管道、重定向、链式操作符、命令替换 → 不走快捷路径
    // 优先使用 CommandAnalyzer 的精准（quote-aware）结果；
    // 没有分析结果时（直接使用 classifier 不经 pipeline）回退到保守正则
    const analysis = request.resolvedAccess?.commandAnalysis;
    const hasChain = analysis
      ? analysis.hasChain
      : this.hasChainOperators(trimmed);
    if (hasChain) return "external";

    const tokens = trimmed.split(/\s+/);
    const executable = this.normalizeExecutable(tokens[0] ?? "");

    // 精确匹配只读命令
    if (SAFE_READ_COMMANDS.has(executable)) return "observe";

    // 匹配 executable + subcommand
    const subcommand = tokens[1]?.toLowerCase();
    const subList = SAFE_SUBCOMMANDS[executable];
    if (subcommand && subList?.has(subcommand)) return "observe";

    if (LOCAL_SCOPED_COMMANDS.has(executable)) return "internal";

    return "external";
  }

  /**
   * 归一化可执行文件名：去掉路径前缀，小写。
   * `/usr/bin/ls` → `ls`，`./script.sh` → `script.sh`
   */
  private normalizeExecutable(raw: string): string {
    const base = raw.split(/[\\/]/).pop() ?? raw;
    return base.toLowerCase();
  }

  /**
   * 保守的链式操作符检测——接受误报。
   * 规格 §3.3 注：文件名含 `>` `|` 的误报只会把操作升级为 external，
   * 不会降级安全等级。Phase 2 的 CommandAnalyzer 提供引号感知的精准检测。
   */
  private hasChainOperators(command: string): boolean {
    return /[|><;`]|&&|\|\||\$\(/.test(command);
  }

  private isDestructive(command: string): boolean {
    return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
  }

  private extractCommand(request: SecurityRequest): string | null {
    const cmd = request.arguments["command"];
    if (typeof cmd === "string") return cmd;

    const commands = request.resolvedAccess?.commands;
    if (commands && commands.length > 0) return commands[0] ?? null;

    return null;
  }
}

// ─── BoundaryImpactClassifier ───

/**
 * 读类访问模式——跨越边界但不产生副作用。
 * 这些访问一律归类为 observe，不管边界类型是什么。
 */
const BOUNDARY_READ_ACCESS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "query",
  "view",
  "fetch",
  "get",
  "describe",
  "inspect",
]);

/**
 * 写类访问在各边界类型下的默认影响等级。
 * 规格 §3.3 的映射表：
 * - process 的写（exec）本身是 internal，命令本身的影响由 ShellClassifier 判断
 * - filesystem 的写在无工作区上下文时回退到 external（有上下文时会走 FileSystemClassifier）
 * - secrets / system / financial 始终是 critical
 */
const BOUNDARY_WRITE_IMPACT: Readonly<Record<BoundaryType, OperationClass>> = {
  process: "internal",
  filesystem: "external",
  network: "external",
  messaging: "external",
  calendar: "external",
  "external-service": "external",
  secrets: "critical",
  system: "critical",
  financial: "critical",
};

export class BoundaryImpactClassifier implements OperationClassifier {
  constructor(private readonly registry: ToolBoundaryRegistry) {}

  classify(request: SecurityRequest): OperationClass {
    const crossings = this.registry.getBoundaries(request.tool);

    // 未声明边界跨越的工具是最不可信的——fail-to-confirm
    if (!crossings || crossings.length === 0) return "critical";

    let maxImpact: OperationClass = "observe";
    for (const crossing of crossings) {
      maxImpact = maxClass(maxImpact, this.classifyCrossing(crossing));
    }
    return maxImpact;
  }

  private classifyCrossing(crossing: BoundaryCrossing): OperationClass {
    const access = crossing.access.toLowerCase();
    if (BOUNDARY_READ_ACCESS.has(access)) return "observe";
    return BOUNDARY_WRITE_IMPACT[crossing.boundaryType] ?? "external";
  }
}

// ─── CompositeClassifier ───

/**
 * 组合分类器 — 按工具名分发到具体分类器。
 *
 * 工具分三类：
 * 1. 注册了上下文分类器的工具 → 使用该分类器（FS / Shell）
 * 2. 其他已知工具 → 走边界影响分类器（读工具边界声明）
 * 3. 完全未注册的工具 → 如果没有 boundary classifier，则 critical
 */
export class CompositeClassifier implements OperationClassifier {
  private contextClassifiers = new Map<string, OperationClassifier>();
  private boundaryClassifier: OperationClassifier | null = null;

  registerContext(toolName: string, classifier: OperationClassifier): this {
    this.contextClassifiers.set(toolName.toLowerCase(), classifier);
    return this;
  }

  setBoundaryClassifier(classifier: OperationClassifier): this {
    this.boundaryClassifier = classifier;
    return this;
  }

  classify(request: SecurityRequest): OperationClass {
    const specific = this.contextClassifiers.get(request.tool.toLowerCase());
    if (specific) return specific.classify(request);

    if (this.boundaryClassifier) {
      return this.boundaryClassifier.classify(request);
    }

    // 无任何分类器可用 → 最保守：critical
    return "critical";
  }

  /** 返回已注册的上下文分类器名单（用于调试） */
  getRegisteredTools(): string[] {
    return [...this.contextClassifiers.keys()];
  }
}

// ─── 空注册表 ───

/**
 * 空边界注册表——所有工具都返回 undefined。
 * 在没有 ToolRegistry 接入时作为默认 fallback：所有未注册的工具都是 critical。
 */
export const EMPTY_BOUNDARY_REGISTRY: ToolBoundaryRegistry = {
  getBoundaries: () => undefined,
};

// ─── 工厂 ───

export interface CreateClassifierOptions {
  /** 工具边界注册表。未提供时使用空注册表——所有未注册工具分类为 critical */
  registry?: ToolBoundaryRegistry;
}

/**
 * 创建默认的组合分类器。
 * 注册 FS / Shell 上下文分类器 + BoundaryImpactClassifier 作为默认 fallback。
 */
export function createDefaultClassifier(
  options: CreateClassifierOptions = {},
): CompositeClassifier {
  const composite = new CompositeClassifier();
  const fsClassifier = new FileSystemClassifier();

  // 文件系统工具
  for (const name of FS_READ_TOOLS) {
    composite.registerContext(name, fsClassifier);
  }
  for (const name of FS_WRITE_TOOLS) {
    composite.registerContext(name, fsClassifier);
  }

  // Shell 工具
  const shellClassifier = new ShellClassifier();
  composite.registerContext("bash", shellClassifier);
  composite.registerContext("shell", shellClassifier);

  // 其他工具走边界分类器
  const registry = options.registry ?? EMPTY_BOUNDARY_REGISTRY;
  composite.setBoundaryClassifier(new BoundaryImpactClassifier(registry));

  return composite;
}
