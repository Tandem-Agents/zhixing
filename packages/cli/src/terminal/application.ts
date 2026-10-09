import { normalizeLeadingSlashAlias } from '@zhixing/terminal-ui/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { createRpcClient } from '@zhixing/server/client';
import { createPlatformSecretStore } from '@zhixing/secrets';
import { createTerminalCredentialRunner, terminalSecretPlatform } from './credential-command.js';
import { TerminalClipboard } from './clipboard.js';
import { isAbsolute } from 'node:path';
import { TerminalChannel } from '@zhixing/terminal-ui/channel';
import { consumeTerminalParentEndpoint, TerminalParentTransport } from '@zhixing/terminal-ui/parent-transport';
import { CheckpointDirectoryHandle } from '@zhixing/mesh/filesystem';
import { TERMINAL_LIMITS, type TerminalAction, type TerminalPasteDraft, type TerminalMessage, type TerminalView, type TerminalCandidateAcceptance, type TerminalTaskStatus, type TerminalProcessStatus } from '@zhixing/terminal-ui/protocol';
import type { SessionEventEnvelope } from '@zhixing/rpc/session-events';
import { getGlobalConfigPath, loadConfig, ConfigurationEditPendingError } from '@zhixing/providers/configuration';
import { beginEntryLogging } from '../logging/bootstrap.js';
import { beginRuntimeLogging, recordRuntimeFailure } from '../logging/runtime.js';
import { LocalLogStore } from '@zhixing/core/logging/storage';
import { LogFilesProcess } from '../logging/files-process.js';
import { createLogWriterProbe } from '../logging/writers.js';
import { createTerminalLogWorker, runTerminalLogObserver } from '../logging/terminal-worker.js';
import { terminalWriterDeadline, TERMINAL_LOG_EXIT_RESERVE_MS } from './close-budget.js';
import { CoreHostConnection, defaultCoreHostConnectionDeps, CoreHostUnavailableError } from '../runtime/core-host-connection.js';
import { connectReplHost } from '../runtime/repl-host-startup.js';
import type { HostReloadOptions } from '../runtime/configuration-application.js';
import type { NodeConfigurationEditSession } from '../runtime/configuration-edit.js';
import type { ConfigEditorRuntime, SectionId } from '../config-editor/types.js';
import type { TerminalConfigurationEditor } from './configuration-editor.js';
import type { TerminalSkillsOwner } from './skills.js';
import type { TerminalSkillCommands } from './skill-commands.js';
import type { TerminalDecisionCommands } from './decision-commands.js';
import type { TerminalTrustCandidates } from './trust-candidates.js';
import type { TerminalTasks } from './tasks.js';
import type { TerminalTaskNotices } from './task-notices.js';
import type { TerminalInformationCommands } from './information-commands.js';
import { TerminalSessionCommands, projectTerminalTurnOutcome, projectCommittedTerminalOutcome, type TerminalTurnOutcome } from './session-commands.js';
import type { SessionAdvancementStateSnapshot } from '@zhixing/rpc';
import type { SkillCatalogClient } from '@zhixing/core/skills/catalog';
import { ConversationController, selectInitialConversation, type AcceptedTurn, type AwaitingRubricConfirmationTurn, type BeginReferencedUserTurnResult, type SessionSendReferenceResult } from '../runtime/conversation-controller.js';
import { RpcConversationFacade } from '../runtime/rpc-conversation-facade.js';
import { RpcWorksceneFacade } from '../runtime/rpc-workscene-facade.js';
import { RpcManagementFacade } from '../runtime/rpc-management-facade.js';
import { ReplLocalView } from '../runtime/repl-local-view.js';
import { createRuntimeConfigurationProvider } from '../runtime/runtime-configuration-provider.js';
import type { AgentYield } from '@zhixing/core/loop';
import type { ConversationOutputSource } from '../runtime/conversation-output.js';
import { TerminalAssetClient } from './asset-client.js';
import { TerminalDisplayStore } from './display-store.js';
import { encodeBodyPage, type BodyPageRevision } from '@zhixing/terminal-ui/body-model';
import { projectRenderedHistoryReverse, textFragments, type TerminalHistoryPosition } from './history-segments.js';
import { TerminalBodyWork } from './body-work.js';
import { TerminalInputStore } from './input-store.js';
import { TerminalManagedFiles } from './managed-files.js';
import { TerminalInputHistoryReader } from './input-history.js';
import { TerminalPendingSendStore } from './pending-send-store.js';
import { prepareSessionSendSnapshot } from './prepare-session-send.js';
import type { SessionSendSnapshotIdentity } from '../runtime/rpc-conversation-facade.js';
import { InputMaterialRegistry, createMaterialTokenPattern } from '../input-material-registry.js';
import { ingestPastedMaterials, ingestSelectedMaterial } from '../input-material-ingest.js';
import { createUserSubmission } from '../runtime/user-submission.js';
import { createReadOnlyConversationStorage } from '../serve/conversation-storage-infrastructure.js';
import type { ConversationHistoryCursor } from '@zhixing/core/conversation/application';
import { createAdvancementContractSelectionRequest, primaryNearbyCandidate } from '../runtime/advancement-contract-selection.js';
import { chooseTerminalSelection, terminalSelectionActions, isSelectionCancelCause, type TerminalSelectionResponse } from './selection.js';
import { TerminalOutputProjection } from './output.js';
import { TerminalProcessSession } from './process-session.js';
import { TerminalRecovery } from './recovery.js';
import { normalizeCliArgs } from '../logging/entry-mode.js';
import { terminalEnvironment } from './environment-presentation.js';
import { RpcConfirmationBroker } from '../runtime/rpc-confirmation-broker.js';
import { projectTerminalConfirmation, resolveTerminalConfirmation } from './confirmation.js';
import { TerminalCandidatesOwner } from './candidates.js';
import { createStopSelectionRequest, shutdownStrategyForChoice } from '../runtime/stop-selection.js';
import { createTerminalOwnedProcessFactory, TerminalHostLauncher } from './host-launch.js';
import { boundedControlProjection } from '../runtime/control-projection.js';

type View = Omit<TerminalView, 'generation'>;
type SkillsBinding = { client: SkillCatalogClient; commands: TerminalSkillCommands; route(name: string): { readonly route: 'input' } | undefined };
class EmptyTerminalSubmission extends Error {}

/** This private role is only admitted by S. It owns the single application
 * connection and configuration transaction; it never opens a terminal reader. */
export async function runTerminalApplication(timing?: {
  entryMs: number; writerDeclarationMs: number; moduleLoadMs: number; processCpuUserMs: number; processCpuSystemMs: number;
}): Promise<void> {
  const instance = process.env.ZHIXING_TERMINAL_INSTANCE;
  const home = process.env.ZHIXING_TERMINAL_HOME;
  const directory = process.env.ZHIXING_TERMINAL_DIRECTORY;
  const directoryIdentity = process.env.ZHIXING_TERMINAL_DIRECTORY_ID;
  const endpoint = consumeTerminalParentEndpoint();
  const identityPattern = process.platform === 'win32' ? /^[a-f0-9]+:[a-f0-9]{16}$/u : /^[0-9]+:[0-9]+$/u;
  if (endpoint === undefined || !instance || !/^[a-f0-9-]{36}$/u.test(instance) || !home || !isAbsolute(home) || !directory || !isAbsolute(directory) || !directoryIdentity || !identityPattern.test(directoryIdentity)) throw Error('terminal-application-admission');
  const transport = new TerminalParentTransport(endpoint);
  // Host self-execution inherits environment: never forward a surface role.
  for (const key of ['ZHIXING_TERMINAL_ROLE', 'ZHIXING_TERMINAL_INSTANCE', 'ZHIXING_TERMINAL_HOME', 'ZHIXING_TERMINAL_DIRECTORY', 'ZHIXING_TERMINAL_DIRECTORY_ID', 'ZHIXING_TERMINAL_PIPE']) delete process.env[key];
  const args = normalizeCliArgs(process.argv.slice(2));
  const early = beginEntryLogging(args.length ? 'independent-command' : 'repl');
  if (timing) early.records.record({ event: 'terminalApplicationLoad', data: timing, refs: [{ kind: 'terminal', id: instance }] });
  const application = new TerminalApplication(instance, home, directory, transport, directoryIdentity, args);
  await application.run();
}

class TerminalApplication {
  readonly #files: TerminalManagedFiles;
  readonly #channel: TerminalChannel;
  readonly #hosts: TerminalHostLauncher;
  readonly #logging: ReturnType<typeof beginRuntimeLogging>;
  readonly #secretStore: ReturnType<typeof createPlatformSecretStore>;
  readonly #secretPlatform = terminalSecretPlatform();
  readonly #connection: CoreHostConnection;
  readonly #conversation: RpcConversationFacade;
  readonly #workscene: RpcWorksceneFacade;
  readonly #management: RpcManagementFacade;
  #resolvedLocalView?: ReplLocalView;
  readonly #assets: TerminalAssetClient;
  readonly #display: TerminalDisplayStore;
  readonly #inputs: TerminalInputStore;
  readonly #pendingSend: TerminalPendingSendStore;
  readonly #inputHistoryReader: TerminalInputHistoryReader;
  readonly #outputProjection: TerminalOutputProjection;
  readonly #processSession: TerminalProcessSession;
  readonly #recovery: TerminalRecovery;
  #processStatus?: TerminalProcessStatus;
  #processStatusDirty = false;
  #processStatusSending?: Promise<void>;
  readonly #bodyWork: TerminalBodyWork;
  #displayUnavailable = false;
  #displayHadGap = false;
  readonly #confirmations: RpcConfirmationBroker;
  readonly #pendingConfirmations = new Set<string>();
  #confirmation?: { id: string; invalid: boolean };
  #presentingConfirmation = false;
  #selectionDepth = 0;
  #confirmationBlocked = false;
  readonly #materials = new InputMaterialRegistry(4 * 1024 * 1024);
  readonly #candidates: TerminalCandidatesOwner;
  readonly #inputHistory: string[] = [];
  #pendingRubric?: AwaitingRubricConfirmationTurn;
  #deferredRubric?: Omit<AwaitingRubricConfirmationTurn, 'rubricDraft'>;
  #pendingRubricNotice?: string;
  readonly #configPath: string;
  readonly #abort = new AbortController();
  readonly #clipboard = new TerminalClipboard(this.#abort.signal);
  readonly #requests = new Set<number>();
  readonly #completion: Promise<void>;
  readonly #state = { activeTurnPromise: null as Promise<unknown> | null };
  #resolve!: () => void;
  #controller?: ConversationController<TerminalTurnOutcome>;
  #editor?: TerminalConfigurationEditor;
  #selection?: { id: string; allowed: ReadonlySet<string>; field: boolean; resolve(selected?: TerminalSelectionResponse): void };
  #history?: { conversationId: string; before?: ConversationHistoryCursor; position?: TerminalHistoryPosition; hasMore: boolean; offline: boolean; recoveryRunIds?: readonly string[] };
  #displayStart?: number;
  #displayRevision = 0;
  #displaySent?: BodyPageRevision;
  #closing?: Promise<void>;
  #generation = 0;
  #hello = false;
  #started = false;
  #operation?: Promise<void>;
  #skills?: TerminalSkillsOwner;
  #skillCommands?: TerminalSkillCommands;
  #decisionCommands?: TerminalDecisionCommands;
  #trustCandidates?: TerminalTrustCandidates;
  #decisionBinding?: Promise<void>;
  #conversationEpoch = 0;
  #sessionCommands?: TerminalSessionCommands;
  #tasks?: TerminalTasks;
  #taskNotices?: TerminalTaskNotices;
  #tasksBinding?: Promise<void>;
  #information?: TerminalInformationCommands;
  #informationBinding?: Promise<void>;
  #taskStatus: TerminalTaskStatus = {};
  #taskStatusDirty = false;
  #taskStatusSending?: Promise<void>;
  #startupWatch?: string;
  #noticeDisplayReady?: Promise<void>;
  #releaseNoticeDisplay?: () => void;
  #sceneCreateAbort?: AbortController;
  readonly #localDeletions = new Set<string>();
  #skillsBinding?: Promise<SkillsBinding>;
  #historyRead?: Promise<void>;
  #nextHistoryRead = false;
  #readOnlyNeedsReset = false;
  #historySelection = false;
  #lastRequest = 0;
  #mainView: View = { kind: 'conversation', title: '知行', message: '', connected: false };
  #historyReturn?: View;
  #publishing?: Promise<void>;
  #nextView?: { readonly view: View; readonly current?: () => boolean };

  #closeDeadline = 0;
  constructor(readonly instance: string, readonly home: string, directory: string, readonly transport: TerminalParentTransport, directoryIdentity: string, readonly args: readonly string[] = []) {
    this.#completion = new Promise(resolve => { this.#resolve = resolve; });
    this.#secretStore = createPlatformSecretStore({ homeDir: home, commandRunner: createTerminalCredentialRunner(this.#abort.signal),
      ...this.#secretPlatform });
    this.#logging = beginRuntimeLogging(home, args.length ? 'independent-command' : 'repl', undefined, undefined, undefined,
      { activityDriven: true, requireCompleteClose: true, createStore: capacity => {
        // N is already an independently supervised process. Keep the bounded
        // async store here; only physical file operations need a separate
        // killable owner. S retains its isolated store so logging cannot hold
        // the foreground supervisor's lifecycle loop.
        const createFiles = createTerminalOwnedProcessFactory('log-files');
        const files = new LogFilesProcess(home, 5000, {
          createWorker: args => createTerminalLogWorker('log-files', args),
          createWindowsSession: () => CheckpointDirectoryHandle.createWindowsSession(5000, (executable, args) =>
            createFiles(executable, args ?? [], { deadline: Date.now() + 5000 }).child),
        });
        return new LocalLogStore({ files, capacity: capacity.arbiter, observeWriters: createLogWriterProbe(home, files, process.pid, runTerminalLogObserver) });
      } });
    this.#configPath = getGlobalConfigPath(process.env, home);
    this.#channel = new TerminalChannel(instance, (packet, done) => transport.send(packet, done),
      message => this.#receive(message), reason => void this.#close(70, reason));
    this.#recovery = new TerminalRecovery({ signal: this.#abort.signal, publish: view => this.#publish(view),
      send: message => this.#channel.send(message, 'body') });
    this.#hosts = new TerminalHostLauncher(this.#channel);
    this.#connection = new CoreHostConnection({ ...defaultCoreHostConnectionDeps(home, this.#logging.records, this.#hosts.start),
      createClient: url => createRpcClient({ url, maximumPendingRequests: 12, maximumQueuedRequestBytes: 1024 * 1024 }),
      createSurfaceClient: async () => {
        this.#abort.signal.throwIfAborted();
        const { createCurrentAnchorSurfaceRpcClient } = await import('../runtime/surface-core-host-link.js');
        return createCurrentAnchorSurfaceRpcClient({ zhixingHome: home, secretStore: this.#secretStore });
      },
    });
    this.#conversation = new RpcConversationFacade(this.#connection);
    this.#conversation.onChanged(payload => {
      this.#tasks?.apply(payload);
      const reaction = this.#controller?.applySessionChanged(payload);
      if (!reaction || reaction.kind === 'ignored') return;
      if (reaction.kind === 'renamed') this.#mainView = { ...this.#mainView, title: reaction.name };
      if (reaction.kind === 'cleared') {
        this.#processSession.reset();
        this.#invalidateAuxiliary(); this.#taskNotices?.resume();
        void this.#tasks?.refresh();
        this.#mainView = { ...this.#mainView, message: '对话内容已清空。' };
      }
      if (reaction.kind === 'deleted') {
        if (this.#localDeletions.has(payload.conversationId)) return;
        this.#invalidateConversation();
      }
      void (async () => {
        if (reaction.kind === 'deleted') {
          try { await this.#controller?.newConversation(); await this.#conversationChanged(); this.#mainView = { ...this.#mainView, message: '当前对话已删除，已创建新对话。' }; }
          catch { this.#deletedCurrent(); }
        }
        await this.#publish(this.#mainView);
      })().catch(() => this.#close(70, 'terminal-session-change-undelivered'));
    });
    this.#workscene = new RpcWorksceneFacade(this.#connection);
    this.#management = new RpcManagementFacade(this.#connection);
    this.#candidates = new TerminalCandidatesOwner(() => ({ sessionBusy: !!this.#state.activeTurnPromise, workspaceId: null,
      cwd: this.#resolvedLocalView?.workspaceRoot ?? process.cwd(), target: 'cli', features: { chrome: true }, now: Date.now() }));
    this.#assets = new TerminalAssetClient(this.#channel, this.#abort.signal);
    const createFilesystem = createTerminalOwnedProcessFactory('filesystem');
    const filesystemSession = CheckpointDirectoryHandle.createSession(5000, (executable, args) => {
      this.#abort.signal.throwIfAborted();
      const creating = new AbortController();
      const cancelCreation = () => creating.abort();
      this.#abort.signal.addEventListener('abort', cancelCreation, { once: true });
      try {
        const owned = createFilesystem(executable, args ?? [], { signal: creating.signal, deadline: Date.now() + 5000 });
        // Business cancellation seals new work. An established file owner must
        // remain alive for ManagedFiles/session cleanup under the close deadline.
        void owned.ready.finally(() => this.#abort.signal.removeEventListener('abort', cancelCreation)).catch(() => {});
        return owned.child;
      } catch (error) {
        this.#abort.signal.removeEventListener('abort', cancelCreation); throw error;
      }
    }, true);
    this.#files = new TerminalManagedFiles(directory, directoryIdentity, filesystemSession,
      () => void this.#close(74, 'terminal-filesystem-unconfirmed'));
    this.#display = new TerminalDisplayStore(directory, this.#logging.capacity.arbiter, this.#assets, this.#abort.signal, this.#files);
    this.#inputs = new TerminalInputStore(directory, this.#logging.capacity.arbiter, this.#assets, this.#abort.signal, this.#files);
    this.#pendingSend = new TerminalPendingSendStore(this.#files, this.#logging.capacity.arbiter, this.#assets, this.#abort.signal);
    this.#inputHistoryReader = new TerminalInputHistoryReader(this.#inputs);
    this.#bodyWork = new TerminalBodyWork(this.#logging.capacity.arbiter, this.#abort.signal);
    this.#processSession = new TerminalProcessSession({
      currentConversation: () => this.#controller?.current.conversationId,
      changed: status => { this.#processStatus = status; this.#sendProcessStatus(); },
      block: block => this.#outputProjection.appendProcessBlock(block),
      gap: () => { void this.#displayGap().catch(() => this.#close(70, 'terminal-process-gap-undelivered')); },
      columns: () => 80, // U applies actual display-cell width to the retained source tail.
    });
    this.#outputProjection = new TerminalOutputProjection((segment, stable) => this.#display.append(segment, false, undefined, stable), () => this.#displayPage(), error => this.#displayGap(error), {
      work: action => this.#bodyWork.run(action),
      amend: (blockId, change) => this.#display.amend(blockId, change),
      seal: blockId => this.#display.seal(blockId),
    }, {
      accept: (event, source) => this.#processSession.acceptYield(event, source),
    });
    const releaseProcessEvents = this.#connection.onNotification('session.event', value => {
      if (value && typeof value === 'object') this.#processSession.acceptEvent(value as SessionEventEnvelope);
    });
    this.#abort.signal.addEventListener('abort', releaseProcessEvents, { once: true });
    this.#confirmations = new RpcConfirmationBroker({ link: this.#connection, onResolveError: () => {
      this.#mainView = { ...this.#mainView, message: '确认应答未获得成功回执；正在重新核对请求状态，不会自动允许。' };
      void this.#publish(this.#mainView).catch(() => {});
    } });
    this.#confirmations.onRequest(request => {
      if (request.id.length > 512 || this.#pendingConfirmations.size >= 128) { void this.#close(70, 'terminal-confirmation-capacity'); return; }
      this.#pendingConfirmations.add(request.id); this.#drainConfirmations();
    });
    this.#confirmations.onInvalidated(id => {
      this.#pendingConfirmations.delete(id);
      if (this.#confirmation?.id !== id) return;
      this.#confirmation.invalid = true;
      const selection = this.#selection; this.#selection = undefined;
      if (selection) {
        selection.resolve({ itemId: 'cancelled', cancelCause: 'aborted' }); void this.#channel.send({ type: 'invalidate', requestId: selection.id }).catch(() => {});
      }
    });
    this.#connection.onDisconnect(() => {
      this.#processSession.reset();
      ++this.#conversationEpoch;
      this.#invalidateAuxiliary();
      this.#sceneCreateAbort?.abort();
      this.#sessionCommands?.invalidate();
      this.#decisionCommands?.invalidate(); this.#trustCandidates?.invalidate(); this.#candidates.close();
      this.#selection?.resolve({ itemId: 'cancelled', cancelCause: 'aborted' }); this.#selection = undefined;
      this.#mainView = { ...this.#mainView, connected: false, message: '连接已断开。可查看已有内容、编辑本机配置或显式重试。',
        choices: [{ id: 'retry', label: '重试连接' }, { id: 'config', label: '本机配置' }, { id: 'exit', label: '退出终端' }] };
      if (!this.#editor && !this.#operation) void this.#publish(this.#mainView).catch(() => this.#close(70, 'view-undelivered'));
    });
  }

  // A malformed local configuration is a recoverable startup result. Do not
  // read it while constructing the surface, before its IPC/lifecycle exists.
  get #localView(): ReplLocalView {
    return this.#resolvedLocalView ??= new ReplLocalView({ management: this.#management,
      configuration: createRuntimeConfigurationProvider(() => loadConfig({ configPath: this.#configPath })) });
  }

  async run(): Promise<void> {
    this.transport.on('message', this.#message);
    this.transport.once('disconnect', this.#disconnected);
    process.on('SIGINT', this.#interrupted);
    process.on('SIGTERM', this.#interrupted);
    process.on('uncaughtException', this.#uncaught);
    process.on('unhandledRejection', this.#uncaught);
    // S may finish spawning while this module's dependency graph is loading.
    // Announce only after the actual IPC consumer exists; no startup packet is lost.
    await this.#channel.send({ type: 'hello', role: 'application' });
    await this.#completion;
  }
  readonly #message = (value: unknown): void => { this.#channel.accept(value); };
  readonly #disconnected = (): void => { void this.#close(70, 'supervisor-disconnected', false); };
  readonly #interrupted = (): void => { void this.#close(this.args.length ? 130 : 0, 'application-interrupted'); };
  readonly #uncaught = (error: unknown): void => {
    // Seal work synchronously before recorder or resource cleanup.
    this.#abort.abort(); void this.#close(71, 'application-failed');
    recordRuntimeFailure(this.#logging.records, error, 'terminal-application-failed');
  };

  #receive(message: TerminalMessage): void {
    if (message.type === 'close') {
      if (!Number.isSafeInteger(message.deadline)) throw Error('terminal-close-deadline');
      this.#closeDeadline = this.#closeDeadline ? Math.min(this.#closeDeadline, message.deadline) : message.deadline;
      void this.#close(this.args.length ? 130 : 0, 'supervisor-close', false); return;
    }
    if (this.#abort.signal.aborted) return;
    if (message.type === 'assets-result') { this.#assets.receive(message); return; }
    if (message.type === 'host-state') { this.#hosts.accept(message); return; }
    if (message.type === 'hello') {
      if (this.#hello || message.role !== 'application') throw Error('terminal-application-hello');
      this.#hello = true; return;
    }
    if (!this.#hello || message.type !== 'request' || !Number.isSafeInteger(message.id) || message.id <= this.#lastRequest ||
      !message.action || typeof message.action.kind !== 'string') throw Error('terminal-application-request');
    this.#lastRequest = message.id;
    if (this.#requests.size >= TERMINAL_LIMITS.pendingRequests) throw Error('terminal-application-request-capacity');
    this.#requests.add(message.id);
    // Receipt acknowledges this finite operation, not its future business result.
    this.#reply(message.id, ['input-history-next', 'input-window'].includes(message.action.kind) ? 'body' : 'control', this.#action(message.action));
  }

  #reply(id: number, lane: 'body' | 'control', result: Promise<unknown>): void {
    // A reply blocked on transport retains only its ID/result, not the parsed
    // request and all its already-consumed input-reference arrays.
    void result.then(
      value => this.#channel.send({ type: 'reply', id, value }, lane),
      error => {
        recordRuntimeFailure(this.#logging.records, error, 'terminal-request-failed');
        return this.#channel.send({ type: 'reply', id, error: '操作未完成；请查看当前页面，不会自动重发。' });
      },
    ).catch(() => this.#close(70, 'application-reply-undelivered')).finally(() => this.#requests.delete(id));
  }

  async #action(action: TerminalAction): Promise<unknown> {
    if (this.args.length && !['startup', 'exit', 'interrupt', 'configuration-action', 'secret-value', 'selection', 'recovery-part', 'recovery-page', 'recovery-cancel', 'clipboard-read'].includes(action.kind)) throw Error('terminal-command-action-unavailable');
    switch (action.kind) {
      case 'startup':
        if (this.#started) throw Error('terminal-startup-already-requested');
        this.#started = true; this.#background(() => this.args.length ? this.#independentCommand() : this.#startup()); return { accepted: true };
      case 'recovery-part': case 'recovery-page': case 'recovery-cancel':
        await this.#recovery.act(action); return { accepted: true };
      case 'retry-connection': this.#leaveHistoryRead(); this.#background(() => this.#startup()); return { accepted: true };
      case 'display-retry': this.#background(() => this.#retryDisplay()); return { accepted: true };
      case 'exit': void this.#close(this.args.length ? 130 : 0, 'user-exit'); return { accepted: true };
      case 'configuration-action': case 'secret-value':
        if (!this.#editor) throw Error('terminal-editor-not-open');
        await this.#editor.act(action); return { accepted: true };
      case 'configuration-open':
        this.#background(() => this.#configuration(action.section === 'mcp' ? 'mcp' : 'config')); return { accepted: true };
      case 'selection': {
        const selection = this.#selection;
        if (!selection || selection.id !== action.requestId) throw Error('terminal-selection-expired');
        if (action.cancelled !== undefined && typeof action.cancelled !== 'boolean') throw Error('terminal-selection-cancel');
        if (action.cancelCause !== undefined && (!action.cancelled || !isSelectionCancelCause(action.cancelCause))) throw Error('terminal-selection-cause');
        if (action.cancelled && (action.itemId !== undefined || action.input !== undefined)) throw Error('terminal-selection-cancel');
        if (!action.cancelled && (!action.itemId || !selection.allowed.has(action.itemId))) throw Error('terminal-selection-invalid');
        if (action.input !== undefined && (!selection.field || typeof action.input !== 'string' || Buffer.byteLength(action.input) > 8192)) throw Error('terminal-selection-input');
        this.#selection = undefined; selection.resolve(action.cancelled ? { itemId: 'cancelled', cancelCause: action.cancelCause ?? 'escape' } : { itemId: action.itemId!, input: action.input }); return { accepted: true };
      }
      case 'confirmation': {
        const selection = this.#selection;
        if (!this.#confirmation || this.#confirmation.invalid || !selection || selection.id !== action.requestId) throw Error('terminal-confirmation-expired');
        if (action.cancelCause !== undefined && (!['reject', 'cancelled'].includes(action.action) || !isSelectionCancelCause(action.cancelCause))) throw Error('terminal-confirmation-cause');
        if (['reject', 'cancelled'].includes(action.action) && action.note !== undefined) throw Error('terminal-confirmation-cancel');
        if (!['reject', 'cancelled'].includes(action.action) && !selection.allowed.has(action.action)) throw Error('terminal-confirmation-option');
        if (action.note !== undefined && (!selection.field || typeof action.note !== 'string' || Buffer.byteLength(action.note) > 8192)) throw Error('terminal-confirmation-input');
        this.#selection = undefined;
        selection.resolve(['reject', 'cancelled'].includes(action.action) ? { itemId: 'cancelled', cancelCause: action.cancelCause ?? (action.action === 'reject' ? 'escape' : 'ctrl-c') } : { itemId: action.action, input: action.note }); return { accepted: true };
      }
      case 'display-page':
        if (action.start !== undefined && !Number.isSafeInteger(action.start)) throw Error('terminal-display-cursor');
        this.#displayStart = action.follow ? undefined : action.start;
        await this.#displayPage(); return { accepted: true };
      case 'history-previous':
        this.#displayStart = this.#display.first - 4;
        if (this.#history?.offline) this.#loadOfflineHistory(); else this.#background(() => this.#historyPage());
        return { accepted: true };
      case 'history-open': this.#background(() => this.#readOnly()); return { accepted: true };
      case 'history-close':
        this.#leaveHistoryRead();
        if (this.#mainView.kind === 'history' && this.#historyReturn) {
          this.#mainView = this.#historyReturn; await this.#publish(this.#mainView);
        }
        return { accepted: true };
      case 'rubric-resume': this.#background(() => this.#resolveRubric()); return { accepted: true };
      case 'confirmation-retry':
        this.#confirmationBlocked = false; await this.#confirmations.refresh(); this.#drainConfirmations(); return { accepted: true };
      case 'input-candidates':
        await this.#ensureDecisionBinding();
        return this.#candidates.query(action.revision, action.text, action.cursor, action.atStart);
      case 'candidate-ghost': return this.#candidates.acceptGhost(action.revision);
      case 'candidate-accept': return this.#acceptCandidate(action.revision, action.id);
      case 'candidate-revoke': return this.#candidates.revokeTrust(action.revision, action.id);
      case 'candidate-manage': {
        if (this.#operation || this.#presentingConfirmation || this.#abort.signal.aborted) throw Error('另一个操作正在进行，请稍后重试。');
        if (!['delete', 'rename', 'create'].includes(action.action)) throw Error('候选操作无效。');
        const target = this.#candidates.manage(action.revision, action.action, action.id);
        this.#background(() => this.#selectionFlow(async () => {
          try { await this.#ensureSessionBinding().manage(target.command, action.action, target.value); }
          finally { if (!this.#abort.signal.aborted) await this.#publish(this.#mainView); }
        }));
        return { accepted: true };
      }
      case 'input-begin': this.#inputs.begin(action.inputId, action.purpose, action.bytes); return { accepted: true };
      case 'input-part': await this.#inputs.part(action.inputId, action.index, action.text, action.final); return { accepted: true };
      case 'input-release': await this.#inputs.release(action.inputId); return { accepted: true };
      case 'input-window': return this.#inputs.window(action.inputId, action.position);
      case 'input-splice': {
        return this.#inputs.editWindow(action.inputId, action.start, action.end, action.replacementId);
      }
      case 'input-references': {
        return this.#inputs.reconcileReferences(action.version, action.ids, action.completed, action.cached).then(result => {
          this.#cleanupMaterials(); return result;
        });
      }
      case 'input-history': {
        if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset >= this.#inputHistory.length) return { end: true };
        const id = this.#inputHistory[this.#inputHistory.length - 1 - action.offset]!;
        return this.#inputHistoryReader.open(id);
      }
      case 'input-history-next': return this.#inputHistoryReader.next(action.ticket);
      case 'input-history-end': await this.#inputHistoryReader.close(action.ticket); return { accepted: true };
      case 'paste-finish': return this.#finishPaste(action.inputId, action.draft);
      case 'clipboard-read': {
        if (action.target === 'field') {
          let text = '';
          await this.#clipboard.read(async part => { text += part; }, 8192);
          return { text }; // Dedicated fields, including secrets, never enter draft storage.
        }
        if (action.target !== 'draft' || this.args.length) throw Error('terminal-clipboard-target');
        this.#inputs.begin(action.inputId, 'paste');
        try {
          let index = 0;
          const hasText = await this.#clipboard.read(text => this.#inputs.part(action.inputId, index++, text, false));
          if (!hasText) { await this.#inputs.release(action.inputId); return { empty: true }; }
          await this.#inputs.part(action.inputId, index, '', true);
          return { accepted: true };
        } catch (error) { await this.#inputs.release(action.inputId); throw error; }
      }
      case 'input-submit':
        if (!Number.isSafeInteger(action.version) || action.version < 0) throw Error('terminal-input-version');
        if (!this.#controller || this.#connection.getStatus().kind !== 'connected' || this.#history?.offline || this.#operation) {
          await this.#channel.send({ type: 'submission', inputId: action.inputId, version: action.version, accepted: false, message: '当前无法接纳输入，草稿已保留。' }); return { accepted: false };
        }
        this.#background(() => this.#submit(action.inputId, action.version)); return { accepted: true };
      case 'abort':
        if (this.#sceneCreateAbort) this.#sceneCreateAbort.abort(); else await this.#controller?.abort();
        return { accepted: true };
      case 'interrupt':
        if (this.#sceneCreateAbort) { this.#sceneCreateAbort.abort(); return { accepted: true }; }
        if (this.#state.activeTurnPromise) { await this.#controller?.abort(); return { accepted: true }; }
        if (this.#controller && await this.#controller.abortBackgroundTask()) {
          this.#mainView = { ...this.#mainView, message: '已请求停止当前后台工作；已发生的动作不会回滚。' }; await this.#publish(this.#mainView);
        } else void this.#close(this.args.length ? 130 : 0, 'user-interrupt');
        return { accepted: true };
      case 'status': this.#background(() => this.#status()); return { accepted: true };
      case 'command-route': return this.#commandRoute(action.name);
      case 'skills-action': return { handled: await this.#skills?.act(action.action) ?? false };
      case 'command': return this.#command(action.name, action.argument);
      default: throw Error('terminal-action-unavailable');
    }
  }

  #background(operation: () => Promise<void>): void {
    if (this.#operation || this.#presentingConfirmation || this.#abort.signal.aborted) throw Error('terminal-operation-in-progress');
    const work = operation().catch(async error => {
      if (this.#abort.signal.aborted) return;
      recordRuntimeFailure(this.#logging.records, error, 'terminal-operation-failed');
      this.#mainView = { ...this.#mainView, busy: false, message: error instanceof ConfigurationEditPendingError
        ? error.message : `操作未完成：${error instanceof Error ? error.message.slice(0, 2048) : '请重试或查看运行记录。'}`,
        ...(error instanceof ConfigurationEditPendingError ? { choices: [{ id: 'config', label: '重新打开配置并核对状态' }, { id: 'exit', label: '退出终端' }] } : {}) };
      if (!this.#editor) await this.#publish(this.#mainView);
    }).finally(() => { if (this.#operation === work) this.#operation = undefined; });
    this.#operation = work;
    void work.catch(() => this.#close(70, 'application-operation-undelivered'));
  }

  async #independentCommand(): Promise<void> {
    let code = 1;
    try {
      await this.#publish({ kind: 'unavailable', title: '知行 · 执行命令', message: '正在执行命令…', busy: true });
      this.#abort.signal.throwIfAborted();
      const { runIndependentCommand } = await import('./independent-command.js');
      code = await runIndependentCommand(this.args, {
        home: this.home, signal: this.#abort.signal, logging: this.#logging, secretStore: this.#secretStore,
        management: this.#management, recovery: this.#recovery,
        ensureManagement: async () => { this.#abort.signal.throwIfAborted(); await this.#connection.ensure(); this.#abort.signal.throwIfAborted(); },
        choose: view => this.#choosePage(view), send: message => this.#channel.send(message, 'body'),
        completeConfiguration: async () => {
          this.#abort.signal.throwIfAborted();
          const { checkStartupConfiguration } = await import('../runtime/startup-application.js');
          const result = await checkStartupConfiguration({ homeDir: this.home, configPath: this.#configPath, mode: 'repl', isTTY: true,
            secretStore: this.#secretStore, records: this.#logging.records,
            processIdentityResolver: this.#secretPlatform.processIdentityResolver,
            edit: session => this.#edit({ initialConfig: session.config, initialCredentials: session.credentials,
              writers: { save: async edit => { await session.save(edit); } } }, '设备初始配置', ['model', 'messaging']),
          });
          this.#abort.signal.throwIfAborted();
          if (result.kind === 'ready' || result.kind === 'cancelled') return result.kind;
          throw Error(result.kind === 'secret-store-error' ? '本机凭据仓库不可用。' : '设备配置尚未完成。');
        },
      });
    } catch {
      if (!this.#abort.signal.aborted) await this.#channel.send({ type: 'command-output', stream: 'stderr', text: '命令未能完成；已接受的操作请按原继续命令查询。\n' }, 'body');
    } finally {
      this.#recovery.close();
      void this.#close(code, code === 0 ? 'command-completed' : 'command-failed');
    }
  }

  async #startup(): Promise<void> {
    await this.#publish({ kind: 'conversation', title: '知行', message: '正在连接本机服务…', busy: true, connected: false });
    this.#invalidateAuxiliary();
    this.#holdNoticeDisplay();
    try {
    await this.#ensureTasksBinding();
    this.#taskNotices?.resume();
    const result = await connectReplHost({ connection: this.#connection, signal: this.#abort.signal, starting: () => {}, settled: () => {},
      checkConfiguration: async () => {
        this.#abort.signal.throwIfAborted();
        // Configuration/identity backends belong to this operation. Loading
        // them must not prevent the real IPC/close consumer from being installed.
        const { checkStartupConfiguration } = await import('../runtime/startup-application.js');
        this.#abort.signal.throwIfAborted();
        return checkStartupConfiguration({ homeDir: this.home, configPath: this.#configPath, mode: 'repl', isTTY: true,
        secretStore: this.#secretStore,
        processIdentityResolver: this.#secretPlatform.processIdentityResolver,
        records: this.#logging.records,
        edit: session => this.#edit({ initialConfig: session.config, initialCredentials: session.credentials,
          writers: { save: async edit => { await session.save(edit); } } }, '初始配置', ['model', 'messaging']),
        });
      },
    });
    this.#abort.signal.throwIfAborted();
    if (result.kind === 'configuration') {
      if (result.result.kind === 'cancelled') { void this.#close(0, 'startup-cancelled'); return; }
      const message = result.result.kind === 'secret-store-error'
        ? '本机凭据仓库当前不可用。请先恢复系统凭据访问，再重试。'
        : '本机配置未就绪。请修复配置后重试，或退出查看运行记录。';
      await this.#unavailable(message); return;
    }
    if (result.kind === 'unavailable') {
      await this.#unavailable(result.error instanceof CoreHostUnavailableError ? result.error.publicReason : '本机服务连接失败。'); return;
    }
    this.#holdNoticeDisplay(); this.#taskNotices?.resume();
    if (this.#controller) {
      const reloadHistory = !!this.#history?.offline;
      if (reloadHistory) {
        this.#mainView = { kind: 'conversation', title: this.#controller.current.name, connected: true };
      }
      await this.#controller.reattachActiveObserver({ reloadHistory }); await this.#localView.refresh();
    } else {
      const initial = await selectInitialConversation({
        list: () => this.#conversation.list(), listPage: (page) => this.#conversation.listPage(page), newConversation: () => this.#conversation.newConversation(),
        pendingContinuationConfirmation: () => this.#conversation.pendingContinuationConfirmation(),
        confirmContinuation: () => this.#conversation.confirmContinuation(),
        resumeIfExists: id => { this.#startupWatch = id; return this.#conversation.consumeResumeIfExists(id, result => {
          const snapshot = result.advancement, draft = snapshot?.pendingRubricDraft;
          if (snapshot?.status === 'awaiting-rubric-confirmation' && draft) {
            this.#deferredRubric = boundedControlProjection({ kind: 'awaiting-rubric-confirmation', conversationId: id,
              turnId: draft.originalTurnId, advancementSessionId: snapshot.advancementSessionId, rubricDraftId: draft.draftId }, 8192);
          }
          return boundedControlProjection({ ...result, advancement: undefined }, 256 * 1024);
        }); },
      }, { confirmContinuation: capabilities => this.#confirmLimited(capabilities) });
      this.#abort.signal.throwIfAborted();
      if (this.#history?.offline || this.#display.first !== this.#display.last) {
        this.#history = undefined;
        await this.#outputProjection.reset(() => !this.#abort.signal.aborted);
        await this.#display.reset(); this.#displayStart = undefined;
      }
      this.#controller = new ConversationController({ conversation: this.#conversation, workscene: this.#workscene,
        onYield: (event, source) => this.#output(event, source),
        presentationProfile: 'bounded-v1',
        onProcess: value => this.#processSession.accept(value),
        pagedRecovery: true,
        historyRunIds: () => this.#history?.conversationId === this.#controller?.current.conversationId ? this.#history?.recoveryRunIds ?? [] : [],
        onRecoveryDrain: source => {
          this.#outputProjection.end(source.conversationId, source.turnId, source.runId);
          return this.#outputProjection.drain();
        },
        onRecoveryYield: async (event, source) => {
          this.#abort.signal.throwIfAborted();
          if (this.#history?.offline) throw Error('terminal-recovery-offline');
          this.#output(event, source);
          await this.#outputProjection.drain();
        },
        onObservedInputFragment: async input => {
          this.#abort.signal.throwIfAborted();
          if (this.#history?.offline) throw Error('terminal-recovery-offline');
          if (this.#displayUnavailable || this.#display.paused) { await this.#displayGap(); return; }
          const identity = createHash('sha256').update(JSON.stringify([input.conversationId, input.runId, input.identity])).digest('hex');
          try { await this.#display.append({ blockId: `received:${identity}`, role: 'user', text: input.text, contentOffset: input.contentOffset, final: input.final }); }
          catch { await this.#displayGap(); return; }
          // Display acknowledgement is the completed store append. Refresh
          // failure cannot make this source fragment appear unconsumed.
          void this.#displayPage().catch(() => this.#close(70, 'terminal-recovery-display-undelivered'));
        },
        onRecoveryReset: async (conversationId, current) => {
          this.#processSession.reset();
          await this.#outputProjection.reset(current);
          if (!current()) return;
          this.#history = undefined;
          await this.#display.reset(); this.#displayStart = undefined;
          if (!current()) return;
          this.#history = { conversationId, hasMore: true, offline: false };
          await this.#historyPage(false);
        },
        projectOutcome: projectTerminalTurnOutcome,
        projectCommittedOutcome: projectCommittedTerminalOutcome,
        onRunTerminal: source => this.#processSession.end(source.conversationId, source.turnId, source.runId),
        onObservedTurnComplete: source => this.#outputProjection.end(source.conversationId, source.turnId, source.runId),
        onNotice: () => { /* Durable/current-owner state is refreshed at the next page boundary. */ },
      }, initial.active);
      await this.#localView.refresh();
      this.#mainView = { kind: 'conversation', title: initial.active.name, message: initial.resumedConversationName ? '已恢复最近对话。' : '准备就绪，开始你的第一条消息。', connected: true };
      this.#history = { conversationId: initial.active.conversationId, hasMore: true, offline: false };
      await this.#historyPage();
      await this.#controller.start();
      this.#ensureSessionBinding();
      if (initial.adoptionReview) this.#mainView = { ...this.#mainView, message: initial.adoptionReview.message };
    }
    this.#mainView = { ...this.#mainView, connected: true, busy: false, choices: undefined };
    this.#startupWatch = undefined;
    this.#historyReturn = undefined;
    await this.#publish(this.#mainView);
    this.#resumeNoticeDisplay();
    // Discovery starts after the connected first page; it is not part of N's
    // admission graph. A directly typed skill awaits this same refresh owner.
    void this.#ensureSkillsBinding().then(binding => binding.commands.refresh()).catch(error => this.#skillsFailed(error));
    void this.#tasks?.refresh();
    if (this.#pendingRubric || this.#deferredRubric) await this.#resolveRubric();
    await this.#confirmations.refresh();
    } finally { this.#resumeNoticeDisplay(); }
  }

  async #unavailable(message: string): Promise<void> {
    this.#invalidateAuxiliary();
    this.#mainView = { kind: 'unavailable', title: '知行 · 连接暂不可用', message,
      connected: false, choices: [{ id: 'retry', label: '重试连接' }, { id: 'history-open', label: '查看本机历史' },
        { id: 'config', label: '编辑本机配置' }, { id: 'exit', label: '退出终端' }] };
    await this.#publish(this.#mainView);
  }

  async #confirmLimited(capabilities: readonly string[]): Promise<boolean> {
    return await this.#choose({ kind: 'selection', title: '当前会话能力受限',
      message: capabilities.join('\n'), choices: [{ id: 'continue', label: '接受以上限制并继续' }, { id: 'cancel', label: '暂不继续' }] }) === 'continue';
  }

  async #choose(view: View): Promise<string | undefined> {
    const response = await this.#choosePage(view);
    return response?.cancelCause ? undefined : response?.itemId;
  }

  async #choosePage(view: View): Promise<TerminalSelectionResponse | undefined> {
    if (this.#selection) throw Error('terminal-selection-capacity');
    const id = randomUUID();
    const allowed = terminalSelectionActions(view);
    const response = new Promise<TerminalSelectionResponse | undefined>(resolve => { this.#selection = { id, resolve, field: !!view.field, allowed }; });
    await this.#publish({ ...view, kind: view.kind === 'confirmation' ? 'confirmation' : 'selection', requestId: id });
    return response;
  }

  async #selectionFlow<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#presentingConfirmation) throw Error('terminal-selection-occupied');
    this.#selectionDepth++;
    try { return await operation(); }
    finally { this.#selectionDepth--; this.#drainConfirmations(); }
  }

  async #readOnly(): Promise<void> {
    this.#historySelection = true;
    try {
      if (this.#mainView.kind !== 'history') this.#historyReturn = this.#mainView;
      const storage = createReadOnlyConversationStorage(this.home);
      const pages: Array<import('@zhixing/core/conversation/application').ConversationDirectoryCursor | undefined> = [undefined];
      for (;;) {
        const result = await storage.listPage!({ limit: 24, after: pages.at(-1) });
        const entries = result.records;
        this.#abort.signal.throwIfAborted();
        if (!entries.length && pages.length === 1) { this.#mainView = { ...this.#mainView, message: '本机还没有可查看的对话历史。' }; return; }
        const choices = entries.slice(0, 24).map(entry => ({ id: entry.conversationId, label: entry.name }));
        if (pages.length > 1) choices.push({ id: 'previous', label: '上一页' });
        if (result.next) choices.push({ id: 'next', label: '下一页' });
        choices.push({ id: 'cancel', label: '返回' });
        const selected = await this.#choose({ kind: 'selection', title: '本机历史 · 只读', message: '只读取已保存内容，不会启动或重发任务。', choices });
        if (!selected || selected === 'cancel') return;
        if (selected === 'next' || selected === 'previous') { if (selected === 'next' && result.next) pages.push(result.next); else pages.pop(); continue; }
        const entry = entries.find(value => value.conversationId === selected)!;
        const continuing = !this.#readOnlyNeedsReset && this.#mainView.kind === 'history' && this.#history?.offline && this.#history.conversationId === selected;
        if (continuing) { await this.#displayPage(); return; }
        this.#nextHistoryRead = false;
        this.#history = { conversationId: selected, hasMore: true, offline: true };
        // A committed-empty display may still own an in-flight first append.
        // Replacing history always waits for that write before resetting it.
        await this.#outputProjection.drain();
        await this.#display.reset(); this.#displayStart = undefined;
        this.#readOnlyNeedsReset = false;
        this.#mainView = { kind: 'history', title: `${entry.name} · 只读`, connected: false, message: '正在读取本机历史…',
          choices: [{ id: 'retry', label: '重试连接' }, { id: 'history-open', label: '选择其他历史' },
            { id: 'history-close', label: '返回连接页 · Esc' }, { id: 'exit', label: '退出终端' }] };
        if (this.#display.first === this.#display.last) this.#loadOfflineHistory(); else await this.#displayPage(); return;
      }
    } finally { this.#historySelection = false; await this.#publishHistoryView(); }
  }

  #publishHistoryView(): Promise<void> {
    return this.#historySelection || this.#abort.signal.aborted ? Promise.resolve() : this.#publish(this.#mainView);
  }

  #leaveHistoryRead(): void {
    this.#nextHistoryRead = false;
    if (this.#history?.offline) {
      // Invalidate the consumer immediately. The one physical read still owns
      // its lifetime; a newer navigation never spawns another concurrent read.
      this.#history = { conversationId: this.#history.conversationId, hasMore: true, offline: true };
      this.#readOnlyNeedsReset = true;
    }
  }

  #loadOfflineHistory(): void {
    if (this.#abort.signal.aborted || !this.#history?.offline) return;
    if (this.#historyRead) { this.#nextHistoryRead = true; return; }
    const history = this.#history;
    const work = this.#historyPage().catch(async error => {
      if (this.#abort.signal.aborted || this.#history !== history) return;
      recordRuntimeFailure(this.#logging.records, error, 'terminal-history-read-failed');
      this.#mainView = { ...this.#mainView, busy: false, message: '本机历史暂时无法读取。可返回连接页、重试或选择其他历史。' };
      await this.#publishHistoryView();
    }).finally(() => {
      if (this.#historyRead === work) this.#historyRead = undefined;
      const next = this.#nextHistoryRead; this.#nextHistoryRead = false;
      if (next && this.#mainView.kind === 'history') this.#loadOfflineHistory();
    });
    this.#historyRead = work;
    void work.catch(() => this.#close(70, 'terminal-history-read-undelivered'));
  }

  async #historyPage(updateStatus = true): Promise<void> {
    const history = this.#history;
    if (!history || !history.hasMore) {
      this.#mainView = { ...this.#mainView, message: '已到达最早的可用历史。' };
      await this.#publishHistoryView(); return;
    }
    const options = { limit: 4, before: history.before };
    const previousMessage = this.#mainView.message, previousBusy = this.#mainView.busy;
    const consume = async (page: Pick<Awaited<ReturnType<RpcConversationFacade['history']>>, 'runs' | 'hasMore'>) => {
      this.#abort.signal.throwIfAborted();
      if (this.#history !== history) return;
      let position: TerminalHistoryPosition | undefined, projected = 0;
      try {
        await this.#bodyWork.run(async () => {
          for await (const segment of projectRenderedHistoryReverse(page.runs, history.position)) {
            if (this.#history !== history) return;
            await this.#display.append(segment, true);
            position = { blockId: segment.blockId, contentOffset: segment.contentOffset };
            // Opening a conversation prepares one bounded viewport, not every
            // fragment of four arbitrarily long runs. The authority page is
            // released now and resumed by stable source coordinates on demand.
            if (++projected === 4) break;
          }
        });
      } catch {
        await this.#displayGap(); return;
      }
      if (this.#history !== history) return;
      // The finite, actually accepted first history page proves the completed
      // prefix owned by history. Later commits and every uncommitted input
      // remain the recovery worker's responsibility.
      if (!options.before) history.recoveryRunIds = page.runs.flatMap(item => 'runId' in item.record && typeof item.record.runId === 'string' ? [item.record.runId] : []);
      const oldest = page.runs.at(-1);
      history.hasMore = projected === 4 || page.hasMore;
      history.position = projected === 4 ? position : undefined;
      if (history.position) {
        const newest = page.runs[0]!;
        history.before = { shardId: newest.shardId, runIndex: newest.record.runIndex + 1 };
      } else if (oldest) history.before = { shardId: oldest.shardId, runIndex: oldest.record.runIndex };
      // A later command receipt or running turn owns the current status.
      // History can finish after /new or /clear has already published it.
      if (updateStatus && this.#mainView.message === previousMessage && this.#mainView.busy === previousBusy) {
        this.#mainView = { ...this.#mainView, message: page.runs.length
          ? 'PageUp / PageDown 回看，翻到顶部读取更早历史 · Ctrl+End 回到最新内容'
          : '还没有已保存的对话内容。', busy: false };
      }
      await this.#displayPage();
      await this.#publishHistoryView();
    };
    if (history.offline) await consume(await createReadOnlyConversationStorage(this.home).readHistory(history.conversationId, options));
    else await this.#conversation.consumeHistory(history.conversationId, options, consume);
  }

  async #displayPage(): Promise<void> {
    const revision = ++this.#displayRevision;
    const page = await this.#display.page(this.#displayStart);
    if (revision === this.#displayRevision && !this.#abort.signal.aborted) {
      const patch = encodeBodyPage(page, revision, this.#displaySent);
      // Body delivery is FIFO. Publish this base before yielding so concurrent
      // navigation can reference the already enqueued page in the same order.
      this.#displaySent = { revision, page };
      try { await this.#channel.send({ type: 'display-patch', patch }, 'body'); }
      catch (error) { this.#displaySent = undefined; throw error; }
    }
  }

  async #displayGap(error?: unknown): Promise<void> {
    if (this.#displayUnavailable) return;
    this.#displayUnavailable = true;
    // Fixed implementation codes only. Parser input, source paths and arbitrary
    // exception text must not be copied into the runtime record.
    const reason = error instanceof Error && ['terminal-body-source-map', 'terminal-body-active-capacity',
      'terminal-body-projection-capacity', 'terminal-output-queue-capacity', 'terminal-display-encoding-size',
      'terminal-display-page-size', 'terminal-frame-too-large'].includes(error.message) ? error.message : 'terminal-display-paused';
    recordRuntimeFailure(this.#logging.records, error, reason);
    this.#displayHadGap = true;
    this.#outputProjection.pause();
    this.#processSession.pause('过程展示已暂停；业务执行与确认仍可继续。');
    await this.#controller?.setPresentationProfile('default').catch(() => {});
    await this.#publishHistoryView();
  }

  async #retryDisplay(): Promise<void> {
    const controller = this.#controller, conversationId = controller?.current.conversationId;
    if (!this.#displayUnavailable || !controller || !conversationId) return;
    const current = () => !this.#abort.signal.aborted && this.#controller === controller && controller.current.conversationId === conversationId;
    try {
      await this.#outputProjection.settlePaused();
      if (!current()) return;
      await this.#bodyWork.run(() => this.#display.retry());
      if (!current()) return;
      if (!await controller.setPresentationProfile('bounded-v1') || !current()) throw Error('terminal-presentation-not-accepted');
      this.#outputProjection.resume(); this.#processSession.resume(); this.#displayUnavailable = false;
      this.#mainView = { ...this.#mainView, message: '展示已恢复，仅接收新的过程内容；原有缺口仍保留。' };
    } catch {
      await controller.setPresentationProfile('default').catch(() => false);
      if (current()) this.#mainView = { ...this.#mainView, message: '展示仍暂停，已保留的内容和草稿没有删除。请释放空间后重试，或退出重开。' };
    }
    if (current()) await this.#publishHistoryView();
  }

  #sendProcessStatus(): void {
    this.#processStatusDirty = true;
    if (this.#processStatusSending || this.#abort.signal.aborted) return;
    this.#processStatusSending = (async () => {
      while (this.#processStatusDirty && !this.#abort.signal.aborted) {
        this.#processStatusDirty = false;
        await this.#channel.send({ type: 'process-status', status: this.#processStatus });
      }
    })().catch(() => this.#close(70, 'terminal-process-status-undelivered'))
      .finally(() => { this.#processStatusSending = undefined; if (this.#processStatusDirty && !this.#abort.signal.aborted) this.#sendProcessStatus(); });
  }

  async #collectInputs(): Promise<readonly string[]> {
    const removed = await this.#inputs.collect();
    this.#cleanupMaterials(); return removed;
  }

  #cleanupMaterials(): void {
    const materialIds = new Set<number>();
    for (const token of this.#inputs.handles) for (const match of token.matchAll(createMaterialTokenPattern())) materialIds.add(Number(match[2]));
    this.#materials.cleanup(materialIds);
  }

  async #finishPaste(inputId: string, draft?: TerminalPasteDraft): Promise<{ text: string; handles: readonly { token: string; id: string }[]; paste: boolean; textEdit?: true } | { edit: { inputId: string; bytes: number; cursor: number } }> {
    // Path intent is inspected only for bounded path-sized input. Large original
    // text is folded without materializing it or probing its contents as paths.
    const paste = this.#inputs.completePaste(inputId);
    if (!paste.bytes) return { text: '', handles: [], paste: false };
    // U sends a draft only after this immutable original received a textEdit preview.
    // Do not probe material paths a second time while committing that text edit.
    if (draft) return { edit: await this.#inputs.applyPaste(draft.inputId, draft.start, draft.end, inputId, draft.cursor) };
    if (paste.bytes <= 64 * 1024) {
      const text = await this.#inputs.text(inputId, 1024 * 1024 * 2);
      const material = ingestPastedMaterials(text, this.#materials, { workspaceRoot: this.#localView.workspaceRoot ?? process.cwd(), maxWorkspaceBytes: 2 * 1024 * 1024 });
      if (material.kind === 'ingested') {
        if (Buffer.byteLength(material.insertText) > 128 * 1024) throw Error('材料引用工作区不足，原有草稿和材料保留。');
        const handles = this.#inputs.registerHandles(inputId, material.insertText);
        const result = { text: material.insertText, handles, paste: false };
        // Fail this complete paste through the ordinary request error path,
        // before an oversized control reply could close the terminal channel.
        if (Buffer.byteLength(JSON.stringify(result)) > TERMINAL_LIMITS.frameBytes - 4096) throw Error('材料引用工作区不足，原有草稿和材料保留。');
        return result;
      }
      if (!paste.fold) return { text, handles: [], paste: false, textEdit: true };
    }
    return { text: paste.token, handles: [{ token: paste.token, id: inputId }], paste: true, textEdit: true };
  }

  async #acceptCandidate(revision: number, id: string): Promise<TerminalCandidateAcceptance> {
    const item = this.#candidates.accept(revision, id), payload = item.acceptPayload;
    const filePath = payload.metadata?.resolvedPath;
    if (item.providerId !== 'file' || payload.metadata?.isDirectory || typeof filePath !== 'string') {
      return { text: payload.replacement, execute: payload.execute };
    }
    const token = ingestSelectedMaterial(filePath, this.#materials, { workspaceRoot: this.#localView.workspaceRoot ?? process.cwd() });
    const inputId = randomUUID(); this.#inputs.begin(inputId, 'paste');
    await this.#inputs.part(inputId, 0, filePath, true);
    return { text: `${token} `, execute: false, inputId, handles: this.#inputs.registerHandles(inputId, token) };
  }

  async #submit(inputId: string, version: number): Promise<void> {
    let settled = false;
    const settle = (accepted: boolean) => {
      if (settled) return; settled = true;
      void this.#channel.send({ type: 'submission', inputId, version, accepted }).catch(() => this.#close(70, 'terminal-submission-undelivered'));
      if (accepted) {
        this.#inputs.transfer(`frozen:${inputId}`, `history:${inputId}`);
        this.#inputHistory.push(inputId);
        if (this.#inputHistory.length > 100) this.#inputs.forget(`history:${this.#inputHistory.shift()!}`);
      }
    };
    const submission = createUserSubmission({ commit: () => settle(true), reject: () => settle(false) });
    const releaseOutput = this.#outputProjection.hold();
    try {
      if (this.#displayUnavailable || this.#display.paused || this.#outputProjection.paused) throw Error('正文保留已暂停，当前不能接纳新输入；草稿已保留。可处理确认、中止工作或退出后重试。');
      await this.#inputs.retainDraft(`frozen:${inputId}`, inputId);
      const completed = await this.#submitPrepared(inputId, submission);
      if (!completed) return;
      releaseOutput();
      const { result, notice } = completed;
      if (result.kind === 'accepted') this.#followTurn(result.turn);
      else if (result.kind === 'awaiting-rubric-confirmation') {
        this.#pendingRubric = undefined;
        this.#deferredRubric = result;
        this.#pendingRubricNotice = notice;
        this.#mainView = { ...this.#mainView, busy: false, message: notice ?? '任务等待确认。' };
        await this.#publish(this.#mainView);
        await this.#resolveRubric();
      } else {
        if (result.kind === 'cancelled') {
          this.#pendingRubric = undefined;
          this.#deferredRubric = undefined;
          this.#pendingRubricNotice = undefined;
          this.#mainView = { ...this.#mainView, choices: this.#mainView.choices?.filter(choice => choice.id !== 'rubric-resume') };
        }
        this.#mainView = { ...this.#mainView, busy: false, message: result.kind === 'contract-failed' ? '推进准则生成失败；输入已保留。' : '已取消这次任务。' };
        await this.#publish(this.#mainView);
      }
    } catch (error) {
      submission.reject();
      this.#mainView = { ...this.#mainView, busy: false };
      throw error;
    } finally {
      releaseOutput();
      await this.#display.cancelAdmission();
      this.#inputs.forget(`frozen:${inputId}`); this.#inputs.published([inputId]);
      await this.#collectInputs();
    }
  }

  /** Large expansion/materials belong to the pending send only. Return from
   * this frame before opening a user-paced confirmation; its cold draft and
   * history owners, not the preparation strings, retain the original input. */
  async #submitPrepared(inputId: string, submission: ReturnType<typeof createUserSubmission>): Promise<{ result: BeginReferencedUserTurnResult<TerminalTurnOutcome>; notice?: string } | undefined> {
    const result = await this.#beginPrepared(inputId, submission);
    if (!result) return;
    const notice = submission.settle(result);
    if (notice) this.#mainView = { ...this.#mainView, message: notice };
    if (result.kind === 'accepted' || (result.kind === 'awaiting-rubric-confirmation' && ['original-saved', 'revision-saved'].includes(result.submission?.disposition ?? ''))) {
      try {
        let offset = 0;
        let pending: { text: string; contentOffset: number } | undefined;
        for await (const page of this.#inputs.expandedPages(inputId)) {
          for (const fragment of textFragments(page)) {
            if (pending) await this.#display.append({ blockId: `input:${inputId}`, role: 'user', ...pending, final: false });
            pending = { contentOffset: offset + fragment.offset, text: fragment.text };
          }
          offset += page.length;
        }
        if (pending) await this.#display.append({ blockId: `input:${inputId}`, role: 'user', ...pending, final: true });
        await this.#displayPage();
      } catch { await this.#displayGap(); }
    }
    return { result, notice };
  }

  async #beginPrepared(inputId: string, submission: ReturnType<typeof createUserSubmission>): Promise<BeginReferencedUserTurnResult<TerminalTurnOutcome> | undefined> {
    await this.#display.admit();
    this.#mainView = { ...this.#mainView, busy: true, message: '正在提交…' };
    await this.#publish(this.#mainView);
    try {
      return await this.#controller!.beginReferencedUserTurn((conversationId, turnId) =>
        this.#conversation.sendPrepared((identity, signal, maximum) => this.#prepareSendSource(inputId, identity, signal, maximum),
          conversationId, turnId, this.#abort.signal, (result): SessionSendReferenceResult => {
            if ('status' in result && result.status === 'awaiting-rubric-confirmation') {
              const { rubricDraft: _draft, ...identity } = result;
              return boundedControlProjection(identity, 8192);
            }
            return boundedControlProjection(result, 256 * 1024);
          }), { onAccepted: submission.accept });
    } catch (error) {
      if (!(error instanceof EmptyTerminalSubmission)) throw error;
      submission.reject(); this.#mainView = { ...this.#mainView, busy: false };
      await this.#publish(this.#mainView); return;
    }
  }

  async #prepareSendSource(inputId: string, identity: SessionSendSnapshotIdentity, signal: AbortSignal, maximumParamsBytes: number) {
    signal.throwIfAborted();
    // Expansion's two carriers have their own phase. Leave 4 MiB for its
    // finite file owner/IPC/page scratch before entering material preparation.
    // Inspect the immutable unexpanded draft: a leading paste handle is body,
    // even when its expanded contents happen to start with a slash alias.
    const head = await this.#inputs.window(inputId, 0);
    const controlHead = head.text.trimStart();
    const commandAliasOffset = head.start === 0 && normalizeLeadingSlashAlias(controlHead) !== controlHead
      ? head.text.length - controlHead.length : undefined;
    const text = await this.#inputs.expand(inputId, TERMINAL_LIMITS.rpcWorkspaceBytes - 4 * 1024 * 1024);
    await new Promise<void>(resolve => setImmediate(resolve));
    const source = await this.#pendingSend.prepare(write => prepareSessionSendSnapshot(text, identity, {
      workspaceRoot: this.#localView.workspaceRoot ?? process.cwd(), materialRegistry: this.#materials,
      signal, maximumParamsBytes, commandAliasOffset,
    }, write), signal);
    if (!source) throw new EmptyTerminalSubmission();
    return source;
  }

  async #resolveRubric(assertCaller?: () => void): Promise<void> {
    const controller = this.#controller, conversationId = controller?.current.conversationId;
    const epoch = this.#conversationEpoch;
    const current = () => {
      assertCaller?.();
      if (!controller || this.#controller !== controller || controller.current.conversationId !== conversationId ||
          epoch !== this.#conversationEpoch || !this.#mainView.connected || this.#abort.signal.aborted) throw Error('对话或连接已变化，请重新打开确认。');
    };
    current();
    if (!this.#pendingRubric && !this.#deferredRubric) {
      const pending = await this.#conversation.consumeResume(conversationId!, result => {
        current();
        const snapshot = result.advancement, draft = snapshot?.pendingRubricDraft;
        if (snapshot?.status !== 'awaiting-rubric-confirmation' || !draft) return undefined;
        return boundedControlProjection({ kind: 'awaiting-rubric-confirmation' as const, conversationId: conversationId!,
          turnId: draft.originalTurnId, advancementSessionId: snapshot.advancementSessionId,
          rubricDraftId: draft.draftId, rubricDraft: draft }, 256 * 1024);
      });
      current(); this.#pendingRubric = pending;
    }
    await this.#selectionFlow(() => this.#rubricLoop(current));
  }

  async #loadPendingRubric(current: () => void): Promise<void> {
    current();
    if (!this.#pendingRubric && this.#deferredRubric) {
      const identity = this.#deferredRubric;
      const pending = await this.#conversation.consumeResume(identity.conversationId, result => {
        current();
        const snapshot = result.advancement, draft = snapshot?.pendingRubricDraft;
        if (snapshot?.status !== 'awaiting-rubric-confirmation' || !draft || draft.originalTurnId !== identity.turnId || snapshot.advancementSessionId !== identity.advancementSessionId) throw Error('待确认任务状态已变化，请重新连接后核对。');
        return boundedControlProjection({ kind: 'awaiting-rubric-confirmation' as const, conversationId: identity.conversationId,
          turnId: draft.originalTurnId, advancementSessionId: snapshot.advancementSessionId,
          rubricDraftId: draft.draftId, rubricDraft: draft }, 256 * 1024);
      });
      current(); this.#pendingRubric = pending;
      this.#deferredRubric = undefined;
    }
  }

  async #rubricLoop(current: () => void): Promise<void> {
    while ((this.#pendingRubric || this.#deferredRubric) && !this.#abort.signal.aborted) {
      current();
      try { await this.#loadPendingRubric(current); current(); }
      catch {
        current();
        const identity = this.#deferredRubric;
        if (!identity) throw Error('待确认任务身份不可用。');
        const selection = await this.#choose({ kind: 'selection', title: '暂时无法完整显示验收方式',
          message: '任务仍保持待确认，尚未开始执行。可以重试读取、收起页面或取消任务。',
          choices: [{ id: 'retry', label: '重试读取' }, { id: 'return', label: '暂时收起' }, { id: 'cancel', label: '取消任务' }] });
        current();
        if (selection === 'retry') continue;
        if (selection === 'cancel') {
          const confirmed = await this.#choose({ kind: 'selection', title: '取消这次任务？', message: '取消后不会执行原任务。', choices: [{ id: 'cancel', label: '确认取消' }, { id: 'return', label: '返回' }] });
          current();
          if (confirmed !== 'cancel') continue;
          await this.#controller!.cancelRubricContract(identity);
          current();
          this.#deferredRubric = undefined; this.#pendingRubricNotice = undefined;
          this.#mainView = { ...this.#mainView, busy: false, message: '已取消这次任务。', choices: undefined };
        } else this.#mainView = { ...this.#mainView, busy: false, message: '任务保持待确认，可以继续核对。', choices: [{ id: 'rubric-resume', label: '继续确认任务' }] };
        await this.#publish(this.#mainView); return;
      }
      const pending = this.#pendingRubric!;
      const selected = await chooseTerminalSelection(createAdvancementContractSelectionRequest(pending.rubricDraft), view => this.#choosePage({
        ...view, message: [this.#pendingRubricNotice, view.message].filter(Boolean).join('\n'),
      }));
      current();
      if (!selected || selected.kind === 'cancelled') {
        const { rubricDraft: _draft, ...identity } = pending;
        this.#deferredRubric = boundedControlProjection(identity, 8192);
        this.#pendingRubric = undefined;
        this.#mainView = { ...this.#mainView, busy: false, message: [this.#pendingRubricNotice, '已收起确认面；任务保持待确认，可点击下方继续处理。'].filter(Boolean).join('\n'), choices: [{ id: 'rubric-resume', label: '继续确认任务' }] };
        await this.#publish(this.#mainView); return;
      }
      const controller = this.#controller!;
      if (selected.value === 'edit') {
        if (!('input' in selected) || !selected.input.trim()) continue;
        await this.#publish({ ...this.#mainView, busy: true, message: '正在更新验收方式…' });
        current();
        try {
          const revised = await this.#conversation.consumeReviseAdvancement(pending.conversationId, pending.advancementSessionId, selected.input, result => {
            current();
            if (result.conversationId !== pending.conversationId || result.advancementSessionId !== pending.advancementSessionId ||
                result.rubricDraft.originalTurnId !== pending.turnId || result.rubricDraftId !== result.rubricDraft.draftId) throw Error('修订结果身份不一致，请重新核对任务。');
            return boundedControlProjection({ kind: 'awaiting-rubric-confirmation' as const, conversationId: result.conversationId,
              turnId: pending.turnId, advancementSessionId: result.advancementSessionId, rubricDraftId: result.rubricDraftId }, 8192);
          });
          current(); this.#deferredRubric = revised;
          this.#pendingRubric = undefined;
          this.#pendingRubricNotice = '准则修订已保存，等待确认。';
        }
        catch {
          current();
          const { rubricDraft: _draft, ...identity } = pending;
          this.#pendingRubric = undefined; this.#deferredRubric = identity;
          await this.#choose({ kind: 'selection', title: '修订结果待核对', message: '尚未开始任务；返回后会重新读取当前验收方式，不会恢复旧快照。', choices: [{ id: 'return', label: '返回' }] });
          current();
        }
        continue;
      }
      let turn: AcceptedTurn<TerminalTurnOutcome> | undefined;
      if (selected.value === 'cancel' || selected.value === 'direct') {
        const result = await controller.cancelRubricContract(pending, { executeOriginal: selected.value === 'direct' });
        current();
        if (result.kind === 'direct-execution') turn = result.turn;
      } else {
        const candidate = primaryNearbyCandidate(pending.rubricDraft);
        if (selected.value === 'update-existing' && !candidate) continue;
        turn = await controller.confirmRubricContract(pending, {
          ...(selected.value === 'update-existing' ? { rubricPersistence: { kind: 'update-existing' as const, rubricId: candidate!.id } }
            : selected.value === 'save-new' ? { rubricPersistence: { kind: 'save-new' as const } } : {}),
        });
        current();
      }
      this.#pendingRubric = undefined;
      this.#deferredRubric = undefined;
      this.#pendingRubricNotice = undefined;
      this.#mainView = { ...this.#mainView, choices: undefined, message: turn ? '开始执行…' : '已取消这次任务。', busy: !!turn };
      if (turn) this.#followTurn(turn); else await this.#publish(this.#mainView);
    }
  }

  #followTurn(turn: AcceptedTurn<TerminalTurnOutcome>): void {
    const { conversationId, turnId, runId } = turn;
    // The controller already consumed the result, even for an early complete
    // notification. Waiting for send acceptance retains only this summary.
    const completion = turn.outcome;
    this.#state.activeTurnPromise = completion;
    this.#mainView = { ...this.#mainView, busy: true, message: turn.advancementContinuation ? '已作为当前任务的补充继续推进。' : '正在处理…' };
    void this.#publish(this.#mainView).catch(() => {});
    const settled = completion.then(async outcome => {
      this.#processSession.end(conversationId, turnId, runId);
      if (!outcome.bodyPending) {
        this.#outputProjection.end(conversationId, turnId, runId);
        await this.#outputProjection.drain();
      }
      if (this.#abort.signal.aborted) return;
      // The local waiter owns this terminal outcome; the controller suppresses
      // its duplicate observer notice. Keep the authoritative error visible,
      // bounded independently of the control frame and detached from its RPC.
      if (this.#controller?.current.conversationId !== conversationId) return;
      this.#mainView = { ...this.#mainView, busy: false, message: outcome.reason === 'completed' ? undefined : outcome.message };
      if (outcome.control?.handedOff) this.#mainView = { ...this.#mainView, message: '已提交任务交接；后续结果将在原对话中返回。' };
      else if (outcome.control?.navigation) {
        this.#invalidateConversation();
        try { await this.#ensureSessionBinding().navigate(outcome.control.navigation); }
        catch (error) { this.#mainView = { ...this.#mainView, title: this.#controller?.current.name ?? this.#mainView.title,
          message: `运行已结束；场景切换未完成：${error instanceof Error ? error.message.slice(0, 1024) : '请重新核对当前对话。'}` }; }
        if (outcome.control.conflict) this.#mainView = { ...this.#mainView, message: `本轮包含多个场景请求，已按最后一次确认处理。${this.#mainView.message ?? ''}` };
      }
      if (outcome.reason !== 'completed' && this.#mainView.message !== outcome.message) {
        this.#mainView = { ...this.#mainView, message: `${outcome.message}\n${this.#mainView.message ?? ''}` };
      }
      if (!this.#editor && !this.#selection) await this.#publish(this.#mainView);
    }).catch(async () => {
      if (!this.#abort.signal.aborted && this.#controller?.current.conversationId === conversationId) {
        this.#mainView = { ...this.#mainView, busy: false, message: '运行结果尚未确认；请重连后查看，不会自动重发。' };
        if (!this.#editor && !this.#selection) await this.#publish(this.#mainView);
      }
    }).finally(() => { if (this.#state.activeTurnPromise === settled) this.#state.activeTurnPromise = null; });
    this.#state.activeTurnPromise = settled;
    void settled.catch(() => this.#close(70, 'terminal-outcome-undelivered'));
  }

  async #edit(session: NodeConfigurationEditSession, title: string, sections: SectionId[], runtime?: ConfigEditorRuntime) {
    this.#abort.signal.throwIfAborted();
    const { TerminalConfigurationEditor } = await import('./configuration-editor.js');
    this.#abort.signal.throwIfAborted();
    if (this.#editor) throw Error('terminal-editor-already-open');
    const editor = new TerminalConfigurationEditor({ session, title, sections, runtime, publish: view => this.#publish(view) });
    this.#editor = editor;
    try { return await editor.run(); }
    finally { editor.dispose(); if (this.#editor === editor) this.#editor = undefined; }
  }

  async #configuration(kind: 'config' | 'mcp'): Promise<void> {
    await this.#publish({ kind: 'configuration', title: kind === 'config' ? '配置' : 'MCP', message: '正在读取本机配置…', busy: true });
    this.#abort.signal.throwIfAborted();
    const { editRuntimeConfiguration, prepareMcpConfiguration } = await import('../runtime/configuration-application.js');
    this.#abort.signal.throwIfAborted();
    const connected = this.#connection.getStatus().kind === 'connected';
    const mcp = kind === 'mcp' ? await prepareMcpConfiguration({ configPath: this.#configPath,
      createStdioProcess: (command, args, env, signal) => createTerminalOwnedProcessFactory('mcp-probe')(command, args, {
        env, signal: signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal, deadline: Date.now() + 5000,
      }),
      readMcpStatusWire: async () => (await this.#management.serverInfoIfConnected())?.mcpServers ?? [],
      readMcpPending: async () => connected && this.#controller ? this.#management.mcpPending(this.#controller.current.conversationId) : [],
      llmComplete: (prompt, role, signal) => {
        if (!connected) return Promise.reject(Error('当前离线，依赖模型的解析暂不可用。'));
        return this.#management.llmComplete(prompt, role, signal);
      },
      llmConsume: (prompt, consume, role, signal) => {
        if (!connected) return Promise.reject(Error('当前离线，依赖模型的解析暂不可用。'));
        return this.#management.llmConsume(prompt, consume, role, signal);
      },
    }) : undefined;
    const result = await editRuntimeConfiguration({ zhixingHome: this.home, configPath: this.#configPath,
      secretStore: this.#secretStore,
      processIdentityResolver: this.#secretPlatform.processIdentityResolver,
      configurationRecords: this.#logging.records, state: this.#state,
      ...(connected ? { readExtensions: () => this.#management.extensions(), readExtensionLocalSetup: () => this.#management.extensionLocalSetup(),
        applyExtensionConfiguration: (ids: readonly string[]) => { this.#abort.signal.throwIfAborted(); return this.#management.applyExtensionConfiguration(ids); } } : {}),
      requestHostReload: options => this.#reload(options),
    }, { kind, edit: session => this.#edit(session, kind === 'config' ? '配置' : 'MCP 管理', kind === 'config' ? ['model', 'messaging'] : ['mcp'], mcp?.runtime),
      mcpApplication: mcp?.mcpApplication });
    this.#abort.signal.throwIfAborted();
    let message = result.kind === 'cancelled' ? '已取消本次配置编辑。'
      : result.kind === 'non-tty' ? '配置编辑未完成。'
      : result.kind === 'mcp' ? result.result.message
      : result.kind === 'saved-pending' ? '配置已保存，但消息通道尚未确认应用；重新打开配置可重试。'
      : result.kind === 'local-applied' ? '配置已保存，本机变更已应用。'
      : '配置已保存并完成服务重载。';
    if (result.kind === 'reloaded' && (result.effects.reload.status === 'failed' || result.effects.reconcile.status === 'failed')) message = '配置已接纳，应用尚未完成；请重试连接，不要恢复旧快照。';
    if (result.kind === 'reloaded' && result.pendingChannels) message += '\n消息通道尚未确认应用；重新打开配置可重试。';
    const reconnected = this.#connection.getStatus().kind === 'connected';
    this.#resolvedLocalView = undefined;
    if (reconnected) await this.#localView.refresh();
    this.#mainView = { ...this.#mainView, message, connected: reconnected, busy: false,
      ...(reconnected ? { choices: undefined } : {}) };
    void this.#tasks?.refresh();
    await this.#publish(this.#mainView);
  }

  async #reload(options?: HostReloadOptions) {
    this.#abort.signal.throwIfAborted();
    const { reloadCoreHostAfterConfig, waitForReloadStatus } = await import('../runtime/configuration-application.js');
    this.#abort.signal.throwIfAborted();
    this.#invalidateAuxiliary();
    this.#holdNoticeDisplay();
    return reloadCoreHostAfterConfig({ options,
      requestDrainShutdown: () => this.#management.serverShutdown({ reason: 'config-reload', strategy: 'drain' }),
      reconnect: input => this.#connection.reconnect(input),
      prepareManagedServiceTurnover: async () => {
        this.#abort.signal.throwIfAborted();
        const { prepareCurrentManagedServiceConfigTurnover } = await import('../serve/managed-service-runtime.js');
        this.#abort.signal.throwIfAborted();
        return prepareCurrentManagedServiceConfigTurnover(undefined, this.home);
      },
      refresh: async () => {
        const status = await waitForReloadStatus(this.#management);
        this.#holdNoticeDisplay();
        this.#taskNotices?.resume();
        await this.#localView.refresh(); await this.#controller?.reattachActiveObserver();
        await this.#confirmations.refresh();
        await this.#tasks?.refresh();
        return status ? { channels: status.channels } : undefined;
      },
    }).finally(() => this.#resumeNoticeDisplay());
  }

  #skillsFailed(error: unknown): void {
    if (this.#abort.signal.aborted) return;
    recordRuntimeFailure(this.#logging.records, error, 'terminal-skills-refresh-failed');
    this.#mainView = { ...this.#mainView, message: '技能命令刷新失败；原有命令和草稿保留。可打开 /skills 重试。' };
    if (!this.#editor && !this.#selection) void this.#publish(this.#mainView).catch(() => this.#close(70, 'terminal-skills-notice-undelivered'));
  }

  #ensureSkillsBinding(): Promise<SkillsBinding> {
    return this.#skillsBinding ??= (async () => {
      this.#abort.signal.throwIfAborted();
      const [{ SkillCatalogRpcClient }, { TerminalSkillCommands, terminalSkillCommandRoute }] = await Promise.all([
        import('@zhixing/rpc/skill-catalog-client'), import('./skill-commands.js'),
      ]);
      this.#abort.signal.throwIfAborted();
      const client = new SkillCatalogRpcClient(this.#connection);
      const commands = new TerminalSkillCommands({ client, registry: this.#candidates.registry,
        onError: error => this.#skillsFailed(error), signal: this.#abort.signal });
      this.#skillCommands = commands;
      return { client, commands, route: (name: string) => terminalSkillCommandRoute(this.#candidates.registry, name) };
    })().catch(error => { this.#skillsBinding = undefined; throw error; });
  }

  async #commandRoute(name: string): Promise<{ readonly route: 'input' | 'local' }> {
    if (typeof name !== 'string' || !name.length || name.length > 480 || /\s/u.test(name)) throw Error('terminal-command-size');
    const definition = this.#candidates.registry.findByName(name);
    if (definition && definition.execution !== 'agent') return { route: 'local' };
    const binding = await this.#ensureSkillsBinding();
    await binding.commands.refresh();
    this.#abort.signal.throwIfAborted();
    return binding.route(name) ?? { route: 'local' };
  }

  async #showSkills(): Promise<void> {
    await this.#selectionFlow(async () => {
      this.#abort.signal.throwIfAborted();
      const [binding, { TerminalSkillsOwner }] = await Promise.all([this.#ensureSkillsBinding(), import('./skills.js')]);
      this.#abort.signal.throwIfAborted();
      const owner = new TerminalSkillsOwner({ client: binding.client, signal: this.#abort.signal,
        refreshCommands: () => binding.commands.refresh(),
        publish: skills => this.#publish({ kind: 'skills', title: '技能管理', skills }) });
      this.#skills = owner;
      try { await owner.open(); }
      finally {
        owner.close(); if (this.#skills === owner) this.#skills = undefined;
        if (!this.#abort.signal.aborted) await this.#publish(this.#mainView);
      }
    });
  }

  #invalidateAuxiliary(): void {
    this.#startupWatch = undefined;
    this.#information?.invalidate(); this.#tasks?.invalidate(); this.#taskNotices?.invalidate();
    this.#resumeNoticeDisplay();
  }

  #holdNoticeDisplay(): void {
    this.#resumeNoticeDisplay();
    this.#noticeDisplayReady = new Promise(resolve => { this.#releaseNoticeDisplay = resolve; });
  }

  #resumeNoticeDisplay(): void {
    this.#releaseNoticeDisplay?.();
    this.#releaseNoticeDisplay = undefined; this.#noticeDisplayReady = undefined;
  }

  async #waitNoticeDisplay(signal: AbortSignal): Promise<void> {
    const ready = this.#noticeDisplayReady;
    if (!ready || signal.aborted) return;
    let cancel!: () => void;
    try {
      await new Promise<void>(resolve => {
        cancel = resolve; signal.addEventListener('abort', cancel, { once: true });
        void ready.then(resolve);
        if (signal.aborted) resolve();
      });
    } finally { signal.removeEventListener('abort', cancel); }
  }

  #sendTaskStatus(): void {
    if (this.#abort.signal.aborted || this.#closing) return;
    this.#taskStatusDirty = true;
    if (this.#taskStatusSending) return;
    this.#taskStatusSending = (async () => {
      while (this.#taskStatusDirty && !this.#abort.signal.aborted) {
        this.#taskStatusDirty = false;
        await this.#channel.send({ type: 'task-status', status: this.#taskStatus });
      }
    })().catch(() => this.#close(70, 'terminal-task-status-undelivered'))
      .finally(() => { this.#taskStatusSending = undefined; if (this.#taskStatusDirty) this.#sendTaskStatus(); });
  }

  #ensureTasksBinding(): Promise<void> {
    return this.#tasksBinding ??= (async () => {
      this.#abort.signal.throwIfAborted();
      const [{ TerminalTasks }, { TerminalTaskNotices }, { RpcSchedulerFacade }] = await Promise.all([
        import('./tasks.js'), import('./task-notices.js'), import('../runtime/rpc-scheduler-facade.js'),
      ]);
      this.#abort.signal.throwIfAborted();
      const scheduler = new RpcSchedulerFacade({ connection: this.#connection });
      this.#tasks = new TerminalTasks({
        controller: () => this.#mainView.connected ? this.#controller : undefined,
        conversation: this.#conversation, scheduler, signal: this.#abort.signal,
        choose: view => this.#choosePage(view),
        publish: async result => {
          const controller = this.#controller, id = controller?.current.conversationId, epoch = this.#conversationEpoch;
          const current = () => this.#controller === controller && controller?.current.conversationId === id &&
            this.#mainView.connected === true && this.#conversationEpoch === epoch && !this.#abort.signal.aborted;
          if (!current()) return;
          this.#mainView = { ...this.#mainView, message: result.message };
          await this.#publish(this.#mainView, current);
        },
        changed: summary => { this.#taskStatus = { ...this.#taskStatus, summary }; this.#sendTaskStatus(); },
      });
      this.#taskNotices = new TerminalTaskNotices({
        link: this.#connection, scheduler, signal: this.#abort.signal,
        watching: id => this.#controller?.isWatching(id) === true || this.#startupWatch === id,
        emit: async (notice, delivery) => {
          await this.#waitNoticeDisplay(delivery.signal);
          const current = () => delivery.isCurrent() && !this.#history?.offline &&
            (!notice.conversationId || this.#controller?.isWatching(notice.conversationId) === true || this.#startupWatch === notice.conversationId);
          if (!current()) return;
          await this.#display.append({ blockId: `notice:${randomUUID()}`, role: 'notice',
            text: `${notice.kind === 'schedule' ? '定时任务' : '发布结果'} · ${notice.message}`, contentOffset: 0, final: true }, false, current);
          if (current()) await this.#displayPage();
        },
        gap: noticeGap => { this.#taskStatus = { ...this.#taskStatus, noticeGap }; this.#sendTaskStatus(); },
      });
    })().catch(error => { this.#tasksBinding = undefined; throw error; });
  }

  async #taskCommand(name: string, argument: string): Promise<void> {
    await this.#ensureTasksBinding();
    await this.#selectionFlow(async () => {
      try { await this.#tasks!.run(name, argument); }
      finally { if (!this.#abort.signal.aborted) await this.#publish(this.#mainView); }
    });
  }

  #ensureInformationBinding(): Promise<void> {
    return this.#informationBinding ??= (async () => {
      this.#abort.signal.throwIfAborted();
      const { TerminalInformationCommands } = await import('./information-commands.js');
      this.#abort.signal.throwIfAborted();
      this.#information = new TerminalInformationCommands({
        controller: () => this.#mainView.connected ? this.#controller : undefined,
        getPrimaryModel: () => this.#localView.primaryModel,
        logs: this.#management.logs(), signal: this.#abort.signal,
        choose: view => this.#choosePage(view),
        publish: async (result, scope) => {
          scope.assertCurrent();
          this.#mainView = { ...this.#mainView, message: result.message,
            ...(result.busy === undefined ? {} : { busy: result.busy }) };
          await this.#publish(this.#mainView, scope.isCurrent);
        },
      });
    })().catch(error => { this.#informationBinding = undefined; throw error; });
  }

  async #informationCommand(name: string, argument: string): Promise<void> {
    await this.#ensureInformationBinding();
    await this.#selectionFlow(async () => {
      try { await this.#information!.run(name, argument); }
      finally {
        if (!this.#abort.signal.aborted) {
          await this.#publish(this.#mainView);
        }
      }
    });
  }

  #ensureDecisionBinding(): Promise<void> {
    return this.#decisionBinding ??= (async () => {
      this.#abort.signal.throwIfAborted();
      const [{ TerminalDecisionCommands }, { TerminalTrustCandidates }] = await Promise.all([
        import('./decision-commands.js'), import('./trust-candidates.js'),
      ]);
      this.#abort.signal.throwIfAborted();
      const controller = () => this.#mainView.connected ? this.#controller : undefined;
      this.#trustCandidates = new TerminalTrustCandidates({ controller, management: this.#management, signal: this.#abort.signal });
      this.#candidates.bindTrust(this.#trustCandidates);
      this.#decisionCommands = new TerminalDecisionCommands({ controller, management: this.#management, signal: this.#abort.signal,
        choose: view => this.#choosePage(view),
        publish: async result => {
          this.#mainView = { ...this.#mainView, message: result.message };
          await this.#publish(this.#mainView);
        },
        resumeRubric: async scope => { scope.assertCurrent(); await this.#resolveRubric(scope.assertCurrent); scope.assertCurrent(); },
      });
    })().catch(error => { this.#decisionBinding = undefined; throw error; });
  }

  async #decision(name: string, argument: string): Promise<void> {
    await this.#ensureDecisionBinding();
    await this.#selectionFlow(async () => {
      try { await this.#decisionCommands!.run(name, argument); }
      finally { if (!this.#abort.signal.aborted) await this.#publish(this.#mainView); }
    });
  }

  #invalidateConversation(): void {
    this.#processSession.reset();
    ++this.#conversationEpoch;
    this.#invalidateAuxiliary();
    this.#decisionCommands?.invalidate(); this.#trustCandidates?.invalidate(); this.#sessionCommands?.invalidate(); this.#candidates.close();
    const selection = this.#selection; this.#selection = undefined;
    if (selection) { selection.resolve({ itemId: 'cancelled', cancelCause: 'aborted' }); void this.#channel.send({ type: 'invalidate', requestId: selection.id }).catch(() => {}); }
  }

  #deletedCurrent(): void {
    this.#invalidateConversation();
    this.#controller?.dispose(); this.#controller = undefined; this.#sessionCommands = undefined; this.#history = undefined;
    this.#mainView = { kind: 'unavailable', title: '知行 · 对话已删除', message: '当前对话已删除，重新连接后可打开可用对话。', busy: false, connected: false,
      choices: [{ id: 'retry', label: '打开可用对话' }, { id: 'exit', label: '退出终端' }] };
  }

  async #conversationChanged(advancement?: SessionAdvancementStateSnapshot): Promise<void> {
    const controller = this.#controller; if (!controller) return;
    this.#invalidateConversation();
    this.#holdNoticeDisplay();
    this.#pendingRubric = undefined; this.#deferredRubric = undefined; this.#pendingRubricNotice = undefined;
    this.#mainView = { kind: 'conversation', title: controller.current.name, busy: false, connected: true };
    this.#taskNotices?.resume();
    await controller.reattachActiveObserver().finally(() => this.#resumeNoticeDisplay());
    await this.#localView.refresh();
    if (this.#controller !== controller || this.#abort.signal.aborted) return;
    void this.#tasks?.refresh();
    const draft = advancement?.pendingRubricDraft;
    if (advancement?.status === 'awaiting-rubric-confirmation' && draft) {
      this.#deferredRubric = boundedControlProjection({ kind: 'awaiting-rubric-confirmation', conversationId: controller.current.conversationId,
        turnId: draft.originalTurnId, advancementSessionId: advancement.advancementSessionId, rubricDraftId: draft.draftId }, 8192);
    }
    await this.#publish(this.#mainView);
    if (this.#deferredRubric) await this.#resolveRubric();
  }

  #ensureSessionBinding(): TerminalSessionCommands {
    if (!this.#sessionCommands) {
      this.#sessionCommands = new TerminalSessionCommands({
        controller: () => this.#mainView.connected ? this.#controller : undefined,
        workscene: this.#workscene, signal: this.#abort.signal, choose: view => this.#choosePage(view),
        activeTurn: () => this.#state.activeTurnPromise,
        changed: advancement => this.#conversationChanged(advancement),
        publish: async message => { this.#mainView = { ...this.#mainView, title: this.#controller?.current.name ?? this.#mainView.title, message }; await this.#publish(this.#mainView); },
        createScene: (input, current) => this.#createScene(input, current),
        deleting: id => { this.#localDeletions.add(id); return () => this.#localDeletions.delete(id); },
        deletedCurrent: () => this.#deletedCurrent(),
      });
      this.#candidates.bindCommands(this.#sessionCommands.commands);
    }
    return this.#sessionCommands;
  }

  async #createScene(input: string, current: () => void): Promise<void> {
    const abort = new AbortController(); this.#sceneCreateAbort = abort;
    const signal = AbortSignal.any([abort.signal, this.#abort.signal]);
    try {
      await this.#publish({ ...this.#mainView, busy: true, message: '正在准备工作场景；Ctrl+C 可取消。' });
      await this.#createSceneInner(input, () => { current(); signal.throwIfAborted(); }, signal);
    } finally {
      if (this.#sceneCreateAbort === abort) this.#sceneCreateAbort = undefined;
    }
  }

  async #createSceneInner(input: string, current: () => void, signal: AbortSignal): Promise<void> {
    current();
    const { runWorksceneCreateAssist, createWorksceneCreateSelectionRequest } = await import('../runtime/workscene-create-assist.js');
    current();
    const ask = async (title: string, prefill = '') => {
      current();
      const response = await this.#choosePage({ kind: 'selection', title, field: { id: 'scene-input', secret: false, label: '输入说明', value: prefill },
        choices: [{ id: 'submit', label: '继续' }, { id: 'cancel', label: '取消' }] });
      current(); return response?.itemId === 'submit' ? response.input?.trim() || null : null;
    };
    const result = await runWorksceneCreateAssist(input, {
      listScenes: () => { current(); return this.#workscene.list(); },
      complete: async (prompt, signal) => { current(); const result = await this.#management.llmComplete(prompt, 'main', signal); current(); return result; },
      create: async (name, workspace) => { current(); const result = await this.#workscene.create(name, workspace); current(); return result; },
      createWithLocalWorkspace: async (name, absolutePath) => {
        current();
        const { withLocalWorkspaceClient, createWorksceneFromLocalWorkspaceAuthorization } = await import('../runtime/workspace-command.js');
        current();
        return withLocalWorkspaceClient(workspace => { current(); return workspace.authorizeForControl(name, absolutePath); }, {
          result: async (workspace, credential) => {
            current(); if (!credential) throw Error('本机工作区授权缺少可恢复的消费凭据。');
            const scene = await createWorksceneFromLocalWorkspaceAuthorization(this.#workscene, name, workspace, credential); current(); return scene;
          },
          recovered: async operations => {
            current();
            for (const operation of operations) {
              if (operation.controlWorkspace) await createWorksceneFromLocalWorkspaceAuthorization(this.#workscene, operation.target, operation.controlWorkspace, operation.credential);
              current();
            }
          },
          failure: async error => { throw error; },
        }, this.home, this.#logging);
      },
      confirm: async proposal => {
        current(); const selected = await chooseTerminalSelection(createWorksceneCreateSelectionRequest(proposal), view => this.#choosePage(view));
        current(); return selected?.kind === 'selected' && selected.value === 'create';
      },
      askUser: question => ask(question),
    }, signal);
    current();
    if (result.kind === 'fallback') {
      const name = await ask('智能创建暂不可用 · 输入场景名称', result.prefill);
      if (name) { await this.#workscene.create(name); current(); }
    }
  }

  async #sessionCommand(name: string, argument: string): Promise<void> {
    await this.#selectionFlow(async () => {
      try { await this.#ensureSessionBinding().run(name, argument); }
      finally { if (!this.#abort.signal.aborted) await this.#publish(this.#mainView); }
    });
  }

  async #command(name: string, argument: string): Promise<unknown> {
    if (typeof name !== 'string' || typeof argument !== 'string' || name.length > 128 || argument.length > 8192) throw Error('terminal-command-size');
    const definition = this.#candidates.registry.findByName(name);
    if (!definition) throw Error('命令不可用，请用 /help 查看当前支持的命令。');
    name = definition.name;
    if (name === 'exit') {
      if (this.#controller?.current.mode.kind === 'workscene') this.#background(() => this.#sessionCommand(name, argument));
      else void this.#close(0, 'user-exit');
      return { accepted: true };
    }
    if (['new', 'name', 'clear', 'resume', 'work'].includes(name)) { this.#background(() => this.#sessionCommand(name, argument)); return { accepted: true }; }
    if (['tasklist', 'task', 'tasks'].includes(name)) { this.#background(() => this.#taskCommand(name, argument)); return { accepted: true }; }
    if (['model', 'usage', 'context', 'compact'].includes(name) || (name === 'config' && argument.trim())) {
      this.#background(() => this.#informationCommand(name, argument)); return { accepted: true };
    }
    if (name === 'config' || name === 'mcp') { this.#background(() => this.#configuration(name)); return { accepted: true }; }
    if (name === 'status') { this.#background(() => this.#status()); return { accepted: true }; }
    if (name === 'stop') { this.#background(() => this.#stop()); return { accepted: true }; }
    if (name === 'skills') { this.#background(() => this.#showSkills()); return { accepted: true }; }
    if (['trust', 'security', 'advancement', 'resolve'].includes(name)) { this.#background(() => this.#decision(name, argument)); return { accepted: true }; }
    if (name === 'help') {
      await this.#publish({ ...this.#mainView, message: this.#candidates.registry.list(this.#candidates.runtime()).map(command => `/${command.name}  ${command.description}`).join('\n') });
      return { accepted: true };
    }
    throw Error('命令不可用，请用 /help 查看当前支持的命令。');
  }

  async #stop(): Promise<void> {
    const status = await this.#management.serverInfoIfConnected();
    this.#abort.signal.throwIfAborted();
    const choice = await this.#selectionFlow(() => chooseTerminalSelection(createStopSelectionRequest(status), view => this.#choosePage(view)));
    if (!choice || choice.kind === 'cancelled' || choice.value === 'cancel') { await this.#publish(this.#mainView); return; }
    await this.#management.serverShutdown({ reason: 'user-stop', strategy: shutdownStrategyForChoice(choice.value), timeoutMs: 30_000 });
    void this.#close(0, 'user-stop');
  }

  async #status(): Promise<void> {
    const controller = this.#controller, epoch = this.#conversationEpoch;
    const status = await this.#management.serverInfoIfConnected();
    if (this.#abort.signal.aborted || this.#controller !== controller || this.#conversationEpoch !== epoch) return;
    const { serverStatusLines } = await import('../runtime/server-status-presentation.js');
    await this.#localView.refresh();
    if (this.#abort.signal.aborted || this.#controller !== controller || this.#conversationEpoch !== epoch) return;
    const current = controller?.current;
    const name = current?.mode.kind === 'workscene' ? `${current.name}（工作场景：${current.mode.sceneName}）` : current?.name ?? '当前对话';
    await this.#selectionFlow(async () => {
      try {
        await chooseTerminalSelection({ id: 'server-status', title: '运行状态',
          body: serverStatusLines(name, this.#localView.primaryModel, this.#localView.networkProxy, status),
          options: [{ value: 'return', label: '返回对话' }],
        }, view => this.#choosePage(view));
      } finally { if (!this.#abort.signal.aborted) await this.#publish(this.#mainView); }
    });
  }

  #output(event: AgentYield, source: ConversationOutputSource): void {
    if (this.#history?.offline || this.#abort.signal.aborted) return;
    this.#outputProjection.accept(event, source);
  }

  #drainConfirmations(): void {
    if (this.#presentingConfirmation || this.#confirmationBlocked || this.#selectionDepth || this.#editor || this.#skills || this.#selection || !this.#mainView.connected || this.#abort.signal.aborted || !this.#pendingConfirmations.size) return;
    this.#presentingConfirmation = true;
    void (async () => {
      while (this.#pendingConfirmations.size && !this.#abort.signal.aborted) {
        const id = this.#pendingConfirmations.values().next().value!;
        const current = { id, invalid: false }; this.#confirmation = current;
        const projection = await this.#confirmations.readPending(id, projectTerminalConfirmation);
        if (!projection || current.invalid) { this.#pendingConfirmations.delete(id); continue; }
        const decision = await resolveTerminalConfirmation(projection, async view => {
          if (current.invalid || this.#abort.signal.aborted) return;
          return this.#choosePage(view);
        });
        if (!current.invalid && !this.#abort.signal.aborted) this.#confirmations.resolve(id, decision);
        this.#pendingConfirmations.delete(id);
      }
    })().catch(() => {
      this.#confirmationBlocked = true;
      this.#mainView = { ...this.#mainView, message: '确认页面暂不可用；未允许此操作。可以重新核对、中止当前工作或退出。',
        choices: [{ id: 'confirmation-retry', label: '重新核对待处理确认' }] };
    }).finally(() => {
      this.#confirmation = undefined; this.#presentingConfirmation = false;
      if (!this.#abort.signal.aborted) void this.#publish(this.#mainView).catch(() => this.#close(70, 'terminal-confirmation-undelivered'));
    });
  }

  #publish(view: View, current?: () => boolean): Promise<void> {
    if (this.#abort.signal.aborted) return Promise.reject(Error('terminal-application-closed'));
    if (current && !current()) return Promise.resolve();
    if (this.#presentingConfirmation && view.kind !== 'confirmation') return Promise.resolve();
    if (this.#skills && view.kind !== 'skills') return Promise.resolve();
    this.#nextView = { view: { ...view, conversationId: view.conversationId ?? this.#controller?.current.conversationId,
      environment: view.kind === 'conversation' && this.#resolvedLocalView ? terminalEnvironment(this.#resolvedLocalView) : undefined }, current };
    if (!this.#publishing) this.#publishing = (async () => {
      while (this.#nextView && !this.#abort.signal.aborted) {
        const next = this.#nextView; this.#nextView = undefined;
        if (next.current && !next.current()) continue;
        await this.#channel.send({ type: 'view', view: { ...next.view, displayGap: this.#displayHadGap, displayPaused: this.#displayUnavailable, generation: ++this.#generation } });
      }
    })().finally(() => { this.#publishing = undefined; if (view.kind === 'conversation') this.#drainConfirmations(); });
    return this.#publishing;
  }

  #close(code: number, reason: string, notify = true): Promise<void> {
    if (this.#closing) return this.#closing;
    let resolveClosing!: () => void;
    this.#closing = new Promise(resolve => { resolveClosing = resolve; });
    this.#channel.beginClose();
    this.#closeDeadline ||= Date.now() + (code === 0 ? 2000 : 8000);
    this.#taskNotices?.dispose(); this.#tasks?.dispose(); this.#information?.dispose();
    this.#resumeNoticeDisplay();
    this.#abort.abort(); this.#decisionCommands?.invalidate(); this.#trustCandidates?.invalidate(); this.#skills?.close(); this.#skillCommands?.dispose(); this.#hosts.close(); this.#candidates.close(); this.#editor?.dispose(); this.#selection?.resolve({ itemId: 'cancelled', cancelCause: 'aborted' }); this.#selection = undefined;
    void (async () => {
      // A failed control lane cannot report its own exit. Closing the existing
      // transport immediately lets S start its shared finite recovery deadline
      // while this owner still attempts ordinary cleanup.
      const notified = notify && this.transport.connected ? this.#channel.send({ type: 'exit', code, reason }) : undefined;
      void notified?.catch(() => this.transport.close());
      this.#controller?.dispose();
      this.#processSession.reset();
      this.#confirmations.dispose(); this.#pendingConfirmations.clear();
      await this.#connection.dispose();
      await this.#operation?.catch(() => {});
      await this.#historyRead?.catch(() => {});
      await this.#outputProjection.close();
      await this.#display.close();
      await this.#inputHistoryReader.close();
      await this.#inputs.close(); this.#materials.clearAll();
      await this.#files.close(terminalWriterDeadline(this.#closeDeadline));
      await this.#logging.finish(code === 0 ? 'success' : 'failure', reason,
        Math.max(0, terminalWriterDeadline(this.#closeDeadline) - Date.now() - TERMINAL_LOG_EXIT_RESERVE_MS));
      await notified;
      await this.#channel.closeAfterReceived();
      this.transport.removeListener('message', this.#message);
      this.transport.removeListener('disconnect', this.#disconnected); process.removeListener('SIGINT', this.#interrupted); process.removeListener('SIGTERM', this.#interrupted);
      process.removeListener('uncaughtException', this.#uncaught); process.removeListener('unhandledRejection', this.#uncaught);
      this.transport.close();
      process.exitCode = code;
    })().catch(() => { process.exitCode = 71; this.#channel.close(); this.transport.close(); }).finally(() => { resolveClosing(); this.#resolve(); });
    return this.#closing;
  }
}
