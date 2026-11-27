import { createHash, randomUUID } from "node:crypto";
import {
  copyProviderMetadata,
  resolveModelInputCapabilities,
  validatePreSendCompatibility,
  type ChatRequest,
  type LLMProvider,
  type LLMRole,
  type LLMRoles,
  type Message,
  type ModelConnectionReadinessDescriptor,
  type ModelRoleId,
  type SessionModelSelection,
  type StreamEvent,
} from "@zhixing-ai/core";
import { parseConversationId } from "@zhixing-ai/core/conversation";
import { compareCanonicalStrings, protocolDigest } from "@zhixing-ai/core/protocol";
import {
  computeSourceOriginKey,
  DEFAULT_MODEL_CATALOG_PORT,
  isAdapterImplemented,
  isLLMConfigV2,
  prepareProviderRoles,
  resolveConnection,
  resolveLLMRoles,
  resolveSessionOverride,
  type ConnectionDiscoveryFacts,
  type LLMConfigV2,
  type ModelCatalogPort,
  type ModelDiscoveryCache,
  type ProviderCredentialProjection,
  type ResolvedLLMRole,
  type ResolvedLLMRoles,
} from "@zhixing-ai/providers";
import type {
  RuntimeAdvancementConfigurationProjection,
  RuntimeModelConfigurationProjection,
} from "./runtime-configuration-projections.js";
import type { CredentialExposureSecretProjection } from "./runtime-secret-projections.js";

export interface ModelRuntimeSnapshot {
  readonly revision: string;
  readonly modelConfiguration: RuntimeModelConfigurationProjection;
  readonly advancementConfiguration?: RuntimeAdvancementConfigurationProjection;
  readonly providerCredentials: ProviderCredentialProjection;
  readonly exposureCredentials: CredentialExposureSecretProjection;
  readonly credentialGeneration: string | null;
}

export interface ModelRolePublicSummary {
  readonly source: "configured" | "fallback-main" | "unconfigured";
  readonly ready: boolean;
}

export interface ModelRuntimeReadiness {
  readonly revision: string;
  readonly credentialGeneration: string | null;
  readonly credentialBindings: readonly {
    readonly bindingId: string;
    readonly service: string;
    readonly verification: "user-alias";
  }[];
  readonly modelConnections: readonly ModelConnectionReadinessDescriptor[];
  readonly readyRoles: readonly ModelRoleId[];
}

export interface ModelRuntimeUpdateInput {
  readonly operationId?: string;
  readonly modelConfiguration: RuntimeModelConfigurationProjection;
  readonly advancementConfiguration?: RuntimeAdvancementConfigurationProjection;
  readonly providerCredentials: ProviderCredentialProjection;
  readonly exposureCredentials: CredentialExposureSecretProjection;
  readonly credentialGeneration: string | null;
  readonly revokedSecretRefs?: readonly string[];
  readonly abortConnectionIds?: readonly string[];
}

export type ModelRuntimeUpdateResult =
  | {
      readonly applied: true;
      readonly deduplicated?: true;
      readonly revision: string;
      readonly abortedCalls: number;
    }
  | {
      readonly applied: false;
      readonly revision: string;
      readonly reason: string;
      readonly abortedCalls?: number;
    };

export interface TrackedModelBinding {
  readonly roles: LLMRoles;
  readonly sessionPrimary?: LLMRole;
  readonly acquireRunLease: () => () => void;
  readonly dispose: () => Promise<void>;
}

interface ActiveModelCall {
  readonly callId: string;
  readonly connectionId: string;
  readonly secretRef?: string;
  readonly revision: string;
  readonly controller: AbortController;
  readonly provider: LLMProvider;
}

interface ManagedProviderEntry {
  readonly provider: LLMProvider;
  readonly connectionId: string;
  readonly secretRef?: string;
  readonly revision: string;
  leaseCount: number;
  activeCount: number;
  retired: boolean;
  /** 凭据撤权或连接强制停用后永久置真：即便同 secretRef 后续轮换新值，旧实例亦绝不恢复许可。 */
  revoked: boolean;
  closed: boolean;
}

/**
 * 宿主唯一模型运行时端口（设计 §5.3 + 单元 1 组 B）：
 * - 持有当前不可变快照，所有宿主模型消费方（主/工作场景会话、ephemeral/job、
 *   推进与轻量补全、就绪快照、首可用预热）按次读取同一真相源，不捕获过期配置；
 * - 显式登记在途调用（connectionId / secretRef / revision / AbortController）与
 *   准入运行租约（leaseCount），撤权在候选预检前即刻中止匹配在途调用并永久吊销旧绑定修订；
 * - 退役连接的底层 dispatcher 仅在运行租约与在途调用均归零后关闭，避免工具往返空窗期撕裂流量；
 * - 窄生效先预校验并装配，失败完整保留旧可用实例（同时剔除已撤权凭据）返回待应用状态，永不打崩宿主。
 */
export class ModelRuntimePort {
  #current: ModelRuntimeSnapshot;
  #appliedOperationIds = new Set<string>();
  #activeCalls = new Map<string, ActiveModelCall>();
  #managedProviders = new Set<ManagedProviderEntry>();
  #revokedSecretRefs = new Set<string>();
  /** 按 secretRef -> 已撤权修订集合永久留痕：新值轮换只解除新修订，绝不复活旧修订绑定。 */
  #revokedSecretRevisions = new Map<string, Set<string>>();
  #abortedConnectionRevisions = new Map<string, Set<string>>();
  #listeners = new Set<(snapshot: ModelRuntimeSnapshot) => void | Promise<void>>();
  #idleRetiredListeners = new Set<(connectionId: string) => void | Promise<void>>();
  #reconcileFromDisk: (() => Promise<void>) | undefined;
  #reconcileInFlight: Promise<void> | undefined;
  #preparePromise: Promise<void> | undefined;
  #prepareRevision: string | undefined;
  #catalogPort: ModelCatalogPort;
  #discoveryCache: ModelDiscoveryCache | undefined;
  #discoveryByConnection: Readonly<Record<string, ConnectionDiscoveryFacts>>;

  constructor(
    initial: Omit<ModelRuntimeSnapshot, "revision"> & {
      readonly revision?: string;
      readonly catalog?: ModelCatalogPort;
      readonly discoveryCache?: ModelDiscoveryCache;
      readonly discoveryByConnection?: Readonly<Record<string, ConnectionDiscoveryFacts>>;
    },
  ) {
    this.#catalogPort = initial.catalog ?? DEFAULT_MODEL_CATALOG_PORT;
    this.#discoveryCache = initial.discoveryCache;
    this.#discoveryByConnection = initial.discoveryByConnection ?? {};
    this.#current = Object.freeze({
      revision:
        initial.revision ??
        computeModelSnapshotRevision({
          ...initial,
          catalogRevision: this.#catalogPort.revision,
          discoveryDigest: computeDiscoveryFactsDigest(this.#discoveryByConnection),
        }),
      modelConfiguration: initial.modelConfiguration,
      ...(initial.advancementConfiguration
        ? { advancementConfiguration: initial.advancementConfiguration }
        : {}),
      providerCredentials: initial.providerCredentials,
      exposureCredentials: initial.exposureCredentials,
      credentialGeneration: initial.credentialGeneration,
    });
    for (const ref of initial.providerCredentials.revokedModelSecretRefs ?? []) {
      this.#revokedSecretRefs.add(ref);
    }
    for (const ref of Object.keys(initial.providerCredentials.compromisedModelSecretTokens ?? {})) {
      this.#revokedSecretRefs.add(ref);
    }
  }

  catalogPort(): ModelCatalogPort {
    return this.#catalogPort;
  }

  discoveryByConnection(): Readonly<Record<string, ConnectionDiscoveryFacts>> {
    return this.#discoveryByConnection;
  }

  /**
   * 原子切换目录读口：当目录修订变化时同步推进 `ModelRuntimeSnapshot.revision`、
   * 退役全部空闲旧实例（保留在途租约绑定直至释放）并触发 `onUpdate` 订阅方。
   */
  setCatalogPort(port: ModelCatalogPort): void {
    this.#catalogPort = port;
    this.#preparePromise = undefined;
    this.#publishDerivedRevisionIfChanged();
  }

  /** 更新连接级原生发现事实并推进运行修订（退役空闲实例、通知订阅方）。 */
  setDiscoveryByConnection(
    facts: Readonly<Record<string, ConnectionDiscoveryFacts>>,
  ): void {
    this.#discoveryByConnection = facts;
    this.#preparePromise = undefined;
    this.#publishDerivedRevisionIfChanged();
  }

  /** 从隔离 `ModelDiscoveryCache` 按当前生效连接与凭据投影重载已验证发现事实。 */
  async refreshDiscoveryCacheFromDisk(): Promise<void> {
    if (!this.#discoveryCache) return;
    const llm = this.#current.modelConfiguration.llm;
    if (!isLLMConfigV2(llm)) {
      this.setDiscoveryByConnection({});
      return;
    }
    const loaded = await this.#discoveryCache.loadConnectionDiscoveryFacts(
      llm.connections,
      this.#current.providerCredentials,
    );
    const next: Record<string, ConnectionDiscoveryFacts> = {};
    for (const [connId, snap] of Object.entries(loaded)) {
      next[connId] = {
        models: snap.models,
        authoritativeNativeFacts: snap.authoritativeNativeFacts,
      };
    }
    this.setDiscoveryByConnection(next);
  }

  #computeRevisionFor(input: {
    readonly modelConfiguration: RuntimeModelConfigurationProjection;
    readonly providerCredentials: ProviderCredentialProjection;
    readonly credentialGeneration: string | null;
  }): string {
    return computeModelSnapshotRevision({
      ...input,
      catalogRevision: this.#catalogPort.revision,
      discoveryDigest: computeDiscoveryFactsDigest(this.#discoveryByConnection),
    });
  }

  #publishDerivedRevisionIfChanged(): void {
    const nextRevision = this.#computeRevisionFor(this.#current);
    if (nextRevision === this.#current.revision) return;
    this.#current = Object.freeze({
      ...this.#current,
      revision: nextRevision,
    });
    for (const entry of [...this.#managedProviders]) {
      if (entry.revision !== nextRevision) {
        entry.retired = true;
        if (entry.leaseCount === 0 && entry.activeCount === 0) {
          void this.#closeEntryAndNotifyIdle(entry);
        }
      }
    }
    for (const listener of this.#listeners) {
      try {
        const res = listener(this.#current);
        if (res && typeof (res as Promise<void>).catch === "function") {
          void (res as Promise<void>).catch(() => {});
        }
      } catch {
        // 隔离单监听器异常
      }
    }
  }

  /** 计算候选模型配置/凭据在当前目录与发现修订下的快照修订号，供宿主对账器核对是否与活快照一致。 */
  computeCandidateRevision(input: {
    readonly modelConfiguration: RuntimeModelConfigurationProjection;
    readonly providerCredentials: ProviderCredentialProjection;
    readonly credentialGeneration: string | null;
  }): string {
    return this.#computeRevisionFor(input);
  }

  snapshot(): ModelRuntimeSnapshot {
    return this.#current;
  }

  onUpdate(listener: (snapshot: ModelRuntimeSnapshot) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onConnectionRetiredIdle(listener: (connectionId: string) => void | Promise<void>): () => void {
    this.#idleRetiredListeners.add(listener);
    return () => {
      this.#idleRetiredListeners.delete(listener);
    };
  }

  setDiskReconciler(reconciler: () => Promise<void>): void {
    this.#reconcileFromDisk = reconciler;
  }

  /** 新模型准入前检查本机配置/凭据修订差，若仅模型域变化则幂等补应用并同步发现缓存（设计 §5.2）。 */
  async ensureFreshBeforeAdmission(): Promise<void> {
    if (this.#reconcileFromDisk) {
      if (this.#reconcileInFlight) {
        await this.#reconcileInFlight;
      } else {
        const task = this.#reconcileFromDisk().finally(() => {
          if (this.#reconcileInFlight === task) {
            this.#reconcileInFlight = undefined;
          }
        });
        this.#reconcileInFlight = task;
        await task;
      }
    }
    await this.refreshDiscoveryCacheFromDisk();
  }

  inFlightConnectionIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const call of this.#activeCalls.values()) {
      ids.add(call.connectionId);
    }
    for (const entry of this.#managedProviders) {
      if (entry.leaseCount > 0 || entry.activeCount > 0) {
        ids.add(entry.connectionId);
      }
    }
    return ids;
  }

  activeCallCount(): number {
    return this.#activeCalls.size;
  }

  /**
   * 包装单次装配产生的角色与可选会话主循环绑定：挂接准入租约、在途调用登记、
   * 撤权即时阻断/中止与退役连接引用归零关闭。
   */
  trackBinding(input: {
    readonly roles: LLMRoles;
    readonly resolvedRoles: ResolvedLLMRoles;
    readonly revision: string;
    readonly sessionPrimary?: LLMRole;
    readonly effectivePrimary?: ResolvedLLMRole;
  }): TrackedModelBinding {
    const providerEntries = new Map<LLMProvider, ManagedProviderEntry>();
    const getOrCreateEntry = (
      provider: LLMProvider,
      connectionId: string,
      secretRef: string | undefined,
    ): ManagedProviderEntry => {
      const existing = providerEntries.get(provider);
      if (existing) return existing;
      const entry: ManagedProviderEntry = {
        provider,
        connectionId,
        ...(secretRef !== undefined ? { secretRef } : {}),
        revision: input.revision,
        leaseCount: 0,
        activeCount: 0,
        retired: false,
        revoked: false,
        closed: false,
      };
      providerEntries.set(provider, entry);
      this.#managedProviders.add(entry);
      return entry;
    };

    const wrapSingleRole = (role: LLMRole, resolvedRole: ResolvedLLMRole): LLMRole => {
      const resolved = resolvedRole.resolved;
      const connectionId = resolved.connectionId ?? resolved.id;
      const secretRef = resolved.secretRef;
      const entry = getOrCreateEntry(role.provider, connectionId, secretRef);
      const trackedProvider: LLMProvider = {
        id: role.provider.id,
        ...copyProviderMetadata(role.provider),
        models: role.provider.models,
        chat: (request: ChatRequest) =>
          this.#runTrackedCall(entry, connectionId, secretRef, input.revision, request),
        ...(role.provider.countTokens
          ? {
              countTokens: (messages, model) =>
                role.provider.countTokens!(messages, model),
            }
          : {}),
        ...(role.provider.close ? { close: () => this.#closeEntryAndNotifyIdle(entry) } : {}),
      };
      return {
        provider: trackedProvider,
        model: role.model,
        chat: (request) => trackedProvider.chat({ ...request, model: role.model }),
        ...(role.countTokens
          ? { countTokens: (messages) => role.countTokens!(messages) }
          : {}),
      };
    };

    const roles: LLMRoles = {
      main: wrapSingleRole(input.roles.main, input.resolvedRoles.main),
      light: wrapSingleRole(input.roles.light, input.resolvedRoles.light),
      power: wrapSingleRole(input.roles.power, input.resolvedRoles.power),
    };
    const sessionPrimary =
      input.sessionPrimary && input.effectivePrimary
        ? wrapSingleRole(input.sessionPrimary, input.effectivePrimary)
        : undefined;

    const boundEntries = [...providerEntries.values()];
    const acquireRunLease = (): (() => void) => {
      for (const entry of boundEntries) {
        entry.leaseCount += 1;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const entry of boundEntries) {
          entry.leaseCount = Math.max(0, entry.leaseCount - 1);
          if (entry.retired && entry.leaseCount === 0 && entry.activeCount === 0) {
            void this.#closeEntryAndNotifyIdle(entry);
          }
        }
      };
    };

    const dispose = async (): Promise<void> => {
      for (const entry of boundEntries) {
        entry.retired = true;
        if (entry.leaseCount === 0 && entry.activeCount === 0) {
          await this.#closeEntryAndNotifyIdle(entry);
        }
      }
    };

    return {
      roles,
      ...(sessionPrimary ? { sessionPrimary } : {}),
      acquireRunLease,
      dispose,
    };
  }

  /**
   * 兼容封装：包装单次装配产生的 LLMRoles（无独立会话覆盖时使用）。
   */
  trackRoles(roles: LLMRoles, resolvedRoles: ResolvedLLMRoles, revision: string): LLMRoles {
    return this.trackBinding({ roles, resolvedRoles, revision }).roles;
  }

  async *#runTrackedCall(
    entry: ManagedProviderEntry,
    connectionId: string,
    secretRef: string | undefined,
    revision: string,
    request: ChatRequest,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    if (entry.revoked || entry.closed) {
      throw new Error(
        secretRef
          ? `模型凭据 "${secretRef}" 的旧绑定修订已撤销，拒绝发起新调用`
          : `模型连接 "${connectionId}" 的旧绑定修订已停用，拒绝发起新调用`,
      );
    }
    if (secretRef && (this.#isSecretRevoked(secretRef) || this.#isSecretRevisionRevoked(secretRef, revision))) {
      throw new Error(`模型凭据 "${secretRef}" 已撤销或封禁，拒绝发起新调用`);
    }
    if (this.#isConnectionRevisionAborted(connectionId, revision)) {
      throw new Error(`模型连接 "${connectionId}" 已停用，拒绝发起新调用`);
    }
    const callId = randomUUID();
    const controller = new AbortController();
    const upstreamSignal = request.abortSignal;
    const onUpstreamAbort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        controller.abort(upstreamSignal.reason);
      } else {
        upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
      }
    }

    const active: ActiveModelCall = {
      callId,
      connectionId,
      secretRef,
      revision,
      controller,
      provider: entry.provider,
    };
    this.#activeCalls.set(callId, active);
    entry.activeCount += 1;

    try {
      const stream = entry.provider.chat({
        ...request,
        abortSignal: controller.signal,
      });
      for await (const event of stream) {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("模型调用已中止");
        }
        yield event;
      }
    } finally {
      if (upstreamSignal) {
        upstreamSignal.removeEventListener("abort", onUpstreamAbort);
      }
      this.#activeCalls.delete(callId);
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      if (
        (entry.revoked && entry.activeCount === 0) ||
        (entry.retired && entry.leaseCount === 0 && entry.activeCount === 0)
      ) {
        void this.#closeEntryAndNotifyIdle(entry);
      }
    }
  }

  #isSecretRevoked(secretRef: string): boolean {
    if (this.#revokedSecretRefs.has(secretRef)) return true;
    const revoked = this.#current.providerCredentials.revokedModelSecretRefs;
    if (revoked !== undefined && revoked.includes(secretRef)) return true;
    return Boolean(this.#current.providerCredentials.compromisedModelSecretTokens?.[secretRef]);
  }

  #isSecretRevisionRevoked(secretRef: string, revision: string): boolean {
    return this.#revokedSecretRevisions.get(secretRef)?.has(revision) ?? false;
  }

  #isConnectionRevisionAborted(connectionId: string, revision: string): boolean {
    return this.#abortedConnectionRevisions.get(connectionId)?.has(revision) ?? false;
  }

  #recordAndAbortRevocations(input: {
    readonly effectiveBlockRefs: ReadonlySet<string>;
    readonly abortConnections: ReadonlySet<string>;
    readonly previousRevision: string;
  }): number {
    for (const ref of input.effectiveBlockRefs) {
      this.#revokedSecretRefs.add(ref);
      let revs = this.#revokedSecretRevisions.get(ref);
      if (!revs) {
        revs = new Set<string>();
        this.#revokedSecretRevisions.set(ref, revs);
      }
      revs.add(input.previousRevision);
    }
    for (const connId of input.abortConnections) {
      let revs = this.#abortedConnectionRevisions.get(connId);
      if (!revs) {
        revs = new Set<string>();
        this.#abortedConnectionRevisions.set(connId, revs);
      }
      revs.add(input.previousRevision);
    }

    let abortedCalls = 0;
    if (input.effectiveBlockRefs.size === 0 && input.abortConnections.size === 0) {
      return 0;
    }
    for (const call of this.#activeCalls.values()) {
      const revokedMatch = call.secretRef !== undefined && input.effectiveBlockRefs.has(call.secretRef);
      const connectionMatch = input.abortConnections.has(call.connectionId);
      if (revokedMatch || connectionMatch) {
        abortedCalls += 1;
        if (call.secretRef && revokedMatch) {
          let revs = this.#revokedSecretRevisions.get(call.secretRef);
          if (!revs) {
            revs = new Set<string>();
            this.#revokedSecretRevisions.set(call.secretRef, revs);
          }
          revs.add(call.revision);
        }
        if (connectionMatch) {
          let revs = this.#abortedConnectionRevisions.get(call.connectionId);
          if (!revs) {
            revs = new Set<string>();
            this.#abortedConnectionRevisions.set(call.connectionId, revs);
          }
          revs.add(call.revision);
        }
        call.controller.abort(
          new Error(
            revokedMatch
              ? `模型凭据 "${call.secretRef}" 已撤销或封禁，调用已中止`
              : `模型连接 "${call.connectionId}" 已停用，调用已中止`,
          ),
        );
      }
    }
    for (const entry of [...this.#managedProviders]) {
      const revokedMatch = entry.secretRef !== undefined && input.effectiveBlockRefs.has(entry.secretRef);
      const connectionMatch = input.abortConnections.has(entry.connectionId);
      if (revokedMatch || connectionMatch) {
        entry.revoked = true;
        entry.retired = true;
        if (entry.secretRef && revokedMatch) {
          let revs = this.#revokedSecretRevisions.get(entry.secretRef);
          if (!revs) {
            revs = new Set<string>();
            this.#revokedSecretRevisions.set(entry.secretRef, revs);
          }
          revs.add(entry.revision);
        }
        if (connectionMatch) {
          let revs = this.#abortedConnectionRevisions.get(entry.connectionId);
          if (!revs) {
            revs = new Set<string>();
            this.#abortedConnectionRevisions.set(entry.connectionId, revs);
          }
          revs.add(entry.revision);
        }
        if (entry.activeCount === 0) {
          void this.#closeEntryAndNotifyIdle(entry);
        }
      }
    }
    return abortedCalls;
  }

  async #sanitizeCurrentCredentialsAndNotify(input: {
    readonly effectiveBlockRefs: ReadonlySet<string>;
    readonly incomingRevoked: ReadonlySet<string>;
    readonly incomingCompromisedTokens?: Readonly<Record<string, string>>;
  }): Promise<void> {
    const previous = this.#current;
    const sanitizedSecrets = { ...(previous.providerCredentials.modelSecrets ?? {}) };
    for (const ref of input.effectiveBlockRefs) {
      delete sanitizedSecrets[ref];
    }
    const sanitizedExposureSecrets = { ...(previous.exposureCredentials.modelSecrets ?? {}) };
    for (const ref of input.effectiveBlockRefs) {
      delete sanitizedExposureSecrets[ref];
    }
    const mergedRevoked = [
      ...new Set([
        ...(previous.providerCredentials.revokedModelSecretRefs ?? []),
        ...input.incomingRevoked,
      ]),
    ].sort();
    const mergedCompromised = {
      ...(previous.providerCredentials.compromisedModelSecretTokens ?? {}),
      ...(input.incomingCompromisedTokens ?? {}),
    };
    const fallbackProviderCredentials: ProviderCredentialProjection = {
      ...previous.providerCredentials,
      ...(Object.keys(sanitizedSecrets).length > 0
        ? { modelSecrets: sanitizedSecrets }
        : { modelSecrets: undefined }),
      ...(mergedRevoked.length > 0 ? { revokedModelSecretRefs: mergedRevoked } : {}),
      ...(Object.keys(mergedCompromised).length > 0
        ? { compromisedModelSecretTokens: mergedCompromised }
        : {}),
    };
    const fallbackExposureCredentials: CredentialExposureSecretProjection = {
      ...previous.exposureCredentials,
      ...(Object.keys(sanitizedExposureSecrets).length > 0
        ? { modelSecrets: sanitizedExposureSecrets }
        : { modelSecrets: undefined }),
      ...(mergedRevoked.length > 0 ? { revokedModelSecretRefs: mergedRevoked } : {}),
    };
    this.#current = Object.freeze({
      ...previous,
      providerCredentials: fallbackProviderCredentials,
      exposureCredentials: fallbackExposureCredentials,
      revision: this.#computeRevisionFor({
        modelConfiguration: previous.modelConfiguration,
        providerCredentials: fallbackProviderCredentials,
        credentialGeneration: previous.credentialGeneration,
      }),
    });
    for (const listener of this.#listeners) {
      await listener(this.#current);
    }
  }

  /**
   * 纯安全撤权/停用执行器（不半应用任何模型配置或非模型配置）：
   * 立即永久吊销受影响绑定修订、中止在途请求、剥离当前快照中的被撤凭据并刷新订阅方。
   * 供混合编辑（等待整机换代前）与磁盘对账在发现安全撤权时优先收敛使用。
   */
  async enforceRevocations(input: {
    readonly revokedSecretRefs?: readonly string[];
    readonly abortConnectionIds?: readonly string[];
    readonly compromisedModelSecretTokens?: Readonly<Record<string, string>>;
  }): Promise<{ readonly abortedCalls: number; readonly revision: string }> {
    const incomingRevoked = new Set(input.revokedSecretRefs ?? []);
    const incomingCompromised = new Set(Object.keys(input.compromisedModelSecretTokens ?? {}));
    const effectiveBlockRefs = new Set<string>([...incomingRevoked, ...incomingCompromised]);
    const abortConnections = new Set(input.abortConnectionIds ?? []);
    if (effectiveBlockRefs.size === 0 && abortConnections.size === 0) {
      return { abortedCalls: 0, revision: this.#current.revision };
    }
    const abortedCalls = this.#recordAndAbortRevocations({
      effectiveBlockRefs,
      abortConnections,
      previousRevision: this.#current.revision,
    });
    await this.#sanitizeCurrentCredentialsAndNotify({
      effectiveBlockRefs,
      incomingRevoked,
      ...(input.compromisedModelSecretTokens
        ? { incomingCompromisedTokens: input.compromisedModelSecretTokens }
        : {}),
    });
    return { abortedCalls, revision: this.#current.revision };
  }

  async #closeEntryAndNotifyIdle(entry: ManagedProviderEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    this.#managedProviders.delete(entry);
    try {
      await entry.provider.close?.();
    } catch {
      // 关闭失败不影响其余运行态
    }
    // 只有当该连接已无任何其他活跃租约或调用时，通知宿主按空闲归零结算待清退秘密
    if (!this.inFlightConnectionIds().has(entry.connectionId)) {
      for (const listener of this.#idleRetiredListeners) {
        try {
          await listener(entry.connectionId);
        } catch {
          // 结算失败将在下次启动/保存恢复中继续幂等收敛
        }
      }
    }
  }

  /**
   * 仅模型域配置/凭据窄生效：
   * - 幂等去重 operationId；
   * - **撤权与显式连接中止优先无条件执行**：即便候选配置预检失败（例如主模型凭据被撤且无替代），
   *   仍立即中止受影响在途调用、永久阻断旧实例继续发请求，并从回退快照剔除已撤权凭据；
   * - 候选预检通过后原子替换快照，仅在租约与在途调用均归零后回收退役连接。
   */
  async applyUpdate(input: ModelRuntimeUpdateInput): Promise<ModelRuntimeUpdateResult> {
    if (input.operationId && this.#appliedOperationIds.has(input.operationId)) {
      return {
        applied: true,
        deduplicated: true,
        revision: this.#current.revision,
        abortedCalls: 0,
      };
    }

    const previous = this.#current;
    const incomingRevoked = new Set<string>([
      ...(input.revokedSecretRefs ?? []),
      ...(input.providerCredentials.revokedModelSecretRefs ?? []),
    ]);
    const incomingCompromised = new Set<string>(
      Object.keys(input.providerCredentials.compromisedModelSecretTokens ?? {}),
    );
    const effectiveBlockRefs = new Set<string>([...incomingRevoked, ...incomingCompromised]);
    const abortConnections = new Set(input.abortConnectionIds ?? []);

    // 0. 无条件安全闸门（先于 resolveLLMRoles 预检）：撤权/封禁/立即中止永不被候选配置缺项阻挡，
    //    且对已存在的旧绑定与旧修订永久吊销（后续轮换新值绝不复活旧实例）。
    const abortedCalls = this.#recordAndAbortRevocations({
      effectiveBlockRefs,
      abortConnections,
      previousRevision: previous.revision,
    });

    const hasConfiguredModel =
      input.modelConfiguration.llm !== undefined &&
      isLLMConfigV2(input.modelConfiguration.llm) &&
      input.modelConfiguration.llm.main !== undefined;

    if (hasConfiguredModel) {
      try {
        resolveLLMRoles(input.modelConfiguration, input.providerCredentials, {
          catalog: this.#catalogPort,
          discoveryByConnection: this.#discoveryByConnection,
        });
      } catch (error) {
        // 即使候选配置无法装配，也必须从保留的旧快照中剔除已撤权/封禁凭据并刷新就绪投影
        if (effectiveBlockRefs.size > 0 || abortConnections.size > 0) {
          await this.#sanitizeCurrentCredentialsAndNotify({
            effectiveBlockRefs,
            incomingRevoked,
            ...(input.providerCredentials.compromisedModelSecretTokens
              ? { incomingCompromisedTokens: input.providerCredentials.compromisedModelSecretTokens }
              : {}),
          });
        }
        return {
          applied: false,
          revision: this.#current.revision,
          abortedCalls,
          reason:
            error instanceof Error
              ? error.message
              : "模型配置装配预检失败，已保留旧运行实例",
        };
      }
    }

    // 候选快照有效：仅解除逻辑凭据对“新修订”的全局拦截；旧修订与已标 revoked 的旧绑定实例保持永久失权
    for (const ref of [...this.#revokedSecretRefs]) {
      if (!effectiveBlockRefs.has(ref)) {
        this.#revokedSecretRefs.delete(ref);
      }
    }

    // 失效被撤权/中止/删除或身份变化连接的隔离发现缓存，再按新快照重载匹配分区
    if (this.#discoveryCache) {
      const invalidateIds = new Set<string>(abortConnections);
      const prevLlm = previous.modelConfiguration.llm;
      const nextLlm = input.modelConfiguration.llm;
      if (isLLMConfigV2(prevLlm)) {
        for (const [connId, prevConn] of Object.entries(prevLlm.connections)) {
          const nextConn = isLLMConfigV2(nextLlm) ? nextLlm.connections[connId] : undefined;
          if (!nextConn) {
            invalidateIds.add(connId);
            continue;
          }
          if (
            prevConn.endpoint !== nextConn.endpoint ||
            prevConn.adapter !== nextConn.adapter ||
            JSON.stringify(prevConn.auth) !== JSON.stringify(nextConn.auth)
          ) {
            invalidateIds.add(connId);
          }
          if (
            (prevConn.auth.mode === "api-key" || prevConn.auth.mode === "header") &&
            (effectiveBlockRefs.has(prevConn.auth.secretRef) ||
              previous.providerCredentials.modelSecrets?.[prevConn.auth.secretRef]?.value !==
                input.providerCredentials.modelSecrets?.[prevConn.auth.secretRef]?.value)
          ) {
            invalidateIds.add(connId);
          }
        }
      }
      for (const connId of invalidateIds) {
        await this.#discoveryCache.invalidateConnection(connId).catch(() => {});
      }
      if (isLLMConfigV2(nextLlm)) {
        const loaded = await this.#discoveryCache
          .loadConnectionDiscoveryFacts(nextLlm.connections, input.providerCredentials)
          .catch(() => ({}));
        const nextFacts: Record<string, ConnectionDiscoveryFacts> = {};
        for (const [connId, snap] of Object.entries(loaded)) {
          nextFacts[connId] = {
            models: snap.models,
            authoritativeNativeFacts: snap.authoritativeNativeFacts,
          };
        }
        this.#discoveryByConnection = nextFacts;
      } else {
        this.#discoveryByConnection = {};
      }
    }

    const finalRevision = this.#computeRevisionFor(input);
    this.#current = Object.freeze({
      revision: finalRevision,
      modelConfiguration: input.modelConfiguration,
      ...(input.advancementConfiguration
        ? { advancementConfiguration: input.advancementConfiguration }
        : previous.advancementConfiguration
          ? { advancementConfiguration: previous.advancementConfiguration }
          : {}),
      providerCredentials: input.providerCredentials,
      exposureCredentials: input.exposureCredentials,
      credentialGeneration: input.credentialGeneration,
    });
    if (input.operationId) {
      this.#appliedOperationIds.add(input.operationId);
    }
    if (this.#prepareRevision !== finalRevision) {
      this.#preparePromise = undefined;
    }

    // 标记旧代 provider 为退役：仅在准入租约与在途调用均归零时立关 dispatcher，
    // 处于工具往返空窗期（leaseCount > 0）的已准入运行保留连接直至运行结束
    for (const entry of [...this.#managedProviders]) {
      if (entry.revision !== finalRevision) {
        entry.retired = true;
        if (entry.leaseCount === 0 && entry.activeCount === 0) {
          void this.#closeEntryAndNotifyIdle(entry);
        }
      }
    }

    // 通知宿主订阅方刷新就绪快照等派生状态
    for (const listener of this.#listeners) {
      await listener(this.#current);
    }

    return {
      applied: true,
      revision: finalRevision,
      abortedCalls,
    };
  }

  /**
   * 派生与执行态同源的模型就绪快照（含免密连接，绝不给 auth.mode === "none" 造假 credentialBindings）。
   */
  readiness(): ModelRuntimeReadiness {
    const snap = this.#current;
    const llm = snap.modelConfiguration.llm;
    const revokedSet = new Set(snap.providerCredentials.revokedModelSecretRefs ?? []);
    const compromisedMap = snap.providerCredentials.compromisedModelSecretTokens ?? {};
    const modelSecrets = snap.providerCredentials.modelSecrets ?? {};

    const credentialBindings: {
      readonly bindingId: string;
      readonly service: string;
      readonly verification: "user-alias";
    }[] = [];
    const seenBindingIds = new Set<string>();
    const modelConnections: ModelConnectionReadinessDescriptor[] = [];
    const readyConnectionIds = new Set<string>();

    if (isLLMConfigV2(llm)) {
      const boundRolesByConnection = computeBoundRolesByConnectionV2(llm);
      for (const [connectionId, connection] of Object.entries(llm.connections).sort(([a], [b]) =>
        compareCanonicalStrings(a, b),
      )) {
        const adapterSupported = isAdapterImplemented(connection.adapter);
        const boundRoles = boundRolesByConnection.get(connectionId);
        if (connection.auth.mode === "none") {
          const ready = adapterSupported;
          if (ready) readyConnectionIds.add(connectionId);
          modelConnections.push({
            connectionId,
            revision: snap.revision,
            adapter: connection.adapter,
            authMode: "none",
            ready,
            ...(boundRoles && boundRoles.length > 0 ? { boundRoles } : {}),
          });
          continue;
        }
        const secretRef = connection.auth.secretRef;
        const secretEntry = modelSecrets[secretRef];
        const hasSecret =
          !revokedSet.has(secretRef) &&
          !this.#revokedSecretRefs.has(secretRef) &&
          !(secretRef in compromisedMap) &&
          typeof secretEntry?.value === "string" &&
          secretEntry.value.trim().length > 0;
        const bindingId = `credential-provider-${secretRef}`;
        const ready = adapterSupported && hasSecret;
        if (ready) readyConnectionIds.add(connectionId);
        if (hasSecret && !seenBindingIds.has(bindingId)) {
          seenBindingIds.add(bindingId);
          credentialBindings.push({
            bindingId,
            service: `provider-${secretRef}`,
            verification: "user-alias",
          });
        }
        modelConnections.push({
          connectionId,
          revision: snap.revision,
          adapter: connection.adapter,
          authMode: connection.auth.mode,
          credentialBindingId: bindingId,
          ready,
          ...(boundRoles && boundRoles.length > 0 ? { boundRoles } : {}),
        });
      }
      const readyRoles = computeReadyRolesV2(llm, readyConnectionIds);
      return {
        revision: snap.revision,
        credentialGeneration: snap.credentialGeneration,
        credentialBindings: credentialBindings.sort((l, r) =>
          compareCanonicalStrings(l.bindingId, r.bindingId),
        ),
        modelConnections,
        readyRoles,
      };
    }

    // Legacy v1 兼容就绪投影
    for (const [providerId, entry] of Object.entries(snap.exposureCredentials.providers ?? {})) {
      if (entry.apiKey.trim().length === 0) continue;
      const bindingId = `credential-provider-${providerId}`;
      if (seenBindingIds.has(bindingId)) continue;
      seenBindingIds.add(bindingId);
      credentialBindings.push({
        bindingId,
        service: `provider-${providerId}`,
        verification: "user-alias",
      });
    }
    return {
      revision: snap.revision,
      credentialGeneration: snap.credentialGeneration,
      credentialBindings: credentialBindings.sort((l, r) =>
        compareCanonicalStrings(l.bindingId, r.bindingId),
      ),
      modelConnections: [],
      readyRoles: [],
    };
  }

  /**
   * 仅返回 main/light/power 三角色的公开无秘密摘要（零 API Key、baseURL 或 connectionId）。
   */
  roleSummary(): Readonly<Record<ModelRoleId, ModelRolePublicSummary>> {
    const snap = this.#current;
    const llm = snap.modelConfiguration.llm;
    const readyRoles = new Set(this.readiness().readyRoles);
    if (isLLMConfigV2(llm)) {
      const mainReady = readyRoles.has("main");
      return Object.freeze({
        main: Object.freeze({
          source: llm.main ? ("configured" as const) : ("unconfigured" as const),
          ready: mainReady,
        }),
        light: Object.freeze({
          source: llm.light
            ? ("configured" as const)
            : llm.main
              ? ("fallback-main" as const)
              : ("unconfigured" as const),
          ready: readyRoles.has("light"),
        }),
        power: Object.freeze({
          source: llm.power
            ? ("configured" as const)
            : llm.main
              ? ("fallback-main" as const)
              : ("unconfigured" as const),
          ready: readyRoles.has("power"),
        }),
      });
    }
    return Object.freeze({
      main: Object.freeze({ source: "unconfigured" as const, ready: false }),
      light: Object.freeze({ source: "unconfigured" as const, ready: false }),
      power: Object.freeze({ source: "unconfigured" as const, ready: false }),
    });
  }

  /**
   * 正式选模保存边界前置兼容性预检（设计 §2.3 / §7）：
   * 在会话 owner 持久化 `modelSelection` 之前，结合最新配置快照与当前活动窗口消息，
   * 校验目标连接是否可解析、图片材料是否受支持、以及未完成工具往返的思考签名/推理态是否兼容。
   * 返回 `null` 表示可安全保存；返回非空中文说明表示须阻断保存并保留原选择。
   */
  async validateSessionModelSelection(input: {
    readonly conversationId: string;
    readonly modelSelection: SessionModelSelection;
    readonly activeWindowMessages: readonly Message[];
  }): Promise<string | null> {
    await this.ensureFreshBeforeAdmission();
    const snap = this.snapshot();

    let primaryRole: ModelRoleId = "main";
    try {
      const parsed = parseConversationId(input.conversationId);
      if (parsed.scope.kind === "workscene") {
        primaryRole = "power";
      }
    } catch {
      // 非结构化兼容测试 ID 默认按 main 角色解析
    }

    let targetRole: ResolvedLLMRole | undefined;
    const resolveOpts = {
      catalog: this.#catalogPort,
      discoveryByConnection: this.#discoveryByConnection,
    };
    try {
      if (input.modelSelection.mode === "override") {
        targetRole = resolveSessionOverride(
          snap.modelConfiguration,
          snap.providerCredentials,
          input.modelSelection,
          resolveOpts,
        );
      } else {
        const resolvedRoles = resolveLLMRoles(
          snap.modelConfiguration,
          snap.providerCredentials,
          resolveOpts,
        );
        targetRole = resolvedRoles[primaryRole];
      }
    } catch (error) {
      if (
        input.modelSelection.mode === "follow-default" &&
        input.activeWindowMessages.length === 0
      ) {
        return null;
      }
      return error instanceof Error ? error.message : String(error);
    }

    if (!targetRole) {
      return "目标模型选择无法解析，已保留原选择。";
    }

    const inputCapabilities = resolveModelInputCapabilities({
      model: targetRole.model,
      providerModels: targetRole.resolved.declaredModels,
      overrides: targetRole.resolved.modelInputCapabilities,
    });
    const sourceOriginKey =
      targetRole.resolved.sourceOriginKey ??
      computeSourceOriginKey(targetRole.resolved.baseUrl, targetRole.resolved.protocol);
    const thinking =
      input.modelSelection.mode === "override"
        ? (input.modelSelection.params?.thinking ?? targetRole.params?.thinking)
        : targetRole.params?.thinking;

    const incompatibility = validatePreSendCompatibility({
      messages: input.activeWindowMessages,
      inputCapabilities,
      target: {
        protocol: targetRole.resolved.protocol,
        sourceConnectionId: targetRole.resolved.connectionId ?? targetRole.resolved.id,
        sourceOriginKey,
        model: targetRole.model,
        thinking,
      },
    });
    return incompatibility ? incompatibility.message : null;
  }

  /** 当前主模型历史装填只读预算（装填开始时单次读取，经三层硬约束合成钳制，不回改历史事实）。 */
  optimalMaxTokens(): number {
    const llm = this.#current.modelConfiguration.llm;
    const model = llm?.main?.model ?? "";
    const base = this.#catalogPort.resolveAttentionCapability(model);
    if (isLLMConfigV2(llm)) {
      const policy = llm.attentionPolicies?.main ?? llm.attentionPolicies?.default;
      if (typeof policy?.optimalMaxTokens === "number" && policy.optimalMaxTokens > 0) {
        return policy.optimalMaxTokens;
      }
      const mainConnId = llm.main?.connectionId;
      const mainConn = mainConnId ? llm.connections[mainConnId] : undefined;
      if (mainConnId && mainConn && model) {
        try {
          const resolved = resolveConnection(
            mainConnId,
            mainConn,
            this.#current.providerCredentials,
            {
              networkProxy: this.#current.modelConfiguration.network?.proxy,
              catalog: this.#catalogPort,
              ...(this.#discoveryByConnection[mainConnId]
                ? { discovery: this.#discoveryByConnection[mainConnId] }
                : {}),
            },
          );
          const effectiveCtx =
            resolved.modelOverrides?.[model]?.contextWindow ??
            resolved.declaredModels.find((m) => m.id === model)?.contextWindow;
          if (
            typeof effectiveCtx === "number" &&
            effectiveCtx > 0 &&
            (mainConn.modelOverrides?.[model]?.contextWindow !== undefined ||
              this.#discoveryByConnection[mainConnId]?.models.some((m) => m.id === model))
          ) {
            return Math.max(1, Math.floor(effectiveCtx * 0.5));
          }
        } catch {
          // 凭据尚未就绪时安全回退策展注意力阈值
        }
      }
    }
    return base.optimalMaxTokens;
  }

  /** 首可用预热始终基于最新快照，不捕获旧启动配置/密钥。 */
  prepareAfterUsable(): Promise<void> {
    const snap = this.#current;
    if (this.#preparePromise && this.#prepareRevision === snap.revision) {
      return this.#preparePromise;
    }
    this.#prepareRevision = snap.revision;
    this.#preparePromise = prepareProviderRoles({
      config: snap.modelConfiguration,
      credentials: snap.providerCredentials,
      catalog: this.#catalogPort,
      discoveryByConnection: this.#discoveryByConnection,
    }).catch(() => {
      if (this.#prepareRevision === snap.revision) {
        this.#preparePromise = undefined;
      }
    });
    return this.#preparePromise;
  }

  async dispose(): Promise<void> {
    for (const call of this.#activeCalls.values()) {
      call.controller.abort(new Error("宿主模型运行时已关闭"));
    }
    this.#idleRetiredListeners.clear();
    await Promise.all([...this.#managedProviders].map((entry) => this.#closeEntryAndNotifyIdle(entry)));
    this.#managedProviders.clear();
    this.#activeCalls.clear();
    this.#listeners.clear();
  }
}

function computeReadyRolesV2(
  llm: LLMConfigV2,
  readyConnectionIds: ReadonlySet<string>,
): ModelRoleId[] {
  const roles: ModelRoleId[] = [];
  const mainReady =
    llm.main !== undefined && readyConnectionIds.has(llm.main.connectionId);
  if (mainReady) roles.push("main");
  const lightReady = llm.light
    ? readyConnectionIds.has(llm.light.connectionId)
    : mainReady;
  if (lightReady) roles.push("light");
  const powerReady = llm.power
    ? readyConnectionIds.has(llm.power.connectionId)
    : mainReady;
  if (powerReady) roles.push("power");
  return roles.sort(compareCanonicalStrings);
}

function computeBoundRolesByConnectionV2(
  llm: LLMConfigV2,
): Map<string, readonly ModelRoleId[]> {
  const byConn = new Map<string, Set<ModelRoleId>>();
  const add = (connectionId: string | undefined, role: ModelRoleId) => {
    if (!connectionId || !(connectionId in llm.connections)) return;
    let set = byConn.get(connectionId);
    if (!set) {
      set = new Set<ModelRoleId>();
      byConn.set(connectionId, set);
    }
    set.add(role);
  };
  const mainConnId = llm.main?.connectionId;
  add(mainConnId, "main");
  add(llm.light?.connectionId ?? mainConnId, "light");
  add(llm.power?.connectionId ?? mainConnId, "power");
  const sorted = new Map<string, readonly ModelRoleId[]>();
  for (const [connId, roles] of byConn) {
    sorted.set(connId, [...roles].sort(compareCanonicalStrings));
  }
  return sorted;
}

function hashSecretValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function computeDiscoveryFactsDigest(
  facts: Readonly<Record<string, ConnectionDiscoveryFacts>>,
): string {
  const keys = Object.keys(facts).sort(compareCanonicalStrings);
  if (keys.length === 0) return "";
  return protocolDigest(
    "ModelDiscoveryFacts",
    1,
    Object.fromEntries(
      keys.map((k) => [
        k,
        {
          authoritative: facts[k]!.authoritativeNativeFacts,
          models: facts[k]!.models,
        },
      ]),
    ),
  );
}

export function computeModelSnapshotRevision(input: {
  readonly modelConfiguration: RuntimeModelConfigurationProjection;
  readonly providerCredentials: ProviderCredentialProjection;
  readonly credentialGeneration: string | null;
  readonly catalogRevision?: string;
  readonly discoveryDigest?: string;
}): string {
  const modelSecretDigests = Object.fromEntries(
    Object.entries(input.providerCredentials.modelSecrets ?? {})
      .sort(([a], [b]) => compareCanonicalStrings(a, b))
      .map(([k, v]) => [k, `${v.kind}:${hashSecretValue(v.value)}`]),
  );
  const legacyProviderDigests = Object.fromEntries(
    Object.entries(input.providerCredentials.providers ?? {})
      .sort(([a], [b]) => compareCanonicalStrings(a, b))
      .map(([k, v]) => [k, hashSecretValue(v.apiKey)]),
  );
  return protocolDigest("ModelRuntimeSnapshot", 1, {
    llm: input.modelConfiguration.llm ?? null,
    network: input.modelConfiguration.network ?? null,
    modelCapabilityOverrides: input.modelConfiguration.modelCapabilityOverrides ?? null,
    credentialGeneration: input.credentialGeneration,
    revokedModelSecretRefs: [...(input.providerCredentials.revokedModelSecretRefs ?? [])].sort(
      compareCanonicalStrings,
    ),
    compromisedKeys: Object.keys(input.providerCredentials.compromisedModelSecretTokens ?? {}).sort(
      compareCanonicalStrings,
    ),
    modelSecretDigests,
    legacyProviderDigests,
    ...(input.catalogRevision ? { catalogRevision: input.catalogRevision } : {}),
    ...(input.discoveryDigest ? { discoveryDigest: input.discoveryDigest } : {}),
  });
}
