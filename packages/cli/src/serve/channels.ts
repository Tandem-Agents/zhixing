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
import { ManagedExtensions } from "@zhixing/core/extensions/runtime";
import type { ExtensionBinding, ExtensionInstance } from "@zhixing/core/extensions/contracts";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import type { ProductApiContribution } from "@zhixing/core/product-api";
import { packagedExtensions } from "../runtime/extensions/catalog.js";
import { ChannelConfiguration } from "../runtime/extensions/channel-configuration.js";
import { channelDeliveryResult, createChannelTypeBinding } from "../runtime/extensions/channel-binding.js";
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
  readonly authorityLog: () => AuthorityCommitLog;
  readonly commitDecision?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly isCurrentOwner: () => boolean;
  readonly configuration: ChannelConfiguration;
  readonly artifactDirectory: string;
  readonly httpRoutes: Map<string, HttpHandler>;
  logger: ChannelLogger;
}

/** Explicit physical-connection profile; absence is never inferred from a missing router. */
export type ConfiguredChannelInbound =
  | Readonly<{
      kind: "router";
      handleMessage(message: InboundMessage): Promise<void>;
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
  const application = new ExtensionApplication({
    log: options.authorityLog,
    commitDecision: options.commitDecision,
    assertOwner: () => {
      if (!options.isCurrentOwner()) throw new Error("Extension decisions require the current owner");
    },
  });
  const artifacts = new ExtensionArtifacts(options.artifactDirectory);
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
  const snapshot = async () => { instances = (await application.list()).instances; };
  const runtime: ManagedExtensions = new ManagedExtensions({
    application, artifacts, isOwner: options.isCurrentOwner,
    projection: (instance) => options.configuration.read(instance),
    binding: (instance) => createChannelTypeBinding({
      instance, routes: options.httpRoutes, process: () => runtime.current(instance.id),
      consumers: () => {
        if (!consumers) throw new Error("Channel consumers unavailable");
        const selected = consumers;
        return {
          message: async (message) => {
            if (selected.inbound.kind !== "router") throw new Error("Inbound Channel unavailable");
            await selected.inbound.handleMessage(message);
          },
          challenge: selected.onChallengeAction,
        };
      },
      ready: (ready) => { if (ready) capabilities.set(instance.id, ready); else capabilities.delete(instance.id); },
    }),
    onState: () => {
      if (closed) return;
      const observation = snapshot().catch(() => undefined);
      observations.add(observation);
      void observation.finally(() => observations.delete(observation));
    },
  });

  // Only distribution-owned migration artifacts are admitted here. Arbitrary
  // candidates require the preparation/admission workflow, not a directory scan.
  const adoptConfigured = async () => {
    for (const [id, entry] of Object.entries(options.configuration.entries())) {
      if (await application.get(id)) continue;
      const seed = seeds.find(({ manifest }) => manifest.type === "channel" && manifest.id === (entry.type ?? id));
      if (!seed) { migrationFailures.add(id); options.logger.error("Channel '%s': no admitted artifact", id); continue; }
      try {
        const bytes = await readFile(join(seed.directory, seed.manifest.entry));
        await artifacts.import(seed.manifest, bytes);
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
    return { instances };
  };
  const productApi = application.contribution({
    changed: async (instance) => { await runtime.reconcile(instance); await snapshot(); },
    refresh, applyConfiguration,
  });
  const send = async (
    target: DeliveryTarget, content: OutboundContent, meta?: Parameters<ChannelAdapter["send"]>[2],
  ): Promise<DeliveryResult> => {
    // Delivery's already-admitted attempts settle under its own drain boundary.
    if (admissionPaused && !meta?.deliveryAttempt) throw new Error("Channel admission is paused");
    const process = runtime.current(target.channelId);
    if (!process) throw new Error("Channel not available");
    return channelDeliveryResult(await process.call("channel.send", { target, content, ...(meta ? { meta } : {}) }));
  };
  const startIfReady = async () => {
    const revision = connectionRevision;
    if (closed || !active || !ownerRequested || !consumers || !options.isCurrentOwner()) return;
    await applyConfiguration([...new Set([...Object.keys(options.configuration.entries()),
      ...(await application.list()).instances.map((instance) => instance.id)])], true);
    if (revision !== connectionRevision || closed || !active || !ownerRequested || !consumers || !options.isCurrentOwner()) return;
    admissionPaused = false;
    await runtime.resume();
  };
  await snapshot();
  return {
    productApi,
    statusSnapshot: () => Object.freeze([...instances.filter((instance) => instance.binding.manifest.type === "channel").map((instance) => Object.freeze({
      channelId: instance.id,
      state: runtime.current(instance.id) ? "connected" as const : runtime.state(instance.id) !== "stopped" ? "connecting" as const :
        ownerRequested && active && instance.enabled && instance.phase === "blocked" ? "error" as const : "disconnected" as const,
      ...(instance.reason ? { error: instance.reason } : {}),
      ...(instance.configurationIssue ? { configurationIssue: instance.configurationIssue } : {}),
    })), ...[...migrationFailures].map((channelId) => Object.freeze({ channelId,
      state: ownerRequested && active ? "error" as const : "disconnected" as const,
      error: "连接迁移受阻，请检查本机制品与账号配置；原数据已保留" }))]),
    delivery: {
      status: (id) => runtime.current(id) ? "connected" : "disconnected",
      send,
    },
    inbound: {
      // During handshake messages may already arrive. Admission is still guarded
      // by current-owner and router gates and does not wait for another Run.
      has: (id) => instances.some((instance) => instance.id === id && instance.enabled),
      bindingPolicy: (id) => capabilities.get(id)?.bindingPolicy,
      send,
    },
    challenges: {
      supports: (id) => Boolean(runtime.current(id) && capabilities.get(id)?.challenges),
      sendChallenge: async (message: ChannelChallengeMessage) => {
        const process = runtime.current(message.token.route.channelId);
        if (!process || !capabilities.get(message.token.route.channelId)?.challenges) throw new Error("Channel challenge unavailable");
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
