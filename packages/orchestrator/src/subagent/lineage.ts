/**
 * 子 agent lineage 派生规则
 *
 * 父 EventBus 已显式标记 lineage(主 root 为 "main"),子 EventBus 必须以
 * `parent.lineage + "/"` 开头(EventBus 构造时强校验,违反 throw)。
 *
 * 设计取舍:
 *   - id 取前 8 字符:UUID 全量 36 字符过长,8 字符冲突概率在单会话内可忽略,
 *     状态条 / 日志可读性最好(`main/sub-3a7f9c2d` 一眼定位)
 *   - 若未提供 parent lineage 视为顶层 main(测试 / 极简自动化路径),
 *     仍走 "main/sub-..." 形态,与生产路径同构,便于切换
 */
export function deriveChildLineage(
  parentLineage: string | undefined,
  subAgentId: string,
): string {
  const base = parentLineage ?? "main";
  return `${base}/sub-${subAgentId.slice(0, 8)}`;
}
