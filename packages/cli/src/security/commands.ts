/**
 * /security · /trust 斜杠命令处理器。
 *
 * /trust 执行体在核心宿主(trust.list / revoke RPC);/security 的状态事实
 * (策略引擎 / 频率限制 / 确认追踪)活在宿主 runtime 内,CLI 只消费
 * session.security 快照并渲染,不再直连本地 SecurityPipeline。
 */

import chalk from "chalk";
import type { PermissionContextId } from "@zhixing/core/security";
import type {
  TrustAdministrationRule,
  TrustAdministrationScopeGroup,
} from "@zhixing/core/trust-administration";
import type { SessionSecurityResult } from "@zhixing/rpc";
import type { CliWriter } from "../screen/index.js";
import { formatGroupedRuleDescription, formatRuleDescription } from "./trust-rule-format.js";

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

async function showSecurityOverview(opts: SecurityOptions): Promise<boolean> {
  const { writer } = opts;
  const edge = opts.framed === false ? "" : chalk.bold("│");
  const snapshot = await loadSecuritySnapshot(opts);
  if (!snapshot) return false;

  const rules = snapshot.permissionRules;
  const sessionCount = rules.filter((r) => r.scope === "session").length;
  const ctxCount = rules.filter((r) => r.scope === "context").length;
  const globalCount = rules.filter((r) => r.scope === "global").length;
  const denyCount = rules.filter((r) => r.decision === "deny").length;

  const bypassCount = snapshot.builtinRules.filter((r) => r.bypassImmune).length;
  // 两类互斥：不可覆盖的规则里也有"确认"动作的，按是否可被用户批准划分，两项之和等于总数
  const confirmCount = snapshot.builtinRules.filter(
    (r) => !r.bypassImmune && r.action === "confirm",
  ).length;

  const ctxLabel = formatContextKindLabel(snapshot.contextId);

  if (opts.framed !== false) {
    writer.line("");
    writer.line(chalk.bold("╭─ 安全状态 ─────────────────────────────"));
  }
  writer.line(edge);
  writer.line(
    `${edge} ${chalk.dim("上下文:")}    ${chalk.cyan(ctxLabel)}` +
      (snapshot.workspacePath ? `  ${chalk.dim(snapshot.workspacePath)}` : ""),
  );
  const scope = snapshot.scope;
  if (scope?.kind === "run") {
    // 正在执行的运行：按它的已验签清单推导的实际范围与冻结快照
    writer.line(
      `${edge} ${chalk.dim("本次运行:")}  ${chalk.cyan(formatContextKindLabel(scope.contextId))}  ` +
        chalk.dim(`冻结规则 ${scope.permissionRules.length} 条`),
    );
  } else {
    writer.line(`${edge} ${chalk.dim("以上为对话默认概览；显式选择工作区的运行按该工作区范围生效")}`);
  }
  writer.line(edge);
  writer.line(`${edge} ${chalk.bold("── 策略规则 ──")}`);
  writer.line(
    `${edge} 内置: ${snapshot.builtinRules.length} 条（${chalk.red(`${bypassCount} 条禁区，每次确认`)} · ${chalk.yellow(`${confirmCount} 条需确认`)}）`,
  );
  writer.line(edge);
  writer.line(`${edge} ${chalk.bold("── 权限规则 ──")}`);
  writer.line(
    `${edge} 会话: ${sessionCount} · 上下文: ${ctxCount} · 全局: ${globalCount}` +
      (denyCount > 0 ? chalk.red(`（含 ${denyCount} 条拒绝规则）`) : ""),
  );
  if (rules.length > 0) {
    writer.line(chalk.dim(`${edge} Tip: /trust 查看详情`));
  }
  writer.line(edge);
  writer.line(`${edge} ${chalk.bold("── 频率限制（最近窗口）──")}`);
  if (snapshot.rateLimits.length === 0) {
    writer.line(`${edge} ${chalk.dim("(无活动)")}`);
  } else {
    for (const entry of snapshot.rateLimits.slice(0, 8)) {
      const pct = entry.used / entry.limit;
      const bar =
        pct > 0.8 ? chalk.red : pct > 0.5 ? chalk.yellow : chalk.green;
      writer.line(
        `${edge}   ${chalk.cyan(entry.key.padEnd(10))} ${bar(`${entry.used}/${entry.limit}`)}`,
      );
    }
  }
  writer.line(edge);
  writer.line(`${edge} ${chalk.bold("── 确认追踪 ──")}`);
  if (snapshot.confirmations.length === 0) {
    writer.line(`${edge} ${chalk.dim("(无累计)")}`);
  } else {
    for (const entry of snapshot.confirmations.slice(0, 8)) {
      const keyShort = entry.key.replace(/^bash::/, "").slice(0, 30);
      writer.line(
        `${edge}   ${chalk.cyan(keyShort.padEnd(30))} ${entry.count} 次 ${chalk.dim(`(${entry.highestRisk})`)}`,
      );
    }
  }
  if (opts.framed !== false) {
    writer.line(chalk.bold("╰────────────────────────────────────────"));
    writer.line("");
  }
  return true;
}

async function showPolicyRules(opts: SecurityOptions): Promise<boolean> {
  const snapshot = await loadSecuritySnapshot(opts);
  if (!snapshot) return false;
  const rules = snapshot.builtinRules;
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
  return true;
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

