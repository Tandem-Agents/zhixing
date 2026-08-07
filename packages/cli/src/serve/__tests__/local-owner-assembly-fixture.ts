import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  ExplicitEnvironmentSelection,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { ConfirmationBroker } from "@zhixing/core";
import type { AuthorityRuntimeStack } from "../../setup-delivery.js";
import { setupAuthorityRuntime } from "../../setup-delivery.js";
import type { ZhixingConfig } from "@zhixing/providers";
import {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
  type ExecutorResourceGovernor,
} from "@zhixing/executor";
import type {
  RuntimeFactory,
  SessionRuntime,
} from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";
import {
  ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
  createConversationExecutorLedger,
} from "../conversation-executor-ledger.js";
import { createDeviceCapacityRuntime } from "../device-capacity-runtime.js";
import {
  localConversationOwnerRuntime,
  type LocalConversationOwnerRuntimeStack,
} from "../conversation-owner-runtime.js";
import {
  DurableConversationInteractionObserver,
} from "../conversation-protocol-runtime.js";
import type { ExecutorDataPlaneRuntime } from "../executor-data-plane-runtime.js";
import {
  LocalConversationOwnerAssembly,
  type LocalConversationOwnerPort,
} from "../local-conversation-owner.js";
import { createSignedTrustRuleSnapshot, StreamDigestChain } from "@zhixing/core/protocol";

export const FIXTURE_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

export const FIXTURE_CONFIG: ZhixingConfig = {
  llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
};

export class FixtureSecretStore implements SecretStorePort {
  readonly #values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.#values.set(`${ref.kind}/${ref.bindingId}`, value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.#values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.#values.delete(`${ref.kind}/${ref.bindingId}`);
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.#values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const separator = key.indexOf("/");
        return {
          kind: key.slice(0, separator) as SecretRef["kind"],
          bindingId: key.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

/** 同一 home 复用同一 SecretStore,模拟同设备重启(设备密钥不变)。 */
const secretStoresByHome = new Map<string, FixtureSecretStore>();

/** 与两生产根一致的本地域依赖精确集(显式字面量,禁止整栈透传)。 */
export function fixtureLocalOwnerRuntime(
  authority: AuthorityRuntimeStack,
): LocalConversationOwnerRuntimeStack {
  return localConversationOwnerRuntime({
    artifacts: authority.artifacts,
    deviceId: authority.deviceId,
    executorCapabilities: authority.executorCapabilities,
    executorId: authority.executorId,
    executorLog: authority.executorLog,
    executorResourceGovernor: authority.executorResourceGovernor,
    executionAssetCatalog: authority.executionAssetCatalog,
    localControlAdmission: authority.localControlAdmission,
    localDomainId: authority.localDomainId,
    localGovernorEpoch: authority.localGovernorEpoch,
    localOwnerEpoch: authority.localOwnerEpoch,
    permissionSnapshotFor: authority.permissionSnapshotFor,
    preflightLocalConversationEnvironment:
      authority.preflightLocalConversationEnvironment,
    prepareLocalConversationAssignment:
      authority.prepareLocalConversationAssignment,
    releaseLocalConversationEnvironmentPreflight:
      authority.releaseLocalConversationEnvironmentPreflight,
    signer: authority.signer,
    validateConversationRuntimeBinding:
      authority.validateConversationRuntimeBinding,
    validateLocalConversationManifest:
      authority.validateLocalConversationManifest,
    verifier: authority.verifier,
  });
}

export interface FixtureRuntimeControl {
  /** 已开始的 run 数。 */
  readonly executions: () => number;
  /** 已收到 abort 的 run 数。 */
  readonly aborts: () => number;
}

export interface LocalOwnerAssemblyFixture {
  readonly home: string;
  readonly authority: AuthorityRuntimeStack;
  readonly assembly: LocalConversationOwnerAssembly;
  readonly port: LocalConversationOwnerPort;
  readonly runtime: FixtureRuntimeControl;
  readonly environment?: ExplicitEnvironmentSelection;
}

export interface CreateLocalOwnerAssemblyFixtureOptions {
  /** anchor-executor 对应同机组合根(assembly 自建 ledger);executor-only 对应独立执行宿主(共享 ledger)。 */
  readonly profile: "anchor-executor" | "executor-only";
  /** 复用既有 home 即模拟重启重建。 */
  readonly home?: string;
  /** 脚本性 run 行为;默认立即完成。 */
  readonly run?: SessionRuntime["run"];
  /** 关闭 drain 预算;默认 30s 的生产值,测试收束失败路径时传小值。 */
  readonly closeDrainBudgetMs?: number;
  /** 为生产 conformance 安装一个真实本机 workspace binding。 */
  readonly withWorkspace?: boolean;
  /** 让默认 runtime 在模型执行中产生一个真实、保持 pending 的确认。 */
  readonly pendingConfirmation?: boolean;
}

export async function createLocalOwnerAssemblyFixture(
  options: CreateLocalOwnerAssemblyFixtureOptions,
): Promise<LocalOwnerAssemblyFixture> {
  const home = options.home ??
    (await createTempDir(`local-owner-assembly-${options.profile}`));
  const secretStore = secretStoresByHome.get(home) ?? new FixtureSecretStore();
  secretStoresByHome.set(home, secretStore);
  const capacity = createDeviceCapacityRuntime(path.join(home, "fixture-capacity"));
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore,
    executorReadiness: FIXTURE_EXECUTOR_READINESS,
    enableAnchor: options.profile === "anchor-executor",
    enableLocalExecutor: true,
    deviceCapacity: capacity.arbiter,
    storageMaintenance: capacity.storage,
  });
  await authority.installPermissionSnapshot(
    createSignedTrustRuleSnapshot(
      {
        snapshotVersion: 1,
        rules: [],
        generatedAt: "2026-08-07T00:00:00.000Z",
      },
      authority.signer,
    ),
  );
  let environment: ExplicitEnvironmentSelection | undefined;
  if (options.withWorkspace) {
    const migration = authority.workspaceBindingMigration;
    if (!migration) throw new Error("fixture: workspace binding migration unavailable");
    const workspacePath = path.join(home, "conformance-workspace");
    await mkdir(workspacePath, { recursive: true });
    const migrationId = `local-owner-${options.profile}-workspace`;
    const sourceSnapshotToken = "workspace-snapshot-v1";
    const binding = await migration.importLegacy(
      {
        migrationId,
        sourceSnapshotToken,
        displayName: "Local Owner Conformance Workspace",
        absolutePath: workspacePath,
      },
      new AbortController().signal,
    );
    await migration.activateLegacy(
      { migrationId, sourceSnapshotToken },
      new AbortController().signal,
    );
    environment = {
      workspace: {
        deviceId: authority.deviceId,
        bindingRef: binding.bindingRef,
      },
    };
  }
  const interactions = new DurableConversationInteractionObserver();
  const confirmationBroker = options.pendingConfirmation
    ? new ConfirmationBroker({ lifecycleObserver: interactions })
    : undefined;
  confirmationBroker?.onRequest(() => {});
  let executions = 0;
  let aborts = 0;
  const defaultRun: SessionRuntime["run"] = async function* (messages) {
    if (confirmationBroker) {
      const now = Date.now();
      await confirmationBroker.requestConfirmation({
        id: "fixture-pending-confirmation",
        tool: "bash",
        toolInput: { command: "pwd" },
        workingDirectory: home,
        display: {
          title: "Run command?",
          body: { kind: "generic", summary: "pwd" },
          cwd: home,
        },
        options: [{ kind: "allow-once", label: "Allow" }],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
      });
    }
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "fixture done" }],
    };
    return {
      agentResult: {
        reason: "completed" as const,
        message: assistant,
        usage: { inputTokens: 2, outputTokens: 2 },
      },
      runRecord: {
        timestamp: new Date().toISOString(),
        messages: [messages.at(-1)!, assistant],
        usage: { inputTokens: 2, outputTokens: 2 },
        source: "interactive" as const,
      },
      newMessages: [assistant],
      durationMs: 1,
    };
  };
  const scriptedRun = options.run;
  const runtime: SessionRuntime = {
    executionPermissionRules: () => [],
    securitySnapshot: () => ({
      contextId: { kind: "main" },
      workspacePath: null,
      permissionRules: [],
      builtinRules: [],
      rateLimits: [],
      confirmations: [],
    }),
    executionProfile: () => ({ tools: [], mcpServers: [], providerIds: [] }),
    sessionId: `fixture-${options.profile}`,
    ...(confirmationBroker ? { confirmationBroker } : {}),
    run: (messages, runOptions) => {
      executions += 1;
      return (scriptedRun ?? defaultRun)(messages, runOptions);
    },
    abort: () => {
      aborts += 1;
      confirmationBroker?.cancelAll("aborted");
      return true;
    },
    dispose: async () => {},
  };
  const runtimeFactory: RuntimeFactory = { create: async () => runtime };
  const owner = fixtureLocalOwnerRuntime(authority);
  const ledger = options.profile === "executor-only"
    ? createConversationExecutorLedger({
        Constructor: ConversationAssignmentLedger,
        authority: owner,
        assignmentRecordV2Writes: ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
        usageFinal: (assignmentId: string) =>
          (
            authority.executorResourceGovernor as ExecutorResourceGovernor
          ).finalizeLocalAssignment(assignmentId),
      })
    : undefined;
  const assembly = await LocalConversationOwnerAssembly.create({
    owner,
    ...(ledger ? { ledger } : {}),
    ConversationAssignmentLedger,
    InProcessAssignmentSubmission,
    runtimeFactory,
    interactions,
    config: FIXTURE_CONFIG,
    credentials: { providers: { deepseek: { apiKey: "fixture-api-key" } } },
    evidence: {
      collect: async () => {
        throw new Error("fixture: evidence unavailable");
      },
    },
    currentAnchorDeviceId: () => authority.deviceId,
    dataPlane: {
      createStream: async ({ assignmentId }: { readonly assignmentId: string }) =>
        new StreamDigestChain(assignmentId),
    } as unknown as Pick<ExecutorDataPlaneRuntime, "tickets" | "createStream">,
    ...(options.closeDrainBudgetMs === undefined
      ? {}
      : { closeDrainBudgetMs: options.closeDrainBudgetMs }),
  });
  return {
    home,
    authority,
    assembly,
    port: assembly.port(),
    runtime: {
      executions: () => executions,
      aborts: () => aborts,
    },
    ...(environment ? { environment } : {}),
  };
}
