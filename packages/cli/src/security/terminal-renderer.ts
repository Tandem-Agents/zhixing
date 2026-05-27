/**
 * TerminalConfirmationRenderer — 把 ConfirmationBroker 接到终端 TUI
 *
 * 职责：
 *   1. 订阅 broker 的新请求通知（broker.onRequest）
 *   2. 把 ConfirmationRequest → SelectOperationRegion 的入参（title / body / options）
 *   3. 启动 SelectOperationRegion（chrome inline 面板）拿到用户的 SelectResult
 *   4. 翻译回 ConfirmationDecision 并 broker.resolve
 *
 * 与 host REPL 的共存：
 *   REPL 用 InputController（typeahead input）占据 chrome input region + 独占
 *   stdin keypress。SelectOperationRegion 也走 chrome inline + 独占 stdin。两者
 *   不能同时活跃 —— renderer 通过 beforeShow / afterShow 两个 hook 通知 host，
 *   典型实现：`() => inputController.suspend()` / `() => inputController.resume()`。
 *
 * 能力声明（`capabilities`）：
 *   - supportsInlineInput: true（SelectOperationRegion 原生支持 input 类型选项）
 *   - supportsAllowNote / supportsDenyReason: true（通过 input 选项）
 *   - supportsQueue: false（broker 顺序处理）
 *   - supportsEdit: false（编辑后允许尚未支持）
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
  RendererCapabilities,
} from "@zhixing/core";
import { tone } from "../tui/style.js";
import type { SelectOption, SelectResult } from "../tui/select-types.js";
import type { ScreenController } from "../screen/index.js";
import { SelectOperationRegion } from "./select-operation-region.js";

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
    // "edit-then-allow" Step 8 再加
    // "show-full" SelectOperationRegion 内部通过自适应截断 + 手动展开处理
  ],
  supportsAllowNote: true,
  supportsDenyReason: true,
  supportsEdit: false,
  supportsQueue: false,
  supportsInlineInput: true,
};

// ─── 构造选项 ───

export interface TerminalConfirmationRendererOptions {
  /**
   * 屏幕协调器——SelectOperationRegion 通过此协调 chrome inline 渲染。
   * 必须注入：confirmation panel 走 chrome inline 而非独立屏，缺失协调器无法工作。
   */
  screen: ScreenController;
  /** 输入流——默认 process.stdin */
  stdin?: NodeJS.ReadStream;
  /**
   * SelectOperationRegion 启动前的 hook —— host 应在此让当前 InputRegion（如 typeahead
   * input）让位。典型实现：`() => inputController.suspend()`。region 走 chrome 共享
   * stdin keypress 路径，必须由 caller 协调 input 资源切换避免双重消费。
   */
  beforeShow?: () => void | Promise<void>;
  /**
   * SelectOperationRegion 结束后的 hook —— host 应恢复 InputRegion。典型实现：
   * `() => inputController.resume()`。
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

  constructor(private readonly options: TerminalConfirmationRendererOptions) {}

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
      // host 暂停当前 InputRegion（让出 chrome 给 SelectOperationRegion）
      if (this.options.beforeShow) {
        await this.options.beforeShow();
      }

      // 构造面板入参
      const { selectOptions, optionById } = buildSelectOptions(request);
      const title = buildInlinePanelTitle(request);
      const bodyLines = buildInlinePanelBody(request);

      let result: SelectResult;
      try {
        const region = new SelectOperationRegion({
          screen: this.options.screen,
          title,
          body: bodyLines,
          options: selectOptions,
          stdin: this.options.stdin ?? process.stdin,
          signal: abort.signal,
        });
        result = await region.run();
      } finally {
        // host 恢复 InputRegion —— 无论成功或抛错都要
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
 * 把 broker 层的 ConfirmationOption 转成 SelectOption（select-types 协议）。
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
      case "show-full":
      case "edit-then-allow":
        selectOptions.push({
          type: "simple",
          value: id,
          label: augmentLabelWithWarning(opt.kind, opt.label),
          hotkey: "hotkey" in opt ? opt.hotkey : undefined,
        });
        break;

      case "allow-with-note":
      case "deny-with-reason":
        selectOptions.push({
          type: "input",
          value: id,
          label: augmentLabelWithWarning(opt.kind, opt.label),
          placeholder: opt.placeholder,
          allowEmptySubmit: true,
          hotkey: opt.hotkey,
        });
        break;
    }
  });

  return { selectOptions, optionById };
}

/**
 * 持久授权类选项加 ⚠ 警示后缀——让用户在 Critical 决策点（一次授权影响未来全部
 * 同类操作）有视觉信号区分。
 *
 * 应用范围：allow-session / allow-workspace / allow-global —— 这三类都是"创建
 * 授权规则"而非"单次放行"，错选代价大。
 *
 * 与 SelectOperationRegion 解耦：augment 发生在 buildSelectOptions（terminal-renderer
 * 即 confirmation 领域专属层），不下沉到 SelectOperationRegion 通用组件——后者
 * 保持领域无关。
 */
function augmentLabelWithWarning(
  kind: ConfirmationOption["kind"],
  label: string,
): string {
  if (
    kind === "allow-session" ||
    kind === "allow-workspace" ||
    kind === "allow-global"
  ) {
    return `${label}  ${tone.dim("⚠ 持久授权")}`;
  }
  return label;
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

// ─── 面板 title / body 构造（对话流嵌入式视觉） ───

/**
 * 构造 inline 面板的 title —— 场景化中文动词短语 + 高风险时形态警示。
 *
 * 用户视角第一性原理：用户做决策真正依赖的是"AI 想做的具体的事"（命令 / 路径
 * 等），而不是"操作类别 / 风险等级"等系统抽象分类。title 应直接告知用户 AI
 * 的意图（"AI 想执行命令"/"AI 想写入文件"），让用户视线立刻聚焦到下方的具体
 * 内容做判断。
 *
 * 风险分级靠 title **形态**承担，不引入新行：
 *   - low / medium / 无：纯文字 title（典型场景，视觉安静）
 *   - high / critical：⚠ + red bold + 风险标识尾缀（极端场景必须醒目）
 *
 *   普通：    "AI 想执行命令"
 *   高风险：  "⚠ AI 想执行命令 (高风险)"  (red bold)
 *   关键：    "⚠ AI 想执行命令 (关键操作)"  (red bold)
 */
export function buildInlinePanelTitle(request: ConfirmationRequest): string {
  const intent = formatIntent(request.display.body);
  const risk = request.decision?.riskLevel;
  if (risk === "high") {
    return tone.error.bold(`⚠ ${intent} (高风险)`);
  }
  if (risk === "critical") {
    return tone.error.bold(`⚠ ${intent} (关键操作)`);
  }
  return intent;
}

/**
 * DisplayBody 派生场景化中文意图短语 —— title 主文案。
 *
 * 设计：每个 DisplayBody.kind 有清晰对应的"AI 想做 X"短语，让用户视觉接收
 * 时立刻 grok AI 的意图类型。中文「想」表达请求语气（AI 在请你允许），与
 * 平铺直叙的「执行」/「访问」拉开 —— 让用户感受到这是个 user-facing 决策点。
 */
function formatIntent(body: DisplayBody): string {
  switch (body.kind) {
    case "bash":
      return "AI 想执行命令";
    case "file-write":
      return "AI 想写入文件";
    case "file-edit":
      return "AI 想修改文件";
    case "file-read":
      return "AI 想读取文件";
    case "network":
      return "AI 想访问网络";
    case "messaging":
      return "AI 想发送消息";
    case "calendar":
      return "AI 想创建日程";
    case "generic":
      return "AI 想做这件事";
  }
}

/**
 * 构造 inline 面板的 body 行 —— 紧凑对话流形态。
 *
 * 与旧 buildPanelBody（标签化多行）差异：
 *   旧：`影响:  external` / `风险:  medium` / `原因:  无匹配规则` 各占一行
 *   新：`外部 · 中风险 · 无匹配规则` 紧凑单行（去冗余 label）
 *
 * 行结构：
 *   1. 主体（命令 / 路径 / 网络 host 等，来自 renderBody）
 *   2. 元信息单行：`<影响> · <风险> · <原因>`（dim 渲染；缺省段省略）
 *   3. cwd 单独 dim 行（仅当存在且 body 内未隐含路径时）
 *   4. envKeys / resolvedPaths（如有，dim 单行）
 *   5. 建议（如有，提示曾批准过相似操作）
 *
 * caller (SelectOperationRegion) 会在每行起首加 4 列 indent，本函数不负责 indent。
 */
export function buildInlinePanelBody(request: ConfirmationRequest): string[] {
  const lines: string[] = [];

  // ── 1. 主体（决策唯一依据） ──
  // 用户做决策真正依赖的是命令本身/路径/URL 等具体内容——其他元信息（影响 / 风险 /
  // 原因 / cwd / env / 路径列表）对决策无增值，全部删除。风险分级靠 title 形态
  // （high/critical 时 ⚠ + red bold + 标识尾缀）承担，不占额外行
  for (const line of renderBody(request.display.body)) {
    lines.push(line);
  }

  // ── 2. 安全管家研判理由（仅 needs-confirm 经管家研判时存在） ──
  // 这不是被省略的元信息，而是 actionable 信号：管家为何把这次操作上交确认，
  // 帮用户判断是否放行
  if (request.display.stewardReason) {
    lines.push(tone.dim(`🛡 安全管家：${request.display.stewardReason}`));
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


