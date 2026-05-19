/**
 * LLM 角色集注册表 —— 角色集的【单一事实源】。
 *
 * main / light / power 三角色的身份、必填性、兜底目标、配置编辑器中文文案
 * 都只在此声明一次。所有"逐角色机械重复"的层（resolve 兜底、config-editor
 * sections/state/checks/types、JSONC 模板、hot-reload diff）都遍历本表派生，
 * 不再散落 `role === "main" ? … : secondary` 之类字面量分支。
 *
 * 新增角色 = 本表加一行 + core 的 `LLMRoles` 接口加一字段。文件末尾的编译期
 * 断言双向守护两者键集合一致：任一侧改了另一侧没跟上 → 此处 TS 报错。
 *
 * 注意分工：消费者契约（`LLMRoles` / `ResolvedLLMRoles` 的显式字段）仍是手写
 * typed 接口——类型安全与 `roles.main.chat()` 人体工学优先，不退化为 Record
 * 索引。本注册表只驱动"角色集是什么 + 各角色元信息"这一机械重复维度。
 */

import type { LLMRoles } from "@zhixing/core";

export interface RoleSpec {
  /** 角色 id —— 与 LLMRoles / ZhixingConfig.llm 的键一一对应 */
  readonly id: "main" | "light" | "power";
  /** 是否必填。仅 main 必填；辅助角色缺省走 fallbackTo 兜底 */
  readonly required: boolean;
  /** 未显式配置时回落到哪个角色（null = 不回落，即 required 角色本身） */
  readonly fallbackTo: "main" | null;
  /** config-editor 入口标签 */
  readonly labelZh: string;
  /** 标签后中文括号说明（语义提示：更强 / 轻量等，给首次用户看懂用途） */
  readonly parenZh: string;
  /** 未配置时 config-editor 状态文案 */
  readonly missingStatusZh: string;
}

/**
 * 角色集定义。顺序即 config-editor 入口展示顺序。
 *
 * 文案语义：
 *   - light：系统侧后台辅助任务（上下文压缩 / WebFetch 蒸馏 / 工具结果摘要 /
 *     子 agent 返回压缩 / 入站分类等 I/O 边界净化），用户不直接调用，由
 *     ContextEngine 与工具 ctx 注入消费；通常挑轻量便宜模型
 *   - power：重活槽——工作场景主对话等高难任务，模型档位由用户决定（即便塞
 *     弱模型也合法，名字表达的是"接重活"而非"模型很强"）；首个真实消费者是
 *     work-mode（进入工作场景后 power 成为该场景的主对话循环）
 */
export const ROLE_SPECS = [
  {
    id: "main",
    required: true,
    fallbackTo: null,
    labelZh: "主模型",
    parenZh: "必填 · 主对话",
    missingStatusZh: "待配置",
  },
  {
    id: "light",
    required: false,
    fallbackTo: "main",
    labelZh: "轻量模型",
    parenZh: "可选 · 系统侧后台辅助任务",
    missingStatusZh: "未启用（默认沿用主模型）",
  },
  {
    id: "power",
    required: false,
    fallbackTo: "main",
    labelZh: "强力模型",
    parenZh: "可选 · 进入工作场景时使用",
    missingStatusZh: "未启用（默认沿用主模型）",
  },
] as const satisfies readonly RoleSpec[];

/** 角色 id 字面量联合 —— 派生自注册表，全仓 role 类型的单一来源 */
export type RoleId = (typeof ROLE_SPECS)[number]["id"];

/** 辅助角色（非必填、有兜底）—— resolve / create-provider / checks 遍历用 */
export const AUX_ROLE_SPECS: readonly RoleSpec[] = ROLE_SPECS.filter(
  (s) => !s.required,
);

/**
 * 编译期强约束：注册表 id 集合 === core `LLMRoles` 键集合（双向严格相等）。
 *
 * 任一侧新增/改名而另一侧没跟上 → `Equal` 得 `false` → `true` 不可赋给 `false`
 * 类型 → 本行 TS 编译失败，强制双向同步。绑到真实常量上（而非裸类型别名）
 * 以同时满足"强制生效""不触发 unused 告警""不污染包公共类型面"三者；
 * `void` 引用消除 unused-local，运行期为单一布尔常量，成本可忽略。
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
const _roleIdsContract: Equal<RoleId, keyof LLMRoles> = true;
void _roleIdsContract;
