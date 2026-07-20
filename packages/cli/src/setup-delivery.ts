/**
 * 投递基础设施组装 — serve 和 repl 共用
 *
 * 职责：
 * - 创建 OutboxRegistry（顺序层，per-target FIFO）
 * - 保留 scheduler 既有 DeliveryPipeline 生产链
 * - 组装 conversation 使用的权威 delivery 生产链
 * - 两条链路共享 per-target FIFO Outbox
 *
 * 不关心通道具体类型（飞书/Slack/...），只依赖 ChannelRegistry 接口。
 * 不关心运行模式（REPL/serve），两端调用方式一样。
 */

import {
  DeliveryPipeline,
  AuthorityDeliveryPipeline,
  DeliveryAuthority,
  DeliveryTransportRegistry,
  DEFAULT_DELIVERY_CONFIG,
  DEFAULT_AUTHORITY_DELIVERY_CONFIG,
  OutboxRegistry,
  type RuntimeExecutionProfile,
  createEventBus,
  createOutboxSender,
  channelAuthorityDeliveryTransport,
  type ChannelRegistry,
  type AuthorityDeliveryEventMap,
  type DeliveryEventMap,
  type DeliveryStatusNotice,
  type OutboxEvent,
  type PermissionRule,
} from "@zhixing/core";
import type {
  AuthorityError,
  CredentialBindingDescriptor,
  ExecutionManifest,
  SecretStorePort,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedCapabilityDescriptor,
  createSignedExecutorVersionInventory,
  compareCanonicalStrings,
  EXECUTION_PROTOCOL_VERSION,
  ExecutorCapabilityDirectory,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  ControlAdmissionJournal,
  OwnerDeliveryParticipant,
  applyDeliveryResolutionControl,
  createDeliveryControlEnvelope,
  type CreateDeliveryControlEnvelopeInput,
  type TransitionConversationCredentialPolicy,
} from "@zhixing/owner-kernel";
import {
  DeviceKey,
  enrollDeviceIdentity,
  verifyDeviceSignature,
} from "@zhixing/mesh/device-identity";
import {
  loadDeviceKey,
  persistDeviceKey,
} from "@zhixing/mesh/device-key-store";

import path from "node:path";
import {
  FileExecutionSnapshotVersionStore,
  FileExecutorCapabilityDirectoryStore,
  FileTrustRuleSnapshotCatalog,
} from "./executor-snapshot-version-store.js";

export interface AuthorityRuntimeStack {
  readonly anchorEpoch: number;
  readonly deviceId: string;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly authority: DeliveryAuthority;
  readonly authorityLog: FileAuthorityCommitLog;
  readonly artifacts: FileArtifactStore;
  readonly participant: OwnerDeliveryParticipant;
  readonly controlAdmission: ControlAdmissionJournal;
  readonly executorCapabilities: ExecutorCapabilityDirectory;
  readonly permissionSnapshotFor: (digest: string) => TrustRuleSnapshot | undefined;
  readonly prepareConversationAssignment: (input: {
    readonly executionProfile: RuntimeExecutionProfile;
    readonly permissionRules: readonly PermissionRule[];
  }) => Promise<PreparedConversationAssignmentAuthority>;
  readonly validateConversationRuntimeBinding: (input: {
    readonly manifest: ExecutionManifest<"conversation">;
    readonly binding: ConversationRuntimeBinding;
  }) => AuthorityError | undefined;
}

export interface ConversationRuntimeBinding {
  readonly executionProfile: RuntimeExecutionProfile;
  readonly deviceDigest: string;
}

export interface PreparedConversationAssignmentAuthority {
  readonly policy: TransitionConversationCredentialPolicy;
  readonly binding: ConversationRuntimeBinding;
}

export interface DeliveryStack {
  delivery: DeliveryPipeline;
  authorityDelivery: AuthorityDeliveryPipeline;
  authority: DeliveryAuthority;
  authorityLog: FileAuthorityCommitLog;
  artifacts: FileArtifactStore;
  participant: OwnerDeliveryParticipant;
  controlAdmission: ControlAdmissionJournal;
  outboxRegistry: OutboxRegistry;
  statusHistory: (
    afterByItem?: Readonly<Record<string, number>>,
  ) => Promise<readonly DeliveryStatusNotice[]>;
  onStatus: (
    listener: (notice: DeliveryStatusNotice) => void | Promise<void>,
  ) => () => void;
  resolve: (
    input: CreateDeliveryControlEnvelopeInput,
  ) => ReturnType<typeof applyDeliveryResolutionControl>;
  stop: () => Promise<void>;
}

export interface SetupDeliveryOptions {
  channels: ChannelRegistry;
  zhixingHome: string;
  authorityRuntime: AuthorityRuntimeStack;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** 可选：观测 Outbox 事件（测试/调试；生产留空由 logger 承接） */
  onOutboxEvent?: (event: OutboxEvent) => void;
}

export interface ExecutorReadiness {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly credentialBindings: readonly Omit<CredentialBindingDescriptor, "revision">[];
  readonly deviceScopedCredentialBindingIds: readonly string[];
  /** Opaque SecretStore commit generation; never published on protocol surfaces. */
  readonly credentialGeneration: string | null;
}

export interface SetupAuthorityRuntimeOptions {
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly anchorEpoch?: number;
  readonly configurationSnapshot?: unknown;
  readonly executorReadiness: ExecutorReadiness | (() => ExecutorReadiness);
  readonly clock?: () => string;
}

export async function setupAuthorityRuntime(
  options: SetupAuthorityRuntimeOptions,
): Promise<AuthorityRuntimeStack> {
  const authorityRoot = path.join(options.zhixingHome, "distributed-runtime");
  const artifacts = new FileArtifactStore(path.join(authorityRoot, "artifacts"));
  const authorityLog = new FileAuthorityCommitLog(
    path.join(authorityRoot, "authority"),
    artifacts,
  );
  const anchorEpoch = options.anchorEpoch ?? 1;
  const authority = new DeliveryAuthority({
    log: authorityLog,
    anchorEpoch,
  });
  const participant = new OwnerDeliveryParticipant({ authority });
  const controlAdmission = new ControlAdmissionJournal(authorityLog, artifacts);
  const key = await loadOrCreateDeviceKey(options.secretStore);
  const identity = enrollDeviceIdentity(key, {
    displayName: "local-anchor",
    platform: process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux",
    enrolledAt: new Date().toISOString(),
  });
  const verifier: ProtocolSignatureVerifier = {
    verify(schemaId, version, payload, signature) {
      verifyDeviceSignature(identity, schemaId, version, payload, signature);
    },
  };
  const clock = options.clock ?? (() => new Date().toISOString());
  const executorId = "executor:local";
  const capabilityDirectoryStore = new FileExecutorCapabilityDirectoryStore(
    path.join(authorityRoot, "executor-capability-directory.json"),
  );
  let capabilityDirectoryEstablished =
    (await capabilityDirectoryStore.load()) !== undefined;
  const versionStore = new FileExecutionSnapshotVersionStore(
    path.join(authorityRoot, "executor-snapshot-version.json"),
    clock,
  );
  await versionStore.assertCapabilityDirectoryCoherence(
    capabilityDirectoryEstablished,
  );
  const permissionSnapshots = await FileTrustRuleSnapshotCatalog.open(
    path.join(authorityRoot, "permission-snapshots"),
    verifier,
  );
  const executorCapabilities = await ExecutorCapabilityDirectory.open({
    verifier,
    store: capabilityDirectoryStore,
    isDeviceAuthorized: (deviceKeyId) => deviceKeyId === key.deviceId,
    allowInitialize: !capabilityDirectoryEstablished,
  });
  const publicationQueue = new SerialTaskQueue();
  const readinessSource = () => normalizeExecutorReadiness(
    typeof options.executorReadiness === "function"
      ? options.executorReadiness()
      : options.executorReadiness,
    key.deviceId,
  );
  const deviceDigestFor = (readiness: NormalizedExecutorReadiness) =>
    protocolDigest("LocalTransitionConfiguration", 1, {
      configuration: options.configurationSnapshot ?? { profile: "default" },
      executorReadiness: {
        tools: readiness.tools,
        mcpServers: readiness.mcpServers,
        credentialBindings: readiness.credentialBindings,
        credentialGeneration: readiness.credentialGeneration,
      },
    });
  const prepareConversationAssignment = (
    input: {
      readonly executionProfile: RuntimeExecutionProfile;
      readonly permissionRules: readonly PermissionRule[];
    },
  ) => publicationQueue.run(async (): Promise<PreparedConversationAssignmentAuthority> => {
    const executionProfile = normalizeRuntimeExecutionProfile(input.executionProfile);
    const readiness = readinessSource();
    assertRuntimeAvailable(executionProfile, readiness);
    const permissionPublication = await permissionSnapshots.publishRules({
      rules: input.permissionRules,
      signer: key,
      generatedAt: canonicalTime(clock(), "Permission snapshot time"),
    });
    const deviceDigest = deviceDigestFor(readiness);
    const inventoryDigest = protocolDigest("LocalTransitionInventory", 1, {
      deviceDigest,
      permissionSnapshotHighWater: permissionPublication.highWater,
    });
    const versionResolution = await versionStore.synchronize(
      executorId,
      deviceDigest,
      inventoryDigest,
      { allowInitialize: !capabilityDirectoryEstablished },
    );
    const capabilityRevision = versionResolution.deviceRevision;
    const versionedCredentialBindings = readiness.credentialBindings.map((binding) => ({
      ...binding,
      revision: capabilityRevision,
    }));
    const requiredCredentialBindings = requiredBindingsForRuntime(
      executionProfile,
      versionedCredentialBindings,
    );
    const descriptor = createSignedCapabilityDescriptor({
      executorId,
      revision: capabilityRevision,
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      workspaces: [],
      tools: [...readiness.tools],
      mcpServers: [...readiness.mcpServers],
      credentialBindings: versionedCredentialBindings,
      evidenceCapabilities: [],
      at: versionResolution.deviceGeneratedAt,
    }, key);
    const inventory = createSignedExecutorVersionInventory({
      executorId,
      inventoryRevision: versionResolution.inventoryRevision,
      capabilityRevision,
      configVersions: {
        runtimeConfigRev: capabilityRevision,
        modelProfileRev: capabilityRevision,
        policyRev: capabilityRevision,
      },
      assetVersions: {
        skillsRev: capabilityRevision,
        rubricsRev: capabilityRevision,
        promptAssetsRev: capabilityRevision,
      },
      permissionSnapshotHighWater: permissionPublication.highWater,
      credentialBindingRevisions: versionedCredentialBindings.map(
        ({ bindingId, revision }) => ({ bindingId, revision }),
      ),
      at: versionResolution.inventoryGeneratedAt,
    }, key);
    const snapshotUpdate = await executorCapabilities.accept({ descriptor, inventory });
    if (!snapshotUpdate.ok) {
      throw new Error(
        `Local executor capability snapshot rejected: ${snapshotUpdate.error.message}`,
      );
    }
    await versionStore.markCapabilityDirectoryEstablished({
      executorId,
      deviceDigest,
      deviceRevision: versionResolution.deviceRevision,
      inventoryDigest,
      inventoryRevision: versionResolution.inventoryRevision,
    });
    capabilityDirectoryEstablished = true;
    return {
      policy: {
        credentialTtlMs: 24 * 60 * 60 * 1_000,
        manifestRequires: {
          runtimeConfigRev: capabilityRevision,
          modelProfileRev: capabilityRevision,
          policyRev: capabilityRevision,
          skillsRev: capabilityRevision,
          rubricsRev: capabilityRevision,
          promptAssetsRev: capabilityRevision,
        },
        manifestCapabilities: {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          tools: executionProfile.tools,
          mcpServers: executionProfile.mcpServers,
          credentialBindings: requiredCredentialBindings,
        },
        permissionSnapshot: permissionPublication.snapshot,
        budget: { maxCalls: 64, maxTokens: 256_000 },
        localGovernorEpoch: 1,
      },
      binding: { executionProfile, deviceDigest },
    };
  });
  const validateConversationRuntimeBinding = (input: {
    readonly manifest: ExecutionManifest<"conversation">;
    readonly binding: ConversationRuntimeBinding;
  }): AuthorityError | undefined => {
    try {
      const profile = normalizeRuntimeExecutionProfile(input.binding.executionProfile);
      const readiness = readinessSource();
      assertRuntimeAvailable(profile, readiness);
      if (input.binding.deviceDigest !== deviceDigestFor(readiness)) {
        return {
          code: "revision-conflict",
          message: "Executor device generation changed before durable receipt",
          retryable: true,
        };
      }
      const versionedBindings = readiness.credentialBindings.map((binding) => ({
        ...binding,
        revision: input.manifest.requires.runtimeConfigRev,
      }));
      const expectedBindings = requiredBindingsForRuntime(profile, versionedBindings);
      if (
        canonicalize(input.manifest.tools) !== canonicalize(profile.tools) ||
        canonicalize(input.manifest.mcpServers) !== canonicalize(profile.mcpServers) ||
        canonicalize(input.manifest.credentialBindings) !== canonicalize(expectedBindings)
      ) {
        return {
          code: "revision-conflict",
          message: "Execution manifest does not bind the assembled runtime",
          retryable: true,
        };
      }
      return undefined;
    } catch (error) {
      return {
        code: "capability-gap",
        message: error instanceof Error ? error.message : "Runtime readiness is unavailable",
        retryable: true,
      };
    }
  };
  return {
    anchorEpoch,
    deviceId: key.deviceId,
    executorId,
    signer: key,
    verifier,
    authority,
    authorityLog,
    artifacts,
    participant,
    controlAdmission,
    executorCapabilities,
    permissionSnapshotFor: (digest) => permissionSnapshots.snapshotFor(digest),
    prepareConversationAssignment,
    validateConversationRuntimeBinding,
  };
}

interface NormalizedExecutorReadiness {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly credentialBindings: readonly Omit<CredentialBindingDescriptor, "revision">[];
  readonly credentialGeneration: string | null;
}

function normalizeExecutorReadiness(
  input: ExecutorReadiness,
  deviceId: string,
): NormalizedExecutorReadiness {
  const tools = normalizeIdentifiers(input.tools, "Executor tools");
  const mcpServers = normalizeIdentifiers(input.mcpServers, "Executor MCP servers");
  const deviceScopedBindingIds = new Set(input.deviceScopedCredentialBindingIds);
  const logicalBindingIds = new Set<string>();
  const credentialBindings = input.credentialBindings.map((binding) => {
    requireIdentifier(binding.bindingId, "Executor credential binding id");
    requireIdentifier(binding.service, "Executor credential service");
    if (logicalBindingIds.has(binding.bindingId)) {
      throw new TypeError("Executor credential binding ids must be unique");
    }
    logicalBindingIds.add(binding.bindingId);
    const deviceScoped = deviceScopedBindingIds.delete(binding.bindingId);
    if (deviceScoped && binding.verification !== "user-alias") {
      throw new TypeError("Only user-alias credential bindings can be device-scoped");
    }
    return {
      bindingId: deviceScoped
        ? deviceScopedUserAliasBindingId(deviceId, binding.bindingId)
        : binding.bindingId,
      service: binding.service,
      verification: binding.verification,
      ...(binding.resource === undefined ? {} : { resource: binding.resource }),
      ...(binding.principalFingerprint === undefined
        ? {}
        : { principalFingerprint: binding.principalFingerprint }),
      ...(binding.tenant === undefined ? {} : { tenant: binding.tenant }),
      ...(binding.scopes === undefined ? {} : { scopes: [...binding.scopes] }),
    } satisfies Omit<CredentialBindingDescriptor, "revision">;
  }).sort((left, right) => compareCanonicalStrings(left.bindingId, right.bindingId));
  if (deviceScopedBindingIds.size > 0) {
    throw new TypeError("Device-scoped executor credential binding is not published");
  }
  if (
    input.credentialGeneration !== null &&
    (typeof input.credentialGeneration !== "string" || input.credentialGeneration.length === 0)
  ) {
    throw new TypeError("Executor credential generation is invalid");
  }
  return {
    tools,
    mcpServers,
    credentialBindings,
    credentialGeneration: input.credentialGeneration,
  };
}

function normalizeRuntimeExecutionProfile(
  input: RuntimeExecutionProfile,
): RuntimeExecutionProfile {
  return {
    tools: normalizeIdentifiers(input.tools, "Runtime tools"),
    mcpServers: normalizeIdentifiers(input.mcpServers, "Runtime MCP servers"),
    providerIds: normalizeIdentifiers(input.providerIds, "Runtime providers"),
  };
}

function assertRuntimeAvailable(
  profile: RuntimeExecutionProfile,
  readiness: NormalizedExecutorReadiness,
): void {
  const tools = new Set(readiness.tools);
  const mcpServers = new Set(readiness.mcpServers);
  if (profile.tools.some((tool) => !tools.has(tool))) {
    throw new Error("Assembled runtime requires an unavailable tool");
  }
  if (profile.mcpServers.some((server) => !mcpServers.has(server))) {
    throw new Error("Assembled runtime requires an unavailable MCP server");
  }
}

function requiredBindingsForRuntime(
  profile: RuntimeExecutionProfile,
  available: readonly CredentialBindingDescriptor[],
): Array<{ readonly service: string; readonly bindingId: string; readonly revision: number }> {
  const byService = new Map<string, CredentialBindingDescriptor>();
  for (const binding of available) {
    if (byService.has(binding.service)) {
      throw new TypeError(`Executor publishes multiple bindings for service ${binding.service}`);
    }
    byService.set(binding.service, binding);
  }
  const required: CredentialBindingDescriptor[] = [];
  for (const providerId of profile.providerIds) {
    const binding = byService.get(`provider-${providerId}`);
    if (binding === undefined) {
      throw new Error(`Resolved provider credential is not ready: ${providerId}`);
    }
    required.push(binding);
  }
  for (const serverId of profile.mcpServers) {
    const binding = byService.get(`mcp-${serverId}`);
    if (binding !== undefined) required.push(binding);
  }
  return required
    .map(({ service, bindingId, revision }) => ({ service, bindingId, revision }))
    .sort((left, right) => compareCanonicalStrings(
      `${left.service}\u0000${left.bindingId}`,
      `${right.service}\u0000${right.bindingId}`,
    ));
}

function normalizeIdentifiers(values: readonly string[], label: string): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    requireIdentifier(value, label);
    normalized.add(value);
  }
  return [...normalized].sort(compareCanonicalStrings);
}

function requireIdentifier(value: string, label: string): void {
  if (!value || value.length > 480 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} contains an invalid identifier`);
  }
}

function canonicalTime(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function deviceScopedUserAliasBindingId(deviceId: string, logicalBindingId: string): string {
  const bindingId = `user-alias:${deviceId}:${logicalBindingId}`;
  if (bindingId.length > 480) {
    throw new TypeError("Device-scoped credential binding id is too long");
  }
  return bindingId;
}

export async function setupDelivery(options: SetupDeliveryOptions): Promise<DeliveryStack> {
  const { channels, zhixingHome, logger } = options;

  // 1. OutboxRegistry — 顺序层，per-target FIFO
  //    doSend 直通 channel adapter；adapter 未就绪则返回可重试失败
  const outboxRegistry = new OutboxRegistry(
    async (target, content, meta) => {
      const adapter = channels.get(target.channelId);
      if (!adapter) {
        // Adapter 可能正处于重连窗口；保持可重试，避免把瞬时不可用误判为永久失败。
        return {
          success: false,
          error: `Channel not found: ${target.channelId}`,
          retryable: true,
        };
      }
      return meta
        ? adapter.send(target, content, meta)
        : adapter.send(target, content);
    },
    {
      onEvent: options.onOutboxEvent,
      logger: {
        debug: logger.debug,
        info: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
        error: (msg) => logger.error(msg),
      },
    },
  );

  // 2. Sender — outbox-bound，Pipeline 的 drain 现在经 Outbox
  const sender = createOutboxSender(outboxRegistry, {
    isReady: (channelId) => {
      const status = channels.getStatus(channelId);
      return status?.state === "connected";
    },
  });

  const {
    artifacts,
    authorityLog,
    authority,
    participant,
    controlAdmission,
  } = options.authorityRuntime;

  const delivery = new DeliveryPipeline({
    sender,
    eventBus: createEventBus<DeliveryEventMap>(),
    config: {
      ...DEFAULT_DELIVERY_CONFIG,
      queueFilePath: path.join(zhixingHome, "delivery-queue.json"),
    },
    logger: {
      debug: () => {},
      info: (msg: string) => logger.info(`[delivery] ${msg}`),
      warn: (msg: string) => logger.warn(`[delivery] ${msg}`),
      error: (msg: string) => logger.error(`[delivery] ${msg}`),
    },
  });
  await delivery.start();

  const transports = new DeliveryTransportRegistry();
  transports.register(channelAuthorityDeliveryTransport(sender));
  const eventBus = createEventBus<AuthorityDeliveryEventMap>();
  const statusListeners = new Set<
    (notice: DeliveryStatusNotice) => void | Promise<void>
  >();
  const publishNotice = async (notice: DeliveryStatusNotice) => {
    await Promise.allSettled(
      [...statusListeners].map(async (listener) => listener(notice)),
    );
  };
  eventBus.on("delivery:notice", ({ notice }) => publishNotice(notice));

  // 权威 Pipeline 只消费已提交事实；conversation 生产入口在 owner commit。
  const authorityDelivery = new AuthorityDeliveryPipeline({
    authority,
    artifacts,
    transport: transports,
    eventBus,
    config: {
      ...DEFAULT_AUTHORITY_DELIVERY_CONFIG,
    },
    logger: {
      debug: () => {},
      info: (msg: string) => logger.info(`[delivery] ${msg}`),
      warn: (msg: string) => logger.warn(`[delivery] ${msg}`),
      error: (msg: string) => logger.error(`[delivery] ${msg}`),
    },
  });
  await authorityDelivery.start();

  return {
    delivery,
    authorityDelivery,
    authority,
    authorityLog,
    artifacts,
    participant,
    controlAdmission,
    outboxRegistry,
    statusHistory: (afterByItem = {}) => authority.statusNotices(afterByItem),
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    resolve: (input) => {
      const envelope = createDeliveryControlEnvelope(input);
      return applyDeliveryResolutionControl({
        admission: controlAdmission,
        authority,
        envelope,
        source: input.source,
        onResolved: (notice) => eventBus.emit("delivery:notice", { notice }),
      });
    },
    stop: async () => {
      statusListeners.clear();
      await authorityDelivery.stop();
      await delivery.stop();
      await outboxRegistry.dispose();
    },
  };
}

async function loadOrCreateDeviceKey(store: SecretStorePort): Promise<DeviceKey> {
  const refs = await store.list("device-key/device/v1/");
  if (refs.length > 1) {
    throw new Error("SecretStore contains multiple local device identities");
  }
  const existing = refs[0];
  if (existing) {
    const deviceId = existing.bindingId.slice("device/v1/".length);
    const key = await loadDeviceKey(store, deviceId);
    if (!key) throw new Error("SecretStore device identity disappeared during startup");
    return key;
  }
  const generated = await DeviceKey.generate();
  await persistDeviceKey(store, generated);
  return generated;
}
