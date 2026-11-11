/**
 * /security · /trust 斜杠命令处理器。
 *
 * /trust 执行体在核心宿主(trust.list / revoke RPC);/security 的状态事实
 * (策略引擎 / 频率限制 / 确认追踪)活在宿主 runtime 内,CLI 只消费
 * session.security 快照并渲染,不再直连本地 SecurityPipeline。
 */

import chalk from "chalk";
import type {
  TrustAdministrationRule,
  TrustAdministrationScopeGroup,
} from "@zhixing-ai/core/trust-administration";
import type { SessionSecurityResult } from "@zhixing-ai/rpc";
import type { TerminalSummary } from "@zhixing-ai/terminal-ui/protocol";
import type { CliWriter } from "../screen/index.js";
import { formatGroupedRuleDescription, formatRuleDescription } from "./trust-rule-format.js";
import { securityOverview, securityRulesDetail } from "./security-summary.js";
import { summaryLines } from "../summary-projection.js";

// ─── /security ───

interface SecurityOptions {
  status: () => Promise<SessionSecurityResult>;
  writer: CliWriter;
  /** Full-screen surfaces already own the surrounding frame. */
  framed?: boolean;
}

export async function handleSecurityCommand(
  args: string,
  opts: SecurityOptions,
): Promise<boolean> {
  const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (subcommand === "rules") {
    return showPolicyRules(opts);
  }
  if (subcommand === "help") {
    printSecurityHelp(opts.writer); return true;
  }
  return showSecurityOverview(opts);
}

function printSecurityHelp(writer: CliWriter): void {
  writer.line("");
  writer.line(chalk.bold("  /security — 安全状态"));
  writer.line("");
  writer.line("  /security             概览：范围、内置规则分档、信任规则、允许累计、调用频率（默认）");
  writer.line("  /security rules       规则说明：每条内置规则的档位、风险与说明");
  writer.line("  /trust                信任规则；输入 /trust 后加空格可浏览与撤销");
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

async function showSecurityOverview(opts: SecurityOptions): Promise<boolean> {
  const snapshot = await loadSecuritySnapshot(opts);
  if (!snapshot) return false;
  writeSummary(opts, "安全状态", securityOverview(snapshot));
  return true;
}

async function showPolicyRules(opts: SecurityOptions): Promise<boolean> {
  const snapshot = await loadSecuritySnapshot(opts);
  if (!snapshot) return false;
  writeSummary(opts, "规则说明", securityRulesDetail(snapshot));
  return true;
}

/** 与终端信息页同一份投影逐行输出（多页依次输出）；全屏页面已有自己的页头时不再写标题 */
function writeSummary(opts: SecurityOptions, title: string, summary: TerminalSummary | readonly TerminalSummary[]): void {
  if (opts.framed !== false) {
    opts.writer.line("");
    opts.writer.line(chalk.bold(`  ${title}`));
  }
  const pages = Array.isArray(summary) ? summary : [summary as TerminalSummary];
  for (const page of pages) {
    for (const line of summaryLines(page)) opts.writer.line(opts.framed === false ? line : `  ${line}`);
  }
  if (opts.framed !== false) opts.writer.line("");
}
// ─── /trust ───

interface TrustOptions {
  /** 列当前语境的用户可管规则(宿主 trust.list) */
  listRules: () => Promise<TrustAdministrationRule[]>;
  /** 撤销规则(宿主 trust.revoke);不存在返回 false */
  revokeRule: (id: string) => Promise<boolean>;
  /** 当前范围以外的其他范围（分页，宿主 trust.list 的 otherScopes） */
  listOtherScopes?: (after?: string) => Promise<{
    readonly groups: readonly TrustAdministrationScopeGroup[];
    readonly next?: string;
  }>;
  /** 撤销其他范围里的规则（带该规则所在分组的范围） */
  revokeRuleIn?: (id: string, context: TrustAdministrationScopeGroup["context"]) => Promise<boolean>;
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
): Promise<boolean> {
  const trimmed = args.trim();
  const sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (sub === "revoke") {
    return revokeTrustRule(trimmed.slice("revoke".length).trim(), opts);
  }
  if (sub === "help") {
    printTrustHelp(opts.writer); return true;
  }
  if (sub === "others") {
    return listOtherTrustScopes(trimmed.slice("others".length).trim() || undefined, opts);
  }
  return listTrustRules(opts);
}

function printScopeGroups(
  writer: CliWriter,
  page: { readonly groups: readonly TrustAdministrationScopeGroup[]; readonly next?: string },
): void {
  for (const group of page.groups) {
    writer.line(`\n  ${chalk.bold(group.label)}${group.effective ? "" : chalk.yellow("（不再生效）")}`);
    if (group.note) writer.line(`    ${chalk.dim(group.note)}`);
    for (const rule of group.rules) {
      writer.line(
        `  ${chalk.cyan(rule.id)}  ${chalk.white(`${rule.pattern.tool} ${rule.pattern.argument}`)}`,
      );
      writer.line(`    ${chalk.dim(formatGroupedRuleDescription(group.label, rule))}`);
    }
  }
  if (page.next) writer.line(chalk.dim(`\n  还有更多范围: /trust others ${page.next}`));
}

async function listOtherTrustScopes(after: string | undefined, opts: TrustOptions): Promise<boolean> {
  const { writer } = opts;
  if (!opts.listOtherScopes) {
    writer.line(chalk.dim("\n  当前前端不支持列出其他范围\n"));
    return true;
  }
  try {
    const page = await opts.listOtherScopes(after);
    if (page.groups.length === 0) {
      writer.line(chalk.dim("\n  没有其他范围的信任规则\n"));
      return true;
    }
    writer.line(`\n${chalk.bold("  其他范围")}`);
    printScopeGroups(writer, page);
    writer.line(chalk.dim("\n  撤销: /trust revoke <id>\n"));
    return true;
  } catch (err) {
    writer.line(chalk.red(`\n  其他范围不可用: ${err instanceof Error ? err.message : String(err)}\n`));
    return false;
  }
}

async function listTrustRules(opts: TrustOptions): Promise<boolean> {
  const { writer } = opts;
  let rules: TrustAdministrationRule[];
  try {
    rules = await opts.listRules();
  } catch (err) {
    writer.line(
      chalk.red(
        `\n  信任规则不可用: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return false;
  }
  // 其他范围取不到不影响当前范围的列表
  const others = await opts.listOtherScopes?.().catch(() => undefined);
  const hasOthers = (others?.groups.length ?? 0) > 0;
  if (rules.length === 0 && !hasOthers) {
    writer.line(chalk.dim("\n  暂无信任规则\n"));
    return true;
  }
  // 只有存在其他范围时才分组显示，否则保持原来的单一列表
  writer.line(`\n${chalk.bold(hasOthers ? `  当前范围与全局 (${rules.length} 条)` : `  信任规则 (${rules.length} 条)`)}`);
  if (rules.length === 0) writer.line(chalk.dim("  暂无"));
  for (const rule of rules) {
    writer.line(
      `  ${chalk.cyan(rule.id)}  ${chalk.white(`${rule.pattern.tool} ${rule.pattern.argument}`)}`,
    );
    writer.line(`    ${chalk.dim(formatRuleDescription(rule))}`);
  }
  if (hasOthers) {
    writer.line(`\n${chalk.bold("  其他范围")}`);
    printScopeGroups(writer, others!);
  }
  writer.line(chalk.dim("\n  撤销: /trust revoke <id>\n"));
  return true;
}

async function revokeTrustRule(id: string, opts: TrustOptions): Promise<boolean> {
  const { writer } = opts;
  if (!id) {
    writer.line(chalk.yellow("\n  用法: /trust revoke <id>\n"));
    return false;
  }
  try {
    let ok = await opts.revokeRule(id);
    if (!ok && opts.listOtherScopes && opts.revokeRuleIn) {
      // 当前范围里没有：按其他范围首页找到该规则所在分组再撤销（宿主再核一次可见）
      // 其他范围查不到时按当前范围的结果报告（不把"不存在"变成撤销失败）
      const others = await opts.listOtherScopes().catch(() => undefined);
      const group = others?.groups.find((entry) => entry.rules.some((rule) => rule.id === id));
      if (group) ok = await opts.revokeRuleIn(id, group.context);
    }
    if (ok) {
      writer.line(chalk.dim(`\n  已撤销信任规则 ${chalk.cyan(id)}\n`));
    } else {
      writer.line(chalk.red(`\n  信任规则 "${id}" 不存在\n`));
    }
    return ok;
  } catch (err) {
    writer.line(
      chalk.red(
        `\n  撤销失败: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return false;
  }
}

function printTrustHelp(writer: CliWriter): void {
  writer.line("");
  writer.line(chalk.bold("  /trust — 信任规则管理"));
  writer.line("");
  writer.line("  /trust                列出用户信任规则");
  writer.line("  /trust revoke <id>    撤销指定规则");
  writer.line("  /trust others [游标]  列出其他范围（显式工作区、已失效工作区等）");
  writer.line("");
  writer.line(
    chalk.dim("  在终端里输入 /trust 后加空格可浏览规则，两次 Ctrl+D 撤销"),
  );
  writer.line("");
}
