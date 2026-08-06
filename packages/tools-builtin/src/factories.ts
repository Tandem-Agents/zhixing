/**
 * Builtin 工具工厂注册表 —— 按工具名映射到工厂函数
 *
 * 集中点：所有内置工具的构造在此一处声明。runtime 装配时根据
 * AgentRoleProfile.enabledTools 按名查工厂创建实例 —— profile 是
 * 工具装配的唯一权威源，工厂表是实现来源。
 *
 * 新增内置工具的接入：
 *   1. 实现工厂函数 createXxxTool()，从 ./xxx.ts 导出
 *   2. 在 BUILTIN_TOOL_FACTORIES 加一条 `<name>: (ctx) => createXxxTool(...)`
 *   3. 在需要启用该工具的 AgentRoleProfile.enabledTools 中加工具名
 */

import type {
  AdmissionLlm,
  SkillMode,
  SkillTextLoader,
  ToolDefinition,
} from "@zhixing/core";
import { assessSkill } from "@zhixing/core";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createMemoryTool } from "./memory.js";
import type { MemoryToolPort } from "./memory.js";
import {
  createAdmitSkillTool,
  createLoadSkillTool,
  createSaveSkillTool,
} from "./skill.js";
import type { SkillAdmissionPort, SkillSaver } from "./skill.js";
import { createReadTool } from "./read.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWriteTool } from "./write.js";

/**
 * 工厂构造上下文 —— 工具实例化时可能需要的环境参数。
 *
 * 装配期统一构造并注入；工厂按需取用，签名保持一致（`(ctx) => Tool`）。
 * 未来工具如需更多上下文在此扩展即可。
 */
export interface BuiltinToolContext {
  /** HTTP 代理地址，web_fetch 透传给底层 fetch 客户端 */
  readonly proxy?: string;
  readonly memoryPort?: MemoryToolPort;
  readonly skillLoader?: SkillTextLoader;
  readonly skillSaver?: SkillSaver;
  readonly skillAdmission?: SkillAdmissionPort;
  /**
   * 当前运行档的技能模式 —— save_skill / admit_skill 对未显式指定 mode 的
   * 输入按此缺省(工作场景 → work、主对话 → main)。缺省 "main"。
   */
  readonly skillMode?: SkillMode;
  /**
   * 接入审查的独立裁判通道(绑 main 档单发,装配期直接注入)—— admit_skill
   * 启用时必须注入;独立调用、不带对话上下文(运动员 / 裁判分离:外部技能
   * 可能含 prompt 注入,主模型读过其内容后自身可能被操纵,裁决不归它)。
   */
  readonly admissionLlm?: AdmissionLlm;
}

export type BuiltinToolFactory = (ctx: BuiltinToolContext) => ToolDefinition;

/**
 * 工具名 → 工厂的映射。**单一权威源**，所有 builtin 工具在此声明。
 *
 * 命名约定：工具名等于 ToolDefinition.name（小写下划线 / 简单标识符）。
 */
export const BUILTIN_TOOL_FACTORIES: Readonly<
  Record<string, BuiltinToolFactory>
> = {
  read: () => createReadTool(),
  write: () => createWriteTool(),
  edit: () => createEditTool(),
  glob: () => createGlobTool(),
  grep: () => createGrepTool(),
  bash: () => createBashTool(),
  memory: (ctx) => {
    if (!ctx.memoryPort) {
      throw new Error(
        "memory 工具需装配期注入 assignment memory port",
      );
    }
    return createMemoryTool(ctx.memoryPort);
  },
  load_skill: (ctx) => {
    const loader = ctx.skillLoader;
    if (!loader) {
      throw new Error(
        "load_skill 工具需装配期注入 assignment skill loader",
      );
    }
    return createLoadSkillTool(loader);
  },
  save_skill: (ctx) => {
    const saver = ctx.skillSaver;
    if (!saver) {
      throw new Error(
        "save_skill 工具需装配期注入 assignment skill saver",
      );
    }
    return createSaveSkillTool(
      saver,
      ctx.skillMode ?? "main",
    );
  },
  admit_skill: (ctx) => {
    const admission = ctx.skillAdmission;
    if (!admission) {
      throw new Error(
        "admit_skill 工具需装配期注入 assignment skill admission port",
      );
    }
    if (!ctx.admissionLlm) {
      throw new Error(
        "admit_skill 工具需装配期注入 ctx.admissionLlm(独立裁判通道)—— 缺失即装配契约破坏,拒绝静默兜底",
      );
    }
    const llm = ctx.admissionLlm;
    return createAdmitSkillTool(
      admission,
      (skill) => assessSkill({ llm }, skill),
      ctx.skillMode ?? "main",
    );
  },
  web_fetch: (ctx) => createWebFetchTool({ proxy: ctx.proxy }),
};

export interface BuiltinToolCapabilityDescriptor {
  readonly authorityWrite: boolean;
}

/** Capability classification is exact-key checked against the production factory table. */
export const BUILTIN_TOOL_CAPABILITIES = {
  read: { authorityWrite: false },
  write: { authorityWrite: false },
  edit: { authorityWrite: false },
  glob: { authorityWrite: false },
  grep: { authorityWrite: false },
  bash: { authorityWrite: false },
  memory: { authorityWrite: true },
  load_skill: { authorityWrite: false },
  save_skill: { authorityWrite: true },
  admit_skill: { authorityWrite: true },
  web_fetch: { authorityWrite: false },
} as const satisfies Record<
  keyof typeof BUILTIN_TOOL_FACTORIES,
  BuiltinToolCapabilityDescriptor
>;

/** 内置工具名集合 —— 用于装配时判断 "name 是否属于 builtin" */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(BUILTIN_TOOL_FACTORIES),
);
