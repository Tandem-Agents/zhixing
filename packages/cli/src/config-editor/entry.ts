/**
 * SectionEntry 派生 helpers——从 discriminated `EntryState` 派生显示用 Status
 * 与阻塞 issues。
 *
 * 与 types.ts 分离：types.ts 是纯类型；运行时函数住此文件，避免 types.ts 模糊
 * "类型定义"职责。
 *
 * 单向派生：caller 声明 EntryState（kind + statusText [+ issues]），所有下游
 * 用途（main panel 染色、progress 计数、完成校验）都通过 derive* 函数读出。
 *
 * ─── 项目命名约定（**单一真相源**，散落在各处的引用都指向此文档） ───
 *
 * 三类动词，按"做什么"区分：
 *   - `build*`：**构造**——从底层事实组装新结构
 *     例：buildEntry(state, ...) → SectionEntry / buildEntryState(...) → EntryState
 *   - `derive*`：**派生**——从已有结构按规则计算下游值（含逻辑分支，非 trivial getter）
 *     例：deriveEntryStatus(entry) → Status / deriveEntryIssues(entry) → string[]
 *   - `collect*`：**聚合**——从多个结构展开成 flat 列表
 *     例：collectAllIssues(sections) → string[]
 *
 * 区分目的：reader 看函数名即知调用方向，无需逐行追代码。命名不一致就是认知债。
 *
 * ─── 防御性约束：buildEntryState 故意不抽公共 ───
 *
 * 两个 sections（model / messaging）都定义私有 `buildEntryState`，签名按各自状态
 * 机定制（model 看 isConfigured + isOptional + issues；messaging 看 enabled + issues）。
 *
 * **不要**尝试把它们抽到此文件作为公共 helper——签名差异反映领域差异，强行统一
 * 会引入"参数过多 + 大部分 caller 不需要"的抽象 leak。各 section 自留 buildEntryState
 * 是有意保持的局部内聚。
 */

import type { SectionEntry, Status } from "./types.js";

/**
 * 把 entry 的 state 派生为 Status（level + text）。
 *
 * Invariant 由 EntryState 的 discriminated union 保证：
 *   - `kind === "blocked"` ⟺ `level === "pending"`（issues 必非空）
 *   - `kind === "disabled"` ⟺ `level === "disabled"`
 *   - `kind === "ready"` ⟺ `level === "ready"`
 */
export function deriveEntryStatus(entry: SectionEntry): Status {
  switch (entry.state.kind) {
    case "ready":
      return { level: "ready", text: entry.state.statusText };
    case "disabled":
      return { level: "disabled", text: entry.state.statusText };
    case "blocked":
      return { level: "pending", text: entry.state.statusText };
  }
}

/**
 * 派生 entry 的阻塞 issues——仅 blocked 态有 issues，其余态返回空数组。
 *
 * progress 计数（main panel "待补充 N 项"）+ 完成校验（错误消息拼接）共用此源。
 */
export function deriveEntryIssues(entry: SectionEntry): readonly string[] {
  return entry.state.kind === "blocked" ? entry.state.issues : [];
}
