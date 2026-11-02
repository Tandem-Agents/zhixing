/**
 * 权限规则存储
 *
 * 管理三种作用域的权限规则：
 *   session — 本次会话有效（纯内存，不落盘）
 *   context — 当前上下文（主模式 OR 工作场景）内有效（{rootDir}/{contextId}.json）
 *   global  — 跨所有上下文有效（{rootDir}/global.json）
 *
 * 匹配流程：
 *   1. 收集所有可见规则（session + context + global）
 *   2. 过滤出匹配当前工具 + 参数 glob 的规则
 *   3. 冲突解决：deny > allow，精确 > 宽泛
 *
 * 落盘策略：
 *   - 只在 create / revoke / reset 时落盘
 *   - match 是热路径，只更新内存中的 matchCount / lastMatchedAt
 *   - 使用 tmp 文件 + rename 做原子写，避免损坏
 */

import * as crypto from "node:crypto";
import * as path from "node:path";

import { getZhixingHome } from "../paths.js";
import { DurablePermissionRuleStore } from "./durable-permission-rules.js";
import type {
  IPermissionStore,
  PermissionContextId,
  PermissionRule,
  PermissionRuleExecutionSource,
  SecurityRequest,
} from "./types.js";

// ─── PermissionContextId ↔ 紧凑 string（Map key + 磁盘文件名） ───

/**
 * 把 PermissionContextId discriminated union 转为紧凑 string —— 用作 contextRules /
 * sessionRules 的 Map key、`<rootDir>/<storageKey>.json` 文件名段。
 *
 * 格式：
 *   - `{kind:"main"}`                       → `"main"`
 *   - `{kind:"workspace",hash}`             → `"workspace-<hash>"`
 *   - `{kind:"scene",sceneId}`              → `"scene-<sceneId>"`
 *
 * 三个 namespace 互不重叠（"main" 4 字符无连字符；workspace hash 是 16 字符 hex；
 * sceneId 是 slugify 输出仅含字母数字 + 连字符），所以 prefix 反向 parse 不歧义。
 * 字符集全部跨平台文件名安全（无 `:` / `\` / `<` / `>`）。
 */
export function toStorageKey(id: PermissionContextId): string {
  switch (id.kind) {
    case "main":
      return "main";
    case "workspace":
      return `workspace-${id.hash}`;
    case "scene":
      return `scene-${id.sceneId}`;
  }
}

/**
 * 反序列化紧凑 string 回 PermissionContextId —— 读盘 sanitizeRules 用。
 *
 * 未识别 prefix（损坏数据 / 旧 schema 残留）返回 null，由 caller 决定降级策略
 * （sanitizeRules 风格：整条丢弃）。这避免幽灵 contextId 串入 Map。
 */
export function parseStorageKey(stored: string): PermissionContextId | null {
  if (stored === "main") return { kind: "main" };
  if (stored.startsWith("workspace-")) {
    const hash = stored.slice("workspace-".length);
    if (!hash) return null;
    return { kind: "workspace", hash };
  }
  if (stored.startsWith("scene-")) {
    const sceneId = stored.slice("scene-".length);
    if (!sceneId) return null;
    return { kind: "scene", sceneId };
  }
  return null;
}

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

const PERMISSIONS_SUBDIR = "permissions";

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
  /**
   * 进程内共享的持久规则所有者。宿主装配传入同一个，使各运行时与管理面看到同一份
   * 落盘规则；传入时忽略 rootDir。
   */
  durable?: DurablePermissionRuleStore;
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
   * 见 [工具与权限集成](../../../../docs/modules/tools/permission-integration.md)
   * 与 ADR-TPE-007（依赖注入而非穿透 tools）。
   */
  extractArgument?: (request: SecurityRequest) => string;
}

/**
 * 深拷贝 PermissionRule —— 嵌套可变字段（pattern / contributors）需独立拷贝防 mutate 串扰。
 * 用于 `registerBuiltinRules` 入栈时和 `getBuiltinRules` 出栈时的双向防御性拷贝。
 */
function cloneRule(rule: PermissionRule): PermissionRule {
  return {
    ...rule,
    pattern: { ...rule.pattern },
    contextId: rule.contextId ? { ...rule.contextId } : undefined,
    contributors: rule.contributors
      ? rule.contributors.map((c) => ({ ...c }))
      : undefined,
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

// ─── PermissionStore 实现 ───

export class PermissionStore implements IPermissionStore {
  private readonly sessionRules = new Map<string, PermissionRule[]>();
  /** 落盘作用域（context/global）的唯一所有者；同进程的实例共享同一个。 */
  private readonly durable: DurablePermissionRuleStore;
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

  private readonly now: () => number;
  private readonly extractArgumentFn: (request: SecurityRequest) => string;

  constructor(options: PermissionStoreOptions = {}) {
    this.durable = options.durable ?? new DurablePermissionRuleStore(
      options.rootDir === null
        ? null
        : options.rootDir !== undefined
          ? options.rootDir
          : getPermissionsDir(),
    );
    this.now = options.now ?? (() => Date.now());
    this.extractArgumentFn = options.extractArgument ?? defaultExtractArgument;
  }

  // ─── 公共 API ───

  match(
    contextId: PermissionContextId,
    request: SecurityRequest,
  ): PermissionRule | null {
    const storageKey = toStorageKey(contextId);
    const tool = request.tool.toLowerCase();
    const argument = this.extractArgumentFn(request);

    // ─── 第一阶段：用户池（session / context / global）─────────────
    // 用户池任一命中 → 完全按用户池 resolveConflict 决定结果（builtin 不参与）。
    // 这保证用户的通配 deny（如 `pattern.argument: "*"`）不会被 builtin 高特异性
    // allow 击败，与"用户拥有最终决定权"的产品语义一致。
    const userCandidates: PermissionRule[] = [];

    const sessionList = this.sessionRules.get(storageKey);
    if (sessionList) {
      for (const rule of sessionList) {
        if (this.ruleMatches(rule, tool, argument)) userCandidates.push(rule);
      }
    }

    for (const rule of this.durable.context(storageKey)) {
      if (ruleAppliesToContext(rule, contextId) && this.ruleMatches(rule, tool, argument)) {
        userCandidates.push(rule);
      }
    }

    for (const rule of this.durable.global()) {
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

  matchFrozen(
    rules: readonly PermissionRule[],
    request: SecurityRequest,
  ): PermissionRule | null {
    const tool = request.tool.toLowerCase();
    const argument = this.extractArgumentFn(request);
    const userCandidates = rules.filter((rule) =>
      rule.scope !== "builtin" && this.ruleMatches(rule, tool, argument),
    );
    const candidates = userCandidates.length > 0
      ? userCandidates
      : rules.filter((rule) =>
          rule.scope === "builtin" &&
      this.ruleMatches(rule, tool, argument),
        );
    if (candidates.length > 0) {
      const chosen = cloneRule(this.resolveConflict([...candidates]));
      chosen.matchCount += 1;
      chosen.lastMatchedAt = this.now();
      return chosen;
    }
    return null;
  }

  async create(contextId: PermissionContextId, rule: PermissionRule): Promise<void> {
    const storageKey = toStorageKey(contextId);
    switch (rule.scope) {
      case "session": {
        const list = this.sessionRules.get(storageKey) ?? [];
        list.push(rule);
        this.sessionRules.set(storageKey, list);
        return;
      }
      case "context":
        await this.durable.addContextRule(storageKey, rule);
        return;
      case "global":
        await this.durable.addGlobalRule(rule);
        return;
      case "builtin": {
        throw new Error(
          "builtin 作用域的规则不能通过 create() 注入——应在启动时通过 registerBuiltinRules() 一次性注册",
        );
      }
    }
  }

  list(contextId: PermissionContextId): PermissionRule[] {
    const storageKey = toStorageKey(contextId);
    const result: PermissionRule[] = [];
    const sessionList = this.sessionRules.get(storageKey);
    if (sessionList) result.push(...sessionList);
    for (const rule of this.durable.context(storageKey)) {
      if (ruleAppliesToContext(rule, contextId)) result.push(rule);
    }
    result.push(...this.durable.global());
    return result;
  }

  snapshot(contextId: PermissionContextId): PermissionRule[] {
    const result = this.list(contextId).map(cloneRule);
    for (const namespaceRules of this.builtinRulesByNamespace.values()) {
      result.push(...namespaceRules.map(cloneRule));
    }
    return result;
  }

  async revoke(ruleId: string): Promise<boolean> {
    for (const [key, rules] of this.sessionRules) {
      const idx = rules.findIndex((r) => r.id === ruleId);
      if (idx !== -1) {
        rules.splice(idx, 1);
        if (rules.length === 0) this.sessionRules.delete(key);
        return true;
      }
    }
    return this.durable.revoke(ruleId);
  }

  async reset(contextId: PermissionContextId): Promise<void> {
    const storageKey = toStorageKey(contextId);
    this.sessionRules.delete(storageKey);
    await this.durable.resetContext(storageKey);
  }

  async resetAll(): Promise<void> {
    // 注意：不清 builtinRulesByNamespace —— 它们是 boot-time 系统配置，
    // 由各模块（cli / WebFetch / 子 agent 等）在启动时通过 registerBuiltinRules
    // 注入；runtime 的 resetAll（用户清自己规则）不该牵连系统配置。
    // 测试套件需要"完全重置"时应创建新 PermissionStore 实例，而不是 resetAll。
    this.sessionRules.clear();
    await this.durable.resetAll();
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
   * - `rules` **拒绝空数组**（fail-fast，空规则集无意义）；namespace 生命周期随 store
   *   实例——MCP / 插件等变更走 reload 整体重建，不单独卸载
   * - `rules` 中每条规则的 `scope` 必须为 `"builtin"`，否则 throw
   *   （用 `PermissionStore.createRule({ ..., scope: "builtin" })` 构造）
   *
   * **生命周期**：builtin 规则不被 `resetAll` 清除——它们是 boot-time 系统配置，
   * 不属于用户 runtime 操作的"清理"语义范围。
   *
   * 见 [工具与权限集成](../../../../docs/modules/tools/permission-integration.md)
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
        `registerBuiltinRules: rules 不能为空数组（空规则集无意义）(namespace="${namespace}")`,
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
   * 构造一条权限规则，自动填充 id / createdAt / 统计字段。
   *
   * 字段语义：
   * - `contextId`：仅 `scope === "context"` 时填，是 PermissionContextId
   *   discriminated union（`{kind:"main"}` / `{kind:"workspace",hash}` /
   *   `{kind:"scene",sceneId}`），决定规则挂载到哪个上下文
   * - `contextPath`：仅 `scope === "context"` 且为工作场景（kind=workspace）时填该
   *   场景的 workdir，UI 友好显示用、不参与匹配
   * - `contributors`：信任来源累积时间线；自动沉淀路径拷贝 tracker 累积数组，
   *   用户显式选 allow-context/allow-global 时为单条 `[{origin:"user", timestamp:now}]`
   */
  static createRule(
    input: Pick<PermissionRule, "pattern" | "decision" | "scope"> &
      Partial<
        Pick<PermissionRule, "contextId" | "contextPath" | "contributors">
      >,
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
      contextId: input.contextId,
      contextPath: input.contextPath,
      contributors: input.contributors,
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
}

/**
 * 工作区规则只在创建它的绑定修订下生效：运行上下文带修订时，修订不同（目录已改）的
 * 工作区规则不适用；不带修订（管理视图）时全部列出。其他范围与全局规则不受影响。
 */
function ruleAppliesToContext(rule: PermissionRule, contextId: PermissionContextId): boolean {
  if (contextId.kind !== "workspace" || contextId.revision === undefined) return true;
  if (rule.scope !== "context" || rule.contextId?.kind !== "workspace") return true;
  return rule.contextId.revision === contextId.revision;
}

/** Bind one already-decided Trust context without exposing mutable storage. */
export function bindPermissionRuleExecutionSource(
  store: Pick<IPermissionStore, "match" | "matchFrozen">,
  contextId: PermissionContextId,
): PermissionRuleExecutionSource {
  const context = cloneContextId(contextId);
  return Object.freeze({
    match: (request: SecurityRequest) => store.match(context, request),
    // 冻结快照按工作区绑定取全部修订，这里按本次运行已认证的修订过滤
    matchFrozen: (
      rules: readonly PermissionRule[],
      request: SecurityRequest,
    ) => store.matchFrozen(rules.filter((rule) => ruleAppliesToContext(rule, context)), request),
  });
}

function cloneContextId(context: PermissionContextId): PermissionContextId {
  switch (context.kind) {
    case "main":
      return Object.freeze({ kind: "main" });
    case "workspace":
      return Object.freeze({
        kind: "workspace",
        hash: context.hash,
        ...(context.revision === undefined ? {} : { revision: context.revision }),
      });
    case "scene":
      return Object.freeze({ kind: "scene", sceneId: context.sceneId });
  }
}
