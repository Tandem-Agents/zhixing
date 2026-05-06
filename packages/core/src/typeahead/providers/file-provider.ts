/**
 * FileProvider —— `@file` 文件路径补全 provider
 *
 * 职责（spec §Step 6，priority=200）：
 *   1. matchTrigger: 检测 `@` 触发，区分显式 `@file:path` 和裸 `@path` 启发式
 *   2. query: 异步读取目录内容，支持 AbortSignal 取消
 *   3. 路径展开：相对路径基于 workspace root，支持 `~/` 和绝对路径
 *   4. 隐藏文件（`.` 开头）仅在显式 `@file:` 前缀时显示
 *   5. metadata 标记 `isOutsideWorkspace`，与安全系统信任边界一致
 *
 * 搜索根目录基于「当前生效的工作区」（`resolvedWorkspace.path`），
 * 由构造参数 `{ root }` 注入，不自己调 `process.cwd()`。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expandUserHome } from "../../paths.js";

import { findTriggerToken } from "../trigger-matcher.js";
import type {
  SuggestionItem,
  SuggestionProvider,
  TriggerContext,
  TriggerMatch,
} from "../types.js";

// ─── 选项 ───

export interface FileProviderOptions {
  /**
   * 搜索根目录（绝对路径）—— 接收 `resolvedWorkspace.path`。
   * FileProvider 不自己调 `process.cwd()`。
   */
  readonly root: string;
  /**
   * 单次查询最大返回条目数。防止大目录撑爆渲染器。
   * 默认 100。
   */
  readonly maxResults?: number;
}

// ─── 常量 ───

/**
 * @ trigger 的 token 字符类 —— 在默认的 `\p{L}\p{N}_\-:` 基础上
 * 增加 `.`（文件扩展名 / 相对路径）、`/`（目录分隔）、`~`（home 目录）。
 */
const FILE_TOKEN_CHAR_CLASS = "\\p{L}\\p{N}_\\-:./~";

const DEFAULT_MAX_RESULTS = 100;

/** 已知的非 file @ 前缀 —— matchTrigger 遇到这些前缀时让出 */
const NON_FILE_PREFIXES = ["memory:", "tool:"] as const;

// ─── Provider Data ───

interface FileProviderData {
  readonly explicit: boolean;
}

// ─── 路径解析结果 ───

interface ResolvedPath {
  /** 相对路径的"目录"部分（用于拼接最终候选的相对路径），正斜杠 */
  readonly relativeDir: string;
  /** 前缀过滤（basename 部分），空字符串表示列出全部 */
  readonly prefix: string;
  /** 要 readdir 的绝对目录路径（OS 原生分隔符） */
  readonly resolvedDir: string;
}

// ─── 实现 ───

export class FileProvider implements SuggestionProvider {
  readonly id = "file";
  readonly priority = 200;
  readonly supportsGhostText = false;
  readonly supportsChaining = false;

  private readonly root: string;
  private readonly maxResults: number;

  constructor(options: FileProviderOptions) {
    this.root = path.resolve(options.root);
    this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  }

  // ── Trigger 检测 ──

  matchTrigger(ctx: TriggerContext): TriggerMatch | null {
    const token = findTriggerToken(ctx.draft, ctx.cursor, {
      triggerChar: "@",
      tokenCharClass: FILE_TOKEN_CHAR_CLASS,
      requireBoundary: true,
      wordTerminators: ctx.wordTerminators,
    });
    if (!token) return null;

    const { query } = token;

    // 显式 @file:path 前缀 —— 无条件匹配
    if (query.startsWith("file:")) {
      const filePath = query.slice(5); // "file:".length
      return {
        providerId: this.id,
        tokenStart: token.tokenStart,
        tokenEnd: token.tokenEnd,
        token: token.token,
        query: filePath,
        runtime: ctx.runtime,
        providerData: { explicit: true } satisfies FileProviderData,
      };
    }

    // 已知非 file 前缀 —— 让出给未来的 MemoryProvider / ToolProvider
    for (const prefix of NON_FILE_PREFIXES) {
      if (query.startsWith(prefix)) return null;
    }

    // 空 query（裸 @）—— 不触发，太模糊
    if (query === "") return null;

    // 裸 @path 启发式 —— 非空 query 全部尝试匹配
    // Phase 2 当前只有 FileProvider 处理 @，所以宽松匹配。
    // Phase 3 MemoryProvider/ToolProvider 上线后，可以收紧到"必须含 / . ~"的启发式。
    return {
      providerId: this.id,
      tokenStart: token.tokenStart,
      tokenEnd: token.tokenEnd,
      token: token.token,
      query,
      runtime: ctx.runtime,
      providerData: { explicit: false } satisfies FileProviderData,
    };
  }

  // ── Query ──

  async query(
    match: TriggerMatch,
    signal: AbortSignal,
  ): Promise<SuggestionItem[]> {
    const { query } = match;
    const { explicit } =
      (match.providerData as FileProviderData | undefined) ?? {
        explicit: false,
      };

    const resolved = this.resolvePath(query);
    if (signal.aborted) return [];

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(resolved.resolvedDir, {
        withFileTypes: true,
      });
    } catch {
      // 目录不存在、无权限等 —— 静默返回空
      return [];
    }

    if (signal.aborted) return [];

    const items: SuggestionItem[] = [];

    for (const entry of entries) {
      if (items.length >= this.maxResults) break;

      // 隐藏文件过滤：仅显式 @file: 前缀时显示
      if (entry.name.startsWith(".") && !explicit) continue;

      // 前缀过滤（大小写不敏感）
      if (
        resolved.prefix &&
        !entry.name.toLowerCase().startsWith(resolved.prefix.toLowerCase())
      ) {
        continue;
      }

      const isDir = entry.isDirectory();
      const relativePath = resolved.relativeDir
        ? `${resolved.relativeDir}/${entry.name}`
        : entry.name;
      const resolvedAbsPath = path.resolve(resolved.resolvedDir, entry.name);
      const isOutsideWorkspace = !this.isInsideWorkspace(resolvedAbsPath);

      items.push({
        id: `file:${relativePath}`,
        providerId: this.id,
        displayText: isDir ? `${entry.name}/` : entry.name,
        description: relativePath,
        icon: isDir ? "\u{1F4C1}" : "\u{1F4C4}",
        tag: isOutsideWorkspace ? "external" : undefined,
        acceptPayload: {
          // 目录：尾 / 保留，继续触发子目录浏览
          // 文件：加尾部空格，打断 trigger token，用户可直接输入后续文字
          replacement: isDir
            ? `@file:${relativePath}/`
            : `@file:${relativePath} `,
          execute: false, // 文件引用不立即执行，嵌入 draft 发给 agent
          metadata: {
            resolvedPath: normalizeToForwardSlash(resolvedAbsPath),
            isDirectory: isDir,
            isOutsideWorkspace,
          },
        },
      });
    }

    // 排序：目录在前，然后按名称字母序
    items.sort((a, b) => {
      const aDir = a.displayText.endsWith("/");
      const bDir = b.displayText.endsWith("/");
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.displayText.localeCompare(b.displayText);
    });

    return items;
  }

  // ── 路径解析 ──

  /**
   * 把用户输入的 query 解析成：要 readdir 的目录 + 前缀过滤 + 相对路径前缀。
   *
   * 路径展开规则（spec §Step 6）：
   * - `src/foo` → 相对于 workspace root
   * - `./foo`  → 相对于 workspace root（显式写法）
   * - `../foo` → workspace root 的上级
   * - `~/foo`  → 用户 home 目录
   * - `/etc`   → 绝对路径
   */
  private resolvePath(query: string): ResolvedPath {
    // 把 query 分成 "目录部分" 和 "前缀部分"
    // 例：query = "src/foo" → dirPart = "src", prefixPart = "foo"
    //     query = "src/"    → dirPart = "src/", prefixPart = ""
    //     query = "foo"     → dirPart = "", prefixPart = "foo"
    //     query = ""        → dirPart = "", prefixPart = ""

    const endsWithSlash = query.endsWith("/");
    let dirPart: string;
    let prefixPart: string;

    if (query === "" || endsWithSlash) {
      dirPart = query;
      prefixPart = "";
    } else {
      const lastSlash = query.lastIndexOf("/");
      if (lastSlash === -1) {
        dirPart = "";
        prefixPart = query;
      } else {
        dirPart = query.substring(0, lastSlash + 1); // 包含尾 /
        prefixPart = query.substring(lastSlash + 1);
      }
    }

    // 把 dirPart 解析成绝对路径
    const resolvedDir = this.resolveToAbsolute(dirPart || ".");

    // relativeDir：用于拼接候选项的相对路径（正斜杠，不含尾 /）
    const relativeDir = dirPart.replace(/\/$/, "");

    return {
      relativeDir,
      prefix: prefixPart,
      resolvedDir,
    };
  }

  /**
   * 把路径片段解析成绝对目录路径。
   */
  private resolveToAbsolute(segment: string): string {
    const expanded = expandUserHome(segment);
    if (path.isAbsolute(expanded)) {
      return path.resolve(expanded);
    }
    return path.resolve(this.root, expanded);
  }

  /**
   * 判断绝对路径是否在 workspace root 内部。
   */
  private isInsideWorkspace(absPath: string): boolean {
    const normalized = path.resolve(absPath);
    return (
      normalized === this.root || normalized.startsWith(this.root + path.sep)
    );
  }
}

// ─── 工具函数 ───

/**
 * 统一为正斜杠 —— metadata 里的 resolvedPath 跨平台一致。
 */
function normalizeToForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}
