/** Node 配置保存/应用编排，复用 Configuration、Secret、Channel 与 MCP owners。 */
import type { ChannelStatus } from "@zhixing/core/channels";
import { loadConfig, loadConfigurationSnapshot, editConfiguration } from "@zhixing/providers";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { canonicalize } from "@zhixing/core/protocol";
import { ChannelConfiguration } from "./extensions/channel-configuration.js";
import { listSupportedChannels } from "../registries/channels.js";
import { reconcileCurrentManagedService } from "../serve/managed-service-runtime.js";
import { createMcpManagementAdapter } from "./mcp-management-adapter.js";
import { McpManagementApplication, type McpManagementEditorPort } from "@zhixing/core/mcp-management";
import type { NodeConfigurationEditor } from "./configuration-edit.js";

export interface ConfigurationApplicationDeps {
  readonly configurationRecords?: import("@zhixing/core/logging").LogRecordPort;
  readonly readExtensions?: () => Promise<import("@zhixing/core/extensions/contracts").ExtensionPublicSnapshot>;
  readonly readExtensionLocalSetup?: () => Promise<Readonly<Record<string, string>>>;
  readonly applyExtensionConfiguration?: (ids: readonly string[]) => Promise<import("@zhixing/core/extensions/contracts").ExtensionPublicSnapshot>;
  readonly zhixingHome: string;
  readonly configPath: string;
  readonly state: { activeTurnPromise: Promise<unknown> | null };
  readonly requestHostReload: (options?: HostReloadOptions) => Promise<HostReloadResult | void>;
}
export interface ConfigurationInteractionOptions {
  readonly kind: "config" | "mcp";
  readonly edit: NodeConfigurationEditor;
  readonly mcpApplication?: (editor: McpManagementEditorPort) => McpManagementApplication;
}
export type ConfigurationApplicationResult =
  | { readonly kind: "cancelled" | "non-tty" | "local-applied" }
  | { readonly kind: "saved-pending"; readonly stage: "channels" }
  | { readonly kind: "reloaded"; readonly effects: ConfigPostCommitEffects; readonly pendingChannels?: true }
  | { readonly kind: "mcp"; readonly result: Awaited<ReturnType<McpManagementApplication["edit"]>> };

export interface HostReloadResult {
  channels?: readonly ChannelStatus[];
}

export interface HostReloadOptions {
  readonly launchSelectionChanged: boolean;
}

export async function waitForReloadStatus(
  management: Pick<import('./rpc-management-facade.js').RpcManagementFacade, 'serverInfo'>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<import('./rpc-management-facade.js').ServerInfoResult | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let lastInfo: import('./rpc-management-facade.js').ServerInfoResult | null = null;
  do {
    lastInfo = await management.serverInfo().catch(() => null);
    if ((lastInfo?.channels ?? []).every(channel => channel.state !== 'connecting')) return lastInfo;
    await new Promise(resolve => setTimeout(resolve, opts.intervalMs ?? 300));
  } while (Date.now() < deadline);
  return lastInfo;
}

export async function reloadCoreHostAfterConfig(input: {
  readonly options?: HostReloadOptions;
  readonly requestDrainShutdown: () => Promise<void>;
  readonly reconnect: (options: { readonly beforeTurnover?: () => Promise<void> }) => Promise<void>;
  readonly prepareManagedServiceTurnover: () => Promise<void>;
  readonly refresh: () => Promise<HostReloadResult | void>;
}): Promise<HostReloadResult | void> {
  const shutdownError = await input.requestDrainShutdown()
    .then(() => undefined, (error: unknown) => error);
  const reconnectError = await input.reconnect({
    ...(input.options?.launchSelectionChanged
      ? { beforeTurnover: input.prepareManagedServiceTurnover }
      : {}),
  }).then(() => undefined, (error: unknown) => error);
  if (reconnectError !== undefined) {
    if (shutdownError !== undefined) {
      throw new AggregateError(
        [shutdownError, reconnectError],
        "核心宿主停机请求与连接换代均未确认",
      );
    }
    throw reconnectError;
  }
  const result = await input.refresh();
  if (shutdownError !== undefined) throw shutdownError;
  return result;
}

export type ConfigPostCommitEffect<T> =
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown };

export interface ConfigPostCommitEffects {
  readonly reload: ConfigPostCommitEffect<HostReloadResult | void>;
  readonly reconcile:
    | { readonly status: "not-required" }
    | ConfigPostCommitEffect<void>;
}

export async function settleConfigPostCommitEffects(input: {
  readonly launchSelectionChanged: boolean;
  readonly reload: (options?: HostReloadOptions) => Promise<HostReloadResult | void>;
  readonly reconcile: () => Promise<unknown>;
}): Promise<ConfigPostCommitEffects> {
  const reload = await captureConfigPostCommitEffect(() => input.reload({
    launchSelectionChanged: input.launchSelectionChanged,
  }));
  const reconcile = input.launchSelectionChanged
    ? await captureConfigPostCommitEffect(async () => {
        await input.reconcile();
      })
    : { status: "not-required" as const };
  return { reload, reconcile };
}

async function captureConfigPostCommitEffect<T>(
  effect: () => Promise<T>,
): Promise<ConfigPostCommitEffect<T>> {
  try {
    return { status: "succeeded", value: await effect() };
  } catch (error) {
    return { status: "failed", error };
  }
}

export async function editRuntimeConfiguration(deps: ConfigurationApplicationDeps, opts: ConfigurationInteractionOptions): Promise<ConfigurationApplicationResult> {
  const { zhixingHome: homeDir, configPath } = deps;
  const secretStore = createPlatformSecretStore({ homeDir });

  // 重新 load 最新——保证用户外部编辑后的一致性，不复用启动缓存
  const { config, credentials } = await loadConfigurationSnapshot({ configPath, store: secretStore, records: deps.configurationRecords });
  const managed = opts.kind === "config" && deps.readExtensions ? await deps.readExtensions() : undefined;
  const channelCatalog = managed ? listSupportedChannels(managed) : undefined;
  const channelSetup = managed && deps.readExtensionLocalSetup ? await deps.readExtensionLocalSetup() : undefined;
  const configuration = new ChannelConfiguration(configPath, secretStore);
  const pendingIds = new Set<string>();
  if (managed) for (const id of new Set([...managed.instances.map((instance) => instance.id), ...Object.keys(config.messaging ?? {})])) {
    if (await configuration.pending(id)) pendingIds.add(id);
  }
  const channelStates = managed ? Object.fromEntries(managed.instances.filter((instance) => instance.binding.manifest.type === "channel")
    .map((instance) => [instance.id, { enabled: instance.enabled, revision: instance.revision, intentRevision: instance.intentRevision, type: instance.binding.manifest.id,
      ...(instance.configurationIssue || pendingIds.has(instance.id)
        ? { configurationIssue: instance.configurationIssue ?? "配置待应用" } : {}) }])) : undefined;
  if (channelStates) for (const operation of managed?.operations ?? []) {
    if (operation.phase === "configuration" && operation.candidate && !channelStates[operation.instanceId]) {
      channelStates[operation.instanceId] = { enabled: false, revision: 0, intentRevision: 0, type: operation.candidate.id,
        configurationIssue: "待填写凭据并完成本人收发验证" };
    }
  }
  const changedChannels = (nextConfig: typeof config, nextCredentials: typeof credentials,
    intents: Readonly<Record<string, boolean>> = {}) => [...new Set([
      ...Object.keys(config.messaging ?? {}), ...Object.keys(nextConfig.messaging ?? {}), ...Object.keys(intents),
      ...pendingIds, ...Object.keys(channelStates ?? {}).filter((id) => channelStates?.[id]?.configurationIssue),
    ])].filter((id) => intents[id] !== undefined || pendingIds.has(id) || channelStates?.[id]?.configurationIssue ||
      canonicalize(config.messaging?.[id] ?? null) !== canonicalize(nextConfig.messaging?.[id] ?? null) ||
      canonicalize(credentials.channels?.[id] ?? null) !== canonicalize(nextCredentials.channels?.[id] ?? null));

  const editorResult = await opts.edit({
    initialConfig: config,
    initialCredentials: credentials,
    ...(channelStates ? { channelStates } : {}),
    ...(channelCatalog ? { channelCatalog } : {}),
    ...(channelSetup ? { channelSetup } : {}),
    writers: {
      save: async (result) => {
        if (opts.mcpApplication) return;
        const ids = changedChannels(result.config, result.credentials, result.channelIntents);
        // Reopening an unchanged pending edit retries its original fenced intent.
        const retryIds = ids.filter((id) => pendingIds.has(id) && result.channelIntents?.[id] === undefined &&
          canonicalize(config.messaging?.[id] ?? null) === canonicalize(result.config.messaging?.[id] ?? null) &&
          canonicalize(credentials.channels?.[id] ?? null) === canonicalize(result.credentials.channels?.[id] ?? null));
        await editConfiguration({ config, credentials }, result, { configPath, store: secretStore, records: deps.configurationRecords,
          prepare: channelStates ? (store, source) => configuration.preparePublications(store, ids,
            source.config, { channels: source.credentials.channels }, channelStates, result.channelIntents, retryIds) : undefined,
        });
      },
    },
  });

  if (editorResult.kind !== "completed") return { kind: editorResult.kind };
  if (opts.mcpApplication) {
    const application = opts.mcpApplication({
      save: async (edit) => {
        await editConfiguration({ config, credentials },
          { config: { mcp: { servers: edit.servers } }, credentials: { mcp: edit.credentials } },
          { configPath, store: secretStore, records: deps.configurationRecords, scope: "mcp" });
      },
      activate: async () => {
        if (deps.state.activeTurnPromise) await deps.state.activeTurnPromise.catch(() => {});
        await deps.requestHostReload();
      },
    });
    const result = await application.edit({ servers: editorResult.config.mcp?.servers ?? {}, credentials: editorResult.credentials.mcp ?? {} });
    return { kind: "mcp", result };
  }
  const changedIds = changedChannels(editorResult.config, editorResult.credentials, editorResult.channelIntents);
  let pendingChannels = false;
  if (changedIds.length > 0) {
    if (!deps.applyExtensionConfiguration) pendingChannels = true;
    else try { await deps.applyExtensionConfiguration(changedIds); }
    catch { pendingChannels = true; }
  }
  const { messaging: _oldMessaging, ...oldConfig } = config;
  const { messaging: _newMessaging, ...newConfig } = editorResult.config;
  const { channels: _oldChannels, ...oldCredentials } = credentials;
  const { channels: _newChannels, ...newCredentials } = editorResult.credentials;
  if (canonicalize(oldConfig) === canonicalize(newConfig) && canonicalize(oldCredentials) === canonicalize(newCredentials)) {
    return pendingChannels ? { kind: "saved-pending", stage: "channels" } : { kind: "local-applied" };
  }
  const launchSelectionChanged = canonicalize({
    enabledRoles: config.mesh?.enabledRoles ?? [],
    executorAutoStart: config.mesh?.executorAutoStart ?? false,
  }) !== canonicalize({
    enabledRoles: editorResult.config.mesh?.enabledRoles ?? [],
    executorAutoStart: editorResult.config.mesh?.executorAutoStart ?? false,
  });
  // 前置等待 in-flight turn——宿主换代前先到 turn 边界,进行中的回答不被截断
  if (deps.state.activeTurnPromise) {
    await deps.state.activeTurnPromise.catch(() => {
      // turn 自身的错误已在 turn 路径展示，此处吞掉即可
    });
  }
  const effects = await settleConfigPostCommitEffects({
    launchSelectionChanged,
    reload: deps.requestHostReload,
    reconcile: () => reconcileCurrentManagedService("local-role-config-committed", undefined, homeDir),
  });
  // Channel publication and host configuration are independent committed
  // effects. A local channel failure cannot discard the same edit's reload.
  return { kind: "reloaded", effects, ...(pendingChannels ? { pendingChannels: true } : {}) };
}

export interface McpConfigurationDeps {
  readonly configPath: string;
    /** MCP 连接状态 wire（宿主快照——具体结构由 infrastructure adapter 严格解码）。 */
    readMcpStatusWire: () => Promise<unknown>;
    readMcpPending?: () => Promise<readonly import("@zhixing/core/mcp-management").McpPendingConnection[]>;
    /** 宿主轻推理通道(llm.complete)——接入向导的源解析 / 提取 */
    llmComplete: (
      prompt: string,
      role?: "main" | "light",
      signal?: AbortSignal,
    ) => Promise<string>;
}

export async function prepareMcpConfiguration(deps: McpConfigurationDeps) {
  const proxy = loadConfig({ configPath: deps.configPath }).network?.proxy;
  const management = createMcpManagementAdapter({
    proxy,
    readStatusWire: deps.readMcpStatusWire,
  });

  // 接入相关的 LLM——走 main 档：搜索引导的判断 / 从 README 抽启动方式的质量
  // 直接决定接入成败，是质量敏感任务，不用 light。推理在宿主(llm.complete),
  // 面板取消（Esc）放弃等待、后台结果丢弃即可。
  const inferLlm: NonNullable<ConstructorParameters<typeof McpManagementApplication>[0]["llm"]> = (prompt, signal) =>
    deps.llmComplete(prompt, "main", signal);
  const application = new McpManagementApplication({ discovery: management, llm: inferLlm });

  // 连接状态取进屏时刻的宿主快照——管理屏打开期间不实时刷新(编辑器 runtime
  // 期望同步读;状态权威在宿主,重开 /mcp 即最新)。
  const statusSnapshot = await management.snapshot().catch(() => []);

  const runtime = {
    mcpPending: await deps.readMcpPending?.() ?? [],
    mcpServerStatuses: () => statusSnapshot,
    mcpProbe: management,
    // 统一输入解析：确定性输入直接出候选，裸输入经搜索引导出 choices（onStep 回报当前步骤）
    mcpResolve: (input: string, signal?: AbortSignal, onStep?: (message: string) => void) =>
      application.resolve(input, signal, onStep),
    // 阶段2：搜索引导选中真实包后，读其 README 提取启动配置（与 mcpResolve 分开）
    mcpExtract: (name: string, signal?: AbortSignal) => application.extract(name, signal),
  };
  return { runtime, mcpApplication: (editor: McpManagementEditorPort) => new McpManagementApplication({ discovery: management, llm: inferLlm, editor }) };
}
