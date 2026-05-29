/**
 * SkillCommandSource —— 把技能库投影成 `/<name>` 动态 slash 命令。
 *
 * 每个非禁用技能映射为一条 `execution:"agent"` 的 CommandDef:用户在 typeahead
 * 里选中 `/<id>` → dispatcher 不调 handler、把 `/<id>` 原文作 user message 发给
 * agent loop → agent 经 `load_skill(id)` 取全文。手动唤醒与模型自动命中由此同走
 * 「agent loop 调 load_skill」一条路、无旁路,故本源只产元数据、不持任何 handler。
 *
 * 命名:`CommandDef.name` = 技能 id(= `skillNameToId(name)`,已 kebab、无空白 ——
 * dispatch 按空白切第一个 token 作命令名,含空白的原始名必匹配失败,故用 id);
 * `CommandDef.id` 命名空间化为 `skill:<id>`,与 builtin 的 `<name>:builtin` 不撞
 * registry id;`aliases` 保留原始 name 供补全显示与按人读名匹配。
 *
 * 撞名:技能 id 与某个非技能命令(builtin / task 等)同名时**不注册为 slash 命令**
 * —— 核心命令优先、不被用户技能遮蔽(该技能仍可被 agent `load_skill`、经管理面板
 * 唤醒)。探测经 findExisting:命中命令的 id 不以 `skill:` 开头即判为外部撞名而跳过;
 * 用 id 前缀排除本源自身上一轮注册的命令(registry.refresh 先调 list() 再替换缓存,
 * list() 期间旧命令仍在),避免把自己误判成撞名而自抑制。
 */

import type {
  CommandDef,
  DynamicCommandSource,
  SkillRecord,
} from "@zhixing/core";

/** 动态源 id —— 命令 id 前缀 `skill:` 与之对应,registry 据此归属本源。 */
const SOURCE_ID = "skill";

/** SkillCommandSource 的最小依赖(接口隔离,便于单测注入 stub)。 */
export interface SkillCommandSourceDeps {
  /** 列出全部非禁用技能(`SkillStore.listAll` 满足此签名)。 */
  listAll(): Promise<readonly SkillRecord[]>;
  /**
   * 按名查现有命令(= `registry.findByName`),用于撞名探测:返回非技能命令即跳过。
   * 见类注释「撞名」段对自抑制的处理。
   */
  findExisting(name: string): CommandDef | null;
}

export class SkillCommandSource implements DynamicCommandSource {
  readonly id = SOURCE_ID;

  constructor(private readonly deps: SkillCommandSourceDeps) {}

  async list(): Promise<readonly CommandDef[]> {
    const skills = await this.deps.listAll();
    const commands: CommandDef[] = [];
    for (const s of skills) {
      const clash = this.deps.findExisting(s.id);
      if (clash && !clash.id.startsWith(`${SOURCE_ID}:`)) {
        // 与非技能命令撞名:让核心命令优先,本技能不注册为 slash 命令。
        continue;
      }
      commands.push({
        id: `${SOURCE_ID}:${s.id}`,
        name: s.id,
        aliases: s.name !== s.id ? [s.name] : undefined,
        description: s.description,
        category: "plugin",
        tag: "plugin",
        execution: "agent",
      });
    }
    return commands;
  }
}
