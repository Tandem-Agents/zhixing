/**
 * /security · /trust 斜杠命令处理器。
 *
 * /trust 执行体在核心宿主(trust.list / revoke RPC);/security 的状态事实
 * (策略引擎 / 频率限制 / 确认追踪)活在宿主 runtime 内,CLI 只消费
 * session.security 快照并渲染,不再直连本地 SecurityPipeline。
 */

import chalk from "chalk";
import type { PermissionContextId, PermissionRule, SecurityRule } from "@zhixing/core";
import type { SessionSecurityResult } from "@zhixing/server";
import type { CliWriter } from "../screen/index.js";
import { formatRuleDescription } from "./trust-rule-format.js";

// ─── /security ───

interface SecurityOptions {
  status: () => Promise<SessionSecurityResult>;
  writer: CliWriter;
}

export async function handleSecurityCommand(
  args: string,
  opts: SecurityOptions,
): Promise<void> {
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
  writer.line("  /trust                权限规则管理");
  writer.line("");
}

async function loadSecuritySnapshot(
  opts: SecurityOptions,
): Promise<SessionSecurityResult | null> {
  try {
    return await opts.status();
  } catch (err) {
    opts.writer.line(
      chalk.red(
        `\n  安全状态不可用: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return null;
  }
}

async function showSecurityOverview(opts: SecurityOptions): Promise<void> {
  const { writer } = opts;
  const snapshot = await loadSecuritySnapshot(opts);
  if (!snapshot) return;

  const rules = snapshot.permissionRules;
  const sessionCount = rules.filter((r) => r.scope === "session").length;
  const ctxCount = rules.filter((r) => r.scope === "context").length;
  const globalCount = rules.filter((r) => r.scope === "global").length;
  const denyCount = rules.filter((r) => r.decision === "deny").length;

  const bypassCount = snapshot.builtinRules.filter((r) => r.bypassImmune).length;
  const confirmCount = snapshot.builtinRules.filter(
    (r) => r.action === "confirm",
  ).length;

  const ctxLabel = formatContextKindLabel(snapshot.contextId);
  const ctxIdDisplay = formatContextIdInline(snapshot.contextId);

  writer.line("");
  writer.line(chalk.bold("╭─ 安全状态 ─────────────────────────────"));
  writer.line(chalk.bold("│"));
  writer.line(
    `${chalk.bold("│")} ${chalk.dim("上下文:")}    ${chalk.cyan(ctxLabel)}` +
      (snapshot.workspacePath ? `  ${chalk.dim(snapshot.workspacePath)}` : ""),
  );
  writer.line(`${chalk.bold("│")} ${chalk.dim("contextId:")} ${chalk.dim(ctxIdDisplay)}`);
  writer.line(chalk.bold("│"));
  writer.line(`${chalk.bold("│")} ${chalk.bold("── 策略规则 ──")}`);
  writer.line(
    `${chalk.bold("│")} 内置: ${snapshot.builtinRules.length} 条 (${chalk.red(`${bypassCount} bypassImmune`)} + ${chalk.yellow(`${confirmCount} confirm`)})`,
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
  if (snapshot.rateLimits.length === 0) {
    writer.line(`${chalk.bold("│")} ${chalk.dim("(无活动)")}`);
  } else {
    for (const entry of snapshot.rateLimits.slice(0, 8)) {
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
  if (snapshot.confirmations.length === 0) {
    writer.line(`${chalk.bold("│")} ${chalk.dim("(无累计)")}`);
  } else {
    for (const entry of snapshot.confirmations.slice(0, 8)) {
      const keyShort = entry.key.replace(/^bash::/, "").slice(0, 30);
      writer.line(
        `${chalk.bold("│")}   ${chalk.cyan(keyShort.padEnd(30))} ${entry.count} 次 ${chalk.dim(`(${entry.highestRisk})`)}`,
      );
    }
  }
  writer.line(chalk.bold("╰────────────────────────────────────────"));
  writer.line("");
}

async function showPolicyRules(opts: SecurityOptions): Promise<void> {
  const snapshot = await loadSecuritySnapshot(opts);
  if (!snapshot) return;
  const rules: readonly SecurityRule[] = snapshot.builtinRules;
  opts.writer.line("");
  opts.writer.line(chalk.bold(`  策略规则 (${rules.length} 条)`));
  opts.writer.line(chalk.dim("  ─────────────────────────────────────────────────────"));
  for (const rule of rules) {
    const action =
      rule.action === "block"
        ? chalk.red("block  ")
        : rule.action === "confirm"
          ? chalk.yellow("confirm")
          : chalk.green("audit  ");
    const immune = rule.bypassImmune ? chalk.red("[!]") : "   ";
    const sev = rule.severity.padEnd(8);
    opts.writer.line(
      `  ${immune} ${action} ${chalk.dim(sev)} ${chalk.cyan(rule.id.padEnd(28))} ${chalk.dim(rule.name)}`,
    );
  }
  opts.writer.line(chalk.dim("  ─────────────────────────────────────────────────────"));
  opts.writer.line(chalk.dim("  [!] = bypassImmune（任何配置都无法覆盖）"));
  opts.writer.line("");
}
// ─── /trust ───

interface TrustOptions {
  /** 列当前语境的用户可管规则(宿主 trust.list) */
  listRules: () => Promise<PermissionRule[]>;
  /** 撤销规则(宿主 trust.revoke);不存在返回 false */
  revokeRule: (id: string) => Promise<boolean>;
  writer: CliWriter;
}

/**
 * /trust 的 target 无关命令行为（cli 文本前端）—— 列出 / 撤销用户信任规则。
 *
 * 执行体在核心宿主(trust.list / trust.revoke RPC,语境派生与"哪些规则归
 * 用户管"的判定在宿主单点);typeahead 模式下另有 trust-rule-arg-provider 的
 * 面板增强（浏览 + Ctrl+D），是同一能力之上的渐进增强，非唯一入口。
 */
export async function handleTrustCommand(
  args: string,
  opts: TrustOptions,
): Promise<void> {
  const trimmed = args.trim();
  const sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (sub === "revoke") {
    return revokeTrustRule(trimmed.slice("revoke".length).trim(), opts);
  }
  if (sub === "help") {
    return printTrustHelp(opts.writer);
  }
  return listTrustRules(opts);
}

async function listTrustRules(opts: TrustOptions): Promise<void> {
  const { writer } = opts;
  let rules: PermissionRule[];
  try {
    rules = await opts.listRules();
  } catch (err) {
    writer.line(
      chalk.red(
        `\n  信任规则不可用: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return;
  }
  if (rules.length === 0) {
    writer.line(chalk.dim("\n  暂无信任规则\n"));
    return;
  }
  writer.line(`\n${chalk.bold(`  信任规则 (${rules.length} 条)`)}`);
  for (const rule of rules) {
    writer.line(
      `  ${chalk.cyan(rule.id)}  ${chalk.white(`${rule.pattern.tool} ${rule.pattern.argument}`)}`,
    );
    writer.line(`    ${chalk.dim(formatRuleDescription(rule))}`);
  }
  writer.line(chalk.dim("\n  撤销: /trust revoke <id>\n"));
}

async function revokeTrustRule(id: string, opts: TrustOptions): Promise<void> {
  const { writer } = opts;
  if (!id) {
    writer.line(chalk.yellow("\n  用法: /trust revoke <id>\n"));
    return;
  }
  try {
    const ok = await opts.revokeRule(id);
    if (ok) {
      writer.line(chalk.dim(`\n  已撤销信任规则 ${chalk.cyan(id)}\n`));
    } else {
      writer.line(chalk.red(`\n  信任规则 "${id}" 不存在\n`));
    }
  } catch (err) {
    writer.line(
      chalk.red(
        `\n  撤销失败: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
  }
}

function printTrustHelp(writer: CliWriter): void {
  writer.line("");
  writer.line(chalk.bold("  /trust — 信任规则管理"));
  writer.line("");
  writer.line("  /trust                列出用户信任规则");
  writer.line("  /trust revoke <id>    撤销指定规则");
  writer.line("");
  writer.line(
    chalk.dim("  typeahead 模式下可在 /trust 面板浏览并 Ctrl+D 双击撤销"),
  );
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
