/**
 * 权限规则存储 — Phase 2
 *
 * 管理三种作用域的权限规则：
 *   session   — 本次会话有效（纯内存，不落盘）
 *   workspace — 当前工作区有效（{rootDir}/{workspaceId}.json）
 *   global    — 跨工作区有效（{rootDir}/global.json）
 *
 * 匹配流程：
 *   1. 收集所有可见规则（session + workspace + global）
 *   2. 过滤出匹配当前工具 + 参数 glob 的规则
 *   3. 冲突解决：deny > allow，精确 > 宽泛（规格 §4.7）
 *
 * 落盘策略：
 *   - 只在 create / revoke / reset 时落盘
 *   - match 是热路径，只更新内存中的 matchCount / lastMatchedAt
 *   - 使用 tmp 文件 + rename 做原子写，避免损坏
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  IPermissionStore,
  PermissionRule,
  PermissionScope,
  SecurityRequest,
} from "./types.js";

// ─── Glob 匹配 ───

/**
 * 将 glob 模式编译为 RegExp。
 *
 * 上下文感知的语义：
 *   - 模式含 `/` → path-aware：`*` 匹配非 /，`**` 匹配任意
 *   - 模式不含 `/` → `*` 匹配任意（包括 /），等价于 `**`
 *
 * 这让 `npm install *` 能匹配 `@scope/pkg`，同时 `src/*` 仍然不跨 `/`。
 * 规格 §4.3 的 suggestPatterns 用 `*` 表示"所有 ${op.tool} 操作"，
 * 只有这种 context-aware 语义能兼顾两种直觉。
 *
 * 其他规则：
 *   - `?` 匹配单个字符（path-aware 模式下不跨 /）
 *   - 正则元字符自动转义
 *   - 整串匹配（`^...$`）
 */
export function globToRegex(pattern: string): RegExp {
  const pathAware = pattern.includes("/");
  const star = pathAware ? "[^/]*" : ".*";
  const question = pathAware ? "[^/]" : ".";

  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += star;
        i++;
      }
    } else if (c === "?") {
      re += question;
      i++;
    } else if (/[.+^${}()|\\[\]]/.test(c)) {
      re += `\\${c}`;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function globMatches(pattern: string, input: string): boolean {
  return globToRegex(pattern).test(input);
}

/**
 * 计算 glob 模式的特异性分数。
 *
 * 基于规格 §4.7 的公式 `depth * 10 - wildcards`，扩展加入字面量长度作为
 * tiebreaker——同深度同通配符数量时，字面量更长的模式得分更高。
 * 这消除了 `npm install *` 和 `npm *` 这类 9/9 平局的歧义。
 *
 * 量级设计：depth 的权重 >> wildcards 的权重 >> literal 长度的权重。
 * 这确保了深度仍然是首要排序依据，literal 只在 tiebreak 时生效。
 */
export function globSpecificity(pattern: string): number {
  const wildcards = (pattern.match(/\*/g) ?? []).length;
  const depth = pattern.split("/").length;
  const literalLength = pattern.replace(/\*/g, "").length;
  return depth * 1000 - wildcards * 10 + literalLength;
}

// ─── 存储配置 ───

const STORAGE_VERSION = 1;
const DEFAULT_SUBDIR = ".zhixing";
const PERMISSIONS_SUBDIR = "permissions";
const GLOBAL_FILE = "global.json";

export interface PermissionStoreOptions {
  /**
   * 持久化根目录。
   * - 未传：默认 ~/.zhixing/permissions/
   * - 传 null：禁用持久化（纯内存，用于测试和临时会话）
   */
  rootDir?: string | null;
  /** 时钟注入（便于测试） */
  now?: () => number;
}

interface StorageFile {
  version: number;
  scope?: "global";
  workspaceId?: string;
  workspacePath?: string;
  rules: PermissionRule[];
}

// ─── PermissionStore 实现 ───

export class PermissionStore implements IPermissionStore {
  private readonly sessionRules = new Map<string, PermissionRule[]>();
  private readonly workspaceRules = new Map<string, PermissionRule[]>();
  private globalRules: PermissionRule[] = [];
  private readonly loadedWorkspaces = new Set<string>();
  private globalLoaded = false;

  private readonly rootDir: string | null;
  private readonly now: () => number;

  constructor(options: PermissionStoreOptions = {}) {
    if (options.rootDir === null) {
      this.rootDir = null;
    } else if (options.rootDir !== undefined) {
      this.rootDir = options.rootDir;
    } else {
      this.rootDir = path.join(
        os.homedir(),
        DEFAULT_SUBDIR,
        PERMISSIONS_SUBDIR,
      );
    }
    this.now = options.now ?? (() => Date.now());
  }

  // ─── 公共 API ───

  match(
    workspaceId: string | null,
    request: SecurityRequest,
  ): PermissionRule | null {
    const tool = request.tool.toLowerCase();
    const argument = this.extractArgument(request);

    const candidates: PermissionRule[] = [];

    // 会话规则
    const sessionList = this.sessionRules.get(this.sessionKey(workspaceId));
    if (sessionList) {
      for (const rule of sessionList) {
        if (this.ruleMatches(rule, tool, argument)) candidates.push(rule);
      }
    }

    // 工作区规则
    if (workspaceId) {
      this.ensureWorkspaceLoaded(workspaceId);
      const wsList = this.workspaceRules.get(workspaceId);
      if (wsList) {
        for (const rule of wsList) {
          if (this.ruleMatches(rule, tool, argument)) candidates.push(rule);
        }
      }
    }

    // 全局规则
    this.ensureGlobalLoaded();
    for (const rule of this.globalRules) {
      if (this.ruleMatches(rule, tool, argument)) candidates.push(rule);
    }

    if (candidates.length === 0) return null;

    const chosen = this.resolveConflict(candidates);
    // 更新匹配统计（仅内存）
    chosen.matchCount += 1;
    chosen.lastMatchedAt = this.now();

    return chosen;
  }

  create(workspaceId: string | null, rule: PermissionRule): void {
    switch (rule.scope) {
      case "session": {
        const key = this.sessionKey(workspaceId);
        const list = this.sessionRules.get(key) ?? [];
        list.push(rule);
        this.sessionRules.set(key, list);
        return;
      }
      case "workspace": {
        if (!workspaceId) {
          throw new Error(
            "workspace 作用域的规则需要 workspaceId——当前无工作区上下文",
          );
        }
        this.ensureWorkspaceLoaded(workspaceId);
        const list = this.workspaceRules.get(workspaceId) ?? [];
        list.push(rule);
        this.workspaceRules.set(workspaceId, list);
        this.persistWorkspace(workspaceId);
        return;
      }
      case "global": {
        this.ensureGlobalLoaded();
        this.globalRules.push(rule);
        this.persistGlobal();
        return;
      }
    }
  }

  list(workspaceId: string | null): PermissionRule[] {
    const result: PermissionRule[] = [];
    const sessionList = this.sessionRules.get(this.sessionKey(workspaceId));
    if (sessionList) result.push(...sessionList);

    if (workspaceId) {
      this.ensureWorkspaceLoaded(workspaceId);
      const wsList = this.workspaceRules.get(workspaceId);
      if (wsList) result.push(...wsList);
    }

    this.ensureGlobalLoaded();
    result.push(...this.globalRules);
    return result;
  }

  revoke(ruleId: string): boolean {
    // 会话
    for (const [key, rules] of this.sessionRules) {
      const idx = rules.findIndex((r) => r.id === ruleId);
      if (idx !== -1) {
        rules.splice(idx, 1);
        if (rules.length === 0) this.sessionRules.delete(key);
        return true;
      }
    }
    // 工作区
    for (const [wsId, rules] of this.workspaceRules) {
      const idx = rules.findIndex((r) => r.id === ruleId);
      if (idx !== -1) {
        rules.splice(idx, 1);
        this.persistWorkspace(wsId);
        return true;
      }
    }
    // 全局
    this.ensureGlobalLoaded();
    const gIdx = this.globalRules.findIndex((r) => r.id === ruleId);
    if (gIdx !== -1) {
      this.globalRules.splice(gIdx, 1);
      this.persistGlobal();
      return true;
    }
    return false;
  }

  reset(workspaceId: string | null): void {
    this.sessionRules.delete(this.sessionKey(workspaceId));
    if (workspaceId) {
      this.workspaceRules.set(workspaceId, []);
      this.persistWorkspace(workspaceId);
    }
  }

  resetAll(): void {
    this.sessionRules.clear();
    this.workspaceRules.clear();
    this.globalRules = [];
    this.loadedWorkspaces.clear();
    this.globalLoaded = false;

    if (this.rootDir && fs.existsSync(this.rootDir)) {
      for (const entry of fs.readdirSync(this.rootDir)) {
        if (entry.endsWith(".json") || entry.endsWith(".json.tmp")) {
          try {
            fs.rmSync(path.join(this.rootDir, entry));
          } catch {
            // 忽略：可能是并发或权限问题
          }
        }
      }
    }
  }

  // ─── 静态辅助 ───

  /**
   * 根据工作区路径生成稳定的 workspaceId（SHA-256 前 16 字符）。
   * Windows 平台规范化为小写以吸收大小写差异。
   */
  static workspaceIdFromPath(workspacePath: string): string {
    const abs = path.resolve(workspacePath);
    const normalized = process.platform === "win32" ? abs.toLowerCase() : abs;
    return crypto
      .createHash("sha256")
      .update(normalized)
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * 构造一条权限规则，自动填充 id / createdAt / 统计字段。
   * 业务层调用方只需提供 pattern / decision / scope。
   */
  static createRule(
    input: Pick<PermissionRule, "pattern" | "decision" | "scope"> &
      Partial<Pick<PermissionRule, "workspace">>,
    now: () => number = () => Date.now(),
  ): PermissionRule {
    return {
      id: crypto.randomUUID(),
      pattern: input.pattern,
      decision: input.decision,
      scope: input.scope,
      createdAt: now(),
      lastMatchedAt: 0,
      matchCount: 0,
      workspace: input.workspace,
    };
  }

  // ─── 内部：匹配与冲突解决 ───

  private ruleMatches(
    rule: PermissionRule,
    tool: string,
    argument: string,
  ): boolean {
    if (
      rule.pattern.tool !== "*" &&
      rule.pattern.tool.toLowerCase() !== tool
    ) {
      return false;
    }
    return globMatches(rule.pattern.argument, argument);
  }

  private resolveConflict(candidates: PermissionRule[]): PermissionRule {
    // deny 胜出 allow
    const denies = candidates.filter((r) => r.decision === "deny");
    const pool = denies.length > 0 ? denies : candidates;
    return this.mostSpecific(pool);
  }

  private mostSpecific(rules: PermissionRule[]): PermissionRule {
    let best = rules[0]!;
    let bestScore = globSpecificity(best.pattern.argument);
    for (let i = 1; i < rules.length; i++) {
      const rule = rules[i]!;
      const score = globSpecificity(rule.pattern.argument);
      if (score > bestScore) {
        best = rule;
        bestScore = score;
      }
    }
    return best;
  }

  private extractArgument(request: SecurityRequest): string {
    const tool = request.tool.toLowerCase();
    const args = request.arguments;

    if (tool === "bash" || tool === "shell") {
      return typeof args["command"] === "string" ? args["command"] : "";
    }

    for (const key of ["path", "file_path", "target", "destination"]) {
      const val = args[key];
      if (typeof val === "string") return val;
    }

    // 泛型回退：第一个字符串参数
    for (const val of Object.values(args)) {
      if (typeof val === "string") return val;
    }
    return "";
  }

  private sessionKey(workspaceId: string | null): string {
    return workspaceId ?? "";
  }

  // ─── 内部：持久化 ───

  private ensureGlobalLoaded(): void {
    if (this.globalLoaded) return;
    this.globalLoaded = true;

    if (!this.rootDir) return;
    const file = path.join(this.rootDir, GLOBAL_FILE);
    if (!fs.existsSync(file)) return;

    try {
      const raw = fs.readFileSync(file, "utf-8");
      const data = JSON.parse(raw) as StorageFile;
      this.globalRules = this.sanitizeRules(data.rules ?? [], "global");
    } catch {
      // 损坏文件：视为空，不中断程序
      this.globalRules = [];
    }
  }

  private ensureWorkspaceLoaded(workspaceId: string): void {
    if (this.loadedWorkspaces.has(workspaceId)) return;
    this.loadedWorkspaces.add(workspaceId);

    if (!this.rootDir) return;
    const file = path.join(this.rootDir, `${workspaceId}.json`);
    if (!fs.existsSync(file)) return;

    try {
      const raw = fs.readFileSync(file, "utf-8");
      const data = JSON.parse(raw) as StorageFile;
      this.workspaceRules.set(
        workspaceId,
        this.sanitizeRules(data.rules ?? [], "workspace"),
      );
    } catch {
      this.workspaceRules.set(workspaceId, []);
    }
  }

  /**
   * 对从磁盘读取的规则做基本校验：过滤掉结构不对的条目，
   * 防止损坏数据传染到后续决策。
   */
  private sanitizeRules(
    rules: unknown[],
    expectedScope: PermissionScope,
  ): PermissionRule[] {
    const out: PermissionRule[] = [];
    for (const raw of rules) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Partial<PermissionRule>;
      if (
        typeof r.id !== "string" ||
        !r.pattern ||
        typeof r.pattern.tool !== "string" ||
        typeof r.pattern.argument !== "string" ||
        (r.decision !== "allow" && r.decision !== "deny") ||
        (r.scope !== "session" &&
          r.scope !== "workspace" &&
          r.scope !== "global")
      ) {
        continue;
      }
      // 磁盘上只应该有 workspace/global 作用域
      if (r.scope !== expectedScope && expectedScope === "global") continue;
      out.push({
        id: r.id,
        pattern: { tool: r.pattern.tool, argument: r.pattern.argument },
        decision: r.decision,
        scope: r.scope,
        createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
        lastMatchedAt:
          typeof r.lastMatchedAt === "number" ? r.lastMatchedAt : 0,
        matchCount: typeof r.matchCount === "number" ? r.matchCount : 0,
        workspace: typeof r.workspace === "string" ? r.workspace : undefined,
      });
    }
    return out;
  }

  private persistWorkspace(workspaceId: string): void {
    if (!this.rootDir) return;
    this.ensureDir();
    const file = path.join(this.rootDir, `${workspaceId}.json`);
    const rules = this.workspaceRules.get(workspaceId) ?? [];
    const data: StorageFile = {
      version: STORAGE_VERSION,
      workspaceId,
      workspacePath: rules[0]?.workspace,
      rules,
    };
    this.atomicWriteJson(file, data);
  }

  private persistGlobal(): void {
    if (!this.rootDir) return;
    this.ensureDir();
    const file = path.join(this.rootDir, GLOBAL_FILE);
    const data: StorageFile = {
      version: STORAGE_VERSION,
      scope: "global",
      rules: this.globalRules,
    };
    this.atomicWriteJson(file, data);
  }

  private atomicWriteJson(file: string, data: StorageFile): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  }

  private ensureDir(): void {
    if (!this.rootDir) return;
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }
  }
}
