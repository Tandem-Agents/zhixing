/**
 * 路径守卫 — 路径解析工具（static）
 *
 * 提供 realpath 解析（防 symlink 逃逸）与工作区边界判断。
 *
 * 不再是 SecurityMiddleware —— 路径解析职责已上移到 authorize 阶段的
 * `PathResolveMiddleware`（在 PolicyEvaluator 之前把 realpath 后的路径填进
 * `resolvedAccess.paths`，下游 PolicyEngine / FileSystemClassifier 统一消费）。
 * 本模块退化为被该中间件与 FileSystemClassifier 复用的纯解析 static。
 *
 * 敏感路径保护由 `builtin-rules.ts` 的 bypassImmune 规则（经 PolicyEngine）
 * 统一负责 —— 本模块不再持有第二套敏感路径清单（消除双清单认知坑）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { expandUserHome } from "../paths.js";

export class PathGuard {
  /**
   * 解析路径：展开 ~，解析 ../ 和符号链接（realpath）。
   *
   * 路径不存在时（新建文件场景）回退到「最近存在祖先目录的 realpath + 拼接剩余段」——
   * 确保父目录中的 symlink 也被解析，防止 `workspace/<软链目录>/newfile` 通过未解析
   * 的父 symlink 绕过边界检查。全程无存在祖先（极端）时兜底 normalize（只会更严）。
   */
  static resolve(targetPath: string, cwd: string): string {
    const absolute = path.resolve(cwd, expandUserHome(targetPath));
    try {
      return fs.realpathSync(absolute);
    } catch {
      return PathGuard.resolveExistingAncestor(absolute);
    }
  }

  /**
   * 对不存在的路径：逐级回退到最近存在的祖先目录做 realpath，再拼回剩余不存在段。
   * 到达文件系统根仍找不到存在祖先时兜底 normalize。
   */
  private static resolveExistingAncestor(absolute: string): string {
    const normalized = path.normalize(absolute);
    const missing: string[] = [];
    let current = normalized;

    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        // 到根仍不存在 —— 兜底逻辑路径
        return normalized;
      }
      missing.unshift(path.basename(current));
      try {
        const realParent = fs.realpathSync(parent);
        return path.join(realParent, ...missing);
      } catch {
        current = parent;
      }
    }
  }

  /**
   * 判断路径是否在工作区内 —— realpath 两边后比较，防 symlink 逃逸。
   */
  static isWithinWorkspace(
    targetPath: string,
    workspace: string,
    cwd: string,
  ): boolean {
    // 两边走同一 resolve（realpath + 祖先解析），保证对称——避免 target 解析了
    // symlink 而 workspace 没解析（或反之）导致前缀比较失真。
    const resolved = PathGuard.resolve(targetPath, cwd);
    const workspaceResolved = PathGuard.resolve(workspace, cwd);

    return (
      resolved === workspaceResolved ||
      resolved.startsWith(workspaceResolved + path.sep)
    );
  }
}
