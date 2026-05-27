/**
 * 策略引擎 — 安全系统的大脑
 *
 * 职责：评估操作是否匹配已知威胁模式，产出安全决策。
 * 不执行安全检查，只做评估。
 *
 * 规则优先级分两阶段：
 * 1. 来源优先级：bypassImmune > user > project > community > builtin
 * 2. 动作严格度：block > confirm > audit > allow
 */

import { BUILTIN_RULES } from "./builtin-rules.js";
import type {
  IPolicyEngine,
  MatchSpec,
  RiskLevel,
  SecurityAction,
  SecurityDecision,
  SecurityRequest,
  SecurityRule,
} from "./types.js";

import * as path from "node:path";

import { expandUserHome } from "../paths.js";

// ─── 动作严格度排序 ───

const ACTION_SEVERITY: Record<string, number> = {
  allow: 0,
  audit: 1,
  confirm: 2,
  block: 3,
};

// ─── 来源优先级排序 ───

const SOURCE_PRIORITY: Record<string, number> = {
  builtin: 0,
  community: 1,
  project: 2,
  user: 3,
};

export class PolicyEngine implements IPolicyEngine {
  private rules: SecurityRule[] = [];

  constructor() {
    this.loadRules(BUILTIN_RULES);
  }

  evaluate(request: SecurityRequest): SecurityDecision {
    const matched = this.findMatchingRules(request);

    if (matched.length === 0) {
      return {
        action: "allow",
        matchedRules: [],
        reason: "无匹配规则，默认放行",
        riskLevel: "low",
      };
    }

    const resolvedRules = this.resolveConflicts(matched);
    const topRule = resolvedRules[0]!;

    const action = this.ruleActionToSecurityAction(topRule.action);
    const riskLevel = this.aggregateRisk(resolvedRules);

    return {
      action,
      matchedRules: resolvedRules,
      reason: topRule.message,
      riskLevel,
      suggestion: topRule.suggestion,
    };
  }

  loadRules(rules: SecurityRule[]): void {
    for (const rule of rules) {
      const existingIndex = this.rules.findIndex((r) => r.id === rule.id);
      if (existingIndex !== -1) {
        this.rules[existingIndex] = rule;
      } else {
        this.rules.push(rule);
      }
    }
  }

  updateRule(rule: SecurityRule): void {
    this.loadRules([rule]);
  }

  getActiveRules(): SecurityRule[] {
    return this.rules.filter((r) => r.enabled);
  }

  // ─── 匹配逻辑 ───

  private findMatchingRules(request: SecurityRequest): SecurityRule[] {
    return this.getActiveRules().filter((rule) =>
      this.matchesSpec(rule.match, request),
    );
  }

  /**
   * 匹配单个 MatchSpec 与 SecurityRequest。
   * 递归处理 composite 类型。
   */
  matchesSpec(spec: MatchSpec, request: SecurityRequest): boolean {
    switch (spec.type) {
      case "command":
        return this.matchCommand(spec, request);
      case "command_prefix":
        return this.matchCommandPrefix(spec, request);
      case "path":
        return this.matchPath(spec, request);
      case "network":
        return this.matchNetwork(spec, request);
      case "env_var":
        return this.matchEnvVar(spec, request);
      case "tool":
        return this.matchTool(spec, request);
      case "interpreter":
        return this.matchInterpreter(spec, request);
      case "composite":
        return this.matchComposite(spec, request);
      default:
        return false;
    }
  }

  private matchCommand(
    spec: Extract<MatchSpec, { type: "command" }>,
    request: SecurityRequest,
  ): boolean {
    const command = this.extractCommand(request);
    if (!command) return false;

    const regex = new RegExp(spec.pattern, spec.flags);
    return regex.test(command);
  }

  private matchCommandPrefix(
    spec: Extract<MatchSpec, { type: "command_prefix" }>,
    request: SecurityRequest,
  ): boolean {
    const command = this.extractCommand(request);
    if (!command) return false;

    const tokens = command.trim().split(/\s+/);
    const executable = tokens[0]?.toLowerCase() ?? "";

    return spec.prefixes.some((prefix) => executable === prefix.toLowerCase());
  }

  private matchPath(
    spec: Extract<MatchSpec, { type: "path" }>,
    request: SecurityRequest,
  ): boolean {
    const paths = this.extractPaths(request);
    if (paths.length === 0) return false;

    const isWrite =
      request.tool === "write" ||
      request.tool === "edit" ||
      (request.arguments["command"] as string | undefined)?.includes(">");
    const accessType = isWrite ? "write" : "read";

    if (spec.access !== "any" && spec.access !== accessType) {
      return false;
    }

    return paths.some((p) => {
      const expandedInput = expandUserHome(p);
      const resolvedInput = path.resolve(request.context.cwd, expandedInput);
      // 统一为正斜杠，避免 Windows 反斜杠导致的匹配失败
      const normalizedInput = resolvedInput.replace(/\\/g, "/");

      return spec.paths.some((specPath) => {
        const expandedSpec = expandUserHome(specPath);

        // 规则路径是绝对路径（如 /etc/）：直接做绝对路径前缀匹配
        if (path.isAbsolute(expandedSpec)) {
          const normalizedSpec = expandedSpec.replace(/\\/g, "/");
          return normalizedInput.startsWith(normalizedSpec);
        }

        // 规则路径是相对路径段（如 .git/）：检查它是否作为路径段出现在输入路径中
        // 例如 "/home/user/project/.git/HEAD" 包含路径段 ".git/"
        const specSegment = expandedSpec.replace(/\\/g, "/");
        const segmentPattern = `/${specSegment}`;
        return (
          normalizedInput.includes(segmentPattern) ||
          normalizedInput.startsWith(specSegment)
        );
      });
    });
  }

  private matchNetwork(
    spec: Extract<MatchSpec, { type: "network" }>,
    request: SecurityRequest,
  ): boolean {
    const hosts = request.resolvedAccess?.hosts ?? [];
    if (hosts.length === 0) return false;

    if (spec.hosts && spec.hosts.length > 0) {
      return hosts.some((h) =>
        spec.hosts!.some(
          (specHost) => h.toLowerCase() === specHost.toLowerCase(),
        ),
      );
    }

    return true;
  }

  private matchEnvVar(
    spec: Extract<MatchSpec, { type: "env_var" }>,
    request: SecurityRequest,
  ): boolean {
    const envVars = request.resolvedAccess?.envVars ?? [];
    if (envVars.length === 0) {
      // 也检查命令中的环境变量设置模式
      const command = this.extractCommand(request);
      if (!command) return false;

      return spec.names.some((name) => {
        const pattern = new RegExp(
          `(^|\\s|export\\s+)${this.escapeRegex(name)}\\s*=`,
        );
        return pattern.test(command);
      });
    }

    return envVars.some((v) =>
      spec.names.some(
        (name) => v.toUpperCase() === name.toUpperCase(),
      ),
    );
  }

  private matchTool(
    spec: Extract<MatchSpec, { type: "tool" }>,
    request: SecurityRequest,
  ): boolean {
    return spec.tools.some(
      (t) => t.toLowerCase() === request.tool.toLowerCase(),
    );
  }

  private matchInterpreter(
    spec: Extract<MatchSpec, { type: "interpreter" }>,
    request: SecurityRequest,
  ): boolean {
    const command = this.extractCommand(request);
    if (!command) return false;

    const tokens = command.trim().split(/\s+/);
    const executable = tokens[0]?.toLowerCase() ?? "";

    // 匹配解释器名称（包括带版本号的，如 python3, node18）
    return spec.languages.some((lang) => {
      const langLower = lang.toLowerCase();
      return (
        executable === langLower ||
        executable.startsWith(langLower) ||
        executable.endsWith(`/${langLower}`)
      );
    });
  }

  private matchComposite(
    spec: Extract<MatchSpec, { type: "composite" }>,
    request: SecurityRequest,
  ): boolean {
    switch (spec.op) {
      case "and":
        return spec.specs.every((s) => this.matchesSpec(s, request));
      case "or":
        return spec.specs.some((s) => this.matchesSpec(s, request));
      case "not":
        return !spec.specs.some((s) => this.matchesSpec(s, request));
      default:
        return false;
    }
  }

  // ─── 冲突解决 ───

  /**
   * 规则冲突解决逻辑：
   * 1. bypassImmune 规则始终最高优先级
   * 2. 同 ID 规则按来源优先级覆盖
   * 3. 最终取最严格的动作
   */
  private resolveConflicts(rules: SecurityRule[]): SecurityRule[] {
    // 按来源优先级去重（高优先级覆盖低优先级的同 ID 规则）
    const deduped = new Map<string, SecurityRule>();
    const sorted = [...rules].sort(
      (a, b) =>
        (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0),
    );

    for (const rule of sorted) {
      deduped.set(rule.id, rule);
    }

    const resolved = [...deduped.values()];

    // 按动作严格度排序（最严格的在前）
    resolved.sort(
      (a, b) =>
        (ACTION_SEVERITY[b.action] ?? 0) - (ACTION_SEVERITY[a.action] ?? 0),
    );

    return resolved;
  }

  // ─── 辅助方法 ───

  private ruleActionToSecurityAction(action: string): SecurityAction {
    switch (action) {
      case "block":
        return "block";
      case "confirm":
        return "confirm";
      case "audit":
        return "allow";
      default:
        return "confirm";
    }
  }

  private aggregateRisk(rules: SecurityRule[]): RiskLevel {
    const order: RiskLevel[] = ["low", "medium", "high", "critical"];
    let maxIndex = 0;
    for (const rule of rules) {
      const idx = order.indexOf(rule.severity);
      if (idx > maxIndex) maxIndex = idx;
    }
    return order[maxIndex]!;
  }

  /** 从请求中提取命令字符串 */
  private extractCommand(request: SecurityRequest): string | null {
    if (request.tool === "bash" || request.tool === "shell") {
      return (request.arguments["command"] as string) ?? null;
    }

    const commands = request.resolvedAccess?.commands;
    if (commands && commands.length > 0) {
      return commands[0] ?? null;
    }

    return null;
  }

  /** 从请求中提取文件路径 */
  private extractPaths(request: SecurityRequest): string[] {
    if (request.resolvedAccess?.paths) {
      return request.resolvedAccess.paths;
    }

    const paths: string[] = [];

    const filePath = request.arguments["path"] as string | undefined;
    if (filePath) paths.push(filePath);

    const target = request.arguments["target"] as string | undefined;
    if (target) paths.push(target);

    const file = request.arguments["file_path"] as string | undefined;
    if (file) paths.push(file);

    return paths;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
