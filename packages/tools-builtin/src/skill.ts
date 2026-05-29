/**
 * load_skill 工具 —— 命中索引后按需加载技能全文(渐进披露的"展开"动作)。
 *
 * 两条触发统一收口到本工具:(1)模型扫到 Available Skills 索引里某个 id 与当前任务
 * 相关 → 主动加载;(2)用户发来一条恰为「斜杠 + 技能 id」的消息(如 `/deploy`,由
 * cli 的 /<name> 唤醒派发为普通 user message)→ 显式调用该技能。手动唤醒不走旁路、
 * 与自动命中同经本工具,故技能全集(含未进 top-N 索引的)都可达。取回技能完整正文
 * (做法 / 约定 / 坑)。固定工具:技能再增删,工具集恒只此一个加载工具。
 *
 * 依赖按接口隔离:只依赖 `SkillTextLoader`(按 id 取全文),不耦合整个 SkillStore,
 * 便于注入与测试。读全文 + 写命中度量属知行应用本地状态,声明 app-state 边界 →
 * 判 internal 自动放行,不每次弹确认;不设 maxResultChars,全文须完整入上下文。
 */

import type { SkillTextLoader, ToolDefinition, ToolResult } from "@zhixing/core";

export function createLoadSkillTool(loader: SkillTextLoader): ToolDefinition {
  return {
    name: "load_skill",
    description:
      "Load the full instructions of a skill by its id. The Available Skills index lists skills with a " +
      "one-line description — that description is only a pointer; the loaded full text tells you how to do " +
      "the task (the user's conventions, steps, pitfalls). Two triggers: (1) a listed skill matches the " +
      "current task — load it before proceeding; (2) the user's message is exactly a slash followed by a " +
      "skill id (for example `/deploy`) — they are explicitly invoking that skill, so call this tool with " +
      "that id even if it is not shown in the index. Pass the exact id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The skill id, exactly as shown in the Available Skills index.",
        },
      },
      required: ["id"],
    },

    isReadOnly: false, // 写命中度量(usage)
    isParallelSafe: true, // per-id 锁护 usage 写
    needsPermission: false,
    // 技能数据 = 知行应用本地状态(~/.zhixing/skills):读全文 + 写 usage、无外部副作用
    // → 经 app-state 边界判 internal(自动放行),不每次加载弹确认。
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],

    async call(input): Promise<ToolResult> {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) {
        return { content: "load_skill 需要非空的 id 参数。", isError: true };
      }
      try {
        const { name, body } = await loader.loadText(id);
        return { content: `# ${name}\n\n${body}`, isError: false };
      } catch (e) {
        return {
          content: `加载技能 "${id}" 失败:${
            e instanceof Error ? e.message : String(e)
          }`,
          isError: true,
        };
      }
    },
  };
}
