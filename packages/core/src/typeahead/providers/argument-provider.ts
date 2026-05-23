/**
 * ArgumentProvider —— 命令参数补全 provider
 *
 * 职责（spec §Step 8，priority=150）：
 *   1. matchTrigger: 当 draft 是 `/cmd arg...` 形态且 cursor 在参数区时触发
 *   2. query: 根据当前参数的 ArgSchema 生成候选
 *      - enum: 静态枚举值 + 前缀过滤
 *      - async-enum: 异步查询（带 AbortSignal）
 *      - 其他类型（text/path/boolean/number）：无 dropdown，仅显示 hint
 *   3. computeArgumentHint: 生成 progressive hint（显示在面板里的参数提示）
 *
 * 触发优先级 150 —— 在 CommandProvider(100) 之后、FileProvider(200) 之前。
 * 当 cursor 还在命令名上时 CommandProvider 命中；当 cursor 移到参数区后
 * CommandProvider 无法匹配（空格打断 trigger token），ArgumentProvider 接管。
 */

import { parseCommandDraft } from "../parse-command-draft.js";
import { renderFullHintLine } from "../progressive-hint.js";
import type {
  ArgChoice,
  ArgSchema,
  ArgumentHint,
  CommandDef,
  ICommandRegistry,
  InlineActionSupport,
  SuggestionItem,
  SuggestionProvider,
  TriggerContext,
  TriggerMatch,
} from "../types.js";

// ─── 选项 ───

export interface ArgumentProviderOptions {
  readonly registry: ICommandRegistry;
}

// ─── Provider Data ───

interface ArgumentProviderData {
  readonly command: CommandDef;
  readonly argIndex: number;
  readonly currentSchema: ArgSchema;
  readonly allSchemas: readonly ArgSchema[];
}

// ─── 实现 ───

export class ArgumentProvider implements SuggestionProvider {
  readonly id = "argument";
  readonly priority = 150;
  readonly supportsGhostText = false;
  readonly supportsChaining = false;

  private readonly registry: ICommandRegistry;

  constructor(options: ArgumentProviderOptions) {
    this.registry = options.registry;
  }

  // ── Trigger 检测 ──

  matchTrigger(ctx: TriggerContext): TriggerMatch | null {
    const parsed = parseCommandDraft(ctx.draft, ctx.cursor);
    if (!parsed) return null;

    // 查找命令
    const cmd = this.registry.findByName(parsed.commandName);
    if (!cmd) return null;

    // 命令必须有参数 schema
    const schemas = cmd.args;
    if (!schemas || schemas.length === 0) return null;

    // argIndex 超出 schema 范围 → 所有参数已填完
    if (parsed.argIndex >= schemas.length) return null;

    const currentSchema = schemas[parsed.argIndex]!;

    return {
      providerId: this.id,
      tokenStart: parsed.currentArgStart,
      tokenEnd: parsed.currentArgEnd,
      token: parsed.currentArgValue,
      query: parsed.currentArgValue,
      runtime: ctx.runtime,
      providerData: {
        command: cmd,
        argIndex: parsed.argIndex,
        currentSchema,
        allSchemas: schemas,
      } satisfies ArgumentProviderData,
    };
  }

  // ── Query ──

  query(
    match: TriggerMatch,
    signal: AbortSignal,
  ): SuggestionItem[] | Promise<SuggestionItem[]> {
    const data = match.providerData as ArgumentProviderData;
    const { currentSchema, command } = data;
    const query = match.query.toLowerCase();

    switch (currentSchema.kind) {
      case "enum":
        return this.queryStaticEnum(
          currentSchema.choices,
          query,
          command,
          data,
        );
      case "async-enum":
        return this.queryAsyncEnum(match, signal, data);
      case "boolean":
        return this.queryStaticEnum(
          [
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ],
          query,
          command,
          data,
        );
      // text / path / number —— 无 dropdown 候选，仅靠 hint 引导
      default:
        return [];
    }
  }

  // ── Argument Hint ──

  /**
   * 计算当前参数的 progressive hint。
   * broker 在 setLoadingFinished 时调用（和 computeGhostText 同模式）。
   */
  computeArgumentHint(match: TriggerMatch): ArgumentHint | null {
    const data = match.providerData as ArgumentProviderData | undefined;
    if (!data) return null;

    return {
      argIndex: data.argIndex,
      renderedHint: renderFullHintLine(data.allSchemas, data.argIndex),
      currentArg: data.currentSchema,
      emptyHint:
        data.currentSchema.kind === "async-enum"
          ? data.currentSchema.provider.emptyHint
          : undefined,
    };
  }

  // ── Inline actions ──

  /**
   * 当前 trigger 的候选列表支持哪些 inline 操作。仅 async-enum schema 透传其
   * provider 静态声明的 `inlineActions`;enum/text/path/boolean/number 等 schema
   * 类型概念上无"候选条目就地操作"语义,返回空集。
   */
  computeInlineActions(match: TriggerMatch): InlineActionSupport {
    const data = match.providerData as ArgumentProviderData | undefined;
    if (!data || data.currentSchema.kind !== "async-enum") return {};
    return data.currentSchema.provider.inlineActions ?? {};
  }

  // ── 静态枚举 ──

  private queryStaticEnum(
    choices: readonly ArgChoice[],
    query: string,
    command: CommandDef,
    data: ArgumentProviderData,
  ): SuggestionItem[] {
    const items: SuggestionItem[] = [];

    for (const choice of choices) {
      const value = typeof choice === "string" ? choice : choice.value;
      const label = typeof choice === "string" ? choice : choice.label;
      const description =
        typeof choice === "string" ? undefined : choice.description;

      // 前缀过滤
      if (query && !value.toLowerCase().startsWith(query)) continue;

      // 是否是最后一个（或最后一个 required）参数 → 决定 execute
      const isLastArg = data.argIndex >= data.allSchemas.length - 1;
      const hasMoreRequired = data.allSchemas
        .slice(data.argIndex + 1)
        .some((s) => s.required);

      items.push({
        id: `arg:${command.id}:${data.currentSchema.name}:${value}`,
        providerId: this.id,
        displayText: label,
        description,
        acceptPayload: {
          replacement: isLastArg || !hasMoreRequired ? value : `${value} `,
          execute: isLastArg || !hasMoreRequired,
          metadata: {
            commandId: command.id,
            argName: data.currentSchema.name,
            argValue: value,
          },
        },
      });
    }

    return items;
  }

  // ── 异步枚举 ──

  private async queryAsyncEnum(
    match: TriggerMatch,
    signal: AbortSignal,
    data: ArgumentProviderData,
  ): Promise<SuggestionItem[]> {
    const schema = data.currentSchema;
    if (schema.kind !== "async-enum") return [];

    const choices = await schema.provider.list(
      {
        query: match.query,
        command: data.command,
        argIndex: data.argIndex,
        runtime: match.runtime,
      },
      signal,
    );

    if (signal.aborted) return [];

    const items: SuggestionItem[] = [];
    const isLastArg = data.argIndex >= data.allSchemas.length - 1;
    const hasMoreRequired = data.allSchemas
      .slice(data.argIndex + 1)
      .some((s) => s.required);

    for (const choice of choices) {
      const value = typeof choice === "string" ? choice : choice.value;
      const label = typeof choice === "string" ? choice : choice.label;
      const description =
        typeof choice === "string" ? undefined : choice.description;

      items.push({
        id: `arg:${data.command.id}:${data.currentSchema.name}:${value}`,
        providerId: this.id,
        displayText: label,
        description,
        acceptPayload: {
          replacement: isLastArg || !hasMoreRequired ? value : `${value} `,
          execute: isLastArg || !hasMoreRequired,
          metadata: {
            commandId: data.command.id,
            argName: data.currentSchema.name,
            argValue: value,
          },
        },
      });
    }

    return items;
  }
}
