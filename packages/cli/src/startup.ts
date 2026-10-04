/** 现有入口的终端首配适配器；检查/保存/重读由 Node 应用编排。 */
import { checkStartupConfiguration, type StartupApplicationOptions, type StartupCheckResult, type StartupMode } from "./runtime/startup-application.js";
export type { StartupCheckResult, StartupMode } from "./runtime/startup-application.js";

export interface RunStartupCheckOptions extends Omit<StartupApplicationOptions, "edit"> {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WritableStream;
}

export async function runStartupCheck(options: RunStartupCheckOptions): Promise<StartupCheckResult> {
  return checkStartupConfiguration({
    ...options,
    edit: async ({ config, credentials, configPath, save }) => {
      const { runConfigEditor } = await import("./config-editor/index.js");
      return runConfigEditor({
        initialConfig: config, initialCredentials: credentials,
        writers: { save: async result => { await save(result); } },
        sections: ["model"], title: pickEditorTitle(options.mode), welcomeText: pickWelcomeText(options.mode),
        header: { workspaceRoot: config.workspace?.root, configPath, secretStoreLabel: "设备本地 SecretStore" },
        stdin: options.stdin ?? process.stdin, stdout: options.stdout ?? process.stdout,
        isTTY: options.isTTY ?? Boolean(process.stdin.isTTY),
      });
    },
  });
}

function pickEditorTitle(mode: StartupMode): string {
  if (mode === "repl") return "初始配置";
  if (mode === "pairing") return "完成这台设备的配置";
  return "核心宿主初始化";
}

/**
 * 初始配置场景的欢迎语——降低用户冷启动认知成本。`/config` 等复编场景不传此字段，
 * 编辑器据此跳过欢迎区，避免老用户每次打开都重读一遍。
 */
function pickWelcomeText(mode: StartupMode): string {
  if (mode === "repl") {
    return "欢迎使用知行。下面填好 API 凭证就能开始使用。";
  }
  if (mode === "pairing") {
    return "知行需要在这台设备上登录模型服务。填好 API 凭证后，这台设备就准备好了。";
  }
  return "欢迎使用知行核心宿主。填好 API 凭证即可启动;消息通道可稍后在 /config 配置。";
}
