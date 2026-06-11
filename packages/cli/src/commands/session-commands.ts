/**
 * session 域命令注册 —— 对话生命周期 + 模式切换的模块化原子注册（范式同
 * registerInfoCommands）。按依赖隔离拆成两个注册函数：
 *
 *   - registerSessionCommands：/new /clear /resume /name /compact（对话生命周期）。这些
 *     命令会**读写** active conversation 运行态，故以 `getConv()` getter 注入——模式切换
 *     会整体替换该引用，getter 在调用时解析当前对象、写其字段即写真实状态；session.runtime
 *     同理 getter；taskListService 跨 reload 单例直接注入。
 *   - registerModeCommands：/work /exit（模式切换）。依赖 applyModeSwitch（模式切换唯一
 *     执行点）+ active mode / in-flight turn，与对话生命周期 deps 不相交，故独立窄接口。
 *
 * /resume·/work 的选择器（ArgChoiceProvider）就近在本模块构造、落进 CommandDef.args；其
 * inline 删除 / 改名 / 新建只声明能力，物理执行由 cli 交互层（onCandidateDelete + 主循环
 * inline-edit）承担。
 */

import chalk from "chalk";
import {
  type ICommandRegistry,
  type CommandDispatcher,
  type CommandHandlerContext,
  type ArgChoiceProvider,
  type ArgQueryContext,
  type ArgChoice,
  type ArgSchema,
  type WorkModeSwitchIntent,
  countRuns,
} from "@zhixing/core";
import type { AgentRuntime } from "@zhixing/orchestrator/runtime";
import {
  switchToNewConversation,
  type MutableConversationState,
} from "../runtime/switch-to-new-conversation.js";
import {
  openConversationWindow,
  writeWindowSnapshot,
} from "../runtime/conversation-window.js";
import type { CliWriter } from "../screen/index.js";
import { layout } from "../tui/style.js";
import { formatRelativeTime } from "./format.js";

export interface SessionCommandsDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly writer: CliWriter;
  /** 当前活跃对话运行态 —— 模式切换会整体替换引用，以 getter 注入按调用时读最新对象。 */
  readonly getConv: () => MutableConversationState;
  /** session.runtime —— reload / 模式切换会 swap，以 getter 注入。 */
  readonly getRuntime: () => AgentRuntime;
  /** task_list 服务（process-wide 单例、跨 reload 稳定，直接注入）。 */
  readonly taskListService: {
    prime(conversationId: string): Promise<void>;
    clear(conversationId: string): void;
  };
  /** 对话切换成功后通知 cli UI 层刷新（如 TaskTail）。 */
  readonly onConversationChanged: () => void;
  /**
   * 把屏幕清回"刚进入交互模式"的初始态（chrome 终端）。/clear 清完数据后调用，
   * extraLines 承接非致命 warning 一并重建；无 chrome 时为 undefined，handler 退回到
   * 仅逐行写提示。
   */
  readonly clearScreenToInitial:
    | ((extraLines?: readonly string[]) => void)
    | undefined;
}

function argRest(ctx: CommandHandlerContext): string {
  return typeof ctx.args._rest === "string" ? ctx.args._rest : "";
}

export function registerSessionCommands(deps: SessionCommandsDeps): void {
  const { registry, dispatcher, writer } = deps;

  // ── /new ──
  registry.register({
    id: "new:repl",
    name: "new",
    description: "创建新对话",
    category: "session",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("new:repl", async (ctx) => {
    const name = argRest(ctx).trim() || undefined;
    try {
      const created = await switchToNewConversation(
        deps.getConv(),
        { runtime: deps.getRuntime() },
        deps.taskListService,
        { name, notify: deps.onConversationChanged },
      );
      writer.line(chalk.dim(`\n  已创建新对话 ${chalk.cyan(created.name)}\n`));
    } catch (err) {
      writer.line(
        chalk.red(
          `\n  创建对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    }
    return {};
  });

  // ── /clear ──
  registry.register({
    id: "clear:repl",
    name: "clear",
    description: "清空对话历史",
    category: "session",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("clear:repl", async () => {
    const conv = deps.getConv();
    // 清空是事件而非销毁：持久层追加一条 clear 记录（倒读原语遇之即止——重启
    // 重建只见其后内容；旧原文物理仍在，由时间窗清理收走），窗口 reset 清空内存。
    // 先盘后窗：持久化失败窗口不动，内存与磁盘停在同一基底。
    if (conv.conversationId) {
      try {
        await conv.store.appendClear(conv.conversationId);
      } catch (err) {
        writer.line(
          chalk.red(
            `\n  清空失败: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        return {};
      }
    }
    conv.window.reset("clear");
    conv.pendingInputPrefix = null;

    // 非致命 warning 收集到本地数组，末尾按 clearScreenToInitial 是否可用分流：chrome
    // 路径（rebuild 会清 scroll region）把 warnings 作为 extraLines 一并注入重建内容避免
    // 丢失；legacy 路径（无 rebuild）逐行输出。数组元素是不含 \n 的单行内容。
    const warnings: string[] = [];

    // 视图层组件通过 Resettable 注册到 runtime；这里一并清空它们的对话级状态。顺序：先
    // 磁盘清，后视图层 reset —— 失败时内存 messages 仍是 canonical 安全态。
    try {
      await deps.getRuntime().resetConversationState();
    } catch (err) {
      warnings.push(
        chalk.yellow(
          `  视图层部分组件 reset 失败（不影响对话清空）: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    // 清空 conversation meta 的视图层状态（task_list / 段切换历史）——/clear 是"重置对话
    // 内容到新起点"，conversation 身份字段保留不动。
    if (conv.conversationId) {
      try {
        await conv.convRepo.clearViewLayerState(conv.conversationId);
      } catch (err) {
        warnings.push(
          chalk.yellow(
            `  conversation meta 视图层字段清空失败（不影响对话清空）: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      // task_list service cache 同步清空 —— 磁盘端已由 clearViewLayerState 处理。service
      // 不实现 Resettable（process-wide 跨 conversation），由本路径显式 clear 维护一致性。
      deps.taskListService.clear(conv.conversationId);
    }
    conv.turnCounter = 0;

    // /clear 既是 conversation 数据重置、也是注意力窗口换代 —— 开新窗触发
    // onWindowClose(clear)→onWindowOpen(clear),更新实例权威 prompt（重建 skill
    // 索引等数据驱动段）。失败仅 warn,不阻断清空。
    try {
      await deps.getRuntime().onAttentionWindowChange("clear");
    } catch (err) {
      warnings.push(
        chalk.yellow(
          `  注意力窗口重建失败（不影响对话清空）: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    if (deps.clearScreenToInitial) {
      deps.clearScreenToInitial(warnings);
    } else {
      for (const w of warnings) writer.line(w);
      writer.line(chalk.dim(`${layout.contentPrefix}对话历史已清空\n`));
    }
    return {};
  });

  // ── /resume ──
  registry.register({
    id: "resume:repl",
    name: "resume",
    description: "切换到其他对话",
    category: "session",
    execution: "local",
    tag: "builtin",
    args: [buildResumeArgSchema(deps)],
  });
  dispatcher.registerHandler("resume:repl", async (ctx) => {
    const conv = deps.getConv();
    const input = argRest(ctx).trim();
    if (!input) {
      const conversations = await conv.convRepo.list();
      if (conversations.length === 0) {
        writer.line(chalk.dim("\n  没有可切换的对话\n"));
        return {};
      }
      writer.line(`\n${chalk.bold("  可用对话：")}`);
      for (let i = 0; i < Math.min(conversations.length, 15); i++) {
        const c = conversations[i]!;
        const label = c.name ? chalk.white(c.name) : chalk.dim(c.id);
        const time = formatRelativeTime(new Date(c.lastActiveAt));
        const turnCount = await countRuns(conv.store, c.id);
        const current =
          c.id === conv.conversationId ? chalk.green(" ← 当前") : "";
        writer.line(
          `  ${label} ${chalk.dim(`(${time}, ${turnCount} 轮)`)}${current}`,
        );
      }
      writer.line(chalk.dim(`\n  使用 /resume <名称或 id> 切换\n`));
      return {};
    }
    if (input === conv.conversationId) {
      writer.line(chalk.dim("\n  已在当前对话中\n"));
      return {};
    }

    const conversations = await conv.convRepo.list();

    // 按 ID 精确匹配
    let target: { id: string; name: string } | null = null;
    const matched = await conv.convRepo.get(input);
    if (matched) target = { id: matched.id, name: matched.name };

    // 按名称模糊匹配
    if (!target) {
      const lowerInput = input.toLowerCase();
      const matches = conversations.filter((c) =>
        c.name.toLowerCase().includes(lowerInput),
      );
      if (matches.length === 1) {
        target = { id: matches[0]!.id, name: matches[0]!.name };
      } else if (matches.length > 1) {
        writer.line(`\n${chalk.bold("  多个匹配：")}`);
        for (const c of matches.slice(0, 10)) {
          const time = formatRelativeTime(new Date(c.lastActiveAt));
          writer.line(`  ${chalk.white(c.name)} ${chalk.dim(`(${time})`)}`);
        }
        writer.line(chalk.dim(`\n  请使用更精确的名称或 id\n`));
        return {};
      }
    }

    if (!target) {
      writer.line(chalk.red(`\n  对话 "${input}" 不存在\n`));
      return {};
    }
    if (target.id === conv.conversationId) {
      writer.line(chalk.dim("\n  已在当前对话中\n"));
      return {};
    }

    try {
      const opened = await openConversationWindow({
        store: conv.store,
        snapshots: conv.snapshots,
        conversationId: target.id,
        model: deps.getRuntime().model,
      });
      conv.window = opened.window;
      conv.pendingInputPrefix = null;
      conv.conversationId = target.id;
      conv.turnCounter = opened.turnCount;
      // 加载目标对话的 task_list 持久化状态到 service cache
      await deps.taskListService.prime(target.id);
      conv.convRepo.touch(conv.conversationId).catch(() => {});
      // 切换对话 = 注意力窗口换代（与 /new、/clear 同纪律）：先清 runtime 内
      // 对话级组件状态，再触发 onWindowClose(resume)→onWindowOpen(resume)
      // 重建实例权威 prompt。两步都非致命——失败不阻塞切换。
      try {
        await deps.getRuntime().resetConversationState();
      } catch {
        /* 非致命：视图层组件 reset 失败不阻塞切换 */
      }
      try {
        await deps.getRuntime().onAttentionWindowChange("resume");
      } catch {
        /* 非致命：窗口重建失败不阻塞切换，下个 run 仍用当前 prompt */
      }
      deps.onConversationChanged();
      writer.line(
        chalk.dim(
          `\n  已切换到 ${chalk.cyan(target.name)}（${opened.turnCount} 轮对话）\n`,
        ),
      );
    } catch (err) {
      writer.line(
        chalk.red(
          `\n  加载对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    }
    return {};
  });

  // ── /name ──
  registry.register({
    id: "name:repl",
    name: "name",
    description: "为当前会话命名",
    category: "session",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("name:repl", async (ctx) => {
    const conv = deps.getConv();
    const name = argRest(ctx).trim();
    if (!name) {
      writer.line(chalk.yellow(`${layout.contentPrefix}用法: /name <名称>\n`));
      return {};
    }
    if (!conv.conversationId) {
      writer.line(chalk.yellow(`${layout.contentPrefix}当前会话尚未保存\n`));
      return {};
    }
    await conv.convRepo.rename(conv.conversationId, name);
    writer.line(chalk.dim(`${layout.contentPrefix}会话已命名为: ${name}\n`));
    return {};
  });

  // ── /compact ──
  registry.register({
    id: "compact:repl",
    name: "compact",
    description: "手动触发上下文压缩",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("compact:repl", async () => {
    const conv = deps.getConv();
    if (conv.window.getMessages().length < 4) {
      writer.line(chalk.dim("\n  对话历史过短，无需压缩\n"));
      return {};
    }
    writer.line(chalk.yellow("\n  ⟳ 正在压缩上下文..."));
    try {
      const result = await deps
        .getRuntime()
        .forceCompact([...conv.window.getMessages()], conv.turnCounter);
      // 压缩是注意力窗口的视图操作：产生真 summary 时折叠窗口；原文持久化
      // append-only、不参与压缩（被摘内容仍完整躺在磁盘上）。非摘要型修改
      //（无 marker）不动窗口——窗口只经折叠 / 接受前进。
      if (result.modified && result.windowCompact) {
        const outcome = conv.window.applyCompact(result.windowCompact);
        // 手动压缩与 run 接受同一快照出口：折叠交出覆盖锚且携结构化摘要
        // 时落盘（fire-and-forget，失败 helper 内 warn）
        if (conv.conversationId) {
          void writeWindowSnapshot(
            conv.snapshots,
            conv.conversationId,
            result.windowCompact,
            outcome,
          );
        }
        // run 外手动压缩 = 注意力窗口换代（与 /clear、/resume 同纪律）——
        // 触发 onWindowClose(compact)→onWindowOpen(compact) 重建实例权威
        // prompt。失败非致命，不影响已完成的折叠。
        try {
          await deps.getRuntime().onAttentionWindowChange("compact");
        } catch {
          /* 非致命：窗口重建失败不阻塞压缩结果 */
        }
        // 降级知情：地板兜底时先呈现方式与代价，再报结果——有损截断
        // 不伪装成正常摘要（与自动路径 emergency_floor 渲染同语义）
        if (result.emergencyFloor) {
          writer.line(
            chalk.yellow(
              `  ⚠ 摘要服务不可用（${result.emergencyFloor.error}），已应急保留最近对话，较早的 ${result.emergencyFloor.droppedTurns} 轮已截断（完整原文在对话历史中）`,
            ),
          );
        }
        const pct = Math.round(result.budget.usageRatio * 100);
        writer.line(chalk.green(`  ✓ 压缩完成，当前上下文占用 ${pct}%\n`));
      } else if (result.modified) {
        writer.line(chalk.dim("  压缩未产生摘要，窗口未变\n"));
      } else {
        writer.line(chalk.dim("  已无可压缩内容\n"));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writer.line(chalk.red(`  ✗ 压缩失败: ${msg}\n`));
    }
    return {};
  });
}

/**
 * /resume 的对话选择器 —— async-enum arg，调用时查 convRepo.list() 生成候选。inline 删除
 * 只声明能力（驱动 Ctrl+D UI）；物理删除 + active 切换编排由 cli 交互层 onCandidateDelete
 * 承担，此处不执行。
 */
function buildResumeArgSchema(deps: SessionCommandsDeps): ArgSchema {
  const provider: ArgChoiceProvider = {
    async list(
      ctx: ArgQueryContext,
      signal: AbortSignal,
    ): Promise<readonly ArgChoice[]> {
      const conv = deps.getConv();
      const conversations = await conv.convRepo.list();
      if (signal.aborted) return [];

      const query = ctx.query.toLowerCase();
      const choices: ArgChoice[] = [];
      for (const c of conversations.slice(0, 15)) {
        if (
          query &&
          !c.name.toLowerCase().includes(query) &&
          !c.id.toLowerCase().includes(query)
        ) {
          continue;
        }
        const time = formatRelativeTime(new Date(c.lastActiveAt));
        const turnCount = await countRuns(conv.store, c.id);
        const current = c.id === conv.conversationId ? " ← 当前" : "";
        choices.push({
          value: c.id,
          label: c.name || c.id,
          description: `${time}, ${turnCount} 轮${current}`,
        });
      }
      return choices;
    },
    mode: "picker",
    inlineActions: { delete: true },
  };

  return {
    kind: "async-enum",
    name: "conversation",
    description: "目标对话名称或 ID",
    required: true,
    provider,
  };
}

export interface ModeCommandsDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly writer: CliWriter;
  /** 模式切换唯一执行点（先 await in-flight turn 到 turn 边界，再 swap runtime/conv）。 */
  readonly applyModeSwitch: (
    intent: WorkModeSwitchIntent,
    source: "llm" | "command",
  ) => Promise<void>;
  /** 当前活跃模式 —— 模式切换会变，以 getter 注入按调用时读。仅读 kind 判别。 */
  readonly getActiveMode: () => { readonly kind: string };
  /** 当前 in-flight turn promise（turn idle 时 null）—— 切换前先 await 到 turn 边界。 */
  readonly getActiveTurnPromise: () => Promise<unknown> | null;
  /** 工作场景注册表 —— /work 选择器列候选、命令解析 idOrName。 */
  readonly workSceneRegistry: {
    list(): Promise<readonly { id: string; name: string; workdir?: string }[]>;
  };
  /** readline —— 主对话 /exit 走 rl.close() 触发完整 cleanup。 */
  readonly rl: { close(): void };
}

export function registerModeCommands(deps: ModeCommandsDeps): void {
  const { registry, dispatcher, writer } = deps;

  // ── /work ──
  registry.register({
    id: "work:repl",
    name: "work",
    description: "进入工作场景(↑↓ 选择 · Enter 进入 · Ctrl+R 改名 · Ctrl+N 新建)",
    category: "tools",
    execution: "local",
    tag: "builtin",
    args: [buildWorkSceneArgSchema(deps)],
  });
  dispatcher.registerHandler("work:repl", async (ctx) => {
    // 已在工作场景中：不重复进入（work 模式内切换到另一场景属后续需求）。
    if (deps.getActiveMode().kind !== "main") {
      writer.line(chalk.dim("\n  已在工作场景中，请先 /exit 退出\n"));
      return {};
    }
    const q = argRest(ctx).trim();
    // 空 args（手敲 /work 直接 Enter，或空场景面板内 Enter）：不进场景、不报错。列表浏览 /
    // 进入 / 改名 / 新建全部走 typeahead 二级面板，命令行不承担这些子操作。
    if (!q) {
      writer.line(chalk.dim("\n  用 ↑↓ 选场景 Enter 进入,Ctrl+N 新建\n"));
      return {};
    }
    // <idOrName> → 解析（精确 id 优先，其次唯一名称匹配，与 /resume 同款纪律）。
    const scenes = await deps.workSceneRegistry.list();
    let sceneId: string | null = scenes.find((s) => s.id === q)?.id ?? null;
    if (!sceneId) {
      const lower = q.toLowerCase();
      const named = scenes.filter((s) => s.name.toLowerCase().includes(lower));
      if (named.length === 1) sceneId = named[0]!.id;
      else if (named.length > 1) {
        writer.line(
          chalk.yellow(`\n  多个工作场景匹配 "${q}"，请用精确 id\n`),
        );
        return {};
      }
    }
    if (!sceneId) {
      writer.line(chalk.red(`\n  工作场景 "${q}" 不存在\n`));
      return {};
    }
    // 命令可能在 turn 运行中输入：先 await in-flight turn 到达 turn 边界（与 hot-reload
    // 先 await in-flight turn 的既有纪律一致）。
    const turn = deps.getActiveTurnPromise();
    if (turn) await turn.catch(() => {});
    await deps.applyModeSwitch({ kind: "enter", sceneId }, "command");
    return {};
  });

  // ── /exit ──
  registry.register({
    id: "exit:repl",
    name: "exit",
    aliases: ["quit"],
    description: "退出工作场景 / 退出知行",
    category: "session",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("exit:repl", async () => {
    // 工作场景中：/exit 语义为退出工作场景回主对话（非退出进程）。
    if (deps.getActiveMode().kind === "workscene") {
      const turn = deps.getActiveTurnPromise();
      if (turn) await turn.catch(() => {});
      await deps.applyModeSwitch({ kind: "exit" }, "command");
      return {};
    }
    // 主对话中：维持原语义——走 rl.close() 让 close 监听器统一执行完整 cleanup
    // (scheduler / deliveryStack / channels / renderer / confirmation)。
    deps.rl.close();
    return {};
  });
}

/**
 * /work 的工作场景选择器 —— async-enum arg，调用时查 workSceneRegistry.list() 生成候选。
 * inline 删除 / 改名 / 新建只声明能力；物理删除走交互层 onCandidateDelete，改名 / 新建走
 * 主循环消费 inline-edit-request。
 */
function buildWorkSceneArgSchema(deps: ModeCommandsDeps): ArgSchema {
  const provider: ArgChoiceProvider = {
    async list(
      ctx: ArgQueryContext,
      signal: AbortSignal,
    ): Promise<readonly ArgChoice[]> {
      const scenes = await deps.workSceneRegistry.list();
      if (signal.aborted) return [];

      const query = ctx.query.toLowerCase();
      const choices: ArgChoice[] = [];
      for (const s of scenes) {
        if (
          query &&
          !s.name.toLowerCase().includes(query) &&
          !s.id.toLowerCase().includes(query)
        ) {
          continue;
        }
        const wd = s.workdir ? ` · ${s.workdir}` : "";
        choices.push({
          value: s.id,
          label: s.name || s.id,
          description: `${s.id}${wd}`,
        });
      }
      return choices;
    },
    mode: "picker",
    inlineActions: { delete: true, rename: true, create: true },
    emptyHint: "暂无工作场景，Ctrl+N 新建一个",
  };

  return {
    kind: "async-enum",
    name: "scene",
    description: "目标工作场景名称或 ID",
    required: true,
    provider,
  };
}
