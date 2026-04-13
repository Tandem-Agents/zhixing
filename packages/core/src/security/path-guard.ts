/**
 * 路径守卫
 *
 * 职责：
 * 1. 路径规范化 — 解析 ../ 和符号链接，防止路径遍历攻击
 * 2. 边界检查 — 判断路径是否在工作区内
 * 3. 敏感路径保护 — 阻止访问系统关键目录
 *
 * 符号链接攻击防护：
 * 对所有路径做 realpath 解析后再判断是否在工作区内，
 * 防止 workspace/link → ~/.ssh/id_rsa 这样的攻击。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "./types.js";

/**
 * 系统保护路径——无论工作区配置如何，这些路径下的写操作都会被标记。
 * 策略引擎的 bypassImmune 规则处理阻止逻辑，PathGuard 只做规范化和标记。
 */
const SYSTEM_PROTECTED_PATHS = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws/credentials",
  "~/.config/gcloud",
] as const;

export class PathGuard implements SecurityMiddleware {
  readonly name = "PathGuard";
  readonly phase = "guard" as const;
  readonly order = 20;

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const rawPaths = this.extractPaths(ctx);

    if (rawPaths.length === 0) {
      return next();
    }

    const cwd = ctx.request.context.cwd;
    const resolvedPaths: string[] = [];

    for (const rawPath of rawPaths) {
      const resolved = PathGuard.resolve(rawPath, cwd);
      resolvedPaths.push(resolved);
    }

    ctx.state.resolvedPaths = resolvedPaths;

    // 补充 resolvedAccess.paths 供后续中间件使用
    if (!ctx.request.resolvedAccess) {
      ctx.request.resolvedAccess = {};
    }
    ctx.request.resolvedAccess.paths = resolvedPaths;

    const result = await next();
    return {
      ...result,
      resolvedPaths,
    };
  }

  /**
   * 解析路径：展开 ~，解析 ../ 和 .，尝试 realpath 解析符号链接。
   * 路径不存在时回退到逻辑路径解析（新建文件场景）。
   */
  static resolve(targetPath: string, cwd: string): string {
    const expanded = PathGuard.expandHome(targetPath);
    const absolute = path.resolve(cwd, expanded);

    try {
      return fs.realpathSync(absolute);
    } catch {
      return path.normalize(absolute);
    }
  }

  /**
   * 判断路径是否在工作区内。
   * 使用 realpath 解析后比较，防止符号链接逃逸。
   */
  static isWithinWorkspace(
    targetPath: string,
    workspace: string,
    cwd: string,
  ): boolean {
    const resolved = PathGuard.resolve(targetPath, cwd);
    let workspaceResolved: string;

    try {
      workspaceResolved = fs.realpathSync(path.resolve(workspace));
    } catch {
      workspaceResolved = path.normalize(path.resolve(workspace));
    }

    return (
      resolved.startsWith(workspaceResolved + path.sep) ||
      resolved === workspaceResolved
    );
  }

  /**
   * 检查路径是否指向系统保护路径。
   * 系统保护路径下的任何操作都应该被特殊处理。
   */
  static isSystemProtected(targetPath: string, cwd: string): boolean {
    const resolved = PathGuard.resolve(targetPath, cwd);
    const home = os.homedir();

    for (const protectedPath of SYSTEM_PROTECTED_PATHS) {
      const expanded = protectedPath.replace("~", home);
      const normalizedProtected = path.normalize(expanded);

      if (
        resolved.startsWith(normalizedProtected + path.sep) ||
        resolved === normalizedProtected
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * 检测路径中是否包含路径遍历序列（../）。
   * 即使最终 resolve 后合法，遍历序列本身也值得记录。
   */
  static hasTraversalSequence(targetPath: string): boolean {
    return /\.\.[/\\]/.test(targetPath) || targetPath === "..";
  }

  /** 展开路径中的 ~ 为用户主目录 */
  static expandHome(targetPath: string): string {
    if (targetPath === "~" || targetPath.startsWith("~/")) {
      return path.join(os.homedir(), targetPath.slice(1));
    }
    if (targetPath.startsWith("~\\")) {
      return path.join(os.homedir(), targetPath.slice(2));
    }
    return targetPath;
  }

  /** 从中间件上下文中提取文件路径 */
  private extractPaths(ctx: SecurityMiddlewareContext): string[] {
    const paths: string[] = [];
    const args = ctx.toolInput;

    if (typeof args["path"] === "string") paths.push(args["path"]);
    if (typeof args["file_path"] === "string") paths.push(args["file_path"]);
    if (typeof args["target"] === "string") paths.push(args["target"]);
    if (typeof args["destination"] === "string")
      paths.push(args["destination"]);

    return paths;
  }
}
