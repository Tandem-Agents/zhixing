/**
 * 命令的 chrome 能力门禁 —— cli target 下"终端是否具备 alt-screen + 持久输入区"对
 * 命令的两道约束，单点收口：
 *
 *   - 列出侧 `chromeOnlyVisibility`：无 chrome 时命令不进 `registry.list(ctx)`，补全与
 *     `/help` 都不列出（声明在 `CommandDef.visibility`，由 registry 过滤）。
 *   - 执行侧 `requireChrome`：用户硬打命令名仍会进 dispatch（`findByName` 是 escape
 *     hatch，不过滤 visibility），alt-screen 命令在 handler 入口调它——无 chrome 则友好
 *     提示并早退，不进 alt-screen 渲染（否则在非 TTY / 管道下写裸 ANSI 到不支持的下游）。
 *
 * 能力键 `FEATURE_CHROME` 由 `getRuntime()` 按 `capability.ok` 写进 `RuntimeContext.features`；
 * 两道门禁同源——列出侧读 features、执行侧读 screen（capability.ok 时才非 null），写入方与
 * 读取方单点定义，不在多处各写一遍字符串而漂移。
 */

import type { CommandVisibility, RuntimeContext } from "@zhixing/core";
import chalk from "chalk";
import { layout } from "../tui/index.js";
import type { CliWriter, ScreenController } from "../screen/index.js";

/**
 * 终端具备 chrome 能力（alt-screen 渲染 + 持久输入区）的 feature 键。
 * 非 TTY / 管道 / dumb 终端探测降级时为 false。
 */
export const FEATURE_CHROME = "chrome";

/**
 * 需要 chrome 才能交互的命令（`/config`·`/mcp` 的 alt-screen 编辑器、`/skills` 管理屏、
 * `/skill-new`·`/skill-add` 创作 / 接入屏）共用的可见性规则：无 chrome 终端下补全与
 * `/help` 都不列出。这只管"列不列"，硬打名字仍能命中——执行期兜底见 `requireChrome`。
 */
export const chromeOnlyVisibility: CommandVisibility = {
  predicate: (ctx: RuntimeContext) => ctx.features[FEATURE_CHROME] === true,
};

/**
 * alt-screen 命令的执行期 chrome 兜底：handler 入口调用，有 chrome（screen 非 null）放行
 * 返回 true；无 chrome 打印一行友好提示并返回 false，调用方据此早退、不进 alt-screen。
 *
 * `feature` 是给用户看的命令用途（如"配置编辑器"·"技能管理器"），让提示具体到位。
 */
export function requireChrome(
  screen: ScreenController | null,
  writer: CliWriter,
  feature: string,
): boolean {
  if (screen) return true;
  writer.line(
    chalk.yellow(
      `${layout.contentPrefix}${feature}需要交互式终端（alt-screen），当前环境（非 TTY / 管道）不支持。`,
    ),
  );
  return false;
}
