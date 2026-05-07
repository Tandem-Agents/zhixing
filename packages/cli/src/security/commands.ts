/**
 * /trust 和 /security 斜杠命令处理器 — Phase 2 Step 8 收尾
 *
 * - /trust list [scope]    列出权限规则（可按 scope 过滤）
 * - /trust revoke <id>     按 id 前缀撤销规则
 * - /trust reset           清除当前工作区的会话+工作区规则（需要确认）
 * - /trust reset all       清除所有规则（含 global，需要二次确认）
 * - /security              安全状态概览
 * - /security rules        列出当前生效的策略规则
 *
 * 这些命令是 Phase 2 用户体验的最后一公里：让用户看见和管理自己创建的规则，
 * 不需要去手动编辑 ~/.zhixing/permissions/<hash>.json
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import { getAgentIdentity } from "@zhixing/core";
import type {
  PermissionRule,
  PermissionScope,
  SecurityPipeline,
  SecurityRule,
} from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";

// ─── 显示辅助 ───

const SCOPE_BADGE: Record<PermissionScope, string> = {
  session: chalk.gray("session  "),
  workspace: chalk.cyan("workspace"),
  global: chalk.magenta("global   "),
  builtin: chalk.yellow("builtin  "),
};

const SCOPE_FILTER_NAMES: Record<string, PermissionScope> = {
  session: "session",
  workspace: "workspace",
  global: "global",
};

function formatRule(rule: PermissionRule): string {
  const idShort = rule.id.slice(0, 8);
  const decision =
    rule.decision === "allow" ? chalk.green("allow") : chalk.red("deny ");
  const scope = SCOPE_BADGE[rule.scope];
  const tool = chalk.cyan(rule.pattern.tool.padEnd(8));
  const arg = rule.pattern.argument.padEnd(28).slice(0, 28);
  const matched = rule.matchCount > 0 ? `匹配 ${rule.matchCount} 次` : "未匹配";
  const ts =
    rule.lastMatchedAt > 0
      ? chalk.dim(formatRelativeMs(rule.lastMatchedAt))
      : chalk.dim("—");
  return `  ${chalk.dim(idShort)}  ${scope}  ${decision}  ${tool} ${arg} ${chalk.dim(matched)} ${ts}`;
}

function formatRelativeMs(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  return `${days}d 前`;
}

// ─── /trust ───

interface TrustOptions {
  pipeline: SecurityPipeline;
  rl: readline.Interface;
  writer: CliWriter;
}

export async function handleTrustCommand(
  args: string,
  opts: TrustOptions,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = (tokens[0] ?? "list").toLowerCase();

  switch (subcommand) {
    case "list":
      return listRules(tokens.slice(1), opts);
    case "revoke":
      return revokeRule(tokens.slice(1), opts);
    case "reset":
      return resetRules(tokens.slice(1), opts);
    case "help":
    default:
      printTrustHelp(opts.writer);
      return;
  }
}

function printTrustHelp(writer: CliWriter): void {
  writer.line("");
  writer.line(chalk.bold("  /trust — 权限规则管理"));
  writer.line("");
  writer.line("  /trust list [scope]      列出规则（scope: session/workspace/global）");
  writer.line("  /trust revoke <id>       按 id 前缀撤销规则");
  writer.line("  /trust reset             清除当前工作区的所有规则");
  writer.line("  /trust reset all         清除所有规则（含 global，需二次确认）");
  writer.line("");
}

function listRules(args: string[], opts: TrustOptions): void {
  const { pipeline, writer } = opts;
  const store = pipeline.getPermissionStore();
  const workspaceId = pipeline.getWorkspaceId();
  const workspacePath = pipeline.getWorkspace();

  const filter = args[0]?.toLowerCase();
  const scopeFilter = filter ? SCOPE_FILTER_NAMES[filter] : null;

  const all = store.list(workspaceId);
  const filtered = scopeFilter ? all.filter((r) => r.scope === scopeFilter) : all;

  if (filtered.length === 0) {
    writer.line("");
    writer.line(
      chalk.dim(
        scopeFilter
          ? `  没有 ${scopeFilter} 作用域的规则`
          : "  当前工作区没有权限规则",
      ),
    );
    const { displayName } = getAgentIdentity();
    writer.line(
      chalk.dim(
        `  Tip: ${displayName} 首次执行 confirm 操作时选 [a]/[g]/[s] 创建规则\n`,
      ),
    );
    return;
  }

  writer.line("");
  writer.line(
    chalk.bold(
      `  权限规则 (${filtered.length} 条${scopeFilter ? `, ${scopeFilter}` : ""})`,
    ),
  );
  if (workspacePath) {
    writer.line(chalk.dim(`  当前工作区: ${workspacePath}`));
  }
  writer.line(
    chalk.dim("  id        scope     dec    tool      pattern                       匹配状态"),
  );
  writer.line(chalk.dim("  ─────────────────────────────────────────────────────────────────────"));

  // 按 scope 分组：global → workspace → session
  const order: PermissionScope[] = ["global", "workspace", "session"];
  for (const scope of order) {
    const inScope = filtered.filter((r) => r.scope === scope);
    for (const rule of inScope) {
      writer.line(formatRule(rule));
    }
  }
  writer.line("");
}

async function revokeRule(args: string[], opts: TrustOptions): Promise<void> {
  const { writer } = opts;
  const prefix = args[0];
  if (!prefix) {
    writer.line(chalk.yellow("\n  用法: /trust revoke <id 前缀>\n"));
    return;
  }

  const store = opts.pipeline.getPermissionStore();
  const workspaceId = opts.pipeline.getWorkspaceId();
  const all = store.list(workspaceId);

  const matches = all.filter((r) => r.id.startsWith(prefix));
  if (matches.length === 0) {
    writer.line(chalk.red(`\n  没有匹配前缀 "${prefix}" 的规则\n`));
    return;
  }
  if (matches.length > 1) {
    writer.line(
      chalk.yellow(
        `\n  ${matches.length} 条规则匹配前缀 "${prefix}"，请提供更长的 id：`,
      ),
    );
    for (const m of matches) {
      writer.line(formatRule(m));
    }
    writer.line("");
    return;
  }

  const target = matches[0]!;
  const ok = store.revoke(target.id);
  if (ok) {
    writer.line(
      chalk.green(
        `\n  ✓ 已撤销规则: ${target.pattern.tool} ${target.pattern.argument} (${target.scope})\n`,
      ),
    );
  } else {
    writer.line(chalk.red(`\n  ✗ 撤销失败\n`));
  }
}

async function resetRules(args: string[], opts: TrustOptions): Promise<void> {
  const { pipeline, rl, writer } = opts;
  const store = pipeline.getPermissionStore();
  const workspaceId = pipeline.getWorkspaceId();

  const isAll = args[0]?.toLowerCase() === "all";

  if (isAll) {
    const allRules = store.list(workspaceId);
    const globalCount = allRules.filter((r) => r.scope === "global").length;
    writer.line(
      chalk.red(
        `\n  ⚠ 即将清除所有权限规则，包括 ${globalCount} 条 global 规则（影响所有工作区）`,
      ),
    );
    const answer = await rl.question(chalk.red("  确认清除所有规则？输入 'yes' 确认: "));
    if (answer.trim() !== "yes") {
      writer.line(chalk.dim("  已取消\n"));
      return;
    }
    store.resetAll();
    writer.line(chalk.green("  ✓ 所有规则已清除\n"));
    return;
  }

  // 默认：清除当前工作区
  const wsRules = store
    .list(workspaceId)
    .filter((r) => r.scope === "workspace" || r.scope === "session");
  if (wsRules.length === 0) {
    writer.line(chalk.dim("\n  当前工作区没有可清除的规则\n"));
    return;
  }
  writer.line(
    chalk.yellow(
      `\n  即将清除当前工作区的 ${wsRules.length} 条规则（不影响 global）`,
    ),
  );
  const answer = await rl.question(chalk.yellow("  确认？(y/N): "));
  if (answer.trim().toLowerCase() !== "y") {
    writer.line(chalk.dim("  已取消\n"));
    return;
  }
  store.reset(workspaceId);
  writer.line(chalk.green(`  ✓ 已清除 ${wsRules.length} 条规则\n`));
}

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
  const workspaceId = pipeline.getWorkspaceId();
  const workspacePath = pipeline.getWorkspace();
  const guard = pipeline.getExecutionGuard();
  const tracker = pipeline.getConfirmationTracker();
  const policy = pipeline.getPolicyEngine();

  const rules = store.list(workspaceId);
  const sessionCount = rules.filter((r) => r.scope === "session").length;
  const wsCount = rules.filter((r) => r.scope === "workspace").length;
  const globalCount = rules.filter((r) => r.scope === "global").length;
  const denyCount = rules.filter((r) => r.decision === "deny").length;

  const builtinRules = policy.getActiveRules();
  const bypassCount = builtinRules.filter((r) => r.bypassImmune).length;
  const confirmCount = builtinRules.filter((r) => r.action === "confirm").length;

  const rateSnapshot = guard.getRateLimiter().snapshot();
  const trackerSnapshot = tracker.snapshot();

  writer.line("");
  writer.line(chalk.bold("╭─ 安全状态 ─────────────────────────────"));
  writer.line(chalk.bold("│"));
  if (workspacePath) {
    writer.line(
      `${chalk.bold("│")} ${chalk.dim("工作区:")}    ${chalk.cyan(workspacePath)}`,
    );
    writer.line(
      `${chalk.bold("│")} ${chalk.dim("ID:")}        ${chalk.dim(workspaceId ?? "—")}`,
    );
  } else {
    writer.line(
      `${chalk.bold("│")} ${chalk.dim("工作区:")}    ${chalk.dim("(无工作区上下文)")}`,
    );
  }
  writer.line(chalk.bold("│"));
  writer.line(`${chalk.bold("│")} ${chalk.bold("── 策略规则 ──")}`);
  writer.line(
    `${chalk.bold("│")} 内置: ${builtinRules.length} 条 (${chalk.red(`${bypassCount} bypassImmune`)} + ${chalk.yellow(`${confirmCount} confirm`)})`,
  );
  writer.line(chalk.bold("│"));
  writer.line(`${chalk.bold("│")} ${chalk.bold("── 权限规则 ──")}`);
  writer.line(
    `${chalk.bold("│")} 会话: ${sessionCount} · 工作区: ${wsCount} · 全局: ${globalCount}` +
      (denyCount > 0 ? chalk.red(`  (含 ${denyCount} 条 deny)`) : ""),
  );
  if (rules.length > 0) {
    writer.line(chalk.dim(`${chalk.bold("│")} Tip: /trust list 查看详情`));
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
