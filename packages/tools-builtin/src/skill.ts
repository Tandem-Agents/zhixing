/**
 * Skill Catalog 内置工具集 —— v2 四工具（skill_read / skill_save / skill_admit / skill_materialize）
 * 与兼容旧工具（load_skill / save_skill / admit_skill）。
 *
 * 依赖按领域端口隔离：只调用 Skill Catalog 应用契约，不耦合 Store、ArtifactStore
 * 或 assignment ledger。所有安全规则（防伪读取分页、双阶段写回基准核验、三向准入授权、
 * 导出先锁版本再落盘）均由领域应用与工具声明协同守门。
 */

import type {
  SkillCatalogAdmissionApplication,
  SkillCatalogLoadApplication,
  SkillCatalogSaveApplication,
  SkillMode,
} from "@zhixing-ai/core/skills/catalog";
import type { ToolDefinition, ToolResult } from "@zhixing-ai/core";
import {
  buildSkillAdmissionTool,
  createSkillAdmitTool,
  createSkillMaterializeTool,
  createSkillReadTool,
  createSkillSaveTool,
  createSystemOnlySkillReadTool,
  type CreateSkillReadToolOptions,
} from "./skill-v2.js";

export {
  createSkillAdmitTool,
  createSkillMaterializeTool,
  createSkillReadTool,
  createSkillSaveTool,
  createSystemOnlySkillReadTool,
  type CreateSkillReadToolOptions,
};

export const LEGACY_COMPAT_BUILTIN_TOOLS = [
  "load_skill",
  "save_skill",
  "admit_skill",
] as const;

export const V2_SKILL_BUILTIN_TOOLS = [
  "skill_read",
  "skill_save",
  "skill_admit",
  "skill_materialize",
] as const;

export function createLoadSkillTool(
  application: SkillCatalogLoadApplication,
): ToolDefinition {
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

    isReadOnly: false,
    isParallelSafe: true,
    needsPermission: false,
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],

    async call(input, context): Promise<ToolResult> {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) {
        return { content: "load_skill 需要非空的 id 参数。", isError: true };
      }
      try {
        const { name, body } = await application.load({
          id,
          operationId: context?.toolCallId,
        });
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

export function createSaveSkillTool(
  application: SkillCatalogSaveApplication,
  defaultMode: SkillMode,
): ToolDefinition {
  return {
    name: "save_skill",
    description:
      "Save a skill (create new, or update when a skill with the same name exists). Call this ONLY after " +
      "the user has explicitly approved the draft you showed them in conversation (e.g. they said 'save it' " +
      "or '就这样'). Never call it silently. The pipeline scrubs credentials, writes the standard SKILL.md " +
      "into the user's own skill area, and refreshes the index. Returns the skill id (usable as /<id>) and " +
      "how many secrets were scrubbed — relay both honestly to the user.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill display name; its id (and /<id> command) derives from this.",
        },
        description: {
          type: "string",
          description:
            "One line oriented to WHEN to use the skill (drives future retrieval), not a content summary.",
        },
        body: {
          type: "string",
          description:
            "Skill body in markdown: the user's specific conventions, pitfalls, proven steps — no generic knowledge.",
        },
        mode: {
          type: "string",
          enum: ["main", "work"],
          description:
            "Where the skill belongs: 'work' for workscene-specific, 'main' for general. Defaults to the current scene.",
        },
      },
      required: ["name", "description", "body"],
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: false,

    async call(input, context): Promise<ToolResult> {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const description =
        typeof input.description === "string" ? input.description.trim() : "";
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (!name || !description || !body) {
        return {
          content: "save_skill 需要非空的 name / description / body。",
          isError: true,
        };
      }
      const mode: SkillMode =
        input.mode === "work" || input.mode === "main" ? input.mode : defaultMode;
      try {
        const result = await application.save(
          { name, description, body, mode },
          context?.toolCallId,
        );
        const action = result.outcome === "created" ? "新建" : "更新";
        const lines = [
          `已记录${action}技能「${result.name}」(id: ${result.id})；本轮成功完成后入库。`,
        ];
        if (result.scrubbedCount > 0) {
          lines.push(
            `对话中有 ${result.scrubbedCount} 处密钥已自动抹掉、不会写进技能 —— 请如实告知用户。`,
          );
        }
        return { content: lines.join("\n"), isError: false };
      } catch (e) {
        return {
          content: `保存技能失败:${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    },
  };
}

export function createAdmitSkillTool(
  application: SkillCatalogAdmissionApplication,
  defaultMode: SkillMode,
): ToolDefinition {
  return buildSkillAdmissionTool("admit_skill", application, defaultMode);
}
