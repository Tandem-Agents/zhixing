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
import * as path from "node:path";

import { getZhixingHome } from "../paths.js";
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
const PERMISSIONS_SUBDIR = "permissions";
const GLOBAL_FILE = "global.json";

/**
 * 默认权限存储根目录——~/.zhixing/permissions/（含 ZHIXING_HOME 覆盖）。
 *
 * 惰性求值，每次调用走 getZhixingHome 让 env 切换在测试 / 部署期能即时生效。
 */
export function getPermissionsDir(): string {
  return path.join(getZhixingHome(), PERMISSIONS_SUBDIR);
}

export interface PermissionStoreOptions {
  /**
   * 持久化根目录。
   * - 未传：默认 ~/.zhixing/permissions/
   * - 传 null：禁用持久化（纯内存，用于测试和临时会话）
   */
  rootDir?: string | null;
  /** 时钟注入（便于测试） */
  now?: () => number;
  /**
   * 自定义参数提取器。
   *
   * - 未注入：使用 `defaultExtractArgument`（priority list `path / file_path /
   *   target / destination` + bash/shell 特例 + 第一个 string 字段 fallback）
   * - 生产入口（CLI run-agent / serve）应注入 `createToolAwareExtractor(tools)`，
   *   读取每个工具自身的 `ToolDefinition.permissionArgumentKey` 显式声明，
   *   避免多 string 字段工具的字段顺序歧义
   *
   * 见 [tool-permission-execution.md §4.2](../../../../research/design/specifications/tool-permission-execution.md)
   * 与 ADR-TPE-007（依赖注入而非穿透 tools）。
   */
  extractArgument?: (request: SecurityRequest) => string;
}

/**
 * 深拷贝 PermissionRule（pattern 是唯一嵌套可变字段，其他都是 primitive）。
 * 用于 `registerBuiltinRules` 入栈时和 `getBuiltinRules` 出栈时的双向防御性拷贝。
 */
function cloneRule(rule: PermissionRule): PermissionRule {
  return {
    ...rule,
    pattern: { ...rule.pattern },
  };
}

/**
 * 默认参数提取器——`PermissionStore` 在未注入 `extractArgument` 时的兜底实现。
 *
 * 顺序：
 * 1. priority list：`path` / `file_path` / `target` / `destination` 中第一个 string 字段
 * 2. 第一个 string 字段（顺序由 `Object.values` 决定，对多 string 字段工具不可靠）
 *
 * **不再含 bash/shell 特例**：M3 后 bash 工具已通过 `permissionArgumentKey: "command"`
 * 显式声明，生产路径走 `ToolArgumentExtractor` 命中 explicit key 不会回退到此。
 * 即使 caller 单独使用 PermissionStore 不传 extractArgument，bash 仍能命中
 * 第一字段 fallback（command 是 bash schema 第一个 string 字段，行为兼容）。
 *
 * 这是脆弱的隐式约定——多 string 字段工具应通过 `ToolDefinition.permissionArgumentKey`
 * 显式声明，并由 `ToolArgumentExtractor.fromTools(tools)` 在入口注入。
 *
 * **可见性**：本函数仅 `tool-aware-extractor` 内部使用做 fallback，**不**从
 * `core/security/index.ts` 导出——避免外部 caller 误用绕过 tool-aware 路径。
 */
export function defaultExtractArgument(request: SecurityRequest): string {
  const args = request.arguments;

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
  /**
   * 系统预置规则池（in-memory，不持久化）—— 按 namespace 分组管理。
   *
   * 多源支持：每个 caller（cli 默认 / WebFetch / 子 agent / MCP 等）独立注入
   * 自己的 namespace。namespace 既是去重 key 也是替换粒度——同 namespace
   * 重复调用 `registerBuiltinRules` 替换该 namespace 的规则集；不同 namespace
   * 之间独立累加。
   *
   * 匹配时遍历所有 namespace 的规则集合并参与 builtin 池兜底，但严格让位
   * 于用户池（ADR-TPE-008）。
   */
  private readonly builtinRulesByNamespace = new Map<string, PermissionRule[]>();
  private readonly loadedWorkspaces = new Set<string>();
  private globalLoaded = false;

  private readonly rootDir: string | null;
  private readonly now: () => number;
  private readonly extractArgumentFn: (request: SecurityRequest) => string;

  constructor(options: PermissionStoreOptions = {}) {
    if (options.rootDir === null) {
      this.rootDir = null;
    } else if (options.rootDir !== undefined) {
      this.rootDir = options.rootDir;
    } else {
      this.rootDir = getPermissionsDir();
    }
    this.now = options.now ?? (() => Date.now());
    this.extractArgumentFn = options.extractArgument ?? defaultExtractArgument;
  }

  // ─── 公共 API ───

  match(
    workspaceId: string | null,
    request: SecurityRequest,
  ): PermissionRule | null {
    const tool = request.tool.toLowerCase();
    const argument = this.extractArgumentFn(request);

    // ─── 第一阶段：用户池（session / workspace / global）─────────────
    // 用户池任一命中 → 完全按用户池 resolveConflict 决定结果（builtin 不参与）。
    // 这保证用户的通配 deny（如 `pattern.argument: "*"`）不会被 builtin 高特异性
    // allow 击败，与"用户拥有最终决定权"的产品语义一致（ADR-TPE-008）。
    const userCandidates: PermissionRule[] = [];

    const sessionList = this.sessionRules.get(this.sessionKey(workspaceId));
    if (sessionList) {
      for (const rule of sessionList) {
        if (this.ruleMatches(rule, tool, argument)) userCandidates.push(rule);
      }
    }

    if (workspaceId) {
      this.ensureWorkspaceLoaded(workspaceId);
      const wsList = this.workspaceRules.get(workspaceId);
      if (wsList) {
        for (const rule of wsList) {
          if (this.ruleMatches(rule, tool, argument)) userCandidates.push(rule);
        }
      }
    }

    this.ensureGlobalLoaded();
    for (const rule of this.globalRules) {
      if (this.ruleMatches(rule, tool, argument)) userCandidates.push(rule);
    }

    if (userCandidates.length > 0) {
      const chosen = this.resolveConflict(userCandidates);
      chosen.matchCount += 1;
      chosen.lastMatchedAt = this.now();
      return chosen;
    }

    // ─── 第二阶段：builtin 池兜底 ────────────────────────────────────
    // 仅在用户池为空时进入；遍历所有 namespace 收集 candidates，之间仍走
    // resolveConflict（deny-wins + globSpecificity）保持冲突解决一致性。
    // 多 namespace 间不区分优先级——产品语义上各 namespace 是平级的"系统预置"。
    const builtinCandidates: PermissionRule[] = [];
    for (const namespaceRules of this.builtinRulesByNamespace.values()) {
      for (const rule of namespaceRules) {
        if (this.ruleMatches(rule, tool, argument)) builtinCandidates.push(rule);
      }
    }

    if (builtinCandidates.length > 0) {
      const chosen = this.resolveConflict(builtinCandidates);
      chosen.matchCount += 1;
      chosen.lastMatchedAt = this.now();
      return chosen;
    }

    return null;
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
      case "builtin": {
        throw new Error(
          "builtin 作用域的规则不能通过 create() 注入——应在启动时通过 registerBuiltinRules() 一次性注册",
        );
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
    // 注意：不清 builtinRulesByNamespace —— 它们是 boot-time 系统配置，
    // 由各模块（cli / WebFetch / 子 agent 等）在启动时通过 registerBuiltinRules
    // 注入；runtime 的 resetAll（用户清自己规则）不该牵连系统配置。
    // 测试套件需要"完全重置"时应创建新 PermissionStore 实例，而不是 resetAll。
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

  /**
   * 注册某个 namespace 的 builtin 默认规则（in-memory，不持久化）。
   *
   * **多源语义**：每个独立模块（cli 默认 / WebFetch / 子 agent / MCP / 第三方插件）
   * 应使用唯一的 namespace 字符串注入自己的规则。同 namespace 重复调用替换该
   * namespace 的规则集（不影响其他 namespace）；不同 namespace 之间独立累加。
   *
   * **严格契约**（fail-fast，不静默修正 caller bug；与 `BoundaryRegistry.register`
   * 拒空数组对偶 / 与 `ToolArgumentExtractor.register` 拒空 key 对偶）：
   * - `namespace` 必须是非空字符串，否则 throw
   * - `rules` **拒绝空数组**——清除某 namespace 应显式调 `unregisterBuiltinRules(ns)`，
   *   不混入"注册"语义
   * - `rules` 中每条规则的 `scope` 必须为 `"builtin"`，否则 throw
   *   （用 `PermissionStore.createRule({ ..., scope: "builtin" })` 构造）
   *
   * **生命周期**：builtin 规则不被 `resetAll` 清除——它们是 boot-time 系统配置，
   * 不属于用户 runtime 操作的"清理"语义范围。
   *
   * 见 [tool-permission-execution.md §4.6](../../../../research/design/specifications/tool-permission-execution.md)
   * 与 ADR-TPE-002。
   *
   * @example
   * ```ts
   * // 21B WebFetch 启用时
   * store.registerBuiltinRules("web_fetch", [
   *   PermissionStore.createRule({
   *     pattern: { tool: "web_fetch", argument: "https://docs.npmjs.com/*" },
   *     decision: "allow",
   *     scope: "builtin",
   *   }),
   * ]);
   *
   * // 显式卸载某 namespace（如 /mcp disconnect）
   * store.unregisterBuiltinRules("mcp:linear");
   * ```
   */
  registerBuiltinRules(namespace: string, rules: PermissionRule[]): void {
    if (typeof namespace !== "string" || namespace.length === 0) {
      throw new Error(
        "registerBuiltinRules: namespace 必须是非空字符串",
      );
    }
    if (rules.length === 0) {
      throw new Error(
        `registerBuiltinRules: rules 不能为空数组——清除 namespace 应显式调 unregisterBuiltinRules(namespace) (namespace="${namespace}")`,
      );
    }
    for (const rule of rules) {
      if (rule.scope !== "builtin") {
        throw new Error(
          `registerBuiltinRules: 规则 scope 必须为 "builtin"，收到 "${rule.scope}" ` +
            `(namespace="${namespace}", ruleId="${rule.id}"). ` +
            `使用 PermissionStore.createRule({ ..., scope: "builtin" }) 构造。`,
        );
      }
    }
    // 防御性深拷贝（pattern 是嵌套可变对象）：避免 caller 后续 mutate 影响 store 内部状态
    this.builtinRulesByNamespace.set(
      namespace,
      rules.map((r) => cloneRule(r)),
    );
  }

  /**
   * 注销某个 namespace 的所有 builtin 规则。
   *
   * **幂等**：未注册的 namespace 调用 noop（与 `BoundaryRegistry.unregister` 对偶
   * 匹配"卸载"操作的容错预期）。
   *
   * 用于场景：MCP `/mcp disconnect xyz` 清除该 MCP 服务器引入的预置规则；
   * 子 agent / 插件卸载时清除其 namespace。
   */
  unregisterBuiltinRules(namespace: string): void {
    this.builtinRulesByNamespace.delete(namespace);
  }

  /**
   * 列出所有 namespace（调试 / 可观测性）。
   * 不暴露具体规则——避免 caller 绕过 namespace API 直接操作内部状态。
   */
  listBuiltinNamespaces(): string[] {
    return [...this.builtinRulesByNamespace.keys()];
  }

  /**
   * 列出指定 namespace 的 builtin 规则（调试 / `/security` 命令展示）。
   * 返回深拷贝避免外部 mutate 内部状态。
   */
  getBuiltinRules(namespace: string): PermissionRule[] {
    const rules = this.builtinRulesByNamespace.get(namespace);
    return rules ? rules.map((r) => cloneRule(r)) : [];
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
   *
   * **scope 处理**：
   * - `session` / `workspace` / `global` 通过白名单
   * - `builtin` 显式**拒绝**——builtin 规则永远不该写磁盘（仅 in-memory，由
   *   `registerBuiltinRules` 注入）。磁盘上若出现（旧版本 bug 或人工编辑），
   *   立即跳过避免幽灵规则进 builtin 池
   * - 其他未知 scope（含未来扩展）一律跳过
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
        // builtin scope 走这条 continue（不在白名单），符合"拒绝磁盘 builtin"语义
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
