/**
 * CLI 启动检查 + 配置编辑器集成。
 *
 * 把"启动期检查 + 触发配置编辑器"封装成单一调用，让 cli/index.ts 与 serve/command.ts
 * 用同一逻辑——避免分裂实现。
 *
 * 流程：
 *   1. 加载公开配置，并在同一协调区完成旧凭据清退与 SecretStore 加载
 *   2. validateConfigSemantics —— 含废弃字段 → semantic-error
 *   3. checkModel —— 缺失则触发编辑器(messaging 可选,不在宿主启动拦截)
 *   4. 编辑器完成 → reload 后返回 ready
 *   5. 全部齐全 → 直接 ready
 *
 * caller 按返回 kind 决定后续：
 *   - ready / completed → 继续启动 REPL / server
 *   - cancelled → process.exit(0)
 *   - 其它（schema-error / secret-store-error / semantic-error / non-tty）→ 打印错误 + exit(2)
 */

import path from "node:path";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { validateMeshRoleBootConfig } from "@zhixing/mesh/bootstrap";
import {
  ConfigSchemaError,
  CredentialsSchemaError,
  getGlobalConfigPath,
  loadConfig,
  loadCredentialsWithLegacyMigration,
  resolveHomeDir,
  validateConfigSemantics,
  writeConfig,
  writeCredentials,
  type CredentialStoreCoordinator,
  type ConfigSemanticIssue,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing/providers";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { FileMeshBootstrapStore } from "./serve/mesh-bootstrap-store.js";
import { CredentialExposureAuthority } from "./serve/credential-exposure-authority.js";
import {
  checkModel,
  runConfigEditor,
  type SectionId,
} from "./config-editor/index.js";

/**
 * 入口模式——repl(交互终端)与 host(核心宿主)。两者都只校 model:
 * messaging 是可选能力,凭证不全由 channel 装配警告跳过(非致命),
 * 配置入口是 /config 而非宿主启动拦截。
 */
export type StartupMode = "repl" | "host";

/**
 * 启动检查结果——caller 据此决定后续动作。
 *
 * - ready：必要字段齐全（编辑器未触发或已完成），返回 config + credentials
 * - cancelled：用户在编辑器里取消（应正常退出 exit 0）
 * - schema-error：JSON 解析失败（exit 2）
 * - semantic-error：含废弃字段（exit 2）
 * - non-tty：缺字段且非交互终端（exit 2）
 */
export type StartupCheckResult =
  | {
      kind: "ready";
      config: ZhixingConfig;
      credentials: ZhixingCredentials;
      credentialGeneration: string | null;
      secretStore: SecretStorePort & CredentialStoreCoordinator;
    }
  | { kind: "cancelled" }
  | { kind: "schema-error"; filePath: string; message: string }
  | { kind: "secret-store-error"; filePath: string; message: string }
  | { kind: "semantic-error"; filePath: string; issues: ConfigSemanticIssue[] }
  | { kind: "non-tty"; missingLabels: string[] };

export interface RunStartupCheckOptions {
  /** ~/.zhixing/ 目录覆盖（仅测试用） */
  homeDir?: string;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  /** 入口模式——决定是否检查 messaging */
  mode: StartupMode;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WritableStream;
  /** SecretStore 覆盖（测试或受管宿主注入）。 */
  secretStore?: SecretStorePort & CredentialStoreCoordinator;
}

export async function runStartupCheck(
  options: RunStartupCheckOptions,
): Promise<StartupCheckResult> {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  const explicitHomeDir = options.homeDir;
  const credentialsHomeDir = explicitHomeDir ?? resolveHomeDir(env);
  const configPath = explicitHomeDir
    ? path.join(explicitHomeDir, "config.jsonc")
    : getGlobalConfigPath(env);
  // 1. load
  let config: ZhixingConfig;
  let credentials: ZhixingCredentials;
  let credentialGeneration: string | null;
  try {
    config = loadConfig({ homeDir: explicitHomeDir, env });
  } catch (err) {
    return {
      kind: "schema-error",
      filePath: err instanceof ConfigSchemaError ? err.filePath : configPath,
      message: err instanceof Error ? err.message : "配置文件不可用",
    };
  }
  const semanticIssues = [
    ...validateConfigSemantics(config),
    ...validateMeshConfiguration(config),
  ];
  if (semanticIssues.length > 0) {
    return { kind: "semantic-error", filePath: configPath, issues: semanticIssues };
  }

  let secretStore: SecretStorePort & CredentialStoreCoordinator;
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
    const credentialReadGuard = await createCredentialReadGuard(
      credentialsHomeDir,
      secretStore,
    );
    const preparedCredentials = await loadCredentialsWithLegacyMigration({
      store: secretStore,
      homeDir: credentialsHomeDir,
      ...(credentialReadGuard
        ? { authorizeCredentialRead: credentialReadGuard }
        : {}),
    });
    credentials = preparedCredentials.credentials;
    credentialGeneration = preparedCredentials.generation;
  } catch (err) {
    if (err instanceof CredentialsSchemaError) {
      return { kind: "schema-error", filePath: err.filePath, message: err.message };
    }
    return {
      kind: "secret-store-error",
      filePath: credentialsHomeDir,
      message: err instanceof Error ? err.message : "SecretStore 不可用",
    };
  }

  // 2. 必要字段检测——按 mode 决定 sections
  const missingSections: SectionId[] = [];
  const missingLabels: string[] = [];

  const modelIssues = checkModel(config, credentials);
  if (modelIssues.length > 0) {
    missingSections.push("model");
    missingLabels.push(...modelIssues.map((i) => i.label));
  }

  if (missingSections.length === 0) {
    return { kind: "ready", config, credentials, credentialGeneration, secretStore };
  }

  // 3. 缺失 + 非 TTY → fail-fast
  if (!isTTY) {
    return { kind: "non-tty", missingLabels };
  }

  // 4. 缺失 + TTY → 跑编辑器
  const title = pickEditorTitle(options.mode, missingSections);
  const welcomeText = pickWelcomeText(options.mode);
  const editorResult = await runConfigEditor({
    initialConfig: config,
    initialCredentials: credentials,
    writers: {
      writeConfig: (next) => writeConfig(next, { homeDir: explicitHomeDir, env }),
      writeCredentials: (next) =>
        writeCredentials(next, { store: secretStore }),
    },
    sections: missingSections,
    title,
    welcomeText,
    header: {
      workspaceRoot: config.workspace?.root,
      configPath,
      secretStoreLabel: "设备本地 SecretStore",
    },
    stdin,
    stdout,
    isTTY,
  });

  if (editorResult.kind === "completed") {
    // reload 拿到落盘后的最新内容
    const updatedConfig = loadConfig({
      homeDir: explicitHomeDir,
      env,
    });
    const updatedCredentialReadGuard = await createCredentialReadGuard(
      credentialsHomeDir,
      secretStore,
    );
    const updatedCredentialSnapshot = await loadCredentialsWithLegacyMigration({
      store: secretStore,
      homeDir: credentialsHomeDir,
      ...(updatedCredentialReadGuard
        ? { authorizeCredentialRead: updatedCredentialReadGuard }
        : {}),
    });
    return {
      kind: "ready",
      config: updatedConfig,
      credentials: updatedCredentialSnapshot.credentials,
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

async function createCredentialReadGuard(
  home: string,
  secretStore: SecretStorePort,
): Promise<
  | ((input: {
      readonly kind: "provider" | "channel" | "mcp";
      readonly id: string;
      readonly ref: SecretRef;
    }) => Promise<boolean>)
  | undefined
> {
  const store = new FileMeshBootstrapStore(home);
  const trust = await store.loadTrustRecord();
  if (!trust) return undefined;
  const deviceRefs = await secretStore.list("device-key/device/v1/");
  if (deviceRefs.length !== 1) return undefined;
  const deviceId = deviceRefs[0]!.bindingId.slice("device/v1/".length);
  if (!trust.members.some((member) =>
    member.device.deviceId === deviceId && member.state === "active")) return undefined;
  const authority = new CredentialExposureAuthority({
    deviceId,
    log: store.authorityLog(),
    secretStore,
  });
  return async ({ kind, id }) => {
    try {
      await authority.assertRoute({
        ref: {
          kind,
          bindingId: `credential-${kind}-${id}`,
        },
        service: kind,
      });
      return true;
    } catch {
      return false;
    }
  };
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

function pickEditorTitle(mode: StartupMode, _sections: SectionId[]): string {
  return mode === "repl" ? "初始配置" : "核心宿主初始化";
}

/**
 * 初始配置场景的欢迎语——降低用户冷启动认知成本。`/config` 等复编场景不传此字段，
 * 编辑器据此跳过欢迎区，避免老用户每次打开都重读一遍。
 */
function pickWelcomeText(mode: StartupMode): string {
  if (mode === "repl") {
    return "欢迎使用知行。下面填好 API 凭证就能开始使用。";
  }
  return "欢迎使用知行核心宿主。填好 API 凭证即可启动;消息通道可稍后在 /config 配置。";
}
