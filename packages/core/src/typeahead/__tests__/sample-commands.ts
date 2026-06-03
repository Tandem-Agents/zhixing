/**
 * Typeahead 测试夹具 —— 一组有代表性的 slash 命令声明。
 *
 * 覆盖 registry / dispatcher / command-provider / ghost-text 各测试需要的形态:多
 * category、name + alias、必填与可选 enum 参数、hidden 命令。纯元数据、不含 handler
 * —— handler 由各测试在 dispatcher 上按 id 自行注册。
 *
 * 这不是生产命令的真相源:真实命令由 cli 各域的 registerXxxCommands 注册。此处仅为
 * 驱动 typeahead 机器提供稳定、可断言的输入。
 */

import type { CommandDef } from "../types.js";

/** 返回一组新的命令副本 —— 调用方可安全 mutate 自己的那份。 */
export function buildSampleCommands(): CommandDef[] {
  return [
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
            { value: "ask", label: "ask", description: "每次单独确认" },
            { value: "full", label: "full", description: "完全绕过确认（谨慎）" },
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
      hidden: true,
    },
  ];
}

/** 把全部样例命令注册到给定 registry。 */
export function registerSampleCommands(registry: {
  register(cmd: CommandDef): void;
}): void {
  for (const cmd of buildSampleCommands()) {
    registry.register(cmd);
  }
}
