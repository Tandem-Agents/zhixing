/**
 * 路径解析中间件 — authorize 阶段早期（order -5）
 *
 * 在 PolicyEvaluator(0) 之前、CommandAnalyzer(-10) 之后运行：把工具参数中的
 * 文件路径 + CommandAnalyzer 从 bash 命令提取的路径，统一做 `realpath` 解析，
 * 回写 `request.resolvedAccess.paths`。
 *
 * 这是**路径的单一解析点**：下游 `PolicyEngine.extractPaths` 与
 * `FileSystemClassifier.extractPaths` 都已优先读 `resolvedAccess.paths`，因此
 * realpath 后的路径自动参与 bypassImmune 路径规则匹配与影响分类 —— 使敏感路径
 * 保护（凭证 / 密钥 / .git）对 symlink 生效，消除「决策用未解析路径、realpath 却
 * 发生在决策之后」的 symlink 绕过（原 PathGuard 在 guard 阶段、决策之后才解析）。
 */

import { PathGuard } from "./path-guard.js";
import { ToolFilePathExtractor } from "./tool-aware-extractor.js";
import type {
  IToolFilePathExtractor,
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "./types.js";

const DEFAULT_FILE_PATH_EXTRACTOR = new ToolFilePathExtractor();

export class PathResolveMiddleware implements SecurityMiddleware {
  readonly name = "PathResolve";
  readonly phase = "authorize" as const;
  readonly order = -5;

  constructor(
    private readonly filePathExtractor: IToolFilePathExtractor = DEFAULT_FILE_PATH_EXTRACTOR,
  ) {}

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const cwd = ctx.request.context.cwd;
    const raw = new Set<string>();

    // 1. 标准路径键 + 显式声明的 filePathArgumentKeys（及 glob/grep 缺省 cwd）
    for (const p of this.filePathExtractor.extract(ctx.toolName, ctx.toolInput, cwd)) {
      if (p.length > 0) raw.add(p);
    }
    // 2. CommandAnalyzer 从 bash 命令提取的路径（含重定向目标）
    for (const p of ctx.request.resolvedAccess?.paths ?? []) raw.add(p);

    if (raw.size === 0) return next();

    const resolved = [...new Set([...raw].map((p) => PathGuard.resolve(p, cwd)))];

    if (!ctx.request.resolvedAccess) ctx.request.resolvedAccess = {};
    ctx.request.resolvedAccess.paths = resolved;
    // 供 buildFinalResult → result.resolvedPaths（确认面板显示）与 SecurityAuditor 复用
    ctx.state.resolvedPaths = resolved;

    return next();
  }
}
