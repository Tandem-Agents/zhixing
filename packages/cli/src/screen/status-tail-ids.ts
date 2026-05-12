/**
 * 状态条尾部段 id 注册表 —— 多 source tail 协议的唯一命名权威。
 *
 * ─── 设计 ───
 *
 * ScreenController.setStatusTail(id, text) 是按 id 注册的多段协议；多个独立
 * source（TaskTail / ContextIndicator / 未来扩展）通过稳定 id 隔离同一行的
 * 多个段位。本文件是 id 字面量的**唯一定义点** —— 调用方禁止直接写字符串
 * 字面量（如 `setStatusTail("task", ...)`），必须引用本文件常量。
 *
 * ─── 为什么需要 ───
 *
 * 字符串字面量在多文件散落时易错：
 *   - 打字错误（"contxet" / "tsak"）让段悄然写入新 id，老段从未清理
 *   - 重命名时遗漏一处 → 段分叉
 *   - 无中心目录看"当前已有哪些 source"
 *
 * 单一注册表 + `as const` 字面量类型，让 IDE 跳转、grep、未来 union type
 * 升级都收敛到一处。
 *
 * ─── 扩展约定 ───
 *
 * 新增 tail source 时：
 *   1. 在此对象上加新 key/value（key = 语义名，value = 稳定字符串 id）
 *   2. source 模块 import 并使用，不允许直接字面量
 *   3. 顺序：注册表内的声明顺序无意义；屏幕上的视觉顺序由"首次注册到 Map"
 *      时间决定（见 render.ts 装配顺序）
 */

export const STATUS_TAIL_IDS = {
  /** TaskTail —— 任务列表摘要 */
  task: "task",
  /** ContextIndicator —— 上下文 tokens + cache 命中指示器 */
  context: "context",
} as const;

/** 已知 tail id 的字面量联合类型 —— 未来可在 setStatusTail 签名上收紧类型 */
export type StatusTailId = (typeof STATUS_TAIL_IDS)[keyof typeof STATUS_TAIL_IDS];
