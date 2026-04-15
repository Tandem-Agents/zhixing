/**
 * 内建 slash 命令的声明式列表
 *
 * 设计原则（spec §9.2 + Hermes `COMMAND_REGISTRY` 的精神）：
 *   - 这里只是**元数据**，不含 handler 实现
 *   - Handler 由 Step 5（REPL 接入）在命令分派层按 id 注册
 *   - 文件保持为纯 literal，无运行时逻辑 —— 方便静态分析和 diff
 *
 * 命令 id 约定：`${name}:builtin`，例如 "new:builtin"。
 *
 * 执行归属（spec §9.2）：
 *   - `local`：纯本地动作（/exit /clear /help /status /fast /verbose）
 *   - `agent`：本质是 system prompt 的便捷入口（没有 builtin 归这档，留给 plugin）
 *   - `hybrid`：本地副作用 + agent 知晓（/new /reset /model /elevated）
 *
 * 关于参数 schema：Phase 1 只给需要枚举 / 确定有限取值的命令配 ArgSchema。
 * 其他自由文本参数（像 /background <prompt>）在 Phase 2 Step 8 补齐。
 */

import type { CommandDef } from "./types.js";

/**
 * 构造内建命令列表 —— 函数而非常量，避免模块加载时就固定引用。
 *
 * 返回新数组（不是同一份引用），这样调用方可以放心 mutate 自己的副本而不影响
 * 下一次调用的结果。对 registry 来说，我们一次性把所有命令 register 进去。
 */
export function buildBuiltinCommands(): readonly CommandDef[] {
  const cmds: CommandDef[] = [
    // ─── Session 类 ───
    {
      id: "new:builtin",
      name: "new",
      aliases: ["reset"],
      description: "开始一个新的会话（清空上下文）",
      category: "session",
      execution: "hybrid",
      tag: "builtin",
      icon: "＋",
    },
    {
      id: "clear:builtin",
      name: "clear",
      description: "清屏并开始新会话",
      category: "session",
      execution: "local",
      tag: "builtin",
    },
    {
      id: "history:builtin",
      name: "history",
      description: "显示会话历史",
      category: "session",
      execution: "local",
      tag: "builtin",
    },
    {
      id: "exit:builtin",
      name: "exit",
      aliases: ["quit"],
      description: "退出知行",
      category: "session",
      execution: "local",
      tag: "builtin",
      icon: "×",
    },

    // ─── Config 类 ───
    {
      id: "model:builtin",
      name: "model",
      description: "切换模型（或查看当前模型）",
      category: "config",
      execution: "hybrid",
      tag: "builtin",
      icon: "◆",
      // args: 在 Step 8（progressive argument hint）时补 async-enum schema
    },
    {
      id: "elevated:builtin",
      name: "elevated",
      aliases: ["elev"],
      description: "切换 elevated（高权限）模式",
      category: "config",
      execution: "hybrid",
      tag: "builtin",
      args: [
        {
          kind: "enum",
          name: "level",
          description: "elevated 等级",
          required: true,
          choices: [
            { value: "off", label: "off", description: "关闭高权限" },
            { value: "on", label: "on", description: "开启高权限" },
            {
              value: "ask",
              label: "ask",
              description: "每次单独确认",
            },
            {
              value: "full",
              label: "full",
              description: "完全绕过确认（谨慎）",
            },
          ],
        },
      ],
    },
    {
      id: "fast:builtin",
      name: "fast",
      description: "切换 fast 模式（提速 / 省钱 tradeoff）",
      category: "config",
      execution: "local",
      tag: "builtin",
      args: [
        {
          kind: "enum",
          name: "mode",
          description: "fast 状态",
          required: false,
          choices: [
            { value: "status", label: "status", description: "仅显示当前状态" },
            { value: "on", label: "on", description: "开启 fast 模式" },
            { value: "off", label: "off", description: "关闭 fast 模式" },
          ],
        },
      ],
    },
    {
      id: "verbose:builtin",
      name: "verbose",
      description: "切换详细工具输出显示",
      category: "config",
      execution: "local",
      tag: "builtin",
      args: [
        {
          kind: "enum",
          name: "level",
          description: "verbose 等级",
          required: false,
          choices: [
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ],
        },
      ],
    },

    // ─── Info 类 ───
    {
      id: "status:builtin",
      name: "status",
      description: "显示会话状态（模型、token 用量、当前工具等）",
      category: "info",
      execution: "local",
      tag: "builtin",
      icon: "◉",
    },
    {
      id: "help:builtin",
      name: "help",
      description: "显示命令帮助",
      category: "info",
      execution: "local",
      tag: "builtin",
      icon: "?",
    },

    // ─── Debug 类（hidden，名字能精确召唤） ───
    {
      id: "debug:builtin",
      name: "debug",
      description: "显示调试信息（内部使用）",
      category: "debug",
      execution: "local",
      tag: "builtin",
      hidden: true, // 不出现在空 `/` 列表，但打 /debug 能精确召唤
    },
  ];
  return cmds;
}

/**
 * 便利函数：一次性把所有 builtin 命令注册到给定的 registry。
 *
 * 用于 bootstrap 路径：
 * ```
 * const registry = new DefaultCommandRegistry();
 * registerBuiltinCommands(registry);
 * ```
 */
export function registerBuiltinCommands(registry: {
  register(cmd: CommandDef): void;
}): void {
  for (const cmd of buildBuiltinCommands()) {
    registry.register(cmd);
  }
}
