/**
 * TerminalConfirmationRenderer — 把 ConfirmationBroker 接到终端 TUI
 *
 * 职责：
 *   1. 订阅 broker 的新请求通知（broker.onRequest）
 *   2. 把 ConfirmationRequest → SelectWithInput 组件的入参
 *   3. 调 selectWithInput 拿到用户的 SelectResult
 *   4. 翻译回 ConfirmationDecision 并 broker.resolve
 *
 * 与 host REPL 的共存:
 *   REPL 用 readline.Interface 管主输入循环，selectWithInput 要独占 stdin
 *   并开 raw mode。两者不能同时消费 stdin。renderer 通过 beforeShow / afterShow
 *   两个 hook 通知 host——典型实现是 `rl.pause()` / `rl.resume()`。
 *
 * 能力声明（`capabilities`）：
 *   - supportsInlineInput: true（selectWithInput 原生支持）
 *   - supportsAllowNote / supportsDenyReason: true（通过 input 选项）
 *   - supportsQueue: false（Phase 2 的 Step 5 再加）
 *   - supportsEdit: false（Step 8 再加）
 */

import chalk from "chalk";
import type {
  BrokerUnsubscribe,
  ConfirmationDecision,
  ConfirmationOption,
  ConfirmationRenderer,
  ConfirmationRequest,
  DisplayBody,
  IConfirmationBroker,
  OperationClass,
  RendererCapabilities,
} from "@zhixing/core";
import { getAgentIdentity } from "@zhixing/core";
import {
  selectWithInput,
  type SelectOption,
  type SelectResult,
} from "../tui/index.js";

// ─── 能力声明 ───

export const TERMINAL_RENDERER_CAPABILITIES: RendererCapabilities = {
  supportedOptions: [
    "allow-once",
    "allow-session",
    "allow-workspace",
    "allow-global",
    "deny",
    "allow-with-note",
    "deny-with-reason",
    "always-ask",
    // "edit-then-allow" Step 8 再加
    // "show-full" selectWithInput 内部通过自适应截断 + 手动展开处理
  ],
  supportsAllowNote: true,
  supportsDenyReason: true,
  supportsEdit: false,
  supportsQueue: false,
  supportsInlineInput: true,
};

// ─── 构造选项 ───

export interface TerminalConfirmationRendererOptions {
  /** 输入流——默认 process.stdin */
  stdin?: NodeJS.ReadStream;
  /** 输出流——默认 process.stdout */
  stdout?: NodeJS.WriteStream;
  /**
   * selectWithInput 启动前的 hook——host（REPL）应在此暂停自己的 stdin 消费。
   * 典型实现：`() => rl.pause()`。
   */
  beforeShow?: () => void | Promise<void>;
  /**
   * selectWithInput 结束后的 hook——host 应恢复 stdin 消费。
   * 典型实现：`() => rl.resume()`。
   */
  afterShow?: () => void | Promise<void>;
}

// ─── 主类 ───

export class TerminalConfirmationRenderer implements ConfirmationRenderer {
  readonly name = "terminal";
  readonly capabilities = TERMINAL_RENDERER_CAPABILITIES;

  private broker: IConfirmationBroker | null = null;
  private unsub: BrokerUnsubscribe | null = null;
  private currentAbort: AbortController | null = null;
  private detached = false;

  constructor(private readonly options: TerminalConfirmationRendererOptions = {}) {}

  attach(broker: IConfirmationBroker): () => void {
    if (this.broker && this.broker !== broker) {
      throw new Error(
        "TerminalConfirmationRenderer already attached to another broker — detach first",
      );
    }
    this.broker = broker;
    this.detached = false;
    this.unsub = broker.onRequest((req) => {
      // fire-and-forget: handleRequest 内部自己处理所有异常并最终 resolve
      void this.handleRequest(req);
    });
    return () => this.detach();
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.unsub?.();
    this.unsub = null;
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    this.broker = null;
  }

  // ─── 核心：处理单个请求 ───

  private async handleRequest(request: ConfirmationRequest): Promise<void> {
    const broker = this.broker;
    if (!broker) return;

    // 构造一个 AbortController 跟踪当前请求——detach 时用来强制中断
    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      // host 暂停
      if (this.options.beforeShow) {
        await this.options.beforeShow();
      }

      // 构造 selectWithInput 入参
      const { selectOptions, optionById } = buildSelectOptions(request);
      const bodyLines = buildPanelBody(request);

      let result: SelectResult;
      try {
        result = await selectWithInput({
          title: request.display.title || "安全确认",
          body: bodyLines,
          options: selectOptions,
          stdin: this.options.stdin ?? process.stdin,
          stdout: this.options.stdout ?? process.stdout,
          signal: abort.signal,
          // keyHintBar 不传 → selectWithInput 在 select/input 模式切换时
          // 自动渲染不同文案（Enter 在两个模式下语义完全不同）。
        });
      } finally {
        // host 恢复——无论 selectWithInput 成功或抛错都要
        if (this.options.afterShow) {
          await this.options.afterShow();
        }
      }

      const decision = translate(result, optionById);
      broker.resolve(request.id, decision);
    } catch (err) {
      // 渲染失败兜底：发 deny，把错误信息回写 reason 便于定位
      const message = err instanceof Error ? err.message : String(err);
      broker.resolve(request.id, {
        kind: "deny",
        reason: `渲染确认对话框失败：${message}`,
      });
    } finally {
      if (this.currentAbort === abort) {
        this.currentAbort = null;
      }
    }
  }
}

// ─── 从 ConfirmationRequest.options 构造 SelectOption[] ───

/**
 * 把 broker 层的 ConfirmationOption 转成 selectWithInput 的 SelectOption。
 * 同时返回一个 `optionById` 副表，用于在用户选中后把 value 映射回原始选项
 * （需要它来取回 pattern / 判断 kind）。
 *
 * 每个 ConfirmationOption 被分配一个稳定的 id（基于 index），作为
 * SelectOption.value。翻译阶段用这个 id 回查 optionById。
 */
export function buildSelectOptions(
  request: ConfirmationRequest,
): {
  selectOptions: SelectOption[];
  optionById: Map<string, ConfirmationOption>;
} {
  const selectOptions: SelectOption[] = [];
  const optionById = new Map<string, ConfirmationOption>();

  request.options.forEach((opt, idx) => {
    const id = `opt-${idx}`;
    optionById.set(id, opt);

    switch (opt.kind) {
      case "allow-once":
      case "allow-session":
      case "allow-workspace":
      case "allow-global":
      case "deny":
      case "always-ask":
      case "show-full":
      case "edit-then-allow":
        selectOptions.push({
          type: "simple",
          value: id,
          label: opt.label,
          hotkey: "hotkey" in opt ? opt.hotkey : undefined,
        });
        break;

      case "allow-with-note":
      case "deny-with-reason":
        selectOptions.push({
          type: "input",
          value: id,
          label: opt.label,
          placeholder: opt.placeholder,
          allowEmptySubmit: true,
          hotkey: opt.hotkey,
        });
        break;
    }
  });

  return { selectOptions, optionById };
}

// ─── 从 SelectResult 翻译回 ConfirmationDecision ───

export function translate(
  result: SelectResult,
  optionById: Map<string, ConfirmationOption>,
): ConfirmationDecision {
  if (result.kind === "cancelled") {
    switch (result.cause) {
      case "ctrl-c":
        return { kind: "cancelled", cause: "user-ctrl-c" };
      case "ctrl-d":
        return { kind: "cancelled", cause: "user-ctrl-d" };
      case "aborted":
        return { kind: "cancelled", cause: "aborted" };
      case "escape":
        // Esc 语义上等价于"拒绝"——用户明确不想做。
        // 与 Ctrl+C 区分：Ctrl+C 是"中止这次对话"，Esc 是"对这个决策说 no"。
        return { kind: "deny" };
    }
  }

  // selected
  const opt = optionById.get(result.value);
  if (!opt) {
    // 理论上不会发生——我们控制 optionById 和 value 的映射
    return {
      kind: "deny",
      reason: `未知选项 value：${result.value}`,
    };
  }

  switch (opt.kind) {
    case "allow-once":
      return { kind: "allow-once" };
    case "allow-with-note":
      return { kind: "allow-once", note: result.note };
    case "allow-session":
      return {
        kind: "allow-session",
        pattern: opt.pattern,
        note: result.note,
      };
    case "allow-workspace":
      return {
        kind: "allow-workspace",
        pattern: opt.pattern,
        note: result.note,
      };
    case "allow-global":
      return {
        kind: "allow-global",
        pattern: opt.pattern,
        note: result.note,
      };
    case "always-ask":
      return { kind: "always-ask", pattern: opt.pattern };
    case "deny":
      return { kind: "deny" };
    case "deny-with-reason":
      return { kind: "deny", reason: result.note };
    case "edit-then-allow":
      // Step 8 feature——Step 3 还未支持
      return {
        kind: "deny",
        reason: "edit-then-allow 尚未实现",
      };
    case "show-full":
      // show-full 是 UI 内部动作，不会产生决定——按 deny 兜底
      return { kind: "deny" };
  }
}

// ─── 面板 body 构造 ───

/**
 * 把 ConfirmationRequest 的显示信息构造成一组面板 body 行。
 * 包含主体（bash 命令 / 文件路径 / 消息...）+ 元数据表（cwd / env / 影响 / 风险 / 原因）。
 *
 * 注意：所有渲染走 chalk，chalk 会根据 NO_COLOR / CI 等自动降级。
 * 行宽由 clampLine 在 selectWithInput 内部处理，这里不需要考虑。
 */
export function buildPanelBody(request: ConfirmationRequest): string[] {
  const lines: string[] = [];
  const body = request.display.body;

  // ── 主体 ──
  for (const line of renderBody(body)) {
    lines.push(line);
  }

  // ── 元数据表 ──
  lines.push("");

  if (request.display.cwd) {
    lines.push(`${chalk.dim("cwd:")}   ${request.display.cwd}`);
  }

  if (request.display.envKeys && request.display.envKeys.length > 0) {
    lines.push(
      `${chalk.dim("env:")}   ${request.display.envKeys.join(", ")}`,
    );
  }

  if (request.display.resolvedPaths && request.display.resolvedPaths.length > 0) {
    const preview = request.display.resolvedPaths.slice(0, 3).join(", ");
    const suffix =
      request.display.resolvedPaths.length > 3
        ? ` (+${request.display.resolvedPaths.length - 3})`
        : "";
    lines.push(`${chalk.dim("路径:")}  ${preview}${suffix}`);
  }

  if (request.operationClass) {
    lines.push(
      `${chalk.dim("影响:")}  ${formatOperationClass(request.operationClass)}`,
    );
  }

  if (request.decision?.riskLevel) {
    lines.push(`${chalk.dim("风险:")}  ${formatRiskLevel(request.decision.riskLevel)}`);
  }

  if (request.decision?.reason) {
    lines.push(`${chalk.dim("原因:")}  ${request.decision.reason}`);
  }

  if (request.suggestion?.suggest) {
    const { displayName } = getAgentIdentity();
    lines.push("");
    lines.push(
      `${chalk.green("💡 提示")} ${chalk.dim(`${displayName} 已经批准过 ${request.suggestion.count} 次相似操作`)}`,
    );
  }

  return lines;
}

// ─── body renderer 辅助 ───

function renderBody(body: DisplayBody): string[] {
  switch (body.kind) {
    case "bash":
      return [`${chalk.gray("$")} ${chalk.cyan(body.commandPreview)}`];

    case "file-write":
      return [
        `${chalk.gray("写入")} ${chalk.cyan(body.path)}`,
        ...(body.preview ? [chalk.dim(truncate(body.preview, 200))] : []),
      ];

    case "file-edit":
      return [`${chalk.gray("编辑")} ${chalk.cyan(body.path)}`];

    case "file-read":
      return [`${chalk.gray("读取")} ${chalk.cyan(body.path)}`];

    case "network":
      return [
        `${chalk.gray("网络")} ${chalk.cyan(body.host)} ${chalk.dim(`(${body.direction})`)}`,
      ];

    case "messaging":
      return [
        `${chalk.gray("消息 →")} ${chalk.cyan(body.recipient)}`,
        `  ${truncate(body.content, 120)}`,
      ];

    case "calendar":
      return [
        `${chalk.gray("日程:")} ${chalk.cyan(body.title)}`,
        ...(body.invitees.length > 0
          ? [chalk.dim(`邀请: ${body.invitees.join(", ")}`)]
          : []),
      ];

    case "generic":
      return [body.summary];
  }
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 1)}…`;
}

function formatOperationClass(cls: OperationClass): string {
  switch (cls) {
    case "observe":
      return chalk.green("observe");
    case "internal":
      return chalk.green("internal");
    case "external":
      return chalk.yellow("external");
    case "critical":
      return chalk.red("critical");
  }
}

function formatRiskLevel(level: string): string {
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
      return level;
  }
}
