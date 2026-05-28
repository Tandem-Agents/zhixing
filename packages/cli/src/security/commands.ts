/**
 * /trust 和 /security 斜杠命令处理器
 *
 * `/trust`（无参数进入面板）—— 沉淀信任规则的查看与撤销入口。
 *   旧子命令（list / revoke / reset / revoke-steward）整体废除，统一面板式交互：
 *   列出本上下文 + 全局的用户/助理沉淀规则、命令式选编号查详情、d<编号> 撤销、
 *   Enter 退出。builtin 系统防护规则不归用户管，归 /security 查看，不进 /trust。
 *
 * `/security` —— 安全系统状态概览 + 内置策略规则列表（只读，无法撤销）。
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import { getAgentIdentity } from "@zhixing/core";
import type {
  PermissionRule,
  SecurityPipeline,
  SecurityRule,
  TrustContribution,
} from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";
import { padEndDisplay } from "../tui/line-width.js";

// ─── 显示辅助 ───

/**
 * 按 scope + contextId 渲染"生效范围"中文标签 —— /trust 面板列表与详情共用。
 *
 * 上下文平等：主模式与工作场景在权限层都是"上下文"，差别仅在 contextId 取值。
 * contextId === "main" → 主模式上下文；contextId === 工作场景 hash → 工作场景上下文；
 * scope=global → 跨所有上下文。
 */
function formatScope(rule: PermissionRule): string {
  if (rule.scope === "global") return chalk.magenta("全局");
  if (rule.scope === "session") return chalk.gray("本次会话");
  if (rule.scope === "context") {
    if (rule.contextId === "main") return chalk.cyan("主模式");
    return chalk.cyan("当前工作场景");
  }
  return chalk.dim("builtin");
}

/**
 * 把 contributors 渲染为 `[你 你 助理]` 形式 —— 按时间顺序、空格分隔、中括号包起。
 * 列表里只显示，不做聚合统计；详情区另行展开完整时间线。
 * 用户面术语统一「助理」（与 SecurityBlockError、confirm 前置标识对齐）。
 */
function formatContributorsList(contributors: TrustContribution[] | undefined): string {
  if (!contributors || contributors.length === 0) return chalk.dim("[—]");
  const tokens = contributors.map((c) => (c.origin === "user" ? "你" : "助理"));
  return `[${tokens.join(" ")}]`;
}

function formatRelativeMs(timestamp: number): string {
  if (timestamp <= 0) return "—";
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

function formatAbsoluteTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * 格式化列表中的一行规则。
 * 列顺序：编号 / id 短码 / 生效范围 / contributors / 工具 / pattern / 匹配状态。
 * 不显示 decision 列 —— 沉淀规则恒为 allow，无信息量。
 */
function formatTrustListRow(idx: number, rule: PermissionRule): string {
  // 列对齐统一走 padEndDisplay —— 正确处理 ANSI 色彩转义 + CJK 全角宽度
  // （原生 String.padEnd 按 char count 算，对 chalk 包裹的中文会严重错位）
  const num = chalk.dim(`[${String(idx).padStart(2, " ")}]`);
  const idShort = chalk.dim(rule.id.slice(0, 8));
  const scope = padEndDisplay(formatScope(rule), 16);
  const contributors = padEndDisplay(
    formatContributorsList(rule.contributors),
    16,
  );
  const tool = padEndDisplay(chalk.cyan(rule.pattern.tool), 10);
  const arg = padEndDisplay(rule.pattern.argument, 24);
  const matched =
    rule.matchCount > 0
      ? `${rule.matchCount} 次 (${formatRelativeMs(rule.lastMatchedAt)})`
      : chalk.dim("未匹配");
  return `  ${num} ${idShort}  ${scope} ${contributors} ${tool} ${arg} ${chalk.dim(matched)}`;
}

/**
 * 格式化选中规则的详情区 —— 操作 / 生效范围 / 匹配 / 累计放行记录完整时间线。
 */
function formatTrustDetail(rule: PermissionRule): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold(`  详情 ${chalk.dim(rule.id.slice(0, 8))}`));
  lines.push("");
  lines.push(`  ${chalk.dim("操作：")}     ${chalk.cyan(rule.pattern.tool)} ${rule.pattern.argument}`);
  lines.push(`  ${chalk.dim("生效范围：")} ${formatScope(rule)}`);
  if (rule.contextPath) {
    lines.push(`  ${chalk.dim("工作目录：")} ${chalk.dim(rule.contextPath)}`);
  }
  const matchedSummary =
    rule.matchCount > 0
      ? `${rule.matchCount} 次 (最近 ${formatRelativeMs(rule.lastMatchedAt)})`
      : "未匹配";
  lines.push(`  ${chalk.dim("匹配：")}     ${matchedSummary}`);
  lines.push("");

  if (rule.contributors && rule.contributors.length > 0) {
    lines.push(`  ${chalk.dim("累计放行记录（按时间顺序）：")}`);
    rule.contributors.forEach((c, i) => {
      const label = c.origin === "user" ? "你" : "安全助理";
      lines.push(
        `    ${chalk.dim(`${i + 1}.`)} [${label}]  ${chalk.dim(formatAbsoluteTime(c.timestamp))}`,
      );
    });
    lines.push("");
  }
  return lines;
}

// ─── /trust ───

interface TrustOptions {
  pipeline: SecurityPipeline;
  rl: readline.Interface;
  writer: CliWriter;
}

/**
 * `/trust` 命令入口 —— 无参数进入面板，命令式列表交互。
 *
 * 面板循环：每轮重新加载并渲染列表 → 等待用户输入 → 处理（查详情 / 撤销 / 退出）。
 * 撤销采用 y/N 二次确认（默认否，避免误删）。重新加载保证列表实时反映规则变化。
 */
export async function handleTrustCommand(
  _args: string,
  opts: TrustOptions,
): Promise<void> {
  const { pipeline, rl, writer } = opts;
  const store = pipeline.getPermissionStore();

  while (true) {
    const contextId = pipeline.getContextId();
    const all = store.list(contextId);
    // builtin 规则归 /security，不进 /trust 用户管理面板
    const rules = all.filter((r) => r.scope !== "builtin");

    writer.line("");
    writer.line(chalk.bold("  已建立的信任规则") + chalk.dim("   (输入编号查看详情 · d<编号> 撤销 · Enter 退出)"));

    if (rules.length === 0) {
      writer.line("");
      const ctxLabel = contextId === "main" ? "主模式" : "当前工作场景";
      writer.line(chalk.dim(`  ${ctxLabel} 与全局都没有建立信任规则`));
      const { displayName } = getAgentIdentity();
      writer.line(
        chalk.dim(
          `  Tip: ${displayName} 触发 confirm 时选 [a]/[g] 显式创建,或同模式累计达阈值自动建立\n`,
        ),
      );
      return;
    }

    writer.line("");
    rules.forEach((rule, idx) => {
      writer.line(formatTrustListRow(idx + 1, rule));
    });
    writer.line("");

    const input = (await rl.question("  > ")).trim();
    if (!input) {
      writer.line("");
      return;
    }

    const lower = input.toLowerCase();
    // 撤销分支：d<编号>，二次确认默认否
    if (lower.startsWith("d")) {
      const numStr = input.slice(1).trim();
      const num = parseInt(numStr, 10);
      if (Number.isNaN(num) || num < 1 || num > rules.length) {
        writer.line(chalk.red(`  无效编号：${numStr || "(空)"}\n`));
        continue;
      }
      const target = rules[num - 1]!;
      const prompt = chalk.yellow(
        `  确认撤销 [${num}] ${target.pattern.tool} ${target.pattern.argument}？(y/N): `,
      );
      const confirm = (await rl.question(prompt)).trim().toLowerCase();
      if (confirm === "y") {
        const ok = store.revoke(target.id);
        if (ok) {
          writer.line(chalk.green(`  已撤销\n`));
        } else {
          writer.line(chalk.red(`  撤销失败（规则可能已不存在）\n`));
        }
      } else {
        writer.line(chalk.dim(`  已取消\n`));
      }
      continue;
    }

    // 查详情分支：纯数字
    const num = parseInt(input, 10);
    if (Number.isNaN(num) || num < 1 || num > rules.length) {
      writer.line(chalk.red(`  无效输入：${input}\n`));
      continue;
    }
    const target = rules[num - 1]!;
    for (const line of formatTrustDetail(target)) {
      writer.line(line);
    }
  }
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

  const ctxLabel = contextId === "main" ? "主模式" : "工作场景";

  writer.line("");
  writer.line(chalk.bold("╭─ 安全状态 ─────────────────────────────"));
  writer.line(chalk.bold("│"));
  writer.line(
    `${chalk.bold("│")} ${chalk.dim("上下文：")}    ${chalk.cyan(ctxLabel)}` +
      (workspacePath ? `  ${chalk.dim(workspacePath)}` : ""),
  );
  writer.line(`${chalk.bold("│")} ${chalk.dim("contextId：")} ${chalk.dim(contextId)}`);
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
