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

import type {
  SkillDraft,
  SkillMode,
  SkillSaveOutcome,
  SkillTextLoader,
  ToolDefinition,
  ToolResult,
} from "@zhixing/core";

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

/**
 * save_skill 对保存管线的最小依赖契约(接口隔离)—— 工具只需"把草稿交给
 * 管线",不耦合 SkillStore 与管线内部;装配期把 runSkillSavePipeline 绑定
 * store 后注入,测试可注入轻量 mock。
 */
export type SkillSaver = (draft: SkillDraft) => Promise<SkillSaveOutcome>;

/**
 * save_skill 工具 —— 创建 / 打磨技能的唯一落盘口(upsert:同名即更新)。
 *
 * 定位 = SkillSavePipeline + 用户确认护栏的工具包装:四不变量(脱敏 / own
 * 落位 / 格式 / 索引版本)焊在管线里;本包装层承载用户路径的系统护栏——
 * **刻意不声明 boundaries**:持久化用户方法资产不该静默放行,无边界声明经
 * 影响分类 fail-to-confirm 走确认管线(与 load_skill 的 app-state 自动放行
 * 形成有意不对称:读放行、写确认)。产品层护栏(保存前必须拿到用户明确
 * 同意)由内置方法「提炼技能」承载,双层互补。
 */
export function createSaveSkillTool(
  saver: SkillSaver,
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
    isParallelSafe: false, // 写技能库结构性状态(index/目录),串行执行
    needsPermission: false, // 确认由影响分类管线承担(无边界声明 → 确认),与此字段正交

    async call(input): Promise<ToolResult> {
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
      const mode: SkillMode = input.mode === "work" || input.mode === "main"
        ? input.mode
        : defaultMode;
      try {
        const result = await saver({ name, description, body, mode });
        const action = result.outcome === "created" ? "新建" : "更新";
        const lines = [
          `已${action}技能「${result.name}」(id: ${result.id})。用户可输入 /${result.id} 唤起它。`,
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
