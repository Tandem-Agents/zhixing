/**
 * 命令的环境可见性 —— cli target 下"终端能力"对命令可见性的约束。
 *
 * `RuntimeContext.features` 是一张 `Record<string, boolean>` 能力表，由 `getRuntime()`
 * 在每次 typeahead query / dispatch 时按当前终端状态填充。需要某项能力的命令在自己的
 * `CommandDef.visibility.predicate` 里读这张表——能力缺失时补全与 `/help` 都不列出它。
 *
 * 这里收口 "chrome（alt-screen + 持久输入区）" 这一项：能力键名与读它的 predicate
 * 单点定义，避免写入方（getRuntime）与读取方（命令 visibility）两处字符串各写一遍而漂移。
 */

import type { CommandVisibility, RuntimeContext } from "@zhixing/core";

/**
 * 终端具备 chrome 能力（alt-screen 渲染 + 持久输入区）的 feature 键。
 * 非 TTY / 管道 / dumb 终端探测降级时为 false。
 */
export const FEATURE_CHROME = "chrome";

/**
 * 需要 chrome 才能交互的命令（`/config`·`/mcp` 的 alt-screen 编辑器、`/skills` 管理屏、
 * `/skill-new`·`/skill-add` 创作 / 接入屏）共用的可见性规则：无 chrome 终端下补全与
 * `/help` 都不列出。这只管"列不列"；用户硬打命令名仍能命中（`findByName` 不过滤
 * visibility，是 escape hatch），执行期的友好兜底由各 handler 入口单独处理。
 */
export const chromeOnlyVisibility: CommandVisibility = {
  predicate: (ctx: RuntimeContext) => ctx.features[FEATURE_CHROME] === true,
};
