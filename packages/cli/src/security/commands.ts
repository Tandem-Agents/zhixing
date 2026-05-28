/**
 * /security 斜杠命令处理器 —— 安全系统状态概览 + 内置策略规则列表（只读）。
 *
 * /trust 的列表交互在 repl.ts 注册为 typeahead args 命令（trustRuleArgProvider），
 * 与 /work /resume 同范式 —— 用户从命令面板 accept /trust 后 typeahead 自动进入
 * args 输入态、立即弹规则候选 dropdown，无需独立 handler。
 */

import chalk from "chalk";
import type {
  PermissionContextId,
  SecurityPipeline,
  SecurityRule,
} from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";

// ─── /security ───

interface SecurityOptions {
  pipeline: SecurityPipeline;
  writer: CliWriter;
}

export function handleSecurityCommand(
  args: string,
  opts: SecurityOptions,
): void {
  const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

  if (subcommand === "rules") {
    return showPolicyRules(opts);
  }
  if (subcommand === "help") {
    return printSecurityHelp(opts.writer);
  }
  return showSecurityOverview(opts);
}

function printSecurityHelp(writer: CliWriter): void {
  writer.line("");
  writer.line(chalk.bold("  /security — 安全系统状态"));
  writer.line("");
  writer.line("  /security             状态概览（默认）");
  writer.line("  /security rules       列出当前生效的策略规则");
  writer.line("");
}

function showSecurityOverview(opts: SecurityOptions): void {
  const { pipeline, writer } = opts;
  const store = pipeline.getPermissionStore();
  const contextId = pipeline.getContextId();
  const workspacePath = pipeline.getWorkspace();
  const guard = pipeline.getExecutionGuard();
  const tracker = pipeline.getConfirmationTracker();
  const policy = pipeline.getPolicyEngine();

  const rules = store.list(contextId);
  const sessionCount = rules.filter((r) => r.scope === "session").length;
  const ctxCount = rules.filter((r) => r.scope === "context").length;
  const globalCount = rules.filter((r) => r.scope === "global").length;
  const denyCount = rules.filter((r) => r.decision === "deny").length;

  const builtinRules = policy.getActiveRules();
  const bypassCount = builtinRules.filter((r) => r.bypassImmune).length;
  const confirmCount = builtinRules.filter((r) => r.action === "confirm").length;

  const rateSnapshot = guard.getRateLimiter().snapshot();
  const trackerSnapshot = tracker.snapshot();

  const ctxLabel = formatContextKindLabel(contextId);
  const ctxIdDisplay = formatContextIdInline(contextId);

  writer.line("");
  writer.line(chalk.bold("╭─ 安全状态 ─────────────────────────────"));
  writer.line(chalk.bold("│"));
  writer.line(
    `${chalk.bold("│")} ${chalk.dim("上下文:")}    ${chalk.cyan(ctxLabel)}` +
      (workspacePath ? `  ${chalk.dim(workspacePath)}` : ""),
  );
  writer.line(`${chalk.bold("│")} ${chalk.dim("contextId:")} ${chalk.dim(ctxIdDisplay)}`);
  writer.line(chalk.bold("│"));
  writer.line(`${chalk.bold("│")} ${chalk.bold("── 策略规则 ──")}`);
  writer.line(
    `${chalk.bold("│")} 内置: ${builtinRules.length} 条 (${chalk.red(`${bypassCount} bypassImmune`)} + ${chalk.yellow(`${confirmCount} confirm`)})`,
  );
  writer.line(chalk.bold("│"));
  writer.line(`${chalk.bold("│")} ${chalk.bold("── 权限规则 ──")}`);
  writer.line(
    `${chalk.bold("│")} 会话: ${sessionCount} · 上下文: ${ctxCount} · 全局: ${globalCount}` +
      (denyCount > 0 ? chalk.red(`  (含 ${denyCount} 条 deny)`) : ""),
  );
  if (rules.length > 0) {
    writer.line(chalk.dim(`${chalk.bold("│")} Tip: /trust 查看详情`));
  }
  writer.line(chalk.bold("│"));
  writer.line(`${chalk.bold("│")} ${chalk.bold("── 频率限制（最近窗口）──")}`);
  if (rateSnapshot.length === 0) {
    writer.line(`${chalk.bold("│")} ${chalk.dim("(无活动)")}`);
  } else {
    for (const entry of rateSnapshot.slice(0, 8)) {
      const pct = entry.used / entry.limit;
      const bar =
        pct > 0.8 ? chalk.red : pct > 0.5 ? chalk.yellow : chalk.green;
      writer.line(
        `${chalk.bold("│")}   ${chalk.cyan(entry.key.padEnd(10))} ${bar(`${entry.used}/${entry.limit}`)}`,
      );
    }
  }
  writer.line(chalk.bold("│"));
  writer.line(`${chalk.bold("│")} ${chalk.bold("── 确认追踪 ──")}`);
  if (trackerSnapshot.length === 0) {
    writer.line(`${chalk.bold("│")} ${chalk.dim("(无累计)")}`);
  } else {
    for (const entry of trackerSnapshot.slice(0, 8)) {
      const keyShort = entry.key.replace(/^bash::/, "").slice(0, 30);
      writer.line(
        `${chalk.bold("│")}   ${chalk.cyan(keyShort.padEnd(30))} ${entry.count} 次 ${chalk.dim(`(${entry.highestRisk})`)}`,
      );
    }
  }
  writer.line(chalk.bold("╰────────────────────────────────────────"));
  writer.line("");
}

function showPolicyRules(opts: SecurityOptions): void {
  const { pipeline, writer } = opts;
  const rules: SecurityRule[] = pipeline.getPolicyEngine().getActiveRules();
  writer.line("");
  writer.line(chalk.bold(`  策略规则 (${rules.length} 条)`));
  writer.line(chalk.dim("  ─────────────────────────────────────────────────────"));
  for (const rule of rules) {
    const action =
      rule.action === "block"
        ? chalk.red("block  ")
        : rule.action === "confirm"
          ? chalk.yellow("confirm")
          : chalk.green("audit  ");
    const immune = rule.bypassImmune ? chalk.red("[!]") : "   ";
    const sev = rule.severity.padEnd(8);
    writer.line(
      `  ${immune} ${action} ${chalk.dim(sev)} ${chalk.cyan(rule.id.padEnd(28))} ${chalk.dim(rule.name)}`,
    );
  }
  writer.line(chalk.dim("  ─────────────────────────────────────────────────────"));
  writer.line(chalk.dim("  [!] = bypassImmune（任何配置都无法覆盖）"));
  writer.line("");
}

// ─── 内部 helpers（/security 概览用） ───

/**
 * PermissionContextId.kind → 中文标签。
 * workspace / scene 统一显示「当前工作场景」，对用户呈现统一术语；底层 kind 由
 * type system 严守隔离。
 */
function formatContextKindLabel(
  contextId: PermissionContextId | undefined,
): string {
  if (!contextId) return "(unknown context)";
  switch (contextId.kind) {
    case "main":
      return "主模式";
    case "workspace":
    case "scene":
      return "当前工作场景";
  }
}

/**
 * PermissionContextId → 紧凑 inspect 字符串（/security 概览展示用）。
 * 与 toStorageKey 格式约定一致，但属 CLI 展示层独立函数。
 */
function formatContextIdInline(contextId: PermissionContextId): string {
  switch (contextId.kind) {
    case "main":
      return "main";
    case "workspace":
      return `workspace-${contextId.hash}`;
    case "scene":
      return `scene-${contextId.sceneId}`;
  }
}
