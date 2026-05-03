/**
 * CLI 启动检查 + 配置编辑器集成。
 *
 * 把"启动期检查 + 触发配置编辑器"封装成单一调用，让 cli/index.ts 与 serve/command.ts
 * 用同一逻辑——避免分裂实现。
 *
 * 流程：
 *   1. loadConfig + loadCredentials —— schema 损坏 → schema-error
 *   2. validateConfigSemantics —— 含废弃字段 → semantic-error
 *   3. checkModel + checkMessaging（按 mode）—— 缺失则触发编辑器
 *   4. 编辑器完成 → reload 后返回 ready
 *   5. 全部齐全 → 直接 ready
 *
 * caller 按返回 kind 决定后续：
 *   - ready / completed → 继续启动 REPL / server
 *   - cancelled → process.exit(0)
 *   - 其它（schema-error / semantic-error / non-tty）→ 打印错误 + exit(2)
 */

import path from "node:path";
import {
  ConfigSchemaError,
  CredentialsSchemaError,
  getCredentialsPath,
  getGlobalConfigPath,
  loadConfig,
  loadCredentials,
  resolveHomeDir,
  validateConfigSemantics,
  writeConfig,
  writeCredentials,
  type ConfigSemanticIssue,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing/providers";
import {
  checkMessaging,
  checkModel,
  runConfigEditor,
  type SectionId,
} from "./config-editor/index.js";

export type StartupMode = "repl" | "server";

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
  | { kind: "ready"; config: ZhixingConfig; credentials: ZhixingCredentials }
  | { kind: "cancelled" }
  | { kind: "schema-error"; filePath: string; message: string }
  | { kind: "semantic-error"; filePath: string; issues: ConfigSemanticIssue[] }
  | { kind: "non-tty"; missingLabels: string[] };

export interface RunStartupCheckOptions {
  cwd?: string;
  /** ~/.zhixing/ 目录覆盖（仅测试用） */
  homeDir?: string;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  /** 入口模式——决定是否检查 messaging */
  mode: StartupMode;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WritableStream;
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
  const credentialsPath = getCredentialsPath(credentialsHomeDir);

  // 1. load
  let config: ZhixingConfig;
  let credentials: ZhixingCredentials;
  try {
    config = loadConfig({ cwd: options.cwd, homeDir: explicitHomeDir, env });
    credentials = loadCredentials({ homeDir: credentialsHomeDir });
  } catch (err) {
    if (
      err instanceof ConfigSchemaError
      || err instanceof CredentialsSchemaError
    ) {
      return { kind: "schema-error", filePath: err.filePath, message: err.message };
    }
    throw err;
  }

  // 2. semantic 校验
  const semanticIssues = validateConfigSemantics(config);
  if (semanticIssues.length > 0) {
    return { kind: "semantic-error", filePath: configPath, issues: semanticIssues };
  }

  // 3. 必要字段检测——按 mode 决定 sections
  const missingSections: SectionId[] = [];
  const missingLabels: string[] = [];

  const modelIssues = checkModel(config, credentials);
  if (modelIssues.length > 0) {
    missingSections.push("model");
    missingLabels.push(...modelIssues.map((i) => i.label));
  }

  if (options.mode === "server") {
    const messagingIssues = checkMessaging(config, credentials);
    if (messagingIssues.length > 0) {
      missingSections.push("messaging");
      missingLabels.push(...messagingIssues.map((i) => i.label));
    }
  }

  if (missingSections.length === 0) {
    return { kind: "ready", config, credentials };
  }

  // 4. 缺失 + 非 TTY → fail-fast
  if (!isTTY) {
    return { kind: "non-tty", missingLabels };
  }

  // 5. 缺失 + TTY → 跑编辑器
  const title = pickEditorTitle(options.mode, missingSections);
  const editorResult = await runConfigEditor({
    initialConfig: config,
    initialCredentials: credentials,
    writers: {
      writeConfig: (next) => writeConfig(next, { homeDir: explicitHomeDir, env }),
      writeCredentials: (next) =>
        writeCredentials(next, { homeDir: credentialsHomeDir }),
    },
    sections: missingSections,
    title,
    header: {
      workspaceRoot: config.workspace?.root,
      configPath,
      credentialsPath,
    },
    stdin,
    stdout,
    isTTY,
  });

  if (editorResult.kind === "completed") {
    // reload 拿到落盘后的最新内容
    const updatedConfig = loadConfig({
      cwd: options.cwd,
      homeDir: explicitHomeDir,
      env,
    });
    const updatedCredentials = loadCredentials({ homeDir: credentialsHomeDir });
    return { kind: "ready", config: updatedConfig, credentials: updatedCredentials };
  }

  if (editorResult.kind === "cancelled") {
    return { kind: "cancelled" };
  }

  // editorResult.kind === "non-tty"——此处理论上不到达（前面已检查 isTTY）
  return { kind: "non-tty", missingLabels };
}

function pickEditorTitle(mode: StartupMode, sections: SectionId[]): string {
  if (mode === "repl") return "首次配置";
  if (sections.length === 1 && sections[0] === "messaging") return "配置消息通道";
  return "服务模式初始化";
}
