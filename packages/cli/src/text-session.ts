import { normalizeLeadingSlashAlias } from './runtime/leading-slash-alias.js';
import { createLifecycleWarningDeduper } from './lifecycle-diagnostics-presentation.js';
/** Non-TTY conversation binding: one line reader, one Host connection, and the
 * existing application commands. It never owns a terminal or replays input. */
import type { Readable } from 'node:stream';
import type { LogRecordPort } from '@zhixing/core/logging';
import { extractText } from '@zhixing/core/types';
import { CommandDispatcher, DefaultCommandRegistry, type RuntimeContext } from '@zhixing/core/typeahead';
import type { SessionAdvancementStateSnapshot } from '@zhixing/rpc';
import { SkillCatalogRpcClient } from '@zhixing/rpc/skill-catalog-client';
import { loadConfig } from '@zhixing/providers/configuration';
import { BUILTIN_COMMANDS } from './commands/builtin-definitions.js';
import { FEATURE_CHROME } from './commands/command-capabilities.js';
import { observeStartupPhase, recordRuntimeFailure, recordStartupFailure } from './logging/runtime.js';
import { recordFirstSurfaceOutput } from './logging/runtime-source.js';
import { runStartupCheck, type StartupCheckResult } from './startup.js';
import { CoreHostConnection, defaultCoreHostConnectionDeps } from './runtime/core-host-connection.js';
import { connectReplHost } from './runtime/repl-host-startup.js';
import { ConversationController, selectInitialConversation } from './runtime/conversation-controller.js';
import { RpcConversationFacade } from './runtime/rpc-conversation-facade.js';
import { RpcWorksceneFacade } from './runtime/rpc-workscene-facade.js';
import { RpcManagementFacade } from './runtime/rpc-management-facade.js';
import { RpcSchedulerFacade } from './runtime/rpc-scheduler-facade.js';
import { RpcConfirmationBroker } from './runtime/rpc-confirmation-broker.js';
import { ReplLocalView } from './runtime/repl-local-view.js';
import { createRuntimeConfigurationProvider } from './runtime/runtime-configuration-provider.js';
import { serverStatusLines } from './runtime/server-status-presentation.js';
import { createObservedTurnPresenter } from './runtime/observed-turn-presenter.js';
import { createTextRunEventBinding } from './runtime/text-run-event-binding.js';
import { createTextRunFeedback } from './runtime/text-run-feedback.js';
import { projectHistoryTail } from './runtime/conversation-history-projection.js';
import { createAdvancementControlPresenter } from './runtime/advancement-control-presenter.js';
import { createLifecycleDiagnosticsPresenter } from './runtime/lifecycle-diagnostics-presenter.js';
import { createPublishResultPresenter } from './runtime/publish-result-presenter.js';
import { renderResumedAdvancementNotice } from './advancement-presentation.js';
import { prepareUserTurnInput } from './user-turn-input.js';
import { prepareSessionSendEngage } from './session-engage.js';
import { InputMaterialRegistry } from './input-material-registry.js';
import { TerminalSessionCommands, projectTerminalTurnOutcome, type TerminalTurnOutcome } from './terminal/session-commands.js';
import { TerminalInformationCommands, TERMINAL_INFORMATION_COMMANDS } from './terminal/information-commands.js';
import { TerminalDecisionCommands, TERMINAL_DECISION_COMMANDS } from './terminal/decision-commands.js';
import { TerminalTasks, TERMINAL_TASK_COMMANDS } from './terminal/tasks.js';
import { TerminalSkillCommands } from './terminal/skill-commands.js';
import { projectTerminalConfirmation, resolveTerminalConfirmation } from './terminal/confirmation.js';
import { TextLineInput, TextSessionOutput, createTextSelection, attachTextInterrupts,
  type TextSink, type TextSignalEmitter } from './text-session-io.js';

export interface TextSessionOptions {
  readonly input?: Readable;
  readonly output?: TextSink;
  readonly error?: TextSink;
  readonly connection?: CoreHostConnection;
  readonly signal?: AbortSignal;
  readonly signals?: TextSignalEmitter;
  readonly runtimeRecords?: LogRecordPort;
  readonly configurationRecords?: LogRecordPort;
  readonly checkConfiguration?: () => Promise<StartupCheckResult>;
}

export async function startTextSession(home: string, configPath: string, options: TextSessionOptions = {}): Promise<number> {
  // Establish the paused reader before startup; demand follows turn completion,
  // and a synchronous EOF cannot discard already buffered pipe input.
  const input = new TextLineInput(options.input ?? process.stdin);
  const output = new TextSessionOutput(options.output ?? process.stdout);
  const errors = new TextSessionOutput(options.error ?? process.stderr);
  const connection = options.connection ?? new CoreHostConnection(defaultCoreHostConnectionDeps(home, options.runtimeRecords));
  const lifetime = new AbortController();
  const off: Array<() => void> = [];
  let controller: ConversationController<TerminalTurnOutcome> | undefined;
  let session: TerminalSessionCommands | undefined;
  let information: TerminalInformationCommands | undefined;
  let decision: TerminalDecisionCommands | undefined;
  let tasks: TerminalTasks | undefined;
  let skills: TerminalSkillCommands | undefined;
  let confirmations: RpcConfirmationBroker | undefined;
  let turnRunning = false, interrupted = false, closing = false, failed = false;
  let activeTurn: Promise<unknown> | null = null;
  let contextWork: Promise<void> = Promise.resolve();
  let connectionClosing: Promise<void> | undefined;
  const disposeConnection = () => connectionClosing ??= connection.dispose();
  const fail = (error: unknown): void => {
    failed = true;
    errors.line(error instanceof Error ? error.message : String(error));
  };
  const requestExit = (): void => {
    closing = true; lifetime.abort(); input.dispose();
    // Cancelling before the controller exists also cancels connection setup.
    // Disposing this surface connection does not stop the independent Host.
    if (!controller) void disposeConnection().catch(fail);
  };
  const abort = async (): Promise<void> => {
    interrupted = true;
    await controller?.abort();
  };
  const externalAbort = (): void => { requestExit(); void abort().catch(fail); };
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  off.push(() => options.signal?.removeEventListener('abort', externalAbort));
  if (options.signal?.aborted) externalAbort();
  off.push(attachTextInterrupts({ signals: options.signals ?? process, active: () => turnRunning,
    abort, abortBackground: async () => {
      const stopped = await controller?.abortBackgroundTask() ?? false;
      if (stopped) output.line('已请求停止当前任务；已发生的动作不会回滚。');
      return stopped;
    }, exit: requestExit, error: fail }));
  const invalidate = (): void => { session?.invalidate(); information?.invalidate(); decision?.invalidate(); tasks?.invalidate(); };
  off.push(connection.onDisconnect(() => {
    invalidate();
    if (!closing) output.line('连接已断开；正在核对原运行，不会重新发送已提交的输入。');
  }));

  // Compute the process result after the lifetime's finally has also settled.
  // A cleanup failure must not be hidden by an earlier successful return.
  const run = async (): Promise<number> => {
    try {
      if (closing) return 0;
      const startup = await connectReplHost({ connection, signal: lifetime.signal, starting: () => {}, settled: () => {},
        checkConfiguration: () => observeStartupPhase(options.runtimeRecords, 'check-configuration', options.checkConfiguration ?? (() => runStartupCheck({ homeDir: home, configPath, mode: 'repl',
          isTTY: false, records: options.configurationRecords }))) });
      if (startup.kind === 'configuration') {
        if (options.runtimeRecords) recordStartupFailure(options.runtimeRecords, startup.result);
        return presentTextStartupResult(startup.result, errors);
      }
      if (startup.kind === 'unavailable') {
        recordRuntimeFailure(options.runtimeRecords, startup.error, 'host-connection-failed');
        await showUnavailableHistory(home, output).catch(fail);
        fail(startup.error); return 1;
      }
      if (closing) return 0;
      const conversation = new RpcConversationFacade(connection);
      const workscene = new RpcWorksceneFacade(connection);
      const management = new RpcManagementFacade(connection);
      const scheduler = new RpcSchedulerFacade({ connection });
      const local = new ReplLocalView({ management,
        configuration: createRuntimeConfigurationProvider(() => loadConfig({ configPath })) });
      const choose = createTextSelection(output);
      const display = createTextSelection(output, { readOnly: true });
      const present = async (value: { title: string; message: string; error?: boolean }): Promise<void> => {
        if (value.error) failed = true;
        (value.error ? errors : output).line(`${value.title}\n${value.message}`);
      };
      const current = () => !closing && connection.getStatus().kind === 'connected' ? controller : undefined;
      const watching = (conversationId: string) => !controller || controller.isWatching(conversationId);
      const observed = createObservedTurnPresenter({ writer: output, flushOutput: output.ensureSegmentBreak,
        isLocalTurn: turn => controller?.isLocalTurn(turn) ?? false, width: () => 100 });
      const lifecycleWarningDeduper = createLifecycleWarningDeduper();
      const eventBus = createTextRunEventBinding({ link: connection, observed: observed.decorateRunBus,
        watching, writer: output, lifecycleWarningDeduper, onError: fail });
      off.push(() => eventBus.dispose());
      const feedback = createTextRunFeedback({ link: connection, watching, line: output.line });
      off.push(() => feedback.dispose());
      // Control notices can arrive inside auto-resume, before the controller exists.
      for (const presenter of [
        createAdvancementControlPresenter({ link: connection, writer: output, width: () => 100, filter: event => watching(event.conversationId) }),
        createLifecycleDiagnosticsPresenter({ link: connection, writer: output, deduper: lifecycleWarningDeduper, filter: event => watching(event.conversationId) }),
        createPublishResultPresenter({ link: connection, writer: output, filter: event => watching(event.conversationId) }),
      ]) off.push(() => presenter.dispose());
      confirmations = new RpcConfirmationBroker({ link: connection, onResolveError: fail });
      off.push(confirmations.onRequest(request => {
        const broker = confirmations!;
        void Promise.resolve().then(() => resolveTerminalConfirmation(projectTerminalConfirmation(request), choose))
          .then(result => { broker.resolve(request.id, result); })
          .catch(error => { fail(error); broker.resolve(request.id, { kind: 'deny' }); });
      }));
      const [initial] = await Promise.all([selectInitialConversation(conversation, {
        confirmContinuation: async unavailable => {
          output.line(`当前会话能力受限：${unavailable.join('；')}。非交互文本输入不能代为确认继续。`);
          return false;
        },
      }), local.refresh()]);
      if (closing) return 0;
      controller = new ConversationController<TerminalTurnOutcome>({ conversation, workscene,
        projectOutcome: projectTerminalTurnOutcome,
        onYield: event => output.yield(event),
        onObservedInputs: turn => observed.onObservedInputs(turn),
        onObservedTurnDelta: turn => observed.onObservedTurnDelta(turn),
        onObservedTurnComplete: turn => observed.onObservedTurnComplete(turn),
        onNotice: output.line,
        onActivity: () => output.line('另一个入口有新动态，可用 /resume 查看。'),
      }, initial.active);
      const activeController = controller;
      const resumed = (value?: SessionAdvancementStateSnapshot): void => {
        if (value) output.line(renderResumedAdvancementNotice(value, 100));
        if (value?.status === 'awaiting-rubric-confirmation') output.line('任务保持待确认，请在交互终端继续。');
      };
      const history = async (): Promise<void> => {
        const id = activeController.current.conversationId;
        const page = await activeController.history(id);
        if (id !== activeController.current.conversationId) return;
        for (const entry of projectHistoryTail(page.runs.map(run => run.record)).entries) {
          const origin = entry.sourceConversationId ? `来自对话 ${entry.sourceConversationId}` : entry.fromAdvancement ? '任务推进' : '用户';
          output.line(`[${origin}] ${entry.userText}`);
          for (const item of entry.inputs ?? []) output.line(`[${item.sourceConversationId ? `来自对话 ${item.sourceConversationId}` : '用户'}] ${item.text}`);
          for (const sent of entry.sent ?? []) output.line(sent);
          output.line(entry.assistantText ?? '（此轮未生成回复）');
        }
        for (const item of page.inputsOutsideHistory ?? []) output.line(`[已接纳输入] ${extractText(item.message)}`);
      };
      const changed = async (advancement?: SessionAdvancementStateSnapshot): Promise<void> => {
        information?.invalidate(); decision?.invalidate(); tasks?.invalidate();
        await local.refresh(); await history().catch(() => {}); resumed(advancement);
        await confirmations!.refresh().catch(fail);
      };
      session = new TerminalSessionCommands({ controller: current, workscene, signal: lifetime.signal, choose,
        publish: async message => output.line(message), changed, activeTurn: () => activeTurn,
        createScene: async () => output.line('新建工作场景需要交互确认，请在交互终端继续。'),
        deleting: () => () => {}, deletedCurrent: requestExit });
      information = new TerminalInformationCommands({ controller: current, signal: lifetime.signal, choose: display,
        getPrimaryModel: () => local.primaryModel, logs: management.logs(), publish: present });
      decision = new TerminalDecisionCommands({ controller: current, management, signal: lifetime.signal, choose: display,
        publish: present, resumeRubric: async () => output.line('任务保持待确认，请在交互终端继续。') });
      tasks = new TerminalTasks({ controller: current, conversation, scheduler, signal: lifetime.signal, choose: display,
        publish: present, changed: () => {} });
      off.push(conversation.onChanged(change => {
        tasks!.apply(change);
        const reaction = activeController.applySessionChanged(change);
        if (reaction.kind === 'ignored') return;
        if (reaction.kind === 'deleted') {
          invalidate();
          contextWork = contextWork.then(async () => {
            if (closing) return;
            output.line('当前对话已在其他入口删除，正在创建新对话。');
            await activeController.newConversation(); await changed();
          }).catch(error => { fail(error); requestExit(); });
        } else if (reaction.kind === 'cleared') {
          information?.invalidate(); decision?.invalidate();
          output.line('当前对话历史已清空。');
        }
      }));
      off.push(connection.onLifecycleNotice(async notice => {
        if (closing) return;
        if (notice.kind === 'host-replaced' || notice.kind === 'reconnected') {
          output.line('连接已恢复，继续观察原运行。');
          await activeController.reattachActiveObserver();
          await local.refresh(); await confirmations!.refresh(); await skills?.refresh();
        } else if (notice.kind === 'version-pending') output.line(`知行版本待更新：当前 ${notice.serverVersion}，CLI ${notice.clientVersion}。`);
      }));
      off.push(scheduler.onEvent(event => {
        if (event.kind === 'completed') output.line(event.status === 'ok'
          ? `任务完成：${event.name}${event.summary ? `\n${event.summary}` : ''}`
          : `任务失败：${event.name}\n${event.error}`);
        else if (event.kind === 'disabled') output.line(`任务已停用：${event.name}\n${event.reason}`);
      }));
      const registry = new DefaultCommandRegistry();
      const dispatcher = new CommandDispatcher({ registry });
      const runtime = (): RuntimeContext => ({ sessionBusy: turnRunning, workspaceId: null,
        cwd: local.workspaceRoot ?? process.cwd(), target: 'cli', features: { [FEATURE_CHROME]: false }, now: Date.now() });
      for (const definition of Object.values(BUILTIN_COMMANDS)) {
        // Keep the same descriptors and capability predicates as the old text path.
        registry.register(definition);
        dispatcher.registerHandler(definition.id, async context => {
          const name = definition.name, argument = String(context.args._rest ?? '');
          if (['new', 'name', 'clear', 'resume', 'work'].includes(name)) await session!.run(name, argument);
          else if ((TERMINAL_INFORMATION_COMMANDS as readonly string[]).includes(name) || (name === 'config' && argument.trim())) await information!.run(name, argument);
          else if ((TERMINAL_DECISION_COMMANDS as readonly string[]).includes(name)) await decision!.run(name, argument);
          else if ((TERMINAL_TASK_COMMANDS as readonly string[]).includes(name)) await tasks!.run(name, argument);
          else if (name === 'help') for (const command of registry.list(runtime())) output.line(`/${command.name}  ${command.description}`);
          else if (name === 'status') {
            await local.refresh();
            for (const line of serverStatusLines(activeController.current.name, local.primaryModel, local.networkProxy, local.hostInfo)) output.line(line);
          } else if (name === 'stop') output.line('当前终端不支持选择交互，未执行停止。请在交互终端使用 /stop。');
          else if (name === 'exit') {
            if (activeController.current.mode.kind === 'workscene') await session!.run('exit', argument);
            else requestExit();
          } else output.line('此命令需要交互终端。');
          return {};
        });
      }
      skills = new TerminalSkillCommands({ registry, client: new SkillCatalogRpcClient(connection), signal: lifetime.signal,
        onError: error => errors.line(`技能命令读取失败：${error.message}`) });
      await skills.refresh().catch(() => {});
      await activeController.start();
      await confirmations.refresh().catch(fail);
      output.line(`知行 · ${activeController.current.name}`);
      recordFirstSurfaceOutput(options.runtimeRecords);
      if (initial.resumedConversationName !== null) await history().catch(() => {});
      if (initial.adoptionReview) output.line(initial.adoptionReview.message);
      resumed(initial.advancement);
      options.runtimeRecords?.record({ event: 'interactionReady', result: 'success', data: { sinceProcessStartMs: Math.round(process.uptime() * 1000) } });
      const materials = new InputMaterialRegistry();
      for (;;) {
        const line = await input.next();
        if (line === undefined || closing) break;
        await contextWork;
        if (closing || !line.trim()) continue;
        try {
          // A later line may establish a new connection. This line is dispatched
          // once, and no failure path recursively invokes send/dispatch again.
          await connection.ensure();
          let text = line;
          const controlText = normalizeLeadingSlashAlias(line.trim());
          if (controlText.startsWith('/')) {
            const result = await dispatcher.dispatch(controlText, runtime());
            if (result.kind === 'local-handled') continue;
            if (result.kind === 'agent-message') text = result.text;
            else if (result.kind === 'hybrid') text = result.systemMessage;
            else {
              if (result.kind === 'unknown') fail(`未知命令：/${result.commandName}。输入 /help 查看帮助。`);
              else if (result.kind === 'missing-handler') fail(`命令缺少执行体：${result.commandId}`);
              else fail(result.error);
              continue;
            }
          }
          const preparation = { workspaceRoot: local.workspaceRoot ?? process.cwd(), materialRegistry: materials };
          const prepared = await prepareUserTurnInput(text, preparation);
          if (!prepared) continue;
          const engage = await prepareSessionSendEngage(text, preparation);
          const preparationErrors = [...prepared.errors, ...(engage?.preparedQuestion.errors ?? []), ...(engage?.kind === 'invalid' ? engage.errors : [])];
          if (preparationErrors.length) { for (const error of preparationErrors) fail(error); continue; }
          turnRunning = true; interrupted = false;
          try {
            const started = await activeController.beginUserTurn(prepared.input, engage?.kind === 'ready' ? { engage: engage.engage } : undefined);
            if (interrupted) await activeController.abort();
            if (started.kind === 'awaiting-rubric-confirmation') {
              output.line(started.submission?.disposition === 'not-saved' ? '旧任务仍待确认，本次新输入未保存。'
                : started.submission?.disposition === 'original-saved' || started.submission?.disposition === 'revision-saved'
                  ? '任务已保存，保持待确认。' : '无法确认本次输入是否已保存；请在交互终端核对待确认任务。');
              output.line('非交互文本输入不会自动确认、直接执行或取消任务。');
              continue;
            }
            if (started.kind === 'contract-failed') { fail(Error(`推进准则生成失败：${started.error.message}`)); continue; }
            if (started.kind === 'cancelled') { output.line('已取消这次任务。'); continue; }
            if (started.turn.rubricPublicationMessage) output.line(started.turn.rubricPublicationMessage);
            if (started.turn.advancementContinuation) output.line(started.turn.advancementContinuation.interruptedProxy
              ? '已中止当前推进以处理你的输入；已作为当前任务的补充继续推进。' : '已作为当前任务的补充继续推进。');
            activeTurn = started.turn.outcome;
            const outcome = await started.turn.outcome;
            output.ensureSegmentBreak();
            if (outcome.reason === 'error') fail(outcome.message);
            else output.line(outcome.message);
            if (outcome.control?.handedOff) output.line('已提交任务交接；后续结果将在原对话中返回。');
            if (outcome.control?.conflict) output.line('本轮存在多个工作场景控制请求，已按最终确认结果处理。');
            if (outcome.control?.navigation) await session.navigate(outcome.control.navigation);
          } finally { turnRunning = false; activeTurn = null; output.ensureSegmentBreak(); }
        } catch (error) { fail(error); }
      }
      return failed ? 1 : 0;
    } catch (error) {
      if (closing && lifetime.signal.aborted) return failed ? 1 : 0;
      recordRuntimeFailure(options.runtimeRecords, error, 'text-session-failed');
      fail(error); return 1;
    } finally {
      closing = true; lifetime.abort(); input.dispose();
      information?.dispose(); tasks?.dispose(); skills?.dispose(); decision?.invalidate(); session?.invalidate();
      for (const detach of off.reverse()) detach();
      confirmations?.dispose(); controller?.dispose();
      await contextWork.catch(() => {});
      await disposeConnection().catch(fail);
      output.ensureSegmentBreak();
    }
  };
  const code = await run();
  return code || (failed ? 1 : 0);
}

export function presentTextStartupResult(result: Exclude<StartupCheckResult, { kind: 'ready' }>, output: TextSessionOutput): number {
  if (result.kind === 'cancelled') { output.line('已取消配置。'); return 0; }
  if (result.kind === 'non-tty') {
    output.line('缺少必要配置，且当前环境非交互终端。');
    output.line('请在 TTY 终端中运行 `zhixing` 完成配置。缺失项：');
    for (const label of result.missingLabels) output.line(`- ${label}`);
  } else if (result.kind === 'semantic-error') {
    output.line(`[配置错误] ${result.filePath}`);
    for (const issue of result.issues) output.line(`${issue.field}：${issue.reason}\n修复：${issue.fix}`);
  } else output.line(`[${result.kind === 'secret-store-error' ? '秘密存储不可用' : '配置错误'}] ${result.message}\n${result.filePath}`);
  return 2;
}

async function showUnavailableHistory(home: string, output: TextSessionOutput): Promise<void> {
  const [{ createReadOnlyConversationStorage }, { listReadOnlyConversations, queryReadOnlyConversationHistory }] = await Promise.all([
    import('./serve/conversation-storage-infrastructure.js'), import('./runtime/read-only-conversation-query.js'),
  ]);
  const storage = createReadOnlyConversationStorage(home);
  output.line('知行暂时无法连接，当前仅显示最近本地对话；新请求尚未发送。');
  for (const conversation of await listReadOnlyConversations(storage, 5)) {
    output.line(`${conversation.name} (${conversation.conversationId})`);
    const page = await queryReadOnlyConversationHistory(storage, conversation.conversationId, 1);
    if (!page) continue;
    for (const entry of page.history.entries) { output.line(`[用户] ${entry.userText}`); output.line(entry.assistantText ?? '（此轮未生成回复）'); }
  }
  output.line('请使用 zz logs 查看运行日志，修复后重新打开。');
}
