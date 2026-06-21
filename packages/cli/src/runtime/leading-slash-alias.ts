/**
 * 输入行首位字符的命令唤醒符别名规范化。
 *
 * 中文输入法 `/` 键位对应字符 "、" —— 用户在中文环境下经常误打 "、" 后
 * 需要删除并切换英文重输。产品规则:输入行首位是 alias 字符时,语义层按
 * `/` 处理(命令面板触发 / 命令名匹配 / 提交执行),显示层保留原字符不动。
 *
 * 仅首位字符触发。命令参数中的 "、" 保留原义(如 `/foo a、b` 不替换中间 `、`)。
 *
 * 当前 SLASH_ALIASES 仅支持单字符 alias。扩展多字符 alias 须同时重算调用方
 * (如 syncBroker)的 ctx.cursor —— draft 字符长度变化时 cursor 需重映射,
 * 否则 cursor 与 draft 字符索引脱节。
 *
 * 两条对外 API 按调用场景分叉:
 *   - {@link normalizeLeadingSlashAlias}:**单字符串场景**(syncBroker)——
 *     直接拿 buffer.draft override 给 broker;此时"判断首位"与"替换首位"
 *     在同一对象,无 paste 展开分叉。
 *   - {@link normalizeLeadingSlashAliasInExpanded}:**双字符串场景**(submit)
 *     —— rawDraft 是用户原始输入(paste 长内容时首位是 token `<` 占位符),
 *     expanded 是 paste 展开后实际送 dispatcher 的字符串;基于 rawDraft 首位
 *     判断"是否用户主动输 alias 作首位",替换发生在 expanded 上,避免 paste
 *     内容首位恰为 alias 时被误命中(中文段落以顿号开头本就罕见,但属
 *     "silent 行为漂移"类边界,显式分叉根治)。
 */

export const SLASH_ALIASES: readonly string[] = ["、"];

export function normalizeLeadingSlashAlias(input: string): string {
  for (const alias of SLASH_ALIASES) {
    if (input.startsWith(alias)) return "/" + input.slice(alias.length);
  }
  return input;
}

/**
 * 基于 `guard` 首位判断是否命中 alias,命中则把 `target` 首位的对应字符替为 `/`。
 *
 * 不变量:`guard` 首位是 alias 时,`target` 首位也必是同一 alias —— paste token
 * 不可能位于"用户首位 alias"与"expanded 首位字符"之间(token 是 buffer 内某段
 * 区间,首位 alias 一定在 token 之前;若 token 在首位则 `guard` 首位就是 `<`
 * 不会命中)。函数据此直接 `target.slice(alias.length)`,无需校验 target 首位。
 *
 * 调用方负责传入已 trim 的控制流字符串。本函数只服务命令识别和别名规范化，
 * 不应用于裁剪普通正文 payload。
 */
export function normalizeLeadingSlashAliasInExpanded(
  target: string,
  guard: string,
): string {
  for (const alias of SLASH_ALIASES) {
    if (guard.startsWith(alias)) return "/" + target.slice(alias.length);
  }
  return target;
}
