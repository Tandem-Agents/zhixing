/**
 * 内置工具的用户可读名称：过程卡片与权限确认面同源使用。
 *
 * 通行的开发工具沿用英文名（Read、Bash 等），产品功能与其余工具用中文说明用途。MCP 工具不在这里命名：
 * 它的“工具（服务）”名由映射层经工具的确认展示上下文声明。未登记的工具由调用方按原样处理，
 * 不臆造名称。本模块无依赖，可经窄子路径被终端启动路径引用。
 */
const BUILTIN_TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  schedule: "定时任务",
  Task: "子任务",
  conversation: "对话通信",
  admit_skill: "接入技能",
  load_skill: "加载技能",
  save_skill: "保存技能",
  log_read: "读取日志",
  log_search: "搜索日志",
  extension: "外部连接",
  extension_connect: "提交连接版本",
  extension_source: "导出接入源码",
  mcp_discover: "查找 MCP 服务",
  mcp_connect: "接入 MCP 服务",
  task_list: "任务列表",
  propose_advancement: "提出推进",
  workmode_enter: "进入工作场景",
  workmode_exit: "退出工作场景",
  workscene_list: "列出工作场景",
  workscene_rename_current: "当前场景改名",
  workscene_set_workdir_current: "设置场景工作目录",
  workscene_clear_workdir_current: "清除场景工作目录",
  workscene_task_list: "场景任务列表",
  workscene_task_stop: "停止场景任务",
  workscene_change_approve: "批准场景变更",
});

/** 内置工具的用户可读名称；未登记时为空。 */
export function builtinToolDisplayName(name: string): string | undefined {
  return Object.hasOwn(BUILTIN_TOOL_DISPLAY_NAMES, name) ? BUILTIN_TOOL_DISPLAY_NAMES[name] : undefined;
}

/**
 * 工具卡片标题可用的输入字段（字符串、各自限长）：实时过程投影与恢复历史的工具事实读取共用这一份，
 * 只含标题需要的目标（路径、命令、名称、编号等），不含正文内容。
 */
export const TOOL_TARGET_INPUT_KEYS = ['path', 'file_path', 'command', 'pattern', 'url', 'name', 'description', 'action', 'conversationId', 'id'] as const;
