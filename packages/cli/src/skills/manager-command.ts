/**
 * `/skills` 命令注册 —— 把技能管理器接入 typeahead 命令系统的"现代路径"
 * (直接注册到 `tRegistry` + `CommandDispatcher`,同 registerTaskCommands,不走
 * legacy slashCommands 桥接)。
 *
 * 注册在 typeahead 块内有两点契合:① 管理器是 alt-screen、本就需要 chrome 终端,
 * 而 typeahead 块正是 chrome 可用的路径(无 chrome 的 legacy 终端下管理器无法渲染,
 * 不注册即不提供,避免坏命令);② 变更后刷新 `/<name>` 补全需要 `tRegistry`,此处直取。
 *
 * 开屏接线同 `/config`(config-command.ts):停 spinner + 让出 readline 的 stdin →
 * 跑 alt-screen 管理器 → 退屏后恢复 readline 并重申 chrome 硬件光标隐藏不变量。
 */

import type * as readline from "node:readline/promises";
import type { ICommandRegistry } from "@zhixing/core";
import type { CommandDispatcher } from "../command-dispatcher.js";
import type { ScreenController } from "../screen/index.js";
import { runSkillManager } from "./manager-screen.js";
import type { SkillManagerStore } from "./manager-controller.js";

export interface SkillsCommandOptions {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly rl: readline.Interface;
  /** cli renderer —— 仅需 `stop()`:进屏前停 spinner,避免动画覆盖管理器画面。 */
  readonly renderer: { stop: () => void };
  /** chrome 屏幕控制器(无 chrome 为 null)—— 退屏后重申硬件光标隐藏不变量。 */
  readonly screen: ScreenController | null;
  /** 会话级单一技能库 store(管理器浏览 / 状态操作的落点)。 */
  readonly skillStore: SkillManagerStore;
  /** 技能集变更后刷新动态命令,让 `/<name>` 补全即时反映禁用 / 归档(§5.1)。 */
  readonly refreshCommands: () => void | Promise<void>;
}

export function registerSkillsCommand(opts: SkillsCommandOptions): void {
  opts.registry.register({
    id: "skills:repl",
    name: "skills",
    description: "管理技能(浏览 / 置顶 / 禁用 / 改 mode / 归档)",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });

  opts.dispatcher.registerHandler("skills:repl", async () => {
    opts.renderer.stop();
    opts.rl.pause();
    try {
      await runSkillManager({
        store: opts.skillStore,
        onMutate: opts.refreshCommands,
        stdin: process.stdin,
        stdout: process.stdout,
        isTTY: Boolean(process.stdin.isTTY),
      });
    } finally {
      opts.rl.resume();
      opts.screen?.reassertCursorHidden();
    }
    return {};
  });
}
