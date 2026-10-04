import type { CommandDef } from "@zhixing/core/typeahead";
import { chromeOnlyVisibility } from "./command-capabilities.js";

/** Shared names, aliases, descriptions and visibility for every terminal surface. */
export const BUILTIN_COMMANDS = {
  "resolve:repl": {
    id: "resolve:repl",
    name: "resolve",
    description: "处理结果待确认的运行",
    category: "tools",
    execution: "local",
    tag: "builtin"
  },
  "help:repl": {
    id: "help:repl",
    name: "help",
    description: "显示帮助信息",
    category: "info",
    execution: "local",
    tag: "builtin"
  },
  "status:repl": {
    id: "status:repl",
    name: "status",
    description: "查看当前运行状态",
    category: "info",
    execution: "local",
    tag: "builtin"
  },
  "stop:repl": {
    id: "stop:repl",
    name: "stop",
    description: "停止知行",
    category: "tools",
    execution: "local",
    tag: "builtin"
  },
  "model:repl": {
    id: "model:repl",
    name: "model",
    description: "显示当前模型信息",
    category: "info",
    execution: "local",
    tag: "builtin"
  },
  "usage:repl": {
    id: "usage:repl",
    name: "usage",
    description: "查看 token 用量详情",
    category: "info",
    execution: "local",
    tag: "builtin"
  },
  "context:repl": {
    id: "context:repl",
    name: "context",
    description: "上下文容量可视化",
    category: "info",
    execution: "local",
    tag: "builtin"
  },
  "tasks:repl": {
    id: "tasks:repl",
    name: "tasks",
    description: "查看定时任务",
    category: "tools",
    execution: "local",
    tag: "builtin"
  },
  "config:repl": {
    id: "config:repl",
    name: "config",
    description: "修改基础配置；/config logs 查看或调整日志容量与保留期限",
    category: "config",
    execution: "local",
    tag: "builtin",
    visibility: chromeOnlyVisibility
  },
  "mcp:repl": {
    id: "mcp:repl",
    name: "mcp",
    description: "管理 MCP 服务（接入外部工具 / 启停 / 查看连接）",
    category: "config",
    execution: "local",
    tag: "builtin",
    visibility: chromeOnlyVisibility
  },
  "trust:repl": {
    id: "trust:repl",
    name: "trust",
    description: "权限规则管理",
    category: "config",
    execution: "local",
    tag: "builtin"
  },
  "security:repl": {
    id: "security:repl",
    name: "security",
    description: "安全状态概览",
    category: "config",
    execution: "local",
    tag: "builtin"
  },
  "new:repl": {
    id: "new:repl",
    name: "new",
    description: "创建新对话",
    category: "session",
    execution: "local",
    tag: "builtin"
  },
  "clear:repl": {
    id: "clear:repl",
    name: "clear",
    description: "清空对话历史",
    category: "session",
    execution: "local",
    tag: "builtin"
  },
  "resume:repl": {
    id: "resume:repl",
    name: "resume",
    description: "切换到其他对话",
    category: "session",
    execution: "local",
    tag: "builtin"
  },
  "advancement:repl": {
    id: "advancement:repl",
    name: "advancement",
    description: "查看当前对话的任务推进详情（判定归因 / 证据 / 收场回看）",
    category: "session",
    execution: "local",
    tag: "builtin"
  },
  "name:repl": {
    id: "name:repl",
    name: "name",
    description: "为当前会话命名",
    category: "session",
    execution: "local",
    tag: "builtin"
  },
  "compact:repl": {
    id: "compact:repl",
    name: "compact",
    description: "手动触发上下文压缩",
    category: "tools",
    execution: "local",
    tag: "builtin"
  },
  "work:repl": {
    id: "work:repl",
    name: "work",
    description: "进入工作场景(↑↓ 选择 · Enter 进入 · Ctrl+R 改名 · Ctrl+N 新建)",
    category: "tools",
    execution: "local",
    tag: "builtin"
  },
  "exit:repl": {
    id: "exit:repl",
    name: "exit",
    aliases: ["quit"],
    description: "退出工作场景 / 退出知行",
    category: "session",
    execution: "local",
    tag: "builtin"
  },
  "tasklist:repl": {
    id: "tasklist:repl",
    name: "tasklist",
    description: "查看当前对话的任务列表",
    category: "tools",
    execution: "local",
    tag: "builtin"
  },
  "task:repl": {
    id: "task:repl",
    name: "task",
    description: "管理任务（new <内容> / done <序号或 id>）",
    category: "tools",
    execution: "local",
    tag: "builtin"
  }
} satisfies Readonly<Record<string, CommandDef>>;
