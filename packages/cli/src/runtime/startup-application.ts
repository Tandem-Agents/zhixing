/** Node 首配检查、owner 保存及重读；终端只提供编辑回调。 */
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getZhixingHome } from "@zhixing/core/paths";
import type { SecretStorePort } from "@zhixing/core/contracts";
import { FileLockBusyError } from "@zhixing/core/persistence";
import { maintenanceRetryDelayMs, StorageMaintenanceAdmissionError } from "@zhixing/core/resources";
import { validateMeshRoleBootConfig } from "@zhixing/mesh/bootstrap";
import {
  ConfigSchemaError,
  CredentialsSchemaError,
  getGlobalConfigPath,
  loadConfig,

  validateConfigSemantics,
  type CredentialStoreCoordinator,
  type ConfigSemanticIssue,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing/providers/configuration";
import { createPlatformSecretStore } from "@zhixing/secrets";
import type { LocalConfigurationPort } from "../serve/local-configuration-application.js";
import {
  projectRuntimeSecrets,
  type RuntimeSecretProjections,
} from "./runtime-secret-projections.js";
import {
  createRuntimeConfigurationSnapshot,
  type RuntimeConfigurationSnapshot,
} from "./runtime-configuration-snapshot.js";
import { checkModel } from "./model-configuration-check.js";

/**
 * 入口模式——repl(交互终端)与 host(核心宿主)。两者都只校 model:
 * messaging 是可选能力,凭证不全由 channel 装配警告跳过(非致命),
 * 配置入口是 /config 而非宿主启动拦截。
 */
export type StartupMode = "repl" | "host" | "pairing";

/**
 * 启动检查结果——caller 据此决定后续动作。
 *
 * - ready：必要字段齐全（编辑器未触发或已完成），返回冻结运行配置与用途秘密投影
 * - cancelled：用户在编辑器里取消（应正常退出 exit 0）
 * - schema-error：JSON 解析失败（exit 2）
 * - semantic-error：含废弃字段（exit 2）
 * - non-tty：缺字段且非交互终端（exit 2）
 */
export type StartupCheckResult =
  | ({
      kind: "ready";
      /** This call completed the interactive setup and published its configuration. */
      configurationCompleted?: true;
      runtimeConfiguration: RuntimeConfigurationSnapshot;
      credentialGeneration: string | null;
      secretStore: SecretStorePort & CredentialStoreCoordinator;
    } & RuntimeSecretProjections)
  | { kind: "cancelled" }
  | { kind: "schema-error"; filePath: string; message: string }
  | { kind: "secret-store-error"; filePath: string; message: string }
  | { kind: "read-unavailable"; filePath: string; message: string }
  | { kind: "semantic-error"; filePath: string; issues: ConfigSemanticIssue[] }
  | { kind: "non-tty"; missingLabels: string[] };

export interface StartupApplicationOptions {
  /** Trusted local Configuration application; available without a Host. */
  configuration?: LocalConfigurationPort;
  processIdentityResolver?: import('@zhixing/core/persistence').FileLockOptions['processIdentityResolver'];
  records?: import("@zhixing/core/logging").LogRecordPort;
  /** 入口固定的数据根；配置文件可单独指定。 */
  homeDir?: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  /** 入口模式——决定是否检查 messaging */
  mode: StartupMode;
  /** Node 内受信编辑回调；秘密不作为 UI/IPC 公共模型发布。 */
  edit: (session: {
    readonly config: ZhixingConfig;
    readonly credentials: ZhixingCredentials;
    readonly configPath: string;
    readonly save: (edit: { config: ZhixingConfig; credentials: ZhixingCredentials }) => Promise<unknown>;
  }) => Promise<{ kind: "completed" | "cancelled" | "non-tty" }>;
  /** SecretStore 覆盖（测试或受管宿主注入）。 */
  secretStore?: SecretStorePort & CredentialStoreCoordinator;
  /** 本次启动尝试的取消信号：读取配置的自动接续随它停止。 */
  signal?: AbortSignal;
  /** 读取配置遇正常内部竞争时的接续期限（测试可缩短）。 */
  readContinuationMs?: number;
}

/** 启动尝试内读取配置遇正常内部竞争（文件锁忙、可重试的资源准入背压）时的接续期限；超过才交给用户。 */
const STARTUP_READ_CONTINUATION_MS = 20_000;
const LOCK_BUSY_RETRY_MS = 250;

/**
 * 同一次启动尝试里有限、可取消地接续读取：只对文件锁忙与 maintenanceRetryDelayMs 给出等待的背压重试，
 * 损坏、不可重试的准入拒绝与其他错误原样交回；期限内仍不可读才交回最后一次错误。
 */
async function readContinuing<T>(read: () => Promise<T>, signal?: AbortSignal, budgetMs = STARTUP_READ_CONTINUATION_MS): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    signal?.throwIfAborted();
    try { return await read(); }
    catch (error) {
      const wait = error instanceof FileLockBusyError ? LOCK_BUSY_RETRY_MS : maintenanceRetryDelayMs(error);
      if (wait === undefined || Date.now() + wait > deadline) throw error;
      await delay(wait, undefined, signal ? { signal } : undefined);
    }
  }
}

export async function checkStartupConfiguration(
  options: StartupApplicationOptions,
): Promise<StartupCheckResult> {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);

  const explicitHomeDir = options.homeDir;
  const credentialsHomeDir = explicitHomeDir ?? getZhixingHome();
  const configPath = options.configPath ?? (explicitHomeDir
    ? path.join(explicitHomeDir, "config.jsonc")
    : getGlobalConfigPath(env, credentialsHomeDir));
  // 1. load
  let config: ZhixingConfig;
  let credentials: ZhixingCredentials;
  let credentialGeneration: string | null;
  try {
    config = loadConfig({ configPath, env });
  } catch (err) {
    return {
      kind: "schema-error",
      filePath: err instanceof ConfigSchemaError ? err.filePath : configPath,
      message: err instanceof Error ? err.message : "配置文件不可用",
    };
  }

  const initialIssues = [...validateConfigSemantics(config), ...validateMeshConfiguration(config)];
  if (initialIssues.length > 0) return { kind: "semantic-error", filePath: configPath, issues: initialIssues };

  let secretStore: SecretStorePort & CredentialStoreCoordinator;
  let configuration: LocalConfigurationPort;
  try {
    secretStore =
      options.secretStore ??
      createPlatformSecretStore({ homeDir: credentialsHomeDir, env });
    const secretState = await secretStore.unlockState();
    if (secretState !== "unlocked") {
      return {
        kind: "secret-store-error",
        filePath: credentialsHomeDir,
        message: `SecretStore 当前状态：${secretState}`,
      };
    }
    configuration = options.configuration ?? (await import("../serve/local-configuration-application.js")).createLocalConfigurationApplication({
      homeDir: credentialsHomeDir, configPath, store: secretStore, records: options.records,
      processIdentityResolver: options.processIdentityResolver,
    });
    const preparedCredentials = await readContinuing(() => configuration!.read(), options.signal, options.readContinuationMs);
    credentials = preparedCredentials.credentials;
    config = preparedCredentials.config;
    credentialGeneration = preparedCredentials.generation;
  } catch (err) {
    // 本次启动尝试已取消：不把取消报成配置或凭据故障
    if (options.signal?.aborted) throw err;
    if (err instanceof CredentialsSchemaError) {
      return { kind: "schema-error", filePath: err.filePath, message: err.message };
    }
    if (err instanceof FileLockBusyError || err instanceof StorageMaintenanceAdmissionError) {
      return { kind: "read-unavailable", filePath: credentialsHomeDir,
        message: "本机数据正在准备或繁忙，暂时无法读取配置，请稍后重试。" };
    }
    return {
      kind: "secret-store-error",
      filePath: credentialsHomeDir,
      message: err instanceof Error ? err.message : "SecretStore 不可用",
    };
  }

  const semanticIssues = [...validateConfigSemantics(config), ...validateMeshConfiguration(config)];
  if (semanticIssues.length > 0) return { kind: "semantic-error", filePath: configPath, issues: semanticIssues };

  // 2. 必要字段检测——按 mode 决定 sections
  const missingLabels: string[] = [];

  const modelIssues = checkModel(config, { providers: credentials.providers });
  if (modelIssues.length > 0) {
    missingLabels.push(...modelIssues.map((i) => i.label));
  }

  if (missingLabels.length === 0) {
    return {
      kind: "ready",
      runtimeConfiguration: createRuntimeConfigurationSnapshot(config),
      ...projectRuntimeSecrets(credentials),
      credentialGeneration,
      secretStore,
    };
  }

  // 3. 缺失 + 非 TTY → fail-fast
  if (!isTTY) {
    return { kind: "non-tty", missingLabels };
  }

  // 4. 缺失 + TTY → 跑编辑器
  const editorResult = await options.edit({
    config, credentials, configPath,
    save: (result) => configuration.edit({ config, credentials }, result),
  });

  if (editorResult.kind === "completed") {
    // reload 拿到落盘后的最新内容
    const updatedCredentialSnapshot = await configuration.read();
    return {
      kind: "ready",
      configurationCompleted: true,
      runtimeConfiguration: createRuntimeConfigurationSnapshot(updatedCredentialSnapshot.config),
      ...projectRuntimeSecrets(updatedCredentialSnapshot.credentials),
      credentialGeneration: updatedCredentialSnapshot.generation,
      secretStore,
    };
  }

  if (editorResult.kind === "cancelled") {
    return { kind: "cancelled" };
  }

  // editorResult.kind === "non-tty"——此处理论上不到达（前面已检查 isTTY）
  return { kind: "non-tty", missingLabels };
}

function validateMeshConfiguration(config: ZhixingConfig): ConfigSemanticIssue[] {
  if (config.mesh === undefined) return [];
  try {
    validateMeshRoleBootConfig(config.mesh);
    return [];
  } catch (error) {
    return [{
      field: "mesh",
      reason: error instanceof Error ? error.message : "Mesh role configuration is invalid",
      fix: "修正 mesh.enabledRoles 与 anchorListen / relayRegistration，使启用角色和可达性参数一致",
    }];
  }
}
