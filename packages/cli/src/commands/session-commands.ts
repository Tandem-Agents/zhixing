/**
 * session 域命令注册 —— 对话生命周期 + 模式切换的模块化原子注册（范式同
 * registerInfoCommands）。
 *
 * 分发在本地、执行体在核心宿主:全部读写经 ConversationController(组合会话 /
 * 场景 facade 与当前对话指针),cli 不再持有任何窗口 / store 实例。
 *
 *   - registerSessionCommands：/new /clear /resume /name /compact（对话生命周期）。
 *   - registerModeCommands：/work /exit（模式切换）。依赖 applyModeSwitch（模式切换
 *     唯一执行点）+ active mode / in-flight turn，与对话生命周期 deps 不相交。
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
} from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";
import { layout } from "../tui/style.js";
import { renderHistoryTail } from "../history-tail.js";
import type { ConversationController } from "../runtime/conversation-controller.js";
import { formatRelativeTime } from "./format.js";

export interface SessionCommandsDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly writer: CliWriter;
  /** 会话控制器——当前对话指针 + 宿主执行体调用的单一入口。 */
  readonly controller: ConversationController;
  /** 对话切换成功后通知 cli UI 层刷新（如 TaskTail）。 */
  readonly onConversationChanged: () => void | Promise<void>;
  /**
   * 本接入面主动发起 /clear 前的标记钩子。宿主会把 cleared 组播回发起端,
   * repl 用该标记区分"本地命令自己的回声"与"其他接入面清空当前对话"。
   */
  readonly markLocalClear?: (
    conversationId: string,
  ) => (outcome: "success" | "failed") => void;
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
  const { registry, dispatcher, writer, controller } = deps;

  // ── /new ──
  registry.register({
    id: "new:repl",
    name: "new",
    description: "创建新对话",
    category: "session",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("new:repl", async () => {
    try {
      const created = await controller.newConversation();
      await deps.onConversationChanged();
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
    // 清空是事件而非销毁:宿主先盘(transcript clear 事件 + meta 视图层清理)
    // 后窗(活跃窗口归零),busy 时拒绝。
    const target = controller.current.conversationId;
    const settleLocalClear = deps.markLocalClear?.(target);
    try {
      await controller.clear();
    } catch (err) {
      settleLocalClear?.("failed");
      writer.line(
        chalk.red(
          `\n  清空失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
      return {};
    }
    settleLocalClear?.("success");
    await deps.onConversationChanged();
    if (deps.clearScreenToInitial) {
      deps.clearScreenToInitial();
    } else {
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
    const input = argRest(ctx).trim();
    if (!input) {
      const conversations = await controller.listConversations();
      if (conversations.length === 0) {
        writer.line(chalk.dim("\n  没有可切换的对话\n"));
        return {};
      }
      writer.line(`\n${chalk.bold("  可用对话：")}`);
      for (const c of conversations.slice(0, 15)) {
        const label = c.name ? chalk.white(c.name) : chalk.dim(c.conversationId);
        const time = formatRelativeTime(new Date(c.lastActiveAt));
        const current =
          c.conversationId === controller.current.conversationId
            ? chalk.green(" ← 当前")
            : "";
        writer.line(`  ${label} ${chalk.dim(`(${time})`)}${current}`);
      }
      writer.line(chalk.dim(`\n  使用 /resume <名称或 id> 切换\n`));
      return {};
    }
    if (input === controller.current.conversationId) {
      writer.line(chalk.dim("\n  已在当前对话中\n"));
      return {};
    }

    const conversations = await controller.listConversations();

    // 按 ID 精确匹配,其次唯一名称模糊匹配
    let target: { id: string; name: string } | null = null;
    const byId = conversations.find((c) => c.conversationId === input);
    if (byId) target = { id: byId.conversationId, name: byId.name };

    if (!target) {
      const lowerInput = input.toLowerCase();
      const matches = conversations.filter((c) =>
        c.name.toLowerCase().includes(lowerInput),
      );
      if (matches.length === 1) {
        target = {
          id: matches[0]!.conversationId,
          name: matches[0]!.name,
        };
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
    if (target.id === controller.current.conversationId) {
      writer.line(chalk.dim("\n  已在当前对话中\n"));
      return {};
    }

    try {
      const resumed = await controller.resume(target.id);
      await deps.onConversationChanged();
      writer.line(chalk.dim(`\n  已切换到 ${chalk.cyan(resumed.name)}\n`));
      // 历史尾巴:切换即见最近几轮变暗摘录(与启动恢复同款"回到工位"展示,
      // 清空边界由宿主倒读原语保证——刚清空的对话零输出)
      renderHistoryTail({
        runs: (await controller.history(target.id)).runs.map((r) => r.record),
        writer,
      });
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
    const name = argRest(ctx).trim();
    if (!name) {
      writer.line(chalk.yellow(`${layout.contentPrefix}用法: /name <名称>\n`));
      return {};
    }
    try {
      await controller.rename(name);
      writer.line(chalk.dim(`${layout.contentPrefix}会话已命名为: ${name}\n`));
    } catch (err) {
      writer.line(
        chalk.red(
          `${layout.contentPrefix}命名失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    }
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
    writer.line(chalk.yellow("\n  ⟳ 正在压缩上下文..."));
    try {
      const result = await controller.compact();
      if (result.modified) {
        // 降级知情:地板兜底时先呈现方式与代价,再报结果——有损截断
        // 不伪装成正常摘要(与自动路径 emergency_floor 渲染同语义)
        if (result.emergencyFloor) {
          writer.line(
            chalk.yellow(
              `  ⚠ 摘要服务不可用（${result.emergencyFloor.error}），已应急保留最近对话，较早的 ${result.emergencyFloor.droppedTurns} 轮已截断（完整原文在对话历史中）`,
            ),
          );
        }
        const before = result.tokensBefore;
        const after = result.tokensAfter;
        const tokensText =
          before !== undefined && after !== undefined
            ? `${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens`
            : "窗口已折叠";
        writer.line(chalk.green(`  ✓ 压缩完成，${tokensText}\n`));
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
 * /resume 的对话选择器 —— async-enum arg，调用时经 RPC 列表生成候选。inline 删除
 * 只声明能力（驱动 Ctrl+D UI）；物理删除 + active 切换编排由 cli 交互层
 * onCandidateDelete 承担，此处不执行。
 */
function buildResumeArgSchema(deps: SessionCommandsDeps): ArgSchema {
  const provider: ArgChoiceProvider = {
    async list(
      ctx: ArgQueryContext,
      signal: AbortSignal,
    ): Promise<readonly ArgChoice[]> {
      const conversations = await deps.controller.listConversations();
      if (signal.aborted) return [];

      const query = ctx.query.toLowerCase();
      const choices: ArgChoice[] = [];
      for (const c of conversations.slice(0, 15)) {
        if (
          query &&
          !c.name.toLowerCase().includes(query) &&
          !c.conversationId.toLowerCase().includes(query)
        ) {
          continue;
        }
        const time = formatRelativeTime(new Date(c.lastActiveAt));
        const current =
          c.conversationId === deps.controller.current.conversationId
            ? " ← 当前"
            : "";
        choices.push({
          value: c.conversationId,
          label: c.name || c.conversationId,
          description: `${time}${current}`,
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
  /** 模式切换唯一执行点（先 await in-flight turn 到 turn 边界，再切换）。 */
  readonly applyModeSwitch: (intent: WorkModeSwitchIntent) => Promise<void>;
  /** 当前活跃模式 —— 模式切换会变，以 getter 注入按调用时读。仅读 kind 判别。 */
  readonly getActiveMode: () => { readonly kind: string };
  /** 当前 in-flight turn promise（turn idle 时 null）—— 切换前先 await 到 turn 边界。 */
  readonly getActiveTurnPromise: () => Promise<unknown> | null;
  /** 工作场景候选(经 RPC) —— /work 选择器列候选、命令解析 idOrName。 */
  readonly listScenes: () => Promise<
    readonly { sceneId: string; name: string; workdir?: string }[]
  >;
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
    const scenes = await deps.listScenes();
    let sceneId: string | null = scenes.find((s) => s.sceneId === q)?.sceneId ?? null;
    if (!sceneId) {
      const lower = q.toLowerCase();
      const named = scenes.filter((s) => s.name.toLowerCase().includes(lower));
      if (named.length === 1) sceneId = named[0]!.sceneId;
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
    // 命令可能在 turn 运行中输入：先 await in-flight turn 到达 turn 边界。
    const turn = deps.getActiveTurnPromise();
    if (turn) await turn.catch(() => {});
    await deps.applyModeSwitch({ kind: "enter", sceneId });
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
      await deps.applyModeSwitch({ kind: "exit" });
      return {};
    }
    // 主对话中：维持原语义——走 rl.close() 让 close 监听器统一执行完整 cleanup。
    deps.rl.close();
    return {};
  });
}

/**
 * /work 的工作场景选择器 —— async-enum arg，调用时经 RPC 列候选。
 * inline 删除 / 改名 / 新建只声明能力；物理删除走交互层 onCandidateDelete，改名 / 新建走
 * 主循环消费 inline-edit-request。
 */
function buildWorkSceneArgSchema(deps: ModeCommandsDeps): ArgSchema {
  const provider: ArgChoiceProvider = {
    async list(
      ctx: ArgQueryContext,
      signal: AbortSignal,
    ): Promise<readonly ArgChoice[]> {
      const scenes = await deps.listScenes();
      if (signal.aborted) return [];

      const query = ctx.query.toLowerCase();
      const choices: ArgChoice[] = [];
      for (const s of scenes) {
        if (
          query &&
          !s.name.toLowerCase().includes(query) &&
          !s.sceneId.toLowerCase().includes(query)
        ) {
          continue;
        }
        const wd = s.workdir ? ` · ${s.workdir}` : "";
        choices.push({
          value: s.sceneId,
          label: s.name || s.sceneId,
          description: `${s.sceneId}${wd}`,
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
