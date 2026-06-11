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

import type { MemoryStore, SkillMode, SkillStore, ToolDefinition } from "@zhixing/core";
import { runSkillSavePipeline } from "@zhixing/core";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createMemoryTool } from "./memory.js";
import { createLoadSkillTool, createSaveSkillTool } from "./skill.js";
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
  /**
   * 装配期解析的单一 scoped MemoryStore —— memory 工具与 flush strategy
   * 共用同一实例（按 memoryScope 定 root）。memory 工具启用时必须注入；
   * 缺失即装配契约破坏，工厂 fail-fast 而非静默 new 默认实例（后者会在
   * 工作场景下写穿个人记忆域）。
   */
  readonly memoryStore?: MemoryStore;
  /**
   * 装配期构造的 SkillStore —— load_skill 工具据此按 id 取技能全文。load_skill
   * 启用时必须注入;缺失即装配未按约定构造下传,工厂 fail-fast 而非静默兜底。
   */
  readonly skillStore?: SkillStore;
  /**
   * 当前运行档的技能模式 —— save_skill 对未显式指定 mode 的草稿按此缺省
   * (工作场景 → work、主对话 → main)。缺省 "main"。
   */
  readonly skillMode?: SkillMode;
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
    if (!ctx.memoryStore) {
      throw new Error(
        "memory 工具需装配期注入 ctx.memoryStore（单一 scoped 实例）—— " +
          "缺失说明装配未按 memoryScope 构造并下传，拒绝静默兜底",
      );
    }
    return createMemoryTool(ctx.memoryStore);
  },
  load_skill: (ctx) => {
    if (!ctx.skillStore) {
      throw new Error(
        "load_skill 工具需装配期注入 ctx.skillStore —— 缺失说明 SkillStore 未构造并下传,拒绝静默兜底",
      );
    }
    return createLoadSkillTool(ctx.skillStore);
  },
  save_skill: (ctx) => {
    if (!ctx.skillStore) {
      throw new Error(
        "save_skill 工具需装配期注入 ctx.skillStore —— 缺失说明 SkillStore 未构造并下传,拒绝静默兜底",
      );
    }
    const store = ctx.skillStore;
    return createSaveSkillTool(
      (draft) => runSkillSavePipeline(store, draft),
      ctx.skillMode ?? "main",
    );
  },
  web_fetch: (ctx) => createWebFetchTool({ proxy: ctx.proxy }),
};

/** 内置工具名集合 —— 用于装配时判断 "name 是否属于 builtin" */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(BUILTIN_TOOL_FACTORIES),
);
