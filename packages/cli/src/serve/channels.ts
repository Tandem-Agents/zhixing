import { randomUUID } from "node:crypto";
import {
  type ChannelAdapter,
  type ChannelLogger,
  type ChannelStatus,
  type DeliveryResult,
  type DeliveryTarget,
  type InboundMessage,
  type ChannelChallengeAction,
  type ChannelChallengeMessage,
  type HttpHandler,
  type OutboundContent,
} from "@zhixing/core/channels";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExtensionApplication, ExtensionRevisionConflict } from "@zhixing/core/extensions/application";
import { ExtensionArtifacts } from "@zhixing/core/extensions/artifacts";
import { ExtensionCandidates } from "@zhixing/core/extensions/candidate";
import { ExtensionOnboarding } from "@zhixing/core/extensions/onboarding";
import { channelDeclaration, validateChannelReplacement } from "@zhixing/core/channels/extension";
import { ChannelVerification } from "../runtime/extensions/channel-verification.js";
import { EXTENSION_LOG_SOURCE, ManagedExtensions } from "@zhixing/core/extensions/runtime";
import type { ExtensionBinding, ExtensionInstance, ExtensionOperation } from "@zhixing/core/extensions/contracts";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import type { ProductApiContribution } from "@zhixing/core/product-api";
import { packagedExtensions } from "../runtime/extensions/catalog.js";
import { ChannelConfiguration } from "../runtime/extensions/channel-configuration.js";
import { channelDeliveryResult, createChannelTypeBinding } from "../runtime/extensions/channel-binding.js";
import { CHANNEL_LOG_SOURCE } from "../runtime/extensions/channel-logging.js";
import type { ChannelDeliveryEffectSource } from "@zhixing/core/delivery/channel-effect";
import {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
  DEFAULT_CANCEL_KEYWORDS,
  InboundRouter,
  createDefaultIntentClassifier,
  type InboundChannelPort,
  type InboundConversationApplicationPort,
  type InboundDeliveryOutboxPort,
} from "@zhixing/server";
import type { ConfirmationHub } from "@zhixing/owner-kernel/confirmation-hub";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc";
import type { ChannelChallengeDeliveryPort } from "./lossless-data-plane-runtime.js";

// ─── Channel Setup ───

export interface SetupChannelsOptions {
  readonly bindLogs?: import("@zhixing/core/logging").BindLogSource;
  readonly authorityLog: () => AuthorityCommitLog;
  readonly commitDecision?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly isCurrentOwner: () => boolean;
  readonly configuration: ChannelConfiguration;
  readonly artifactDirectory: string;
  readonly httpRoutes: Map<string, HttpHandler>;
  readonly notifyOperation?: (operation: ExtensionOperation) => Promise<unknown>;
  readonly preparationClosed?: (operation: ExtensionOperation) => Promise<boolean>;
  readonly repairSource?: (instance: ExtensionInstance) => Promise<ExtensionOperation["source"] | undefined>;
  logger: ChannelLogger;
}

/** Explicit physical-connection profile; absence is never inferred from a missing router. */
export type ConfiguredChannelInbound =
  | Readonly<{
      kind: "router";
      handleMessage(message: InboundMessage): Promise<void>;
      handleControlMessage?(message: InboundMessage): Promise<boolean>;
    }>
  | Readonly<{ kind: "absent"; reason: "outbound-only" }>;

/** Complete physical consumers required before any configured adapter connects. */
export interface ConfiguredChannelConsumers {
  readonly inbound: ConfiguredChannelInbound;
  readonly onChallengeAction: (action: ChannelChallengeAction) => Promise<void>;
}

export interface SetupChannelsResult {
  readonly productApi: ProductApiContribution;
  statusSnapshot(): readonly Readonly<ChannelStatus>[];
  readonly delivery: ChannelDeliveryEffectSource;
  readonly inbound: InboundChannelPort;
  readonly challenges: ChannelChallengeDeliveryPort;
  /** Release the Host gate after dependencies and startup recovery are ready. */
  activate(): Promise<void>;
  /** Before activation these record owner intent without opening a transport. */
  connectConfigured(consumers: ConfiguredChannelConsumers): Promise<void>;
  disconnectConfigured(): Promise<void>;
  suspendConfigured(): Promise<void>;
  resumeConfigured(consumers: ConfiguredChannelConsumers): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreateInboundChannelRouterOptions {
  readonly conversation: InboundConversationApplicationPort;
  readonly channels: InboundChannelPort;
  readonly deliveryOutbox: InboundDeliveryOutboxPort;
  readonly logger: ChannelLogger;
  readonly confirmationHub?: ConfirmationHub;
  readonly cancelKeywords?: readonly string[];
  readonly sessionBroadcast: SessionBroadcast;
  readonly sessionActivityBroadcast: SessionActivityBroadcast;
  readonly isCurrentOwner: () => boolean;
}

/** Constructs the complete inbound consumer only after Delivery owns its Outbox. */
export function createInboundChannelRouter(
  options: CreateInboundChannelRouterOptions,
): InboundRouter {
  const mergedCancelKeywords =
    options.cancelKeywords && options.cancelKeywords.length > 0
      ? [...DEFAULT_CANCEL_KEYWORDS, ...options.cancelKeywords]
      : DEFAULT_CANCEL_KEYWORDS;
  const intentClassifier = createDefaultIntentClassifier({
    cancelKeywords: mergedCancelKeywords,
    confirmationApproveKeywords: APPROVE_KEYWORDS,
    confirmationDenyKeywords: DENY_KEYWORDS,
  });
  return new InboundRouter({
    conversation: options.conversation,
    channels: options.channels,
    deliveryOutbox: options.deliveryOutbox,
    logger: options.logger,
    confirmationHub: options.confirmationHub,
    intentClassifier,
    sessionBroadcast: options.sessionBroadcast,
    sessionActivityBroadcast: options.sessionActivityBroadcast,
    isCurrentOwner: options.isCurrentOwner,
  });
}

export async function setupChannels(options: SetupChannelsOptions): Promise<SetupChannelsResult> {
  const deliveryRecords = options.bindLogs?.(CHANNEL_LOG_SOURCE, { scope: "storage" }, [], { maxPerSecond: 32 });
  const application = new ExtensionApplication({
    log: options.authorityLog,
    commitDecision: options.commitDecision,
    assertOwner: () => {
      if (!options.isCurrentOwner()) throw new Error("Extension decisions require the current owner");
    },
  });
  const artifacts = new ExtensionArtifacts(options.artifactDirectory);
  const candidates = new ExtensionCandidates(join(options.artifactDirectory, "..", "candidates"));
  const seeds = packagedExtensions();
  let instances: readonly ExtensionInstance[] = [];
  const capabilities = new Map<string, { challenges: boolean; bindingPolicy?: import("@zhixing/core/channels").ChannelBindingPolicy }>();
  let consumers: ConfiguredChannelConsumers | undefined;
  let active = false;
  let closed = false;
  let ownerRequested = false;
  let admissionPaused = false;
  let connectionRevision = 0;
  const migrationFailures = new Set<string>();
  const observations = new Set<Promise<void>>();
  let onboarding: ExtensionOnboarding | undefined;
  const snapshot = async () => { instances = (await application.list()).instances; };
  const changedOperation = () => {
    const observation = snapshot().then(() => onboarding?.reconcile()).then(async () => {
      for (const instance of (await application.list()).instances) await verification.resume(instance);
    }).catch(() => undefined);
    observations.add(observation); void observation.finally(() => observations.delete(observation));
  };
  const verification = new ChannelVerification(application, options.configuration.secretPort(), (id) => runtime.current(id), changedOperation);
  const runtime: ManagedExtensions = new ManagedExtensions({
    recordsFor: (instance, generation) => options.bindLogs?.(EXTENSION_LOG_SOURCE, { scope: "storage" }, [
      { kind: "extension", id: instance.id }, { kind: "generation", id: generation },
      ...(instance.admission ? [{ kind: "operation", id: instance.admission.operationId }] : []),
    ], { maxPerSecond: 32 }),
    application, artifacts, isOwner: options.isCurrentOwner,
    projection: (instance) => options.configuration.read(instance),
    binding: (instance) => createChannelTypeBinding({
      records: options.bindLogs?.(CHANNEL_LOG_SOURCE, { scope: "storage" }, [{ kind: "extension", id: instance.id }, ...(instance.generation ? [{ kind: "generation", id: instance.generation }] : [])], { maxPerSecond: 32 }),
      instance, routes: options.httpRoutes,
      consumers: () => {
        if (!consumers) throw new Error("Channel consumers unavailable");
        const selected = consumers;
        return {
          message: async (message, controlOnly) => {
            const current = await application.get(instance.id);
            const operation = current?.admission && !current.admission.ready
              ? await application.operation(current.admission.operationId) : undefined;
            const previouslyAdmitted = current && (!current.admission || current.admission.ready || operation?.previous);
            // A committed handover revokes the generation before the physical
            // process quiesces. Keep only existing controls in that gap; an
            // unverified first trial has never earned this control admission.
            if (controlOnly || current?.generation !== instance.generation) {
              if (current?.enabled && current.binding.configurationRevision === instance.binding.configurationRevision &&
                  previouslyAdmitted &&
                  !/^(连接|确认) [a-f0-9]{32}$/.test(message.text.trim()) && selected.inbound.kind === "router" &&
                  await selected.inbound.handleControlMessage?.(message)) return;
              throw new Error("连接交接期间只接纳既有确认与取消");
            }
            if (!current || !current.enabled || current.generation !== instance.generation) throw new Error("连接代际已失效");
            if (current.admission && !current.admission.ready && !/^(连接|确认) [a-f0-9]{32}$/.test(message.text.trim()) &&
                operation?.previous && selected.inbound.kind === "router" &&
                await selected.inbound.handleControlMessage?.(message)) return;
            if (await verification.accept(current, message)) return;
            const admitted = await application.get(instance.id);
            if (!admitted?.enabled || admitted.generation !== instance.generation || (admitted.admission && !admitted.admission.ready)) throw new Error("连接准入已变化");
            if (selected.inbound.kind !== "router") throw new Error("Inbound Channel unavailable");
            await selected.inbound.handleMessage(message);
          },
          challenge: async (action) => {
            // Signed challenges and responder identity remain owned by the
            // ConfirmationHub, including replies from a retiring generation.
            await selected.onChallengeAction(action);
          },
        };
      },
      ready: (ready) => { if (ready) capabilities.set(instance.id, ready); else capabilities.delete(instance.id); },
    }),
    onState: () => {
      if (closed) return;
      changedOperation();
    },
  });

  // Only distribution-owned migration artifacts are admitted here. Arbitrary
  // candidates require the preparation/admission workflow, not a directory scan.
  const adoptConfigured = async () => {
    // Older installations already have an adopted binding but no source archive.
    for (const instance of (await application.list()).instances) {
      const seed = seeds.find(item => item.manifest.digest === instance.binding.manifest.digest);
      if (!seed) continue;
      try { await candidates.read(seed.manifest.digest); }
      catch {
        const code = await readFile(join(seed.directory, seed.manifest.entry), "utf8");
        await candidates.save({ manifest: seed.manifest, code,
          provenance: { kind: "existing", url: "https://github.com/Tandem-Agents/zhixing", revision: seed.manifest.digest },
          sources: { [seed.manifest.entry]: code }, build: "发布包固定 Node 24 独立制品；保留的入口也是可修改的完整源码，无外部依赖" });
      }
    }
    for (const [id, entry] of Object.entries(options.configuration.entries())) {
      if (await application.get(id)) continue;
      // Dynamic candidates (including cancelled operations) never become a
      // distribution migration just because their type matches a seed.
      if ((await application.list()).operations?.some(operation => operation.instanceId === id)) continue;
      const seed = seeds.find(({ manifest }) => manifest.type === "channel" && manifest.id === (entry.type ?? id));
      if (!seed) { migrationFailures.add(id); options.logger.error("Channel '%s': no admitted artifact", id); continue; }
      try {
        const bytes = await readFile(join(seed.directory, seed.manifest.entry));
        await artifacts.import(seed.manifest, bytes);
        await candidates.save({ manifest: seed.manifest, code: bytes.toString("utf8"),
          provenance: { kind: "existing", url: "https://github.com/Tandem-Agents/zhixing", revision: seed.manifest.digest },
          sources: { [seed.manifest.entry]: bytes.toString("utf8") }, build: "发布包固定 Node 24 独立制品；保留的入口也是可修改的完整源码，无外部依赖" });
        const binding = await options.configuration.prepare(id, seed.manifest);
        const enabled = await options.configuration.requestedEnabled(id, undefined, binding.sourceRevision);
        const adopted = await application.adopt(id, binding, enabled ?? true);
        if (adopted.binding.projectionRevision !== binding.projectionRevision) await options.configuration.discard(id, binding);
        await options.configuration.acknowledge(id, adopted.binding.sourceRevision);
        migrationFailures.delete(id);
      } catch {
        migrationFailures.add(id);
        options.logger.error("Channel '%s': migration blocked; original configuration retained", id);
      }
    }
    await snapshot();
  };
  const refresh = async (id: string, expectedRevision: number, recovering = false) => {
    const current = await application.get(id);
    if (!current) throw new Error("Unknown extension instance");
    // Validate the entire candidate before retiring the currently working process.
    if (current.revision !== expectedRevision) throw new Error("Extension revision conflict");
    const publication = await options.configuration.publication(id);
    const enabled = await options.configuration.requestedEnabled(id, current, publication?.revision);
    let binding: ExtensionBinding;
    let configurationIssue: string | undefined;
    try {
      binding = await options.configuration.prepare(id, current.binding.manifest, current, recovering);
    } catch (error) {
      if (enabled !== false || !publication) throw error;
      // Stop intent is independent of candidate validity; keep the last valid pair.
      await options.configuration.requestedEnabled(id, current, publication.revision);
      binding = { ...current.binding, sourceRevision: publication.revision };
      configurationIssue = "连接已停用；新配置尚未应用，请补全配置后保存";
    }
    await options.configuration.requestedEnabled(id, current, binding.sourceRevision);
    if (binding.projectionRevision === current.binding.projectionRevision && enabled === undefined) {
      await runtime.reconcile(current);
      await options.configuration.acknowledge(id, current.binding.sourceRevision);
      await application.noteConfiguration(id, (await application.get(id))!.revision);
      return (await application.get(id))!;
    }
    let next: ExtensionInstance;
    try { next = await application.refresh(id, binding, expectedRevision, enabled); }
    catch (error) {
      if (error instanceof ExtensionRevisionConflict && binding.projectionRevision !== current.binding.projectionRevision) {
        await options.configuration.discard(id, binding);
      }
      throw error;
    }
    await runtime.reconcile(next);
    if (configurationIssue) await application.noteConfiguration(id, next.revision, configurationIssue);
    await options.configuration.acknowledge(id, next.binding.sourceRevision);
    await snapshot();
    return next;
  };
  const applyConfiguration = async (ids: readonly string[], recovering = false) => {
    await adoptConfigured();
    const entries = options.configuration.entries();
    for (const instance of (await application.list()).instances) {
      if (instance.binding.manifest.type !== "channel" || !ids.includes(instance.id)) continue;
      try {
      if (!entries[instance.id]) {
        const publication = await options.configuration.publication(instance.id);
        if (!instance.enabled && !publication) continue;
        if (recovering && !publication) throw new Error("配置项已移除但停用尚未提交，请在配置入口确认；旧绑定保持不变");
        await options.configuration.requestedEnabled(instance.id, instance, publication?.revision);
        if (publication?.revision !== instance.binding.sourceRevision || instance.enabled) {
          const stopped = await application.refresh(instance.id, { ...instance.binding,
            ...(publication ? { sourceRevision: publication.revision } : {}) }, instance.revision, false);
          await runtime.reconcile(stopped);
        }
        await options.configuration.acknowledge(instance.id, publication?.revision);
      } else {
        await refresh(instance.id, instance.revision, recovering);
      }
      } catch (error) {
        await application.noteConfiguration(instance.id, (await application.get(instance.id))!.revision,
          "配置尚未应用：请在本机配置入口确认完整设置；当前启停意图与旧绑定保持不变");
        await snapshot();
        if (!recovering) throw error;
      }
    }
    await snapshot();
    await onboarding?.reconcile();
    return application.list();
  };
  onboarding = new ExtensionOnboarding(application, artifacts, candidates, {
    validate: (manifest) => { channelDeclaration(manifest); },
    configuration: async (operation) => {
      if (operation.previous) {
        const current = await application.get(operation.instanceId);
        if (!current) throw new Error("原连接不存在");
        return options.configuration.replacement(current, operation.candidate!);
      }
      const trial = await application.get(operation.instanceId);
      if (trial) {
        if (!trial.enabled || trial.admission?.ready || trial.admission?.operationId !== operation.id) throw new ExtensionRevisionConflict();
        const binding = await options.configuration.replacement(trial, operation.candidate!);
        validateChannelReplacement(trial.binding, binding, "repair");
        return binding;
      }
      if (!options.configuration.entries()[operation.instanceId]) return undefined;
      const publication = await options.configuration.publication(operation.instanceId);
      if (!publication) throw new Error("候选配置必须经安全入口完整保存");
      const intent = await options.configuration.requestedEnabled(operation.instanceId, undefined, publication.revision);
      if (intent === false) { await application.cancel(operation.id, operation.revision); return undefined; }
      const binding = await options.configuration.prepare(operation.instanceId, operation.candidate!, undefined, true);
      await verification.code(operation);
      return binding;
    },
    replacement: async (operation, binding) => {
      validateChannelReplacement(operation.previous!.binding, binding, operation.purpose!);
    },
    discard: (id, binding) => options.configuration.discard(id, binding),
    changed: async (instance) => {
      // Trial admission has durably consumed this exact publication. Retaining
      // its initial enable intent would contaminate a later configuration edit.
      await options.configuration.acknowledge(instance.id, instance.binding.sourceRevision);
      await runtime.reconcile(instance); await snapshot();
    },
    notify: async (operation) => {
      if (!options.notifyOperation) throw new Error("原请求结果入口尚未就绪");
      return options.notifyOperation(operation);
    },
    preparationClosed: options.preparationClosed,
    repairSource: options.repairSource,
    isActive: () => active && ownerRequested && !closed && !admissionPaused && options.isCurrentOwner(),
  });
  const productApi = application.contribution({
    changed: async (instance) => { await runtime.reconcile(instance); await snapshot(); await onboarding?.reconcile(); },
    refresh, applyConfiguration,
    manage: (request) => onboarding!.manage(request),
    localSetup: async () => {
      const instructions: Record<string, string> = {};
      for (const operation of (await application.list()).operations ?? []) {
        if (["configuration", "verifying"].includes(operation.phase)) instructions[operation.instanceId] = `保存凭据并启用后，本人在对应 APP 的目标会话发送：连接 ${await verification.code(operation)}；再在同一会话按收到的回复确认。`;
      }
      return instructions;
    },
  });
  const send = async (
    target: DeliveryTarget, content: OutboundContent, meta?: Parameters<ChannelAdapter["send"]>[2],
  ): Promise<DeliveryResult> => {
    const refs = [
      { kind: "extension", id: target.channelId },
      ...(meta?.deliveryAttempt ? [{ kind: "delivery", id: meta.deliveryAttempt.itemId }] : []),
      { kind: "deliveryAttempt", id: meta?.deliveryAttempt ? meta.deliveryAttempt.itemId + ":" + meta.deliveryAttempt.attempt : randomUUID() },
    ];
    const records = deliveryRecords;
    const refuse = (error: string): DeliveryResult => {
      records?.record({ event: "delivered", refs, result: "refused", data: { attempted: false, retryable: true, error } });
      return { success: false, error, retryable: true, attempted: false };
    };
    // Delivery's already-admitted attempts settle under its own drain boundary.
    if (admissionPaused && !meta?.deliveryAttempt) return refuse("Channel admission is paused");
    const instance = await application.get(target.channelId);
    if (instance?.generation) refs.push({ kind: "generation", id: instance.generation });
    if (instance?.admission && !instance.admission.ready) return refuse("连接尚未通过收发验证");
    const process = runtime.current(target.channelId);
    if (!instance?.enabled || !process || instance.generation !== process.generation) return refuse("Channel not available");
    records?.record(() => ({ event: "sending", refs, data: { attempt: meta?.deliveryAttempt?.attempt } }));
    try {
      const result = channelDeliveryResult(await process.call("channel.send", { target, content, ...(meta ? { meta } : {}) }, refs));
      records?.record(() => ({ event: "delivered", refs: [...refs, ...(result.messageId ? [{ kind: "message", id: result.messageId }] : [])], result: result.success ? "success" : result.attempted === false ? "refused" : "unknown", data: { attempted: result.attempted, retryable: result.retryable, error: result.error } }));
      return result;
    } catch (error) {
      records?.record(() => ({ event: "delivered", refs, result: "unknown", data: { error: error instanceof Error ? error.message : "渠道未确认投递结果" } }));
      throw error;
    }
  };
  const startIfReady = async () => {
    const revision = connectionRevision;
    if (closed || !active || !ownerRequested || !consumers || !options.isCurrentOwner()) return;
    await applyConfiguration([...new Set([...Object.keys(options.configuration.entries()),
      ...(await application.list()).instances.map((instance) => instance.id)])], true);
    if (revision !== connectionRevision || closed || !active || !ownerRequested || !consumers || !options.isCurrentOwner()) return;
    admissionPaused = false;
    await runtime.resume();
    await onboarding?.reconcile();
  };
  await snapshot();
  return {
    productApi,
    statusSnapshot: () => Object.freeze([...instances.filter((instance) => instance.binding.manifest.type === "channel").map((instance) => Object.freeze({
      channelId: instance.id,
      state: runtime.current(instance.id) ? instance.admission && !instance.admission.ready ? "connecting" as const : "connected" as const : runtime.state(instance.id) !== "stopped" ? "connecting" as const :
        ownerRequested && active && instance.enabled && instance.phase === "blocked" ? "error" as const : "disconnected" as const,
      ...(instance.reason ? { error: instance.reason } : {}),
      ...(instance.configurationIssue ? { configurationIssue: instance.configurationIssue } : instance.admission && !instance.admission.ready ? { configurationIssue: "待完成本人收发验证，尚未开放正常使用" } : {}),
    })), ...[...migrationFailures].map((channelId) => Object.freeze({ channelId,
      state: ownerRequested && active ? "error" as const : "disconnected" as const,
      error: "连接迁移受阻，请检查本机制品与账号配置；原数据已保留" }))]),
    delivery: {
      status: (id) => runtime.current(id) && !instances.some(instance => instance.id === id && instance.admission && !instance.admission.ready) ? "connected" : "disconnected",
      send,
    },
    inbound: {
      // During handshake messages may already arrive. Admission is still guarded
      // by current-owner and router gates and does not wait for another Run.
      has: (id) => instances.some((instance) => instance.id === id && instance.enabled && (!instance.admission || instance.admission.ready)),
      bindingPolicy: (id) => {
        const instance = instances.find(item => item.id === id);
        return instance ? channelDeclaration(instance.binding.manifest).bindingPolicy : undefined;
      },
      send,
    },
    challenges: {
      supports: (id) => Boolean(runtime.current(id) && capabilities.get(id)?.challenges && !instances.some(instance => instance.id === id && instance.admission && !instance.admission.ready)),
      sendChallenge: async (message: ChannelChallengeMessage) => {
        const instance = await application.get(message.token.route.channelId);
        const process = runtime.current(message.token.route.channelId);
        if (!instance?.enabled || !process || instance.generation !== process.generation ||
            (instance.admission && !instance.admission.ready) || !capabilities.get(message.token.route.channelId)?.challenges) throw new Error("Channel challenge unavailable");
        return channelDeliveryResult(await process.call("channel.send-challenge", message));
      },
    },
    activate: async () => {
      if (closed || active) throw new Error("Channel lifecycle cannot activate");
      active = true; await startIfReady();
    },
    connectConfigured: async (next) => { if (closed) throw new Error("Channel lifecycle closed"); connectionRevision++; consumers = next; ownerRequested = true; await startIfReady(); },
    disconnectConfigured: async () => { connectionRevision++; ownerRequested = false; admissionPaused = true; await runtime.suspend(); },
    suspendConfigured: async () => { connectionRevision++; ownerRequested = false; admissionPaused = true; runtime.pause(); },
    resumeConfigured: async (next) => { if (closed) throw new Error("Channel lifecycle closed"); connectionRevision++; consumers = next; ownerRequested = true; await startIfReady(); },
    dispose: async () => {
      connectionRevision++; closed = true; ownerRequested = false; consumers = undefined;
      await runtime.close(); await Promise.all(observations);
    },
  };
}
