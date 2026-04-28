/**
 * Cancel intent 默认关键词集——叫停整个 turn 的"控制命令"型词。
 *
 * 设计哲学:**宁可漏不可误**。
 *
 * 原因:cancel 是破坏性操作——一旦命中就 abort 整个 in-flight turn,用户失去
 * 全部进度。误触代价(用户失去进度)远大于漏触代价(用户重发一次)。两边代价
 * 不对称,所以默认集合应**保守缩小到强意图无歧义**的词,而不是为提升覆盖率
 * 而加入边缘表达。
 *
 * 入选标准:
 *   - 单词/短语**单独成消息**时几乎只能是"叫停整个 turn"的意图
 *   - 字面是"控制命令"性质,而非"否定表态"(后者归 confirmation DENY)
 *
 * 排除示例(单独成消息有歧义,不收):
 *   - "暂停"——"暂时停可恢复"非 cancel 语义
 *   - "够了" / "行了"——多义("受够了 vs OK 够了")
 *   - "别写了" / "别答了" / "别问了"——上下文强相关,agent 不在做对应事
 *     时语义错位
 *   - "好了"——IM 多义("我好了/OK 完成/受够了")
 *   - "abort" 单独——IM 罕见(CLI 用户用 /abort)
 *   - "打断"——单独"打断"可能是"我要插话",非叫停
 *
 * 与 confirmation DENY 的产品语义二分:
 *   - 字面是控制命令(stop / cancel / 停 / 取消) → 用户意图叫停整个 turn → 归 CANCEL
 *   - 字面是否定表态(no / 不 / 拒绝 / 算了)       → 用户意图拒绝当前工具 → 归 DENY
 *
 * 字面互斥由 IntentClassifier 启动期 assertDisjoint 强制保证(cancel ∩ approve
 * ∪ deny = ∅);冲突时启动 fail-fast,优于在生产产生歧义。
 *
 * 用户/团队的额外习惯词通过 `ZhixingConfig.intent.cancelKeywords` 追加,启动
 * 期与本默认集合并并通过同样的互斥校验。
 */
export const DEFAULT_CANCEL_KEYWORDS: ReadonlyArray<string> = [
  // 显式控制命令(跨平台无歧义)
  "/cancel",
  "/stop",
  "/abort",
  // 英文控制词
  "stop",
  "cancel",
  // 中文核心控制词
  "停",
  "停止",
  "停下",
  "停一下",
  "中止",
  "中断",
  "终止",
  "取消",
  "打住",
];
