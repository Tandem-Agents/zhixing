/**
 * 知行品牌锚 —— 视觉身份字符常量的单一事实源。
 *
 * 形态：
 *   ╲           ← topEdge（天线）
 *    ▄▄▄        ← row1（头顶）
 *   ▌●●▐        ← row2（脸）
 *    ▀▀         ← row3（下巴）
 *
 * 复用场景：
 *   - `workbench/welcome.ts`：启动 welcome chrome 内的品牌签名
 *   - `farewell/farewell.ts`：退出告别块的品牌签名
 *   - 未来扩展（如 config-editor / about / version 等）使用同款品牌身份
 *
 * 改 logo？只改这一处，所有 caller 自动同步。
 *
 * ─── 设计决策 ───
 *
 * 字符宽度细节：
 *   - row1/row3 前导单空格让 3 行视觉中心列对齐到 row2 的 ●● 之间
 *   - row3 末尾补空格使三行视宽一致（4 col），便于右侧 inline 文字对齐
 *   - INLINE_GAP = 4 空格：锚 glyph 右边到 inline 文字之间的统一间距
 *
 * topEdge 字符 `╲`（U+2572）：
 *   - 在 chrome 框模式下嵌入顶边 `╭──── ╲ ───...─╮`，与 row1 ▄▄▄ 视觉上构成
 *     "从顶边垂下的天线"
 *   - 在无框模式下作为独立行 emit 在 row1 上方，同样构成天线意象
 */

/** 天线字符（chrome 顶边嵌入 / 无框模式独立行）*/
export const BRAND_ANCHOR_TOP_EDGE = "╲";

/** 机器人头顶 */
export const BRAND_ANCHOR_GLYPH_ROW1 = " ▄▄▄";

/** 机器人脸（心脏位置 ●● 是"知行"标识签名落点）*/
export const BRAND_ANCHOR_GLYPH_ROW2 = "▌●●▐";

/** 机器人下巴 / 脚（末尾补空格让三行视宽一致）*/
export const BRAND_ANCHOR_GLYPH_ROW3 = " ▀▀ ";

/** 锚 glyph 与右侧 inline 文字之间的列间距（所有 inline row 共用）*/
export const BRAND_ANCHOR_INLINE_GAP = "    ";
