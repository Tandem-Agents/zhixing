/**
 * REPL 交互模式 —— 核心宿主的终端接入面。
 *
 * 会话状态的唯一权威在核心宿主(窗口 / turnCounter / 持久化 / runtime 全在
 * 宿主侧);本回路是纯 UI:读输入 → session.send → 主通道 delta 喂渲染 →
 * complete 落定 → 回到输入。命令分发在本地,执行体经 RPC 在宿主。
 *
 * 流程：
 * 1. ensure 核心宿主(不在则拉起)→ auto-resume 最近对话(经 session.list)
 * 2. readline / typeahead 获取用户输入
 * 3. 斜杠命令本地分发、宿主执行
 * 4. 否则 sendTurn:发送 + 等待 complete(delta 流随通知实时渲染)
 * 5. turn 边界消费模式切换意图(宿主定向通知)
 * 6. 回到步骤 2
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import {
  CommandProvider,
  FileProvider,
  ArgumentProvider,
  DefaultCommandRegistry,
  DefaultTypeaheadBroker,
  UsageTracker,
  type RuntimeContext,
  type DispatchResult,
  createEventBus,
  type SchedulerEventMap,
  CommandDispatcher,
} from "@zhixing/core";
import { loadCredentials, resolveHomeDir } from "@zhixing/providers";
import { TaskTail } from "./task-tail/index.js";
import { TaskListViewCache } from "./runtime/task-list-view.js";
import { registerTaskCommands } from "./commands/task-commands.js";
import { registerInfoCommands } from "./commands/info-commands.js";
import {
  registerSessionCommands,
  registerModeCommands,
} from "./commands/session-commands.js";
import { registerConfigCommands } from "./commands/config-commands.js";
import { SkillCommandSource } from "./commands/skill-command-source.js";
import { FEATURE_CHROME } from "./commands/command-visibility.js";
import { registerSkillsCommand } from "./skills/manager-command.js";
import { PASTE_TOKEN_PATTERN, PasteRegistry } from "./paste-registry.js";
import { resolveFileRefs } from "./resolve-file-refs.js";
import { renderError, createRenderSubscribers } from "./render.js";
import { renderHistoryTail } from "./history-tail.js";
import { createOutputRenderer, getLlmChunkDump } from "./output/index.js";
import {
  createScreenController,
  createScreenWriter,
  createStdoutWriter,
  type CliWriter,
  type ScreenController,
} from "./screen/index.js";
import { detectTerminalCapability } from "./screen/terminal-capability.js";
import { layout } from "./tui/style.js";
import { InlineTextPromptRegion } from "./tui/inline-text-prompt.js";
import { InputController } from "./typeahead-input.js";
import { BottomInfoModel } from "./bottom-info/index.js";
import { renderHomeWelcome } from "./workbench/index.js";
import { renderFarewell } from "./farewell/index.js";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
  type CoreHostLifecycleNotice,
} from "./runtime/core-host-connection.js";
import { RpcSchedulerFacade } from "./runtime/rpc-scheduler-facade.js";
import { RpcConversationFacade } from "./runtime/rpc-conversation-facade.js";
import { RpcWorksceneFacade } from "./runtime/rpc-workscene-facade.js";
import {
  RpcManagementFacade,
  type ServerInfoResult,
} from "./runtime/rpc-management-facade.js";
import { RpcEventBus } from "./runtime/rpc-event-bus.js";
import { RpcConfirmationBroker } from "./runtime/rpc-confirmation-broker.js";
import { createObservedTurnPresenter } from "./runtime/observed-turn-presenter.js";
import {
  ConversationController,
  selectInitialConversation,
  type ActiveConversation,
} from "./runtime/conversation-controller.js";
import { createCandidateDeleteHandler } from "./runtime/candidate-delete-controller.js";
import { ReplLocalView } from "./runtime/repl-local-view.js";
import { TerminalConfirmationRenderer } from "./security/index.js";
import { createReplInterruptRuntime } from "./interrupt/repl-runtime.js";
import { renderReadOnlyConversationBrowser } from "./runtime/read-only-conversation-browser.js";

// ─── REPL 状态 ───

/**
 * REPL 的接入面状态——会话事实(窗口 / turnCounter / 持久化)全在宿主,
 * 此处只剩 UI 态:当前对话指针(controller 持有)、turn 进行标志、
 * 启动期诊断快照。
 */
interface ReplState {
  running: boolean;
  /**
   * 当前 in-flight turn promise——turn idle 时为 null。模式切换命令在
   * 执行前 await 它(切换天然落在 turn 边界)。
   */
  activeTurnPromise: Promise<unknown> | null;
}

async function waitForReloadStatus(
  management: RpcManagementFacade,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ServerInfoResult | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;

  let lastInfo: ServerInfoResult | null = null;
  do {
    lastInfo = await management.serverInfo().catch(() => null);
    const channels = lastInfo?.channels ?? [];
    if (channels.every((s) => s.state !== "connecting")) return lastInfo;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);

  return lastInfo;
}

function renderCoreHostLifecycleNotice(
  writer: CliWriter,
  notice: CoreHostLifecycleNotice,
): void {
  if (notice.kind === "reconnected") {
    writer.line(
      chalk.yellow(
        `${layout.contentPrefix}核心宿主连接已恢复，当前会话会重新订阅。`,
      ),
    );
    return;
  }
  if (notice.kind === "host-replaced") {
    writer.line(
      chalk.yellow(
        `${layout.contentPrefix}核心宿主已换代完成，当前会话会继续使用新宿主。`,
      ),
    );
    return;
  }
  const suffix =
    notice.connectionCount === undefined
      ? "活跃接入面数量暂不可确认，已保守保持旧宿主运行。"
      : `还有 ${Math.max(0, notice.connectionCount - 1)} 个其它接入面在线，稍后会自动换代。`;
  writer.line(
    chalk.yellow(
      `${layout.contentPrefix}核心宿主版本待更新：当前 ${notice.serverVersion}，cli ${notice.clientVersion}；${suffix}`,
    ),
  );
}

async function ensureCoreHostWithReadOnlyFallback(
  coreHost: CoreHostConnection,
  writer: CliWriter,
): Promise<boolean> {
  let lastError: unknown;
  while (true) {
    try {
      await coreHost.ensure();
      if (lastError !== undefined) {
        writer.line(chalk.green(`${layout.contentPrefix}核心宿主已恢复，继续进入对话。`));
      }
      return true;
    } catch (err) {
      lastError = err;
      await renderReadOnlyConversationBrowser({ writer, error: err });
      if (!process.stdin.isTTY) return false;

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      try {
        const answer = (
          await rl.question(
            chalk.green(`${layout.contentPrefix}宿主不可用，按 Enter 重试，输入 q 退出：`),
          )
        )
          .trim()
          .toLowerCase();
        if (answer === "q" || answer === "quit" || answer === "exit") {
          return false;
        }
      } finally {
        rl.close();
      }
      writer.line("");
    }
  }
}

// ─── REPL 启动语义 ───
//
// 启动期不承载用户功能参数;"对话选择"维度统一由 REPL 内
// 的 `/new` `/resume` `/name` 命令承担,启动期不再有 `--continue`/`--resume`/`--name`
// 这类与 REPL 命令同语义的双轨入口,工作区等受保护配置也进入交互内修改。
// 启动行为:经宿主 `session.list` 取最近 user 域候选,逐个 `resumeIfExists`
// 校验（防 list/resume 之间被其它接入面删除的竞态）;无可恢复 main 对话则
// 经 `session.new` 新建。用户想切换到其它对话或新建,进入 REPL 后用
// `/resume` / `/new`。

// ─── bracketed paste mode 设置 ───

/**
 * 全局启用 bracketed paste mode：进入 REPL 前一次性启用，process exit 时 reset。
 *
 * Paste 检测不依赖 bracketed paste mode markers——typeahead-input / SelectOperationRegion /
 * typeahead-panel 各自用 keypress batcher（time-window）识别"同步多次 keypress = 粘贴"，
 * 跨终端兼容性好。本函数只发送 `\x1b[?2004h` 抑制 Windows Terminal 等的"多行粘贴
 * 警告"弹窗——是用户体验改进，与 paste 检测算法解耦。
 *
 * `process.on("exit")` 是同步钩子，stdout.write 同步刷出；正常 exit / 信号触发的
 * exit 都会调用，保证 bracketed paste mode 不残留到 shell。
 */
function setupBracketedPasteMode(): void {
  // 启用 bracketed paste mode 主要是抑制 Windows Terminal 等终端默认的"多行粘贴
  // 警告"弹窗——paste 检测本身用 keypress batcher（不依赖 markers）。退出时 reset。
  // allow-direct-stdout: 终端模式控制 ANSI 序列，非文字输出，不经 chrome 协调
  process.stdout.write("\x1b[?2004h");
  process.on("exit", () => {
    // allow-direct-stdout: process.exit 同步钩子，chrome 已 dispose
    process.stdout.write("\x1b[?2004l");
  });
}

// ─── 启动 REPL ───

export async function startRepl(): Promise<void> {
  // 在 ScreenController 接管 stdout 之前预热 chunk-dump singleton——若 --log 启用，
  // dump 创建时会经 stderr 写一行启用提示（"[zhixing] LLM raw chunk dump enabled →
  // <path>"）。chrome 接管后 stderr 写入会破坏 frame；提前到 chrome 启动前让提示落在
  // 终端的启动期 banner 阶段，与 shell prompt 自然衔接。后续 attachChunkDumpToBus 内的
  // getLlmChunkDump() 复用 cached handle，不再触发 stderr。
  //
  // 启用状态由 index.ts action 入口 `configureLlmChunkDump(options.log)` 设置，
  // 此处仅触发 cached 实例化（NOOP / 真实由 configure 决定）。
  getLlmChunkDump();

  // 启用 bracketed paste mode + 初始化 paste detector：
  //   detector 注册 stdin "data" listener 必须早于 readline 启用 keypress——同步广
  //   播按 listener 注册顺序执行，detector 先 setInPasteMode，下游 onKeypress 才能
  //   短路 ignore
  //   退出时通过 process.on("exit") reset，否则用户回 shell 后粘贴看到 ESC[200~
  //   等原始字节
  setupBracketedPasteMode();

  // 粘贴附件 registry——REPL session 级，多轮 readInputLine 共享。
  // commit 后 buffer.draft 含占位符进 history ring buffer；用户按 ↑ 浏览历史时
  // 占位符仍可 expand。session 退出时随 startRepl scope 自然 GC，无需显式 clearAll。
  const pasteRegistry = new PasteRegistry();

  // 终端能力探测——DECSTBM 三区模型要求 TTY 直连 + 现代终端基线。检测失败时
  // fail-fast 降级到 stdout 直写模式（无 chrome），保留基础对话能力
  const capability = detectTerminalCapability();
  let renderScreen: ScreenController | null = null;
  let cliWriter: CliWriter;
  if (capability.ok) {
    // 屏幕协调器——cli REPL session 级，所有写入屏幕的逻辑（AI 输出 / status-bar /
    // scheduler 通知 / retry-compact-interrupt 等）必须经此协调，让输入区 chrome
    // 永驻屏底不被推走。在 typeahead 模式下绑定 input controller；其他模式下
    // 仅协调 status / scroll。
    renderScreen = createScreenController({ capability: capability.capability });
    cliWriter = createScreenWriter({ screen: renderScreen });

    // 异常退出兜底：SIGTERM / 父进程 kill / 未捕获异常等不走 main loop 的退出
    // 路径，正常 dispose 不被调用 → DECSTBM 残留 + chrome 字节残留 → shell 接管
    // 后 \n 行为受 region 限制 + 屏底残留 zhixing chrome 与 shell prompt 重叠。
    // process.on("exit") 是同步钩子，dispose 内 ScrollRegion.shutdown 同步 emit
    // `\x1b[r\x1b[2J\x1b[1;1H` 能在退出前刷出。
    //
    // 与正常路径幂等：main loop break 后 renderScreen.dispose() 已撤 DECSTBM + 整屏清；
    // 此处 listener 触发时 disposed=true，dispose 提前 return（library 层幂等保证）。
    //
    // 与 setupBracketedPasteMode 内的 process.on("exit") 形成"终端模式 reset 钩子族"
    // 语义对称：bracketed paste / DECSTBM 都是终端模式残留物，统一在退出钩子卸载。
    // Node.js exit 事件除 SIGKILL 外都触发，业界都不防御 SIGKILL。
    process.on("exit", () => {
      renderScreen?.dispose();
    });
  } else {
    // 终端不支持 region 模式（管道 / 重定向 / dumb / 旧 Windows 等）——直写
    // stdout 退化模式。无 chrome、无 input box、无 segment 双态渲染；仅基础
    // 对话输出可用。caller 通过 typeaheadMode = "legacy" 自动适配为 rl.question 路径。
    // allow-direct-stdout: chrome 未建立、cliWriter 还未创建、必须直写 stderr 通知用户
    process.stderr.write(
      `\x1b[33mzhixing: 终端能力探测降级 (${capability.reason})——使用基础对话模式\x1b[0m\n`,
    );
    cliWriter = createStdoutWriter();
  }

  // renderer 接收 cliWriter，所有 AI 输出（text/thinking/tool 卡片）经 writer 协调。
  const renderer = createOutputRenderer({ writer: cliWriter });

  // schedulerEventBus 作为渲染中转——REPL 订阅它渲染任务通知。cli 无本地 scheduler，
  // 事件来自下面 schedulerFacade.onEvent 经 RPC 订阅核心宿主后桥接到此 bus。
  const schedulerEventBus = createEventBus<SchedulerEventMap>();

  // 核心宿主连接 —— cli 进程级唯一(连接即接入面身份单位):调度 / 会话 / 确认 /
  // 管理域经各自 facade 共用这一条已认证连接;释放在退出链(本入口持有)。
  const coreHost = new CoreHostConnection({
    ...defaultCoreHostConnectionDeps(),
    onLifecycleNotice: (notice) =>
      renderCoreHostLifecycleNotice(cliWriter, notice),
  });

  // 各方法域门面——facade 不持连接,只做方法域封装。
  const schedulerFacade = new RpcSchedulerFacade({ connection: coreHost });
  const conversationFacade = new RpcConversationFacade(coreHost);
  const worksceneFacade = new RpcWorksceneFacade(coreHost);
  const managementFacade = new RpcManagementFacade(coreHost);

  const credentials = loadCredentials({ homeDir: resolveHomeDir() });
  void credentials;

  // 会话本身在宿主执行——宿主必须在场,启动即 ensure(不在则拉起)。
  // 拉起 / 连接 / 协议失败时进入只读事实面，不启动任何会话写路径。
  const startupFallbackWriter = renderScreen ? createStdoutWriter() : cliWriter;
  if (!(await ensureCoreHostWithReadOnlyFallback(coreHost, startupFallbackWriter))) {
    renderScreen?.dispose();
    process.exit(1);
  }

  // 本地派生视图——配置显示 / 代理诊断 / workspace root 随宿主换代刷新。
  const localView = new ReplLocalView({ management: managementFacade });
  await localView.refresh();

  // ── 当前对话指针:auto-resume 最近可恢复的一条(session.list 新→旧),无则新建 ──
  const { active: initialActive, resumedConversationName } =
    await selectInitialConversation(conversationFacade);

  let controller: ConversationController;
  const observedTurnPresenter = createObservedTurnPresenter({
    writer: cliWriter,
    flushOutput: () => renderer.stop(),
    isLocalTurn: (turn) => controller.isLocalTurn(turn),
  });

  // 会话控制器——当前对话指针 + turn 编排(send → delta 喂渲染 → complete)。
  controller = new ConversationController(
    {
      conversation: conversationFacade,
      workscene: worksceneFacade,
      onYield: (e) => renderer.handleEvent(e),
      onObservedTurnDelta: (turn) =>
        observedTurnPresenter.onObservedTurnDelta(turn),
      onObservedTurnComplete: (turn) =>
        observedTurnPresenter.onObservedTurnComplete(turn),
    },
    initialActive,
  );
  await controller.start();

  // 带外通道——宿主 per-run bus 的 UI 订阅集事件经信封还原为本地投影 bus,
  // createRenderSubscribers(retry / segment / interrupt / status-bar)零改挂接。
  // "只投当前对话"是接入面 UI 态,经 filter 注入。
  const renderSubscribers = createRenderSubscribers({
    renderer,
    writer: cliWriter,
    screen: renderScreen ?? undefined,
  });
  const rpcEventBus = new RpcEventBus({
    link: coreHost,
    decorate: (ctx) => {
      const disposeObserved = observedTurnPresenter.decorateRunBus(ctx);
      const disposeRender = renderSubscribers(ctx);
      return () => {
        disposeRender();
        disposeObserved();
      };
    },
    filter: (envelope) =>
      envelope.conversationId === controller.current.conversationId,
    onListenerError: (err) =>
      cliWriter.notify(
        chalk.yellow(
          `  ⚠ 渲染订阅异常: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ),
  });

  // 初始 region 内容(欢迎块)单一来源——启动时逐行写入 + resize-end / clear
  // 整屏重建复用同一生成逻辑。模型 / provider 显示取本地配置(宿主按同一
  // 配置装配);workspace 取宿主解析值;会话名取当前对话指针,避免 /new /
  // /resume / 工作场景切换后重建出启动时的旧会话身份。
  const initialRegionLines = (): string[] => {
    const lines: string[] = [];
    lines.push(
      ...renderHomeWelcome({
        providerId: localView.config.llm?.main?.provider ?? "",
        model: localView.config.llm?.main?.model ?? "",
        workspaceRoot: localView.workspaceRoot ?? undefined,
        conversationName: controller.current.name,
      }),
    );
    lines.push("");
    return lines;
  };
  for (const line of initialRegionLines()) cliWriter.line(line);

  // 历史尾巴 —— "回到工位"的用户侧一半:恢复对话时渲染最近几轮变暗摘录,
  // 经 RPC 倒读宿主落盘事实流。新对话无历史跳过;读失败静默(纯增益展示)。
  if (resumedConversationName !== null) {
    try {
      renderHistoryTail({
        runs: (
          await controller.history(controller.current.conversationId)
        ).runs.map((r) => r.record),
        writer: cliWriter,
      });
    } catch {
      // 尾巴是纯增益展示,绝不因它阻塞启动
    }
  }

  // 清屏回到刚进入交互模式的初始态 —— `/clear` 在清完数据后调用。chrome 终端
  // 走 renderScreen.rebuildAfterResize(整屏清 + scrollback 全清 + chrome 自适应
  // 重画 + region 内容重写,与 firstAttach 同源序列),复用 initialRegionLines
  // 单一来源避免视觉漂移;extraLines 承接 handler 收集的非致命 warning,与
  // initialRegionLines + cleared notice 一起作为 region 内容重建,可观测性
  // 不丢失。legacy 终端无 renderScreen,本闭包为 undefined,handler 退回到
  // 逐行写 warning + 一行提示。
  const clearScreenToInitial:
    | ((extraLines?: readonly string[]) => void)
    | undefined = renderScreen
    ? (extraLines) => {
        const clearedNotice = `${layout.contentPrefix}${chalk.dim(
          "⟳ 对话已清空 · 可以从这里开始新一轮",
        )}`;
        renderScreen.rebuildAfterResize(() =>
          [...initialRegionLines(), ...(extraLines ?? []), clearedNotice]
            .map((l) => `${l}\n`)
            .join(""),
        );
      }
    : undefined;

  // chrome 模式（capability.ok）下主输入走 InputController，rl 仅作退出生命
  // 周期钩子，不需要 terminal 能力。terminal:true 会让 readline 自监听 resize
  // 并 _refreshLine 重画（裸 > prompt）绕过 ScreenController → 冲突碎裂（已由
  // 排除实验证实）。legacy 模式（capability 探测失败）走 rl.question，需要
  // terminal 行编辑能力，保持 true。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !capability.ok,
  });

  // 挂载终端确认渲染器到会话 broker。渲染器生命周期绑到 REPL 退出：rl.on("close") 里 detach。
  //
  // 共存协议（chrome inline SelectOperationRegion）：
  //   - SelectOperationRegion 通过 ScreenController.attachInput 接入 chrome inline，
  //     与 InputController（typeahead input）同 InputRegion 接口、共享 stdin keypress
  //     路径。两者不能同时活跃（stdin raw mode + keypress listener 必须独占）。
  //   - beforeShow 调 inputController.suspend()：让 typeahead 输入区 detach + 释放
  //     keypress / raw mode 资源，让 SelectOperationRegion 接管 chrome 区域
  //   - afterShow 调 inputController.resume()：SelectOperationRegion 结束并 detach 后
  //     重新 attach typeahead 输入区，chrome 切回输入模式
  //
  // 不再走 alt-screen 切换（ScreenController.suspend/resume）——权限请求面板与对话流
  // 共存让 scrollback 始终可见，提升上下文连贯性。config-editor 是另一类全屏 modal，
  // 但它自管 alt-screen + 光标（startup 期无 ScreenController 也要能独立运行），退出后
  // 经 ScreenController.reassertCursorHidden() 重申光标隐藏不变量——不走 suspend/resume，
  // 故该协议目前无调用方（作为"真正委托 ScreenController 接管整屏"的 modal 原语保留）。
  //
  // **NB**: inputController 在闭包内通过 let 引用（声明在下方）—— beforeShow/afterShow
  // 在 confirmation 实际触发时才求值，那时 inputController 已 start()，可选链兜底 null。
  const confirmationRenderer = renderScreen
    ? new TerminalConfirmationRenderer({
        screen: renderScreen,
        beforeShow: () => {
          inputController?.suspend();
        },
        afterShow: () => {
          inputController?.resume();
        },
      })
    : null;
  // 确认链路:宿主 Bridge 推 pending(可信连接附完整请求投影)→ RPC broker
  // 还原 → 终端面板零改挂接;应答经 confirmation.resolve 回程,失败可观测。
  const rpcConfirmationBroker = new RpcConfirmationBroker({
    link: coreHost,
    onResolveError: (err, requestId) =>
      cliWriter.notify(
        chalk.red(
          `  ✗ 确认应答未送达(${requestId}): ${err instanceof Error ? err.message : String(err)}`,
        ),
      ),
  });
  const detachConfirmation = confirmationRenderer
    ? confirmationRenderer.attach(rpcConfirmationBroker)
    : null;

  const state: ReplState = {
    running: false,
    activeTurnPromise: null,
  };

  // TaskTail 在 useTypeahead 分支内装配（需要 ScreenController）。声明在外层让
  // /new / /resume handler 通过 onConversationChanged 闭包延迟引用 —— 命令 handler
  // 触发时 TaskTail 早已创建完毕，无装配时序问题。
  let taskTail: TaskTail | null = null;

  // task_list 只读视图缓存——宿主权威快照 + 会话级变更组播共同喂入。
  // 发起端的命令写入/切换路径走 RPC 读回执保证即时一致性;旁观端实时性
  // 仍由 session.changed(taskList) 广播补齐。
  const taskListView = new TaskListViewCache();
  const locallyDeletingConversations = new Set<string>();
  const locallyClearingConversations = new Set<string>();
  const syncTaskListView = async (conversationId: string): Promise<void> => {
    try {
      const result = await conversationFacade.taskList(conversationId);
      taskListView.apply(conversationId, result.taskList);
    } catch {
      // task_list 是辅助视图,宿主读失败时隐藏而不阻断主对话。
      taskListView.apply(conversationId, null);
    }
  };
  const syncCurrentTaskListView = async (): Promise<void> => {
    await syncTaskListView(controller.current.conversationId);
    taskTail?.refresh();
  };
  coreHost.onLifecycleNotice(async (notice) => {
    if (notice.kind === "version-pending") return;
    if (notice.kind === "reconnected" && notice.reason === "manual-reconnect") return;
    await controller.reattachActiveObserver();
    await syncCurrentTaskListView();
  });
  conversationFacade.onChanged((p) => {
    if (p.change === "taskList") {
      taskListView.apply(p.conversationId, p.taskList);
      return;
    }
    const reaction = controller.applySessionChanged(p);
    if (reaction.kind === "ignored") return;
    if (reaction.kind === "cleared") {
      void syncCurrentTaskListView();
      if (locallyClearingConversations.has(p.conversationId)) return;
      const notice = `${layout.contentPrefix}${chalk.yellow(
        "⚠ 当前对话已在其他接入面清空，已刷新视图。",
      )}`;
      if (clearScreenToInitial) {
        clearScreenToInitial([notice]);
      } else {
        cliWriter.line(chalk.yellow("\n  当前对话已在其他接入面清空，已刷新视图\n"));
      }
      return;
    }
    if (reaction.kind === "deleted") {
      if (locallyDeletingConversations.has(p.conversationId)) return;
      void (async () => {
        cliWriter.line(
          chalk.yellow("\n  当前对话已在其他接入面删除，已切换到新对话\n"),
        );
        try {
          await controller.newConversation();
          await syncCurrentTaskListView();
        } catch (err) {
          cliWriter.line(
            chalk.red(
              `\n  新建空对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
        }
      })();
    }
  });
  await syncTaskListView(controller.current.conversationId);

  // main 对话指针的最近值——退出场景时切回。进入场景前快照当前 main 指针,
  // 多次进出始终回到"进场景前所在的 main 对话"。
  let mainReturnTarget: ActiveConversation = initialActive;

  /**
   * 模式切换唯一执行点 —— turn 边界消费(LLM 意图经宿主定向通知 / /work·/exit
   * 命令)。宿主侧场景对话取建是原子的(workscene.enter),接入面只切指针——
   * cli 侧无事务、无 undo 栈;失败即不切,当前对话原样。
   *
   * 触发句语义:LLM 在 main 对话里产生 enter 意图时,场景新对话的首轮输入
   * 由用户自己给出——切换横幅后输入区即场景对话,用户的下一句话就是首轮。
   */
  const applyModeSwitch = async (
    intent: { kind: "enter"; sceneId: string } | { kind: "exit" },
  ): Promise<void> => {
    const sepWidth = Math.max(38, (process.stdout.columns ?? 80) - 3);
    const sep = "─".repeat(sepWidth);

    if (intent.kind === "enter") {
      if (controller.current.mode.kind !== "main") {
        cliWriter.line(chalk.dim("\n  已在工作场景中，请先 /exit 退出\n"));
        return;
      }
      mainReturnTarget = controller.current;
      let entered: ActiveConversation;
      try {
        entered = await controller.enterScene(intent.sceneId);
      } catch (err) {
        cliWriter.line(
          chalk.red(
            `\n  进入工作场景失败：${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        return;
      }
      const sceneName =
        entered.mode.kind === "workscene" ? entered.mode.sceneName : intent.sceneId;
      cliWriter.line(
        chalk.dim(
          `\n  ${sep}\n  已进入工作场景 ${chalk.cyan(sceneName)}\n  ${sep}\n`,
        ),
      );
      // 历史尾巴:场景对话的"回到工位"展示(auto-resume 该场景最近对话由宿主
      // enter 保证);新场景对话无历史零输出。
      try {
        renderHistoryTail({
          runs: (await controller.history(entered.conversationId)).runs.map(
            (r) => r.record,
          ),
          writer: cliWriter,
        });
      } catch {
        // 历史尾巴是辅助展示,失败不阻断进入
      }
      await syncCurrentTaskListView();
      return;
    }

    // intent.kind === "exit"
    if (controller.current.mode.kind !== "workscene") {
      cliWriter.line(chalk.dim("\n  当前不在工作场景中\n"));
      return;
    }
    // 退出 = 宿主 touch + 指针切回 main。场景实例的收尾(末窗记忆 flush)随
    // 宿主实例生命周期(grace 到期 dispose)自行发生,不在接入面。
    const exitResult = await controller.exitScene(mainReturnTarget);
    mainReturnTarget = controller.current;
    const exitMessage =
      exitResult.kind === "returned"
        ? "已退出工作场景，回到主对话"
        : exitResult.kind === "fallback-latest"
          ? `已退出工作场景；原主对话已不存在，已切换到最近主对话 ${chalk.cyan(exitResult.active.name)}`
          : exitResult.kind === "fallback-new"
            ? `已退出工作场景；原主对话已不存在，已创建新主对话 ${chalk.cyan(exitResult.active.name)}`
            : "当前不在工作场景中";
    cliWriter.line(
      chalk.dim(`\n  ${sep}\n  ${exitMessage}\n  ${sep}\n`),
    );
    await syncCurrentTaskListView();
  };

  // ── 命令系统装配 ──
  //
  // 命令层（registry 真相源 + dispatcher 执行器 + 全部注册）无条件构建、与终端能力
  // 无关；其上的输入交互层才依 chrome 分叉：feature flag ZHIXING_INPUT_TYPEAHEAD
  // （默认 "on"）与终端 chrome 能力都满足时走 typeahead 持久输入区 + 补全，否则
  // （显式 legacy / 无 chrome）回退到 rl.question 行编辑。
  //
  // 命令由各域 registerXxxCommands 模块（info / session / mode / config / task / skill）
  // 原子注册进 registry + dispatcher，动态 /<name> 技能由 SkillCommandSource 投影；registry
  // 是唯一真相源，/help 与补全都读 registry.list(ctx)。核心命令 execution 统一 "local"，
  // 不把本地动作泄露给 agent loop（否则 agent 不知 runtime 真实状态、会凭训练记忆瞎编）。
  const typeaheadMode = (process.env.ZHIXING_INPUT_TYPEAHEAD ?? "on").toLowerCase();
  // capability 探测失败时强制走 legacy `rl.question` 路径——typeahead 持久输入区
  // 依赖 ScreenController 的 chrome 模式，无 chrome 终端（管道 / 重定向 / dumb）下
  // typeahead 视觉环境缺失，启用会让 InputController 内部 fallback 创建 silent
  // ScreenController 写 raw ANSI 到不支持的下游
  const useTypeahead =
    typeaheadMode !== "legacy" &&
    typeaheadMode !== "off" &&
    capability.ok;

  // ── 命令层（无条件构建，与终端能力无关）──
  // registry 是命令的单一真相源、dispatcher 是统一执行器，任何模式恒在；其上的
  // 交互层（补全 broker + 渲染）才依 chrome 分叉。
  const tRegistry = new DefaultCommandRegistry();
  const typeaheadDispatcher = new CommandDispatcher({ registry: tRegistry });

  // info 域命令（help/status/me/model/usage/context/journal/people/tasks）。
  // 运行时信息(model / usage / context)的权威在宿主——经管理面 RPC 取。
  registerInfoCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    getConfig: () => localView.config,
    controller,
    getNetworkProxy: () => localView.networkProxy,
    getScheduler: () => schedulerFacade,
    management: managementFacade,
  });

  // session 域命令（new/clear/resume/name/compact）—— 分发在此、执行体在宿主,
  // controller 持当前对话指针。/resume 的对话选择器在模块内构造;inline 删除的
  // 物理执行由下方交互层 onCandidateDelete 承担。
  registerSessionCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    controller,
    onConversationChanged: syncCurrentTaskListView,
    markLocalClear: (conversationId) => {
      locallyClearingConversations.add(conversationId);
      return (outcome) => {
        if (outcome === "failed") {
          locallyClearingConversations.delete(conversationId);
          return;
        }
        setTimeout(
          () => locallyClearingConversations.delete(conversationId),
          1000,
        ).unref?.();
      };
    },
    clearScreenToInitial,
  });

  // 模式切换命令（work/exit）—— applyModeSwitch 是模式切换唯一执行点;
  // 场景候选经 RPC 取。
  registerModeCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    applyModeSwitch,
    getActiveMode: () => controller.current.mode,
    getActiveTurnPromise: () => state.activeTurnPromise,
    listScenes: () => worksceneFacade.list(),
    rl,
  });

  // config 域命令（config/mcp/trust/security）—— 编辑器留本地 TTY,落盘后经
  // 宿主换代生效;/trust 经管理面 RPC。
  registerConfigCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    rl,
    renderer,
    screen: renderScreen,
    getActiveTurnPromise: () => state.activeTurnPromise,
    management: managementFacade,
    getConversationId: () => controller.current.conversationId,
    requestHostReload: async () => {
      // 配置热重载 = 宿主换代:请求优雅退出(flush 落盘)→ 重新 ensure 拉起
      // 新宿主(按新配置装配)。重连后刷新本地派生视图并重挂当前会话 observer。
      await managementFacade.serverShutdown("config-reload").catch(() => {});
      await coreHost.reconnect();
      const reloadStatus = await waitForReloadStatus(managementFacade);
      await localView.refresh();
      await controller.reattachActiveObserver();
      await syncCurrentTaskListView();
      return reloadStatus ? { channels: reloadStatus.channels } : undefined;
    },
  });

  // task_list cli 命令组 —— 读为宿主推送的只读视图缓存,写经宿主执行体。
  registerTaskCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    service: taskListView,
    update: async (conversationId, action) => {
      const result = await conversationFacade.taskListUpdate(
        conversationId,
        action,
      );
      taskListView.apply(conversationId, result.taskList);
      taskTail?.refresh();
      return result;
    },
    getConversationId: () => controller.current.conversationId,
    writer: cliWriter,
  });

  // /skills 技能管理器（alt-screen）—— 技能库读写经管理面 RPC 在宿主执行,
  // 管理器消费的 store 窄面由 facade 适配(管理器自身零改)。
  registerSkillsCommand({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    rl,
    renderer,
    screen: renderScreen,
    writer: cliWriter,
    skillStore: {
      listForManagement: async () =>
        (await managementFacade.skillList()).skills as never,
      setState: (id, patch) => managementFacade.skillSetState(id, patch),
      archive: (id) => managementFacade.skillArchive(id),
    },
    refreshCommands: () => tRegistry.refresh(),
  });

  // 技能 /<name> 动态唤醒 —— 把技能库投影成 execution:"agent" 命令,候选经
  // skill.list RPC 取;宿主写后广播 skill.changed,补全候选随之刷新(代替
  // 旧的 run 收尾版本轮询比对)。
  tRegistry.registerDynamicSource(
    new SkillCommandSource({
      listAll: async () => (await managementFacade.skillList()).skills as never,
      findExisting: (name) => tRegistry.findByName(name),
    }),
  );
  managementFacade.onSkillChanged(() => {
    void tRegistry.refresh();
  });
  await tRegistry.refresh();

  // ── 交互层（依 chrome）：补全 broker + providers + 屏幕底部任务区 ──
  // 有 chrome 走 typeahead 补全；无 chrome / 显式 legacy 不构建（输入走 rl.question）。
  let typeaheadBroker: DefaultTypeaheadBroker | null = null;
  if (useTypeahead) {
    const usageTracker = new UsageTracker({ rootDir: null });
    typeaheadBroker = new DefaultTypeaheadBroker({
      now: () => Date.now(),
      // 粘贴占位符 token 作 word 边界 —— trigger 反向扫不跨过占位符；用户在 `/file `
      // 后粘贴长文件路径时，占位符整段不进 trigger query，typeahead 自然退出。
      wordTerminators: [PASTE_TOKEN_PATTERN],
    });
    typeaheadBroker.register(
      new CommandProvider({ registry: tRegistry, usageTracker }),
    );
    typeaheadBroker.register(new ArgumentProvider({ registry: tRegistry }));
    typeaheadBroker.register(
      new FileProvider({
        // @ 补全 root 取宿主解析的 workspace——任何目录运行效果一致
        root: () => localView.workspaceRoot ?? process.cwd(),
      }),
    );

    // 屏幕底部任务区 —— 订阅视图缓存变化驱动 setStatusTail，仅 chrome 终端需要。
    if (renderScreen) {
      taskTail = new TaskTail({
        screen: renderScreen,
        service: taskListView,
        getConversationId: () => controller.current.conversationId,
      });
      taskTail.start();
    }
  }

  const getRuntime = (): RuntimeContext => ({
    sessionBusy: state.running,
    workspaceId: localView.workspaceRoot,
    cwd: process.cwd(),
    target: "cli",
    // chrome 能力进 features:需要 alt-screen 的命令(config/mcp/skills)据此被
    // visibility 过滤——非 TTY / 管道(capability.ok=false)下补全与 /help 不列出。
    features: { [FEATURE_CHROME]: capability.ok },
    now: Date.now(),
  });

  // typeahead 候选删除 callback —— Ctrl+D 二次按下时触发。物理删除全部经
  // RPC 在宿主执行;删的是当前对话则自动新建空对话切换。
  const onCandidateDelete = createCandidateDeleteHandler({
    controller,
    workscene: worksceneFacade,
    management: managementFacade,
    writer: cliWriter,
    locallyDeletingConversations,
    syncCurrentTaskListView,
  });

  // 持久输入区——typeahead 模式下绑定 renderScreen（与 renderer / EventBus 渲染共用同一
  // 屏幕协调器），inputController 长生命周期持有 buffer / chrome / panel / paste，turn 间不
  // cleanup；主循环每轮 await inputController.waitOnce() 拿下次用户输入。
  let inputController: InputController | null = null;
  if (useTypeahead && typeaheadBroker) {
    // 底部信息行内容容器(来源无关)。本期唯一来源是 InputController 自身
    // (输入态 → "esc 清空");未来其他来源(系统事件等)持本引用 set 即可。
    const bottomInfo = new BottomInfoModel();
    inputController = new InputController({
      broker: typeaheadBroker,
      dispatcher: typeaheadDispatcher,
      getRuntime,
      screen: renderScreen ?? undefined,
      placeholder: "输入消息或 / 查看命令",
      registry: pasteRegistry,
      onCandidateDelete,
      bottomInfo,
    });
    inputController.start();

    // resize 结束后整屏重建（A 方案）：拖拽过程中 ScreenController 不画
    // （internal-only，无残留），resize 防抖稳定后一次性 \x1b[2J 清屏（保留
    // scrollback）→ 重画欢迎块（initialRegionLines 单一来源）+ 自适应 chrome。
    // 代价：屏内未滚出对话视觉刷新（早滚出的在 scrollback 可滚看、全量在磁盘，
    // 已与用户对齐）。renderScreen 为 null（legacy 无 chrome）则不订阅。
    if (renderScreen) {
      // resize-end 重建内容 = 纯净 initialRegionLines()（启动共享的单一来源，
      // 不污染）+ 一行 resize 提示（仅 resize 场景，在消费点装饰）。提示用
      // layout.contentPrefix 左缩进对齐全局 + dim 低调，不抢欢迎块；紧跟
      // initialRegionLines 末尾自带的空行之后，欢迎块 box 与提示天然分隔。
      // 已知边界：极窄终端下该行显示宽度可能 > columns-1 被终端软 wrap（region
      // 内容、无下游精细依赖，下次 resize 又整屏重建，影响可忽略，不额外 clamp
      // 以免过度设计）。
      const resizeNotice = `${layout.contentPrefix}${chalk.dim(
        "⟳ 已适配新窗口 · 历史对话未丢失（磁盘已存），可继续正常使用",
      )}`;
      renderScreen.onResizeEnd(() => {
        renderScreen?.rebuildAfterResize(() =>
          [...initialRegionLines(), resizeNotice]
            .map((l) => `${l}\n`)
            .join(""),
        );
      });
    }
  }

  // close 监听器 + 主循环的协作信号：
  //
  // 异步 cleanup 监听器（下方）会跑 dispose / "再见 👋" / process.exit，含 await
  // 可能挂起多个 tick；期间 /exit 等命令的 handler 已 resolve，主循环若 continue
  // 进入下一轮 readInputLine 会渲染新 box，与"再见 👋"输出视觉重叠。
  //
  // 同步监听器立即设 flag，主循环顶部检查 flag 直接 break——不渲染新 box；
  // 异步 cleanup 沿原 timeline 跑完，最终 process.exit。两个监听器按注册顺序
  // 同步触发（同步部分），共同表达"REPL 正在关闭"的协作语义。
  let replShuttingDown = false;
  rl.on("close", () => {
    replShuttingDown = true;
  });

  rl.on("close", async () => {
    renderer.stop();
    // UI 订阅先撤(tail / 确认面板 / 带外投影 / 会话订阅),再断连接——
    // 避免连接关闭期间残留事件触发已无效的渲染。
    taskTail?.dispose();
    detachConfirmation?.();
    rpcConfirmationBroker.dispose();
    rpcEventBus.dispose();
    controller.dispose();
    // 核心宿主连接最后释放（各域 facade 共用,须等全部消费者停止）——断开后宿主
    // 失去本接入面,是否退场由宿主自己的 idle 判定决定。
    await coreHost.dispose().catch((err) =>
      cliWriter.line(`[coreHost.dispose] ${err instanceof Error ? err.message : String(err)}`),
    );
    cliWriter.line(chalk.dim("\n再见 👋"));
    process.exit(0);
  });

  // ── Scheduler 事件 → 终端渲染 ──
  //
  // 任务结果通过 EventBus 通知 REPL，在当前 readline prompt 之上插入通知行。
  // scheduler 通知任意时刻可能触发（含 LLM 流式输出中），走 cliWriter.notify
  // 表达"异步通知"语义——底层经 frame buffer 协调，chrome 不被推走。
  const writeScheduledNotice = (text: string): void => {
    cliWriter.notify(text);
  };
  // 经门面订阅核心宿主任务事件，桥回 schedulerEventBus 复用下面的终端渲染。
  // RPC 事件模型 completed 含 ok/error，拆回本地 task-completed / task-failed；
  // started 终端无渲染需求，不桥（避免只发不收的空事件 + 失真的占位字段）。
  schedulerFacade.onEvent((e) => {
    if (e.kind === "completed" && e.status === "ok") {
      void schedulerEventBus.emit("scheduler:task-completed", {
        taskId: e.taskId,
        name: e.name,
        durationMs: e.durationMs ?? 0,
        summary: e.summary,
      });
    } else if (e.kind === "completed") {
      void schedulerEventBus.emit("scheduler:task-failed", {
        taskId: e.taskId,
        name: e.name,
        error: e.error ?? "Unknown error",
        consecutiveErrors: e.consecutiveErrors ?? 0,
        nextRunAt: e.nextRunAt,
      });
    } else if (e.kind === "disabled") {
      void schedulerEventBus.emit("scheduler:task-disabled", {
        taskId: e.taskId,
        name: e.name,
        reason: e.reason ?? "",
        lastError: e.lastError,
      });
    }
  });
  schedulerEventBus.on("scheduler:task-completed", (info) => {
    writeScheduledNotice(
      chalk.green(`  ✓ 任务完成: ${info.name}`) +
      chalk.dim(` (${Math.round(info.durationMs / 1000)}s)`) +
      (info.summary ? `\n  ${chalk.dim(info.summary.slice(0, 120))}` : ""),
    );
  });
  schedulerEventBus.on("scheduler:task-failed", (info) => {
    writeScheduledNotice(
      chalk.red(`  ✗ 任务失败: ${info.name}`) +
      chalk.dim(` (连续 ${info.consecutiveErrors} 次)`) +
      `\n  ${chalk.dim(info.error.slice(0, 120))}` +
      (info.nextRunAt ? chalk.dim(`\n  下次重试: ${new Date(info.nextRunAt).toLocaleTimeString()}`) : ""),
    );
  });
  schedulerEventBus.on("scheduler:task-disabled", (info) => {
    writeScheduledNotice(
      chalk.red(`  ⊘ 任务已自动停用: ${info.name}`) +
      chalk.dim(`\n  原因: ${info.reason}`) +
      (info.lastError ? chalk.dim(`\n  最后错误: ${info.lastError.slice(0, 120)}`) : ""),
    );
  });

  // ── dispatcher 分派结果落地（两条输入路径共用）──
  //
  // typeahead 持久输入区与 legacy rl.question 都把命令交给同一个 dispatcher,再把
  // DispatchResult 喂进这里——命令执行语义单点一致。返回 `{ input }` 表示要作为 user
  // turn 发给 agent loop 的文本(agent-message / hybrid);返回 null 表示本轮已就地消化
  // (local 执行完 / 未知命令 / 缺 handler / 执行出错都打印反馈后不产生 agent turn)。
  const applyDispatchResult = (
    d: DispatchResult,
  ): { readonly input: string } | null => {
    switch (d.kind) {
      case "local-handled":
        return null;
      case "agent-message":
        return { input: d.text };
      case "hybrid":
        return { input: d.systemMessage };
      case "unknown":
        cliWriter.line(
          chalk.yellow(`${layout.contentPrefix}未知命令: /${d.commandName}`) +
            chalk.dim("  输入 /help 查看帮助\n"),
        );
        return null;
      case "missing-handler":
        cliWriter.line(
          chalk.red(
            `${layout.contentPrefix}命令缺少执行体: ${d.commandId}（内部错误，请反馈）\n`,
          ),
        );
        return null;
      case "error":
        cliWriter.line(
          chalk.red(
            `${layout.contentPrefix}命令执行失败: ${d.error.message}\n`,
          ),
        );
        return null;
    }
  };

  // REPL 主循环
  while (true) {
    // 检查 close 监听器的同步协作信号——/exit / 双击 Ctrl+C / 终端关闭等任何
    // 退出路径触发 rl.close() 后立即设此 flag，主循环 break 不再进入下一轮
    // readInputLine，避免在 cleanup 异步流程跑完前渲染新 box 与"再见 👋"重叠
    if (replShuttingDown) break;

    let input: string;

    if (useTypeahead && inputController) {
      // ── Typeahead 路径（持久输入区） ──
      // inputController 在 startRepl 顶层一次性创建并 start()，turn 间持续 active；
      // 这里仅 await 下次 submit / cancel——chrome / paste / panel 等内部状态跨 turn 持久。
      const result = await inputController.waitOnce();

      if (result.kind === "cancelled") {
        if (result.cause === "ctrl-c" || result.cause === "ctrl-d") break;
        continue;
      }

      if (result.kind === "inline-edit-request") {
        // inline 编辑(/work 面板 Ctrl+R 改名 / Ctrl+N 新建):suspend typeahead 让
        // InlineTextPromptRegion 接管键盘收一行文本,改 registry 后 resume + 刷新
        // 候选。suspend/resume 由主循环驱动(它知道此刻不在等普通输入),无死锁窗口。
        if (renderScreen) {
          const isRename = result.editKind === "rename";
          const sceneId =
            typeof result.item?.acceptPayload.metadata?.argValue === "string"
              ? result.item.acceptPayload.metadata.argValue
              : undefined;
          const prefill = isRename ? result.item?.displayText : undefined;
          inputController.suspend();
          try {
            const text = await new InlineTextPromptRegion({
              prompt: isRename ? "重命名工作场景" : "新建工作场景",
              prefill,
              placeholder: isRename ? undefined : "场景名称",
              screen: renderScreen,
            }).run();
            const name = text?.trim();
            if (name) {
              try {
                if (isRename) {
                  if (sceneId) await worksceneFacade.rename(sceneId, name);
                } else {
                  await worksceneFacade.create(name);
                }
              } catch (err) {
                cliWriter.line(
                  chalk.red(
                    `\n  ${isRename ? "重命名" : "新建"}工作场景失败: ${
                      err instanceof Error ? err.message : String(err)
                    }\n`,
                  ),
                );
              }
            }
          } finally {
            inputController.resume();
          }
        }
        continue;
      }

      if (result.kind === "command-dispatched") {
        // dispatch 已在 InputController 内完成,这里只落地结果(与 legacy 路径共用）。
        const applied = applyDispatchResult(result.dispatchResult);
        if (!applied) continue;
        input = applied.input;
      } else {
        // kind === "text"
        if (!result.text) continue;
        input = result.text;
      }
    } else {
      // ── Legacy 路径 ──
      try {
        input = await rl.question(chalk.green("❯ "));
      } catch {
        break;
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        // 命令统一交 dispatcher——与 typeahead 路径同源,所有命令在 legacy 终端也可达。
        const applied = applyDispatchResult(
          await typeaheadDispatcher.dispatch(trimmed, getRuntime()),
        );
        if (!applied) continue;
        input = applied.input;
      }
    }

    // ── 解析 @file: 引用 ──
    let resolvedInput = input.trim();
    if (resolvedInput.includes("@file:")) {
      const refResult = await resolveFileRefs(resolvedInput, {
        workspaceRoot: localView.workspaceRoot ?? process.cwd(),
      });
      resolvedInput = refResult.text;
      if (refResult.errors.length > 0) {
        for (const err of refResult.errors) {
          cliWriter.line(chalk.yellow(`  ⚠ ${err}`));
        }
      }
    }

    // 正常对话 —— send 入队宿主唯一串行点;窗口推进 / 持久化 / 自动命名 /
    // journal 维护全在宿主侧随 turn 落定发生,本回路只等 complete。
    state.running = true;
    renderer.startThinking();

    // Per-turn 装载中断协调:KeyboardSource 拦截 Esc/Ctrl+C(raw mode) +
    // SignalSource 兜底 SIGINT/SIGTERM(cooked mode / non-TTY)。打断信号
    // 触发宿主侧 abort——in-flight run 经宿主 cleanup 落定,complete 通知
    // 随之到达,本回路的等待自然结束。
    //
    // exitRequested flag 协调双击退出:第二次 Ctrl+C 只设 flag,finally 块
    // detach 后再 rl.close——避免杀掉宿主侧 cleanup 回执的接收。
    let exitRequested = false;
    const interruptRuntime = createReplInterruptRuntime({
      onDoublePress: () => {
        exitRequested = true;
      },
    });
    interruptRuntime.controller.signal.addEventListener("abort", () => {
      void controller.abort().catch(() => {});
    });

    try {
      const turnPromise = controller.sendTurn(resolvedInput);
      // 暴露给模式切换命令——切换前 await 它,天然落在 turn 边界
      state.activeTurnPromise = turnPromise;
      const outcome = await turnPromise;

      renderer.stop();
      // turn 终止反馈(耗时 / token / abort 原因)由 status-bar 经带外事件
      // 单点接管;error 终止额外渲染错误详情(宿主 wire 投影保真 name/message)。
      if (outcome.result.reason === "error") {
        renderError(
          new Error(outcome.result.error.message || outcome.result.error.name),
          cliWriter,
        );
      }

      // turn 边界:消费本轮 LLM 产生的模式切换意图(宿主定向通知,随 complete
      // 带出;命令触发走 /work·/exit handler 同源 applyModeSwitch)。
      if (outcome.modeSwitchIntent) {
        await applyModeSwitch(outcome.modeSwitchIntent);
      }
    } catch (err) {
      renderer.stop();
      renderError(err, cliWriter);
    } finally {
      // 释放 stdin keypress ownership + 卸 SIGINT/SIGTERM listener;
      // 恢复 attach 前的 raw mode 状态,让下一轮 typeahead-input / readline 正常工作。
      interruptRuntime.detach();
      state.running = false;
      state.activeTurnPromise = null;
      if (exitRequested) {
        rl.close();
      }
    }
  }

  // 循环退出后释放屏幕协调资源——typeahead path 的 Ctrl+C 由 input.waitOnce()
  // 捕获并 resolve cancelled，break 跳出循环后此处真正释放 input + screen。
  if (inputController) {
    inputController.stop();
  }

  // 退出告别块 —— 仅在有 conversationId 时显示（ephemeral 路径不显示）。
  // 必须在 renderScreen.dispose() 之前调，dispose 内 emit 时机由 ScreenController
  // 自管（清屏序列之后）。详见 ScreenController.setFarewell docstring。
  if (renderScreen) {
    renderScreen.setFarewell(
      renderFarewell({ conversationId: controller.current.conversationId }),
    );
  }

  renderScreen?.dispose();

  // 关闭 readline——typeahead 路径下 break 跳出循环后必须显式 close，否则 readline 持
  // stdin 让事件循环不空，进程不退出。Legacy 路径下 readline 已 close，幂等 no-op。
  rl.close();
}
