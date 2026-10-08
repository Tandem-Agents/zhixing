/** Error text shared by command and noninteractive entry points. */
import chalk from "chalk";
import { getZhixingHome } from "@zhixing/core/paths";
import { getGlobalConfigPath } from "@zhixing/providers/configuration";
import type { CliWriter } from "./screen/cli-writer.js";

export function renderError(error: unknown, writer: CliWriter): void {
  if (error instanceof Error && error.name === "ProviderConfigError") {
    const configPath = getGlobalConfigPath(process.env, getZhixingHome());
    writer.line(
      `\n${chalk.red("✗")} ${chalk.red.bold("配置错误")}: ${error.message}`,
    );
    writer.line(chalk.dim(`\n  请检查配置文件: ${configPath}`));
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  writer.line(`\n${chalk.red("✗")} ${message}`);
}
