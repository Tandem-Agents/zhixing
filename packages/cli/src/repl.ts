/**
 * REPL 交互模式
 *
 * 基于 Node.js readline/promises 的多轮对话循环。
 *
 * 流程：
 * 1. 初始化分片 transcript store → 创建或恢复会话
 * 2. readline.question() 获取用户输入
 * 3. 如果是斜杠命令，就地处理
 * 4. 否则瞬态构造 run 输入，启动 spinner，运行 Agent Loop
 * 5. Turn 完成后追加 run record（append-only 原文）并经接受协议推进窗口
 * 6. 回到步骤 2
 */

import * as readline from "node:readline/promises";
import { access } from "node:fs/promises";
import chalk from "chalk";
import {
  userMessage,
  type Message,
  ShardedTranscriptStore,
  getZhixingHome,
  ConversationRepository,
  conversationsDir,
  type ConversationScope,
  JournalStore,
  CommandProvider,
  FileProvider,
  ArgumentProvider,
  DefaultCommandRegistry,
  DefaultTypeaheadBroker,
  UsageTracker,
  type RuntimeContext,
  type DispatchResult,
  type SuggestionItem,
  type SchedulerFacade,
  createEventBus,
  type SchedulerEventMap,
  type WorkModeSwitchIntent,
  type Conversation,
  extractText,
  buildWorksceneDigestMessage,
  maybeAutoNameFirstTurn,
  sanitizeConversationName,
  buildConversationNamerPrompt,
  type InferConversationName,
  CommandDispatcher,
  type AttentionWindowState,
  createAttentionWindow,
  SnapshotStore,
  userMessageOf,
} from "@zhixing/core";
import { describeProxy, type ProxyDescription } from "@zhixing/network";
import { loadConfig, loadCredentials, resolveHomeDir } from "@zhixing/providers";
import type { TaskListService } from "@zhixing/tools-builtin";
import { createMcpHub } from "@zhixing/mcp";
import { createBuiltinExtraToolsAssembly } from "./runtime/builtin-extra-tools.js";
import { parseServerSpecs } from "./runtime/mcp-config.js";
import { createCliSegmentDeps } from "./runtime/segment-deps.js";
import { ConversationRepoTaskListStore } from "./runtime/task-list-stores.js";
import { RoutingConversationRepository } from "./runtime/conversation-router.js";
import { acquireWorksceneConversation } from "./runtime/workscene-conversation.js";
import { switchToNewConversation } from "./runtime/switch-to-new-conversation.js";
import {
  openConversationWindow,
  writeWindowSnapshot,
} from "./runtime/conversation-window.js";
import { TaskTail } from "./task-tail/index.js";
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
import { registerSkillAddCommand } from "./skills/admission-command.js";
import { PASTE_TOKEN_PATTERN, PasteRegistry } from "./paste-registry.js";
import { resolveFileRefs } from "./resolve-file-refs.js";
import {
  type AgentRuntime,
  type RunResult,
} from "@zhixing/orchestrator/runtime";
import { renderError } from "./render.js";
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
import { renderHomeWelcome, renderStartupAdvisories } from "./workbench/index.js";
import { renderFarewell } from "./farewell/index.js";
import { RuntimeSession } from "./runtime/session.js";
import { RpcSchedulerFacade } from "./runtime/rpc-scheduler-facade.js";
import { shouldEnsureOnStartup } from "./runtime/scheduler-projection.js";
import {
  createBlockedRenderer,
  TerminalConfirmationRenderer,
} from "./security/index.js";
import { createReplInterruptRuntime } from "./interrupt/repl-runtime.js";

// ─── REPL 状态 ───

/**
 * per-conversation 运行态聚合 —— 各字段与当前 active runtime 强绑，模式切换
 * 时必须整体随 runtime 同一原子事务替换。main 与 workscene 各持一份独立实例，
 * applyModeSwitch 在 turn 边界切换 ReplState.conv 指向（双份持有：进入工作
 * 模式后 main 这份原样保留，退出时直接切回，无需重建）。
 *
 * 不含 agent —— agent 走 session.runtime getter（reload / 模式切换自动指向
 * 新实例，值捕获会与 getter 分叉）。
 */
interface ConversationRuntimeState {
  /**
   * 注意力窗口运行态 —— "给 LLM 看什么"的唯一内存权威。
   *
   * 窗口只经 acceptRun / applyCompact / reset 前进；接受顺序固定为
   * "先持久化成功、后入窗"——持久化失败窗口不前进，下轮在同一基底重试，
   * 内存与磁盘不再产生漂移。run 输入由本回路瞬态构造
   * （[...window.getMessages(), 用户消息]），用户消息不预写入任何状态。
   */
  window: AttentionWindowState;
  /**
   * 一次性输入前缀 —— 工作场景 LLM 触发句的承载。它不是窗口事实（无配对、
   * 不落盘），本质是"等待随下一个 run 消费的首个用户输入"：随首个成功
   * accept 的 run 进入发送视图后即清空；持久化只记录该 run 自己的用户消息。
   */
  pendingInputPrefix: Message[] | null;
  /** transcript 持久化（main 项目域 / workscene 域各自独立实例） */
  store: ShardedTranscriptStore;
  /** 派生摘要快照（与 store 同域同目录树）—— 窗口折叠的快照出口 + 装填来源 */
  snapshots: SnapshotStore;
  /** conversation meta 仓储（绑各自 ConversationScope） */
  convRepo: ConversationRepository;
  conversationId: string | null;
  turnCounter: number;
  /** 是否已执行过 Journal 自动凝练 */
  journalCondenseDone: boolean;
}

interface ReplState {
  /**
   * 当前活跃的 per-conversation 运行态（main 或 workscene）。模式切换由
   * applyModeSwitch 在 turn 边界整体替换此引用——所有读写经 state.conv.*
   * 自然跟随活跃域，无需逐字段同步。
   */
  conv: ConversationRuntimeState;
  running: boolean;
  /**
   * task_list 服务 —— cli 主线程在 conversation 切换 / `/clear` 时显式调
   * prime / clear 维护 cache。service 是 process-wide 单例，跨 reload 持续，
   * 且跨 main/workscene 模式共用（其 per-convId cache 天然隔离两域）。
   */
  taskListService: TaskListService;
  /** 调度门面 —— cli 经它接入核心宿主（无本地 scheduler）。 */
  scheduler: SchedulerFacade;
  /**
   * 启动时计算的代理诊断（mode + resolved + display 三元组）。用于 /status
   * 展示——区分 off / auto+null / auto+url / explicit 四态，display 字段
   * 永远脱敏（凭证不会泄露到终端 / 日志录屏）。
   */
  networkProxy: ProxyDescription;
  /**
   * 当前 in-flight turn promise——turn idle 时为 null。
   *
   * RuntimeSession.reload 流程在 swap 之前必须 await 此 promise，避免在 turn
   * 跑中替换 agentRuntime 导致状态错乱。turn 启动时设置、完成（resolve / reject）
   * 时由 finally 块清空。
   */
  activeTurnPromise: Promise<RunResult> | null;
}

// ─── REPL 启动选项 ───
//
// 启动期只承载"运行模式 / 环境配置"维度的选项;"对话选择"维度统一由 REPL 内
// 的 `/new` `/resume` `/name` 命令承担,启动期不再有 `--continue`/`--resume`/`--name`
// 这类与 REPL 命令同语义的双轨入口(见 conversation-model.md §11.2)。
// 启动行为:总是 auto-resume `convRepo.findLatest()` 最近一条对话(无 latest 则
// 创建 default)。用户想切换到其它对话或新建,进入 REPL 后用 `/resume` / `/new`。

export interface ReplOptions {
  workspace?: string;
}

/**
 * 构造退出工作场景时给 power 的纪要指令。
 *
 * `callText` 单发无历史，故把本场景对话的文本内容嵌入 prompt，由 power（绑
 * light = 用户中档，成本正确）概括成一段给主对话的交接。只取 text block
 * （工具调用/结果噪音不入），无任何可读文本时返回 undefined（无可纪要 →
 * 调用方跳过 LLM 调用）。
 */
function buildWorksceneDigestPrompt(
  messages: readonly Message[],
): string | undefined {
  const transcript = messages
    .map((m) => {
      const text = extractText(m).trim();
      if (!text) return null;
      const who =
        m.role === "user" ? "用户" : m.role === "assistant" ? "你" : m.role;
      return `${who}: ${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
  if (!transcript) return undefined;
  return (
    `以下是你在某个工作场景中与用户的完整对话：\n\n${transcript}\n\n` +
    `你即将退出该工作场景、回到主对话。请用简短一段（中文，至多 5 句）向主` +
    `对话交接：本场景做了什么、关键产出或结论、有无未尽事项。只输出这段交接` +
    `文本本身，不要寒暄、不要提问、不要复述本提示。`
  );
}

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

export async function startRepl(options: ReplOptions): Promise<void> {
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

  // renderer 借给 RuntimeSession——session 内部装配 agent 时通过 closure 注入。
  // renderer 接收 cliWriter，所有 AI 输出（text/thinking/tool 卡片）经 writer 协调。
  const renderer = createOutputRenderer({ writer: cliWriter });

  // schedulerEventBus 作为渲染中转——REPL 订阅它渲染任务通知。cli 无本地 scheduler，
  // 事件来自下面 schedulerFacade.onEvent 经 RPC 订阅核心宿主后桥接到此 bus。
  const schedulerEventBus = createEventBus<SchedulerEventMap>();

  // 调度门面 —— cli 经它接入核心宿主（懒拉起 + 读写分离）。注入 session（schedule 工具 /
  // turn-context），供 /tasks 命令读投影、订阅任务事件桥回渲染。
  const schedulerFacade = new RpcSchedulerFacade();

  // cli 启动轻检查：纯聊天零后台；仅在「系统维护未 seed / 逾期」或「近期用户任务待触发」
  // 时主动 ensure 核心宿主（防饿死 + 守候近期任务）。fire-and-forget，不阻塞 REPL 启动。
  if (shouldEnsureOnStartup()) {
    // ensure 失败不静默：给一行友好降级提示（不阻塞 REPL 启动）。失败时定时任务
    // 可能不按时触发——让用户可观测，而非零感知丢失。
    void schedulerFacade.ensureHost().catch((err) => {
      cliWriter.notify(
        chalk.yellow(
          `  ⚠ ${err instanceof Error ? err.message : "定时功能当前不可用"}`,
        ),
      );
    });
  }

  const zhixingHome = getZhixingHome();
  const config = loadConfig();
  const credentials = loadCredentials({ homeDir: resolveHomeDir() });

  const scope: ConversationScope = { kind: "user" };
  const convRepo = new ConversationRepository(scope);
  const convDir = conversationsDir(scope);
  const store = new ShardedTranscriptStore(convDir);
  const snapshotStore = new SnapshotStore(convDir);

  // 对话仓储路由核 —— builtinExtraTools(含 TaskListService) 与 segmentDeps 在此
  // 一次性装配并跨 reload 持久，二者构造期即绑定后端 repo、无法重建。插一层
  // 路由代理：默认透传主项目 convRepo，进入工作模式时 applyModeSwitch 在 turn
  // 边界 setActive 切到工作场景独立 repo，两个消费者无感知（spec：两个 facade
  // 适配器包同一路由核——ConversationRepoTaskListStore 是 TaskListStore 形、
  // createCliSegmentDeps 是 IConversationRepository 形，路由决策同源）。
  const routingRepo = new RoutingConversationRepository(convRepo);

  // builtin extra tools assembly —— task_list 持久化走路由核（按活跃模式落到
  // 主项目 / 工作场景各自的 conversation meta）。
  //
  // assembly 持有 TaskListService 单例，跨 reload 复用（service.cache 与持久化连续
  // 性由此保障）。session 内部每次 createAgent 都调 assembly.assembleTools() 拿
  // 新的 ToolDefinition 实例，工具内部都闭包引用同一 service —— 行为一致。
  // MCP host —— 连接 config.mcp 声明的外部 server，其工具经 assembleTools 进入工具集。
  // connectAll 必须在 createAgent（RuntimeSession.create 内部 assembleTools）之前完成，
  // 工具目录才能进入首个 system prompt。空配置时 hub 为 no-op，connectAll 立即返回。
  const mcpHub = createMcpHub(parseServerSpecs(config.mcp, credentials.mcp), {
    networkProxy: config.network?.proxy,
  });
  await mcpHub.connectAll();

  const builtinExtraTools = createBuiltinExtraToolsAssembly(
    new ConversationRepoTaskListStore(routingRepo),
    mcpHub,
  );

  // 段切换外部依赖 —— 跨 reload 持久，封装 taskListReader（适配自 TaskListService）
  // 与 segmentMetadata persistence（接 ConversationRepository）。
  //
  // 不含 transcript：段切换产出走"emit segment:new_started → orchestrator
  // accumulator → RunResult.windowCompact"路径，随 turn 在 run 边界折叠窗口
  // （压缩是窗口的视图操作，不落盘），cli 装配层无需透传 transcript。
  const segmentDeps = createCliSegmentDeps({
    taskListService: builtinExtraTools.taskListService,
    conversationRepo: routingRepo,
  });

  const session = await RuntimeSession.create({
    config,
    credentials,
    cliWorkspace: options.workspace,
    renderer,
    writer: cliWriter,
    screen: renderScreen ?? undefined,
    zhixingHome,
    schedulerFacade,
    onSecurityBlocked: createBlockedRenderer(cliWriter),
    builtinExtraTools,
    segmentDeps,
  });

  // 自动命名 inferer ── 在新对话第一轮 turn 完成后由 hook 触发，生成短主题名。
  //
  // 闭包内动态访问 session.runtime.callText：active runtime 在工作模式 enter/
  // exit 时会切换（main ↔ power overlay），自动命名必须跟随当前 active runtime
  // 的 light 通道。预捕获 `const callText = session.runtime.callText` 会与
  // getter 分叉，模式切换后还指向旧 runtime。
  const inferConversationName: InferConversationName = async (msg) => {
    const text = extractText(msg).trim();
    if (!text) return null;
    const prompt = buildConversationNamerPrompt(text);
    const raw = await session.runtime.callText(prompt);
    return sanitizeConversationName(raw);
  };

  let window: AttentionWindowState | null = null;
  let conversationId: string | null = null;
  let turnCounter = 0;
  // 当前 REPL 接续的对话名称——auto-resume 命中时写入,喂给 welcome chrome 内
  // 的锚 row2 inline 渲染（替代分散的 cliWriter.line "已恢复对话..." 噪音）。
  // 新对话保持 null → 锚 row2 退化为仅 glyph。
  let resumedConversationName: string | null = null;

  // 启动期对话选择策略：统一 auto-resume `convRepo.findLatest()` 最近一条对话,
  // 无 latest 或加载失败则降级到创建 default 新对话。
  // 用户想切换到其它对话或新建命名,进入 REPL 后用 `/resume` / `/new <name>`。
  // 恢复的历史经启动装填进入注意力窗口：摘要快照 + 预算化倒读的最近原文
  // 渲染为装填对，作为窗口起始条目（跨 run 存续直到被折叠摘要对取代）。
  const latest = await convRepo.findLatest();
  if (latest) {
    try {
      const opened = await openConversationWindow({
        store,
        snapshots: snapshotStore,
        conversationId: latest,
        model: session.runtime.model,
      });
      window = opened.window;
      conversationId = latest;
      turnCounter = opened.turnCount;
      const conv = await convRepo.get(latest);
      resumedConversationName = conv?.name ?? latest;
    } catch {
      // transcript 加载失败 → 降级到创建新对话
    }
  }

  // 新对话：先创建 Conversation（meta.json），再建分片 transcript 索引
  if (!conversationId) {
    const conversation = await convRepo.create({
      preferredModel: session.runtime.model,
      preferredProvider: session.runtime.providerId,
    });
    await store.init(conversation.id);
    conversationId = conversation.id;
  }

  // 加载 task_list 持久化状态到 service cache —— 新建 conversation 时为空，
  // 恢复时拉取 meta.taskListState。conversation 切换走 /new / /resume 处的 prime 调用。
  await session.taskListService.prime(conversationId);

  // 启动告警先于 chrome——异常状态需立即吸引注意；无告警时返回空数组，
  // 视觉序列退化为"shell prompt → chrome"无空行干扰
  // 初始 region 内容（启动告警 + 欢迎块）单一来源——启动时逐行写入 +
  // resize-end 整屏重建复用同一生成逻辑，杜绝两处渲染漂移（架构债务）。
  // 延迟求值：每次调用按当时 session 状态重新生成（resize-end 时仍准确）。
  const initialRegionLines = (): string[] => {
    const lines: string[] = [];
    const adv = renderStartupAdvisories({
      workspaceDirStatus: session.runtime.workspaceDirStatus,
      workspacePath: session.runtime.resolvedWorkspace.path,
      workspaceSource: session.runtime.resolvedWorkspace.source,
    });
    lines.push(...adv);
    if (adv.length > 0) lines.push("");
    lines.push(
      ...renderHomeWelcome({
        providerId: session.runtime.providerId,
        model: session.runtime.model,
        workspaceRoot: session.runtime.resolvedWorkspace.path ?? undefined,
        resumedConversationName: resumedConversationName ?? undefined,
      }),
    );
    lines.push("");
    return lines;
  };
  for (const line of initialRegionLines()) cliWriter.line(line);

  // 历史尾巴 —— "回到工位"的用户侧一半：恢复对话时渲染最近几轮变暗摘录
  //（agent 侧启动装填已"全记得"，用户侧打开即见，信息对称）。新对话无历史
  // 跳过；输出落 scrollback、不进 initialRegionLines（后者是 resize 重建的
  // 纯净欢迎块单一来源，历史尾巴与屏内对话同生命周期）。
  if (resumedConversationName !== null && conversationId !== null) {
    await renderHistoryTail({ store, conversationId, writer: cliWriter });
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
  if (confirmationRenderer) {
    // session 持有 renderer 与 broker 的绑定，dispose 时自动 detach
    session.attachConfirmationRenderer(confirmationRenderer);
  }

  // main 域运行态 —— 进入工作模式后此实例原样保留，退出时直接切回（双份持有）。
  const mainConv: ConversationRuntimeState = {
    // 启动恢复命中时已经启动装填建窗；新建对话从空窗起步
    window:
      window ?? createAttentionWindow({ conversationId: conversationId ?? undefined }),
    pendingInputPrefix: null,
    store,
    snapshots: snapshotStore,
    convRepo,
    conversationId,
    turnCounter,
    journalCondenseDone: false,
  };
  const state: ReplState = {
    conv: mainConv,
    running: false,
    taskListService: session.taskListService,
    scheduler: session.scheduler,
    networkProxy: describeProxy(config.network?.proxy),
    activeTurnPromise: null,
  };

  // TaskTail 在 useTypeahead 分支内装配（需要 ScreenController）。声明在外层让
  // /new / /resume handler 通过 onConversationChanged 闭包延迟引用 —— 命令 handler
  // 触发时 TaskTail 早已创建完毕，无装配时序问题。
  let taskTail: TaskTail | null = null;

  /**
   * 模式切换唯一执行点 —— REPL 主回路 turn 边界原子事务。
   *
   * 两条触发路径汇聚到此：LLM 工具经 RunResult.pendingModeSwitch（主回路 turn
   * 结束后消费，source="llm"）、`/work`·`/exit` 命令（handler 先 await
   * in-flight turn，source="command"）。
   *
   * 原子性不对称（焊死）：
   *   - enter 失败 = fail-back 到 main：按序执行有副作用步骤，任一步抛错则
   *     逆序撤销已执行项，active 始终留 main（active 只在最后一步纯赋值切换、
   *     不可能抛错）。
   *   - exit 失败 = fail-forward 到 main：power overlay 一旦弃不可复原，弃后
   *     任一步失败都继续推进到 main 干净态，绝不退回 workscene。
   *
   * 与 reload 共享 session 的单一 lifecycle guard（忙时拒绝并提示）。
   */
  const applyModeSwitch = async (
    intent: WorkModeSwitchIntent,
    source: "llm" | "command",
    triggerMsg?: Message,
  ): Promise<void> => {
    if (!session.tryBeginLifecycleOp()) {
      cliWriter.line(
        chalk.dim("\n  模式切换被拒绝：另一生命周期操作正在进行\n"),
      );
      return;
    }
    try {
      if (intent.kind === "enter") {
        if (session.activeMode.kind !== "main") {
          cliWriter.line(chalk.dim("\n  已在工作场景中，请先 /exit 退出\n"));
          return;
        }
        const sceneId = intent.sceneId;
        const scene = await session.workSceneRegistry.get(sceneId);
        if (!scene) {
          cliWriter.line(chalk.red(`\n  工作场景 "${sceneId}" 不存在\n`));
          return;
        }
        // workdir 校验前置于全部副作用 —— 不可访问则整体失败、active 留 main，
        // 无任何已执行副作用需撤销（fail-back 退化为零成本）。
        if (scene.workdir) {
          try {
            await access(scene.workdir);
          } catch {
            cliWriter.line(
              chalk.red(
                `\n  工作场景 "${scene.name}" 的工作目录不可访问：${scene.workdir}\n`,
              ),
            );
            return;
          }
        }

        const worksceneRepo = new ConversationRepository({
          kind: "workscene",
          sceneId,
        });
        const wsConvDir = conversationsDir({ kind: "workscene", sceneId });
        const wStore = new ShardedTranscriptStore(wsConvDir);
        const wSnapshots = new SnapshotStore(wsConvDir);

        // 有副作用步骤按序执行，undo 逆序栈在任一步抛错时回退（fail-back）。
        const undos: Array<() => Promise<void> | void> = [];
        // 命令触发的 auto-resume 降级降级 create 时携带的提示文案，
        // 仅 enter 整体成功后输出 —— 避免 helper 内即时输出 + 后续步骤
        // 回滚导致用户看到 "已创建新对话" + "已回退主对话" 的双消息困惑。
        let acquireWarning: string | undefined;
        try {
          // ① 路由核 register：后续 power turn 的 task_list / 段切换落 workscene
          routingRepo.setActive(worksceneRepo);
          undos.push(() => routingRepo.setActive(mainConv.convRepo));
          // ② workscene scope 获取 conversation —— 按触发源分支：
          //   - LLM 触发（workmode_enter 工具）：始终 create 新对话。LLM 是
          //     为新任务进 scene，若读历史会让 power 上下文被上次无关主题污染、
          //     answer 跑偏；新建 + 触发句作为起始 message + 第一轮 turn 后
          //     自动命名落地，不产生孤儿空对话。
          //   - 命令触发（/work）：auto-resume 该 scene 最近活跃对话（与 main
          //     启动 auto-resume 对齐 —— 用户手动进就是为回到最近对话继续）。
          //
          // 不传 name：让 convRepo.create 走默认 name=id（autoChatId）的 sentinel，
          // 与 main 模式 /new 无参一致。scene.name 是工作场景级语义，不应直接占
          // conversation.name 槽位 —— 否则 N 次进同 scene 会产生 N 个同名对话，
          // 在 /resume typeahead 里完全无法区分。命名职责交给自动命名机制（第一
          // 轮 turn 完成后用 light LLM 生成精确主题名）统一接管。
          let wConv: Conversation;
          let recovered = false;
          if (source === "llm") {
            wConv = await worksceneRepo.create({});
          } else {
            const acquired = await acquireWorksceneConversation(worksceneRepo);
            wConv = acquired.conversation;
            recovered = acquired.recovered;
            acquireWarning = acquired.warning;
          }
          // undo：仅 create 路径（LLM 触发 / 命令触发首次 / 命令触发降级）才
          // push delete —— recovery 路径必须保留用户已有历史对话，不能因
          // 后续 enter 步骤失败被回滚误删。
          if (!recovered) {
            undos.push(async () => {
              await worksceneRepo.delete(wConv.id).catch(() => {});
            });
          }
          // 起始内容按触发源 × 路径分流到窗口 / 输入前缀：
          //   - LLM：触发句进 pendingInputPrefix（power 不知干啥就靠它）——它
          //     不是窗口事实（无配对、从不落盘），随首个成功 accept 的 run
          //     进入发送视图后即清空，与"触发句只活到首次提交"的语义一致。
          //   - command-recovery：启动装填重建窗口，接续历史（建窗推迟到
          //     enterWorkMode 之后——装填预算按 power 模型的能力取值）。
          //   - command-create / command-降级：空窗（用户随后在 workscene 输入）。
          //
          // 触发句由主回路显式透传该 turn 构造的原始 userMsg —— 不扫描 canonical
          // 反推：带工具调用的 turn 末尾 tool_result 消息同为 role:"user"
          // （toolResultMessage），按 role 反查会误取工具结果而非用户原句。
          const wPrefix =
            source === "llm" && triggerMsg ? [triggerMsg] : null;
          // ③ task_list service cache prime（新建 → 空 items；recovery → 读
          // 已落盘的 task_list state）
          await state.taskListService.prime(wConv.id);
          undos.push(() => state.taskListService.clear(wConv.id));
          // ④ 装 power runtime + broker swap（其自身原子由 RuntimeSession 保证）
          await session.enterWorkMode(sceneId);
          undos.push(async () => {
            await session.exitWorkMode();
          });
          // 建 transcript 索引（幂等：recovery 路径已存在则 no-op）。
          await wStore.init(wConv.id);
          // ⑤ 启动装填建窗并切 active（建窗在 enterWorkMode 之后——runtime
          // 已是 power，装填预算按 power 模型取值；装填 IO 失败走 undo 回退）
          const openedW = recovered
            ? await openConversationWindow({
                store: wStore,
                snapshots: wSnapshots,
                conversationId: wConv.id,
                model: session.runtime.model,
              })
            : null;
          state.conv = {
            window:
              openedW?.window ??
              createAttentionWindow({ conversationId: wConv.id }),
            pendingInputPrefix: wPrefix,
            store: wStore,
            snapshots: wSnapshots,
            convRepo: worksceneRepo,
            conversationId: wConv.id,
            turnCounter: openedW?.turnCount ?? 0,
            journalCondenseDone: false,
          };
        } catch (err) {
          for (const undo of undos.reverse()) {
            try {
              await undo();
            } catch {
              // 撤销尽力而为：单步撤销失败不阻断其余撤销，最终态仍是 main
            }
          }
          cliWriter.line(
            chalk.red(
              `\n  进入工作场景失败：${err instanceof Error ? err.message : String(err)}（已回退主对话）\n`,
            ),
          );
          return;
        }

        // 渲染：事务点直接 cliWriter（不经 EventBus 订阅）。
        // 分隔线宽度跟随终端、与 chrome / security banner frameWidth = max(40, cols-1)
        // 同基线：整行 = 2 空格 prefix + sep，故 sep 宽 = frameWidth - 2 = max(38, cols-3)。
        const sepWidth = Math.max(38, (process.stdout.columns ?? 80) - 3);
        const sep = "─".repeat(sepWidth);
        cliWriter.line(
          chalk.dim(
            `\n  ${sep}\n  已进入工作场景 ${chalk.cyan(scene.name)}` +
              `${scene.workdir ? chalk.dim(`（${scene.workdir}）`) : ""}\n  ${sep}\n`,
          ),
        );
        if (acquireWarning) {
          cliWriter.line(chalk.dim(`  ${acquireWarning}\n`));
        }
        // 历史尾巴：场景的工位同款"回到工位"展示——/work 的 auto-resume 接续
        // 了场景对话（agent 已装填记得），用户侧同样要看见。与主对话启动 /
        // /resume 同一语义同一待遇；新场景对话无历史零输出。enter 成功后
        // conversationId 必非空，守卫仅为类型收窄。
        if (state.conv.conversationId !== null) {
          await renderHistoryTail({
            store: state.conv.store,
            conversationId: state.conv.conversationId,
            writer: cliWriter,
          });
        }
        taskTail?.refresh();
        return;
      }

      // intent.kind === "exit"
      if (session.activeMode.kind !== "workscene") {
        cliWriter.line(chalk.dim("\n  当前不在工作场景中\n"));
        return;
      }
      // 退出是用户明确意图：弃 power overlay 后不可复原，弃后任一步失败都继续
      // 推进到 main 干净态（fail-forward），绝不退回 workscene。
      const worksceneConvId = state.conv.conversationId;

      // 退出纪要（best-effort，失败不阻断退出 —— 退出是用户明确意图，不可因
      // 纪要 LLM 失败卡在 workscene；失败则跳过 + 记降级提示，主对话后续仍可
      // query 工作场景记忆兜底）。此刻 session.runtime 仍 = power（exitWorkMode
      // 尚未调用），callText 绑 light（power 的 light = 用户中档）。state.conv
      // 仍 = worksceneConv，持本场景全部消息。
      let digest: string | undefined;
      const digestPrompt = buildWorksceneDigestPrompt(
        state.conv.window.getMessages(),
      );
      if (digestPrompt) {
        try {
          digest =
            (await session.runtime.callText(digestPrompt)).trim() || undefined;
        } catch (err) {
          cliWriter.line(
            chalk.dim(
              `\n  工作场景纪要生成失败（不阻断退出，主对话后续可查工作场景记忆）：${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
        }
      }

      try {
        await session.exitWorkMode();
      } catch (err) {
        cliWriter.line(
          chalk.dim(
            `\n  退出工作模式时 overlay 清理告警（不阻断回到主对话）：${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
      }
      // 切 active 回 main + 丢弃 workscene 运行态（路由核注销 + service cache 清）
      state.conv = mainConv;
      routingRepo.setActive(mainConv.convRepo);
      if (worksceneConvId) state.taskListService.clear(worksceneConvId);

      // 仅纪要成功时，挂为 main 运行态的一次性输入前缀，以 system-meta 元标签
      // 包裹（主对话据既有 meta-protocol 通用框架识别为机制插入、非自己原话）。
      // 这是一次性交接上下文：随主对话下一 run 进入发送视图、被接受后即消费
      // （不入窗口事实、不落盘），是否长存由主对话自判调 memory 工具；不写个人记忆。
      if (digest) {
        mainConv.pendingInputPrefix = [
          ...(mainConv.pendingInputPrefix ?? []),
          buildWorksceneDigestMessage(digest),
        ];
      }
      const sepWidth = Math.max(38, (process.stdout.columns ?? 80) - 3);
      const sep = "─".repeat(sepWidth);
      cliWriter.line(
        chalk.dim(
          `\n  ${sep}\n  已退出工作场景，回到主对话` +
            `${digest ? "（已为主对话生成本场景交接纪要）" : ""}\n  ${sep}\n`,
        ),
      );
      taskTail?.refresh();
    } finally {
      session.endLifecycleOp();
    }
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
  // 技能集结构版本快照 —— run 收尾时比对,变了才刷新 /<name> 动态补全候选。
  // save_skill 在 agent loop 内落盘,cli 无直接信号;版本比对零开销(内存 int)、
  // 与 runtime 索引重建同源同纪律:结构性写才递增,普通 turn 零动作。
  let skillVersionSeen = session.skillStore.version("main");
  const typeaheadDispatcher = new CommandDispatcher({ registry: tRegistry });

  // info 域命令（help/status/me/model/usage/context/journal/people/tasks）—— 现代路径
  // 模块化原子注册。reload / 模式切换会 swap runtime 与 conv,故以 getter 注入、handler
  // 调用时读最新值。/help 在此注入 registry 用于列命令；注册在动态技能源之前使撞名可见。
  registerInfoCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    getRuntime: () => session.runtime,
    getMessages: () => state.conv.window.getMessages(),
    getConversationId: () => state.conv.conversationId,
    getTurnCounter: () => state.conv.turnCounter,
    getNetworkProxy: () => state.networkProxy,
    getScheduler: () => state.scheduler,
  });

  // session 域命令（new/clear/resume/name/compact）—— 对话生命周期，会读写 active conv，
  // 故 getConv / getRuntime 以 getter 注入；taskListService 是跨 reload 单例直接注入。
  // /resume 的对话选择器在模块内构造、落进 CommandDef.args，其 inline 删除的物理执行仍由
  // 下方交互层 onCandidateDelete 承担。
  registerSessionCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    getConv: () => state.conv,
    getRuntime: () => session.runtime,
    taskListService: state.taskListService,
    onConversationChanged: () => taskTail?.refresh(),
    clearScreenToInitial,
  });

  // 模式切换命令（work/exit）—— 与对话生命周期 deps 不相交，独立注册。applyModeSwitch
  // 是模式切换唯一执行点；activeMode / in-flight turn 以 getter 注入按调用时读。
  registerModeCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    applyModeSwitch,
    getActiveMode: () => session.activeMode,
    getActiveTurnPromise: () => state.activeTurnPromise,
    workSceneRegistry: session.workSceneRegistry,
    rl,
  });

  // config 域命令（config/mcp/trust/security）—— config/mcp 是 alt-screen 编辑器（挂
  // chromeOnlyVisibility）；/trust 选择器的 securityPipeline 以 getter 注入（reload 会 swap）。
  registerConfigCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    writer: cliWriter,
    rl,
    renderer,
    screen: renderScreen,
    session,
    getActiveTurnPromise: () => state.activeTurnPromise,
    mcpHub,
  });

  // task_list cli 命令组 —— 直接注册到 registry + dispatcher 的命令现代路径
  // （未来 /memory 等同模式抽出）。
  registerTaskCommands({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    service: session.taskListService,
    getConversationId: () => state.conv.conversationId,
    writer: cliWriter,
  });

  // /skills 技能管理器（alt-screen）—— 走命令现代路径。注册在 /<name> 动态源之前，
  // 使撞名探测能看见 /skills（避免名为 "skills" 的技能遮蔽本命令）；onMutate 接
  // tRegistry.refresh，让管理器内禁用 / 归档后 /<name> 补全即时反映。
  registerSkillsCommand({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    rl,
    renderer,
    screen: renderScreen,
    writer: cliWriter,
    skillStore: session.skillStore,
    refreshCommands: () => tRegistry.refresh(),
  });

  // 创建 / 打磨技能无专门入口 —— 走对话流能力内化:模型经索引命中内置方法
  //「提炼技能」、起草打磨后调 save_skill 落盘;run 收尾的技能版本比对会刷新
  // /<name> 补全(见上),新技能当轮即可唤起。

  // /skill-add 接入入口 —— 外部技能（本地路径）经扫描 + AI 研判后入库。注册在
  // /<name> 动态源之前（撞名探测可见）；研判 LLM 走 main 档，接入后刷新 /<name> 补全。
  registerSkillAddCommand({
    registry: tRegistry,
    dispatcher: typeaheadDispatcher,
    rl,
    renderer,
    screen: renderScreen,
    writer: cliWriter,
    callText: (prompt) => session.runtime.callText(prompt, "main"),
    skillStore: session.skillStore,
    refreshCommands: () => tRegistry.refresh(),
  });

  // 技能 /<name> 动态唤醒 —— 把技能库投影成 execution:"agent" 命令。注册在
  // builtin / task 命令之后，撞名探测（findExisting）才让核心命令优先。初次 refresh
  // 把当前技能集拉进补全缓存；后续创建 / 接入由各自流程触发 registry.refresh() 增量纳入。
  tRegistry.registerDynamicSource(
    new SkillCommandSource({
      listAll: () => session.skillStore.listAll(),
      findExisting: (name) => tRegistry.findByName(name),
    }),
  );
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
        root: session.runtime.resolvedWorkspace.path ?? process.cwd(),
      }),
    );

    // 屏幕底部任务区 —— 订阅 service 变化驱动 setStatusTail，仅 chrome 终端需要。
    if (renderScreen) {
      taskTail = new TaskTail({
        screen: renderScreen,
        service: session.taskListService,
        getConversationId: () => state.conv.conversationId,
      });
      taskTail.start();
    }
  }

  const getRuntime = (): RuntimeContext => ({
    sessionBusy: state.running,
    workspaceId: session.runtime.resolvedWorkspace.path,
    cwd: process.cwd(),
    target: "cli",
    // chrome 能力进 features:需要 alt-screen 的命令(config/mcp/skills)据此被
    // visibility 过滤——非 TTY / 管道(capability.ok=false)下补全与 /help 不列出。
    features: { [FEATURE_CHROME]: capability.ok },
    now: Date.now(),
  });

  // typeahead 候选删除 callback —— Ctrl+D 二次按下时触发(仅当前 trigger 的
  // provider 通过 computeDeletable 声明支持时)。本函数负责"物理删除 + 业务编排":
  // 物理删除经 conversationArgProvider.delete → state.conv.convRepo.delete;若删的
  // 是当前 active 对话则自动新建空对话切换(转载启动 auto-resume 同款 fallback,
  // 视图层 reset 与 /clear handler 同款)。删的非当前对话仅删除不切换 active。
  // 实施完成后由 InputController 调 broker.refresh 刷新候选列表(本回调无需感知)。
  const onCandidateDelete = async (item: SuggestionItem): Promise<void> => {
    const meta = item.acceptPayload.metadata;
    const value = typeof meta?.argValue === "string" ? meta.argValue : undefined;
    if (!value) return;
    const commandId = typeof meta?.commandId === "string" ? meta.commandId : "";

    // 删场景(/work 面板):走 session.removeWorkScene(带 active guard),error
    // 染红。无 fallback 新建(与删对话不同)—— 系统数据物理清除,用户 workdir 不动。
    if (commandId === "work:repl") {
      try {
        await session.removeWorkScene(value);
      } catch (err) {
        cliWriter.line(
          chalk.red(
            `\n  删除工作场景失败: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
      }
      return;
    }

    // 撤销信任规则（/trust 面板）：物理调 store.revoke；规则刚被并发删时
    // ok=false 时静默忽略（后续 broker.refresh 会拿到最新列表）。撤销成功
    // 不打印反馈 —— 候选行从 dropdown 消失即用户得到的视觉确认。
    if (commandId === "trust:repl") {
      try {
        session.runtime.securityPipeline.getPermissionStore().revoke(value);
      } catch (err) {
        cliWriter.line(
          chalk.red(
            `\n  撤销信任规则失败: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
      }
      return;
    }

    // 删对话(/resume 面板):物理删 + 删的若是当前对话则自动新建空对话切换。
    const wasActive = value === state.conv.conversationId;

    try {
      await state.conv.convRepo.delete(value);
    } catch (err) {
      cliWriter.line(
        chalk.red(
          `\n  删除对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
      return;
    }

    if (!wasActive) return;

    try {
      await switchToNewConversation(state.conv, session, state.taskListService, {
        notify: () => taskTail?.refresh(),
      });
    } catch (err) {
      cliWriter.line(
        chalk.red(
          `\n  新建空对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    }
  };

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
    // TaskTail 先于 session dispose —— 取消 service 订阅 + 清屏底 tail，
    // 避免 session dispose 期间残留事件触发已无效的渲染
    taskTail?.dispose();
    // session.dispose 内部 detach renderer + stop scheduler/delivery + dispose channels
    await session.dispose().catch((err) =>
      cliWriter.line(`[session.dispose] ${err instanceof Error ? err.message : String(err)}`),
    );
    // MCP 连接 / stdio 子进程关闭 —— 在 session 停止之后（工具不再被调用），由 hub 的
    // owner（本入口）释放，避免子进程在 CLI 退出后成为孤儿。
    await builtinExtraTools.mcpHub.dispose().catch((err) =>
      cliWriter.line(`[mcpHub.dispose] ${err instanceof Error ? err.message : String(err)}`),
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
                  if (sceneId) await session.workSceneRegistry.rename(sceneId, name);
                } else {
                  await session.workSceneRegistry.add({ name });
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
        workspaceRoot: session.runtime.resolvedWorkspace.path ?? process.cwd(),
      });
      resolvedInput = refResult.text;
      if (refResult.errors.length > 0) {
        for (const err of refResult.errors) {
          cliWriter.line(chalk.yellow(`  ⚠ ${err}`));
        }
      }
    }

    // 正常对话 —— 用户消息不预写入任何状态：run 输入瞬态构造
    // （[...窗口事实, ...一次性前缀, 用户消息]），窗口只在持久化成功后经
    // acceptRun 前进。失败路径因此天然干净：窗口与前缀原样保留，下轮重试
    // 同一基底，无需任何回滚动作。
    const userMsg = userMessage(resolvedInput);
    state.running = true;
    renderer.startThinking();

    // Per-turn 装载中断协调:KeyboardSource 拦截 Esc/Ctrl+C(raw mode) +
    // SignalSource 兜底 SIGINT/SIGTERM(cooked mode / non-TTY)。
    // controller.signal 透传给 session.runtime.run 让用户中断真正生效。
    // 每个 turn 独立 controller 实例,turn 结束 detach 释放 stdin 与 listener。
    //
    // exitRequested flag 协调双击退出:
    //   - 第一次 Ctrl+C 由 KeyboardSource 触发 abort, agent-loop 进入 unwinding
    //   - 第二次 Ctrl+C (800ms 内) 触发 onDoublePress, **只设 flag 不立即 close**
    //   - finally 块 detach 后判 flag 调 rl.close —— 此时 agent-loop 已因第一次 abort
    //     unwind 完成 (finalizeRun 完整 emit fired+run_end + tool 进程 cleanup +
    //     transcript commit),rl.close 触发现有 close handler 走 scheduler.stop /
    //     channels.dispose / process.exit 完整退出路径
    // 直接在 onDoublePress 内 rl.close 会让 process.exit(0) 杀掉 in-flight agent run,
    // 跳过 finalizeRun 的 emit + 资源清理 → 违反"已 emit 的 fired 必有对应 run_end"。
    let exitRequested = false;
    const interruptRuntime = createReplInterruptRuntime({
      onDoublePress: () => {
        exitRequested = true;
      },
    });

    // LLM 工具触发的模式切换意图 —— turn 内只产生意图，本回路在 turn 完全
    // 落定后（持久化 + finally 资源释放）于 turn 边界唯一消费。turn 出错
    // （catch 路径）则 runResult 不可达、保持 undefined → 不切换。
    let pendingModeSwitch: WorkModeSwitchIntent | undefined;

    try {
      const runPromise = session.runtime.run({
        // run 输入 = 窗口事实 + 一次性前缀（工作场景触发句）+ 本轮用户消息。
        // 瞬态构造：窗口在 accept 之前不前进，失败即弃，无回滚负担。
        messages: [
          ...state.conv.window.getMessages(),
          ...(state.conv.pendingInputPrefix ?? []),
          userMsg,
        ],
        turnIndex: state.conv.turnCounter,
        // 透传当前 conversationId 进 RunContext —— 让工具按需取（在持久化会话中
        // 区分写入目标 / 读取上下文）；ephemeral 路径（无 conversation）自然为
        // undefined，工具自行 graceful degrade。
        conversationId: state.conv.conversationId ?? undefined,
        abortSignal: interruptRuntime.controller.signal,
        onYield: (e) => renderer.handleEvent(e),
      });
      // 暴露给 RuntimeSession.reload 流程——reload 在 swap 之前 await 此 promise
      state.activeTurnPromise = runPromise;
      const runResult = await runPromise;
      pendingModeSwitch = runResult.pendingModeSwitch;

      renderer.stop();
      // turn 终止反馈（耗时 / token / abort 原因 / error 类型 / max_turns）由 status-bar
      // 单点接管——renderSummary 已移除，避免每条 AI 消息底下重复的 "─ 1.6s" 视觉噪音。
      // 状态条 done 永驻显示直到下一次 agent:run_start，新 turn 起始覆盖回 thinking。

      // 接受协议：先持久化成功、后窗口前进（acceptRun 应用 windowCompact 折叠
      // 并追加本 run 蒸馏对）。持久化只追加原始 run record——压缩是注意力窗口
      // 的视图操作，原文 append-only、永不因压缩变短；窗口是唯一压缩视图。
      if (state.conv.conversationId) {
        try {
          const { runIndex } = await state.conv.store.appendRunRecord(
            state.conv.conversationId,
            runResult.runRecord,
          );
          const outcome = state.conv.window.acceptRun({
            runMessages: runResult.runRecord.messages,
            runIndex,
            windowCompact: runResult.windowCompact,
          });
          // 折叠产生结构化摘要 → 顺手落派生快照（启动装填的摘要来源）。
          // fire-and-forget：写失败 helper 内 warn，绝不阻塞 turn 收尾。
          if (runResult.windowCompact) {
            void writeWindowSnapshot(
              state.conv.snapshots,
              state.conv.conversationId,
              runResult.windowCompact,
              outcome,
            );
          }
          // 一次性前缀已随本 run 进入发送视图并被摘要语境覆盖 → 消费完毕
          state.conv.pendingInputPrefix = null;
          state.conv.turnCounter++;
          state.conv.convRepo.touch(state.conv.conversationId).catch(() => {});

          // 一次性自动命名 ── 仅当 turnCounter 刚 === 1 时由 helper 内部进入
          // 异步分支（其它 turn helper 内同步 short-circuit）。fire-and-forget
          // 不 await 不阻塞下一轮；helper 内部全 catch swallow，失败保持 name=id。
          // commit 失败走外层 catch 分支 turnCounter 未 ++，此调用自然不会被
          // 触发；即便误调，helper 内 short-circuit 兜底。
          void maybeAutoNameFirstTurn({
            conversationId: state.conv.conversationId,
            turnCounter: state.conv.turnCounter,
            userMessage: userMessageOf(runResult.runRecord.messages),
            inferName: inferConversationName,
            convRepo: state.conv.convRepo,
          });
        } catch (err) {
          // 持久化失败 → 窗口不前进：内存与磁盘停在同一基底，下轮重试。
          // 本轮的对话内容用户已在屏上看到（流式渲染），不会无声丢失；
          // 但它未成为窗口事实，下轮 LLM 不可见——比"内存 append 造成
          // 与磁盘漂移、再靠下轮压缩自愈"的旧策略更可预期。
          cliWriter.line(
            chalk.dim(
              `  [持久化警告] 本轮对话未写入磁盘，已从上下文丢弃: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }

        // 首轮对话后异步执行 Journal 生命周期维护 —— 个人记忆维护单向阀：
        // 仅 main 模式触发（工作场景模式记忆域是 workscene，绝不跑个人 journal）。
        if (
          session.activeMode.kind === "main" &&
          !state.conv.journalCondenseDone
        ) {
          state.conv.journalCondenseDone = true;
          runJournalLifecycle(session.runtime).catch(() => {});
        }
      } else {
        // 无会话 ID（无持久化，正常 cli 流程不出现）：窗口直接接受本 run，
        // 与持久化路径同一窗口协议——跨 run 留存的是蒸馏对而非全量协议消息。
        state.conv.window.acceptRun({
          runMessages: runResult.runRecord.messages,
        });
        state.conv.pendingInputPrefix = null;
      }

      // 本 run 内技能集变更(save_skill 新建/更新)→ 刷新 slash 补全候选,
      // 新技能 /<id> 当轮即可唤起(builtin 不在 listAll、天然不进候选)。
      const skillVersionNow = session.skillStore.version("main");
      if (skillVersionNow !== skillVersionSeen) {
        skillVersionSeen = skillVersionNow;
        tRegistry.refresh();
      }
    } catch (err) {
      renderer.stop();
      renderError(err, cliWriter);
      // 用户消息未预写入任何状态，错误路径无需回滚
    } finally {
      // 释放 stdin keypress ownership + 卸 SIGINT/SIGTERM listener;
      // 恢复 attach 前的 raw mode 状态,让下一轮 typeahead-input / readline 正常工作。
      interruptRuntime.detach();
      state.running = false;
      state.activeTurnPromise = null;
      // 双击 Ctrl+C 退出: 此时 agent-loop 已因第一次 abort unwind 完成
      // (run() 已 resolve / reject),安全调 rl.close 触发现有 cleanup 路径
      // (scheduler.stop / channels.dispose / process.exit)。
      // detach 之后 close 让 stdin 状态先归还再关闭 readline。
      if (exitRequested) {
        rl.close();
      }
    }

    // turn 边界：消费本轮 LLM 工具产生的模式切换意图（命令触发走 /work·
    // /exit handler 同源 applyModeSwitch）。此时 turn 已完全落定、in-flight
    // promise 已清——切换天然在 turn 边界，旧 runtime 已跑完本轮。
    if (pendingModeSwitch) {
      // 透传本 turn 构造的原始 userMsg 作触发句（power 起始 messages[0]）。
      await applyModeSwitch(pendingModeSwitch, "llm", userMsg);
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
  if (renderScreen && conversationId) {
    renderScreen.setFarewell(renderFarewell({ conversationId }));
  }

  renderScreen?.dispose();

  // 关闭 readline——typeahead 路径下 break 跳出循环后必须显式 close，否则 readline 持
  // stdin 让事件循环不空，进程不退出。Legacy 路径下 readline 已 close，幂等 no-op。
  rl.close();
}

// ─── 工具函数 ───

/**
 * 异步执行 Journal 生命周期维护。
 * 首轮对话后触发：删除过期文件 + 凝练温日志。
 * 静默执行，失败不影响用户对话。
 */
async function runJournalLifecycle(session: AgentRuntime): Promise<void> {
  const jStore = new JournalStore();

  // 先删除过期凝练文件（纯文件操作，极快）
  await jStore.expireOld();

  // 扫描是否需要凝练
  const plan = await jStore.scan();
  if (!plan.condensePlan) return;

  await jStore.condense(plan.condensePlan, {
    async condense(dailyContents: string): Promise<string> {
      return session.callText(
        `请将以下日志内容凝练为简洁的月度摘要，保留关键事实和决策，去掉冗余细节。\n\n${dailyContents}`,
      );
    },
  });
}

