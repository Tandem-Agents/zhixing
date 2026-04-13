/**
 * 安全确认对话框 — Phase 2 Step 8
 *
 * 当 SecurityPipeline 返回 requiresConfirmation=true 时，渲染一个
 * 阻塞式终端对话框让用户选择：允许一次 / 始终允许（3 种 scope）/ 拒绝。
 *
 * 设计要点：
 *   - prompt 函数由外部注入（REPL 传入 rl.question），便于测试与替换
 *   - 智能建议：tracker 达到阈值时在对话框中高亮提示
 *   - 永远不自动替用户选择——空输入/无效输入重新提问
 *   - 对话框输出使用 chalk 着色，但所有决策都是选项文本
 */

import chalk from "chalk";
import { suggestPatterns } from "@zhixing/core";
import type {
  OperationClass,
  RiskLevel,
  SecurityMiddlewareResult,
  SecurityRequest,
  SuggestedPattern,
} from "@zhixing/core";

// ─── 类型 ───

export type ConfirmationChoice =
  | { kind: "allow-once" }
  | { kind: "allow-session"; pattern: SuggestedPattern }
  | { kind: "allow-workspace"; pattern: SuggestedPattern }
  | { kind: "allow-global"; pattern: SuggestedPattern }
  | { kind: "deny" };

export type PromptFn = (text: string) => Promise<string>;

export interface ShowConfirmationOptions {
  toolName: string;
  toolInput: Record<string, unknown>;
  result: SecurityMiddlewareResult;
  prompt: PromptFn;
}

// ─── 格式化辅助 ───

function formatOperation(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "bash" || toolName === "shell") {
    const cmd = typeof input["command"] === "string" ? input["command"] : "";
    return `${chalk.gray("$")} ${chalk.cyan(cmd)}`;
  }
  const pathArg =
    (typeof input["path"] === "string" && input["path"]) ||
    (typeof input["file_path"] === "string" && input["file_path"]) ||
    (typeof input["target"] === "string" && input["target"]) ||
    "";
  if (pathArg) {
    return `${chalk.gray(toolName + " →")} ${chalk.cyan(pathArg)}`;
  }
  const summary = JSON.stringify(input);
  const brief = summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
  return `${chalk.gray(toolName)} ${chalk.dim(brief)}`;
}

function formatRiskBadge(level?: RiskLevel): string {
  switch (level) {
    case "low":
      return chalk.green("low");
    case "medium":
      return chalk.yellow("medium");
    case "high":
      return chalk.red("high");
    case "critical":
      return chalk.bgRed.white(" critical ");
    default:
      return chalk.dim("?");
  }
}

function formatImpactBadge(cls?: OperationClass): string {
  switch (cls) {
    case "observe":
      return chalk.green("observe");
    case "internal":
      return chalk.green("internal");
    case "external":
      return chalk.yellow("external");
    case "critical":
      return chalk.red("critical");
    default:
      return chalk.dim("?");
  }
}

/**
 * 从建议模式列表中挑一个最适合作为"始终允许"的候选。
 * 优先选"中间精度"（如 `npm install *` 而非 `npm *` 或完整命令）。
 */
function pickSuggestedPattern(
  patterns: SuggestedPattern[],
): SuggestedPattern | null {
  if (patterns.length === 0) return null;
  if (patterns.length >= 3) return patterns[1]!; // 中间精度
  return patterns[patterns.length - 1]!;
}

// ─── 渲染 ───

function renderDialog(
  opts: ShowConfirmationOptions,
  suggested: SuggestedPattern | null,
): void {
  const { toolName, toolInput, result } = opts;
  const decision = result.decision;
  const suggestion = result.suggestion;

  console.log();
  console.log(chalk.yellow("╭─ 安全确认 ────────────────────────────"));
  console.log(chalk.yellow("│"));
  console.log(`${chalk.yellow("│")} ${chalk.bold("智能体想要执行:")}`);
  console.log(`${chalk.yellow("│")}   ${formatOperation(toolName, toolInput)}`);
  console.log(chalk.yellow("│"));
  console.log(
    `${chalk.yellow("│")} ${chalk.dim("影响范围:")} ${formatImpactBadge(result.operationClass)}` +
      `   ${chalk.dim("风险等级:")} ${formatRiskBadge(decision?.riskLevel)}`,
  );
  if (decision?.reason) {
    console.log(`${chalk.yellow("│")} ${chalk.dim("原因:")} ${decision.reason}`);
  }
  if (result.matchedPermissionRule) {
    const r = result.matchedPermissionRule;
    console.log(
      `${chalk.yellow("│")} ${chalk.dim("匹配权限规则:")} ${chalk.cyan(
        `${r.pattern.tool} ${r.pattern.argument}`,
      )} (${r.scope})`,
    );
  }

  // 智能建议提示
  if (suggestion?.suggest) {
    console.log(chalk.yellow("│"));
    console.log(
      `${chalk.yellow("│")} ${chalk.green("💡 建议:")} 你已经批准了 ${chalk.bold(
        String(suggestion.count),
      )} 次相似操作`,
    );
    console.log(
      `${chalk.yellow("│")}    ${chalk.dim("考虑选 [a] 或 [g] 创建永久规则？")}`,
    );
  }

  console.log(chalk.yellow("│"));
  console.log(`${chalk.yellow("│")} ${chalk.bold("[y]")} 允许这一次`);
  if (suggested) {
    const label = chalk.cyan(`"${suggested.pattern.argument}"`);
    console.log(
      `${chalk.yellow("│")} ${chalk.bold("[a]")} 始终允许 ${label}（本工作区）`,
    );
    console.log(
      `${chalk.yellow("│")} ${chalk.bold("[g]")} 始终允许 ${label}（全局）`,
    );
    console.log(
      `${chalk.yellow("│")} ${chalk.bold("[s]")} 会话内允许 ${label}`,
    );
  }
  console.log(`${chalk.yellow("│")} ${chalk.bold("[n]")} 拒绝`);
  console.log(chalk.yellow("╰────────────────────────────────────────"));
}

// ─── 主函数 ───

export async function showConfirmationDialog(
  opts: ShowConfirmationOptions,
): Promise<ConfirmationChoice> {
  // 候选模式独立于 tracker 的建议状态——用户从第一次起就能选"始终允许"
  const request: SecurityRequest = {
    tool: opts.toolName,
    arguments: opts.toolInput,
    context: {
      cwd: "",
      workspace: null,
      sessionType: "interactive",
    },
  };
  const patterns = suggestPatterns(request);
  const suggested = pickSuggestedPattern(patterns);

  renderDialog(opts, suggested);

  const validChars = suggested ? "y/a/g/s/n" : "y/n";
  while (true) {
    const raw = await opts.prompt(chalk.yellow(`选择 [${validChars}]: `));
    const input = raw.trim().toLowerCase();

    switch (input) {
      case "y":
        return { kind: "allow-once" };
      case "n":
      case "":
        // 空输入视为取消——避免误按回车放行
        return { kind: "deny" };
      case "a":
        if (suggested) return { kind: "allow-workspace", pattern: suggested };
        break;
      case "g":
        if (suggested) return { kind: "allow-global", pattern: suggested };
        break;
      case "s":
        if (suggested) return { kind: "allow-session", pattern: suggested };
        break;
    }

    console.log(
      chalk.red(`未识别的选择 "${raw.trim()}"，请输入 ${validChars} 之一`),
    );
  }
}

/** 渲染"被策略/权限规则阻止"的拒绝消息——无需用户交互 */
export function renderBlockedMessage(
  toolName: string,
  toolInput: Record<string, unknown>,
  result: SecurityMiddlewareResult,
): void {
  console.log();
  console.log(chalk.red("╭─ 操作被阻止 ────────────────────────"));
  console.log(`${chalk.red("│")} ${formatOperation(toolName, toolInput)}`);
  console.log(chalk.red("│"));
  console.log(
    `${chalk.red("│")} ${chalk.dim("原因:")} ${result.reason ?? "未知"}`,
  );
  const rules = result.decision?.matchedRules ?? [];
  if (rules.length > 0) {
    console.log(
      `${chalk.red("│")} ${chalk.dim("匹配规则:")} ${rules
        .map((r) => r.id)
        .join(", ")}`,
    );
  }
  console.log(chalk.red("╰────────────────────────────────────────"));
}
