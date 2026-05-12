/**
 * 退出告别块 —— REPL ctrl+c 退出后在 main buffer 渲染的临别 UI。
 *
 * ─── 形态 ───
 *
 * 形态示例（指 dispose 退出清屏序列之后 emit 的内容）：
 *
 *      ╲
 *     ▄▄▄
 *    ▌●●▐    知行
 *     ▀▀     chat-20260512-6bce
 *
 * 与 welcome 的关系：
 *   - **复用同款品牌锚字符**（机器人脸 + 天线），强化"接管 + 归还"对偶感
 *     —— 启动有同款机器人脸 chrome，退出仍是同款机器人脸但无 chrome 框
 *   - **去 chrome 框**：退出动作 = 减法，不再做仪式（welcome 用 chrome 框，
 *     farewell 用无框版本形成"启动重 / 退出轻"的视觉反差）
 *   - **去元数据**：welcome 给工作目录/模型让用户进入状态；farewell 用户已经
 *     在离开，元数据再展示啰嗦
 *
 * ─── 设计原则 ───
 *
 *   1. **信息克制**：只展示对话 ID —— 用户最关心的"我下次怎么回来"已由 zhixing
 *      默认恢复机制解决（直接打 `zhixing` 即接续最近对话），续聊命令冗余。
 *      用时 / 轮数 / token 数都是"过程数据"，不属于"临别要传达的核心"。
 *   2. **纯函数**：输入 FarewellData → 输出字符串，无副作用，易测试 + 易替换
 *   3. **可扩展**：FarewellData 是接口，未来加字段（季节性 logo / 告别词 /
 *      session stats）只动接口 + 此函数实现 + 调用方装配数据，ScreenController
 *      协议层零感知（caller 渲染好字符串 → setFarewell(text)）
 *   4. **可替换**：UI 改样式只改本文件 renderFarewell 实现，调用方零感知 ——
 *      产品 / UI 设计师未来想换形态（如做成卡片 / 加分隔线 / 用 ASCII art logo）
 *      都在此一处改
 *
 * ─── 边界 ───
 *
 *   不在本模块处理（caller 决定）：
 *     - conversationId 缺失（ephemeral 路径）→ caller 不调 setFarewell
 *     - runOnce 单次模式 / serve daemon → 无 REPL chrome，不调
 *     - 异常退出 → 错误信息已占满 viewport，不调
 *
 *   本模块只负责"给定有效数据时，渲染出对应字符串"。
 */

import {
  BRAND_ANCHOR_GLYPH_ROW1,
  BRAND_ANCHOR_GLYPH_ROW2,
  BRAND_ANCHOR_GLYPH_ROW3,
  BRAND_ANCHOR_INLINE_GAP,
  BRAND_ANCHOR_TOP_EDGE,
  tone,
} from "../tui/index.js";

/**
 * 告别块数据 —— 渲染所需的全部字段。
 *
 * 当前只 conversationId 一个字段；未来扩展（如 farewellQuote / sessionStats /
 * seasonalLogo 等）在此加可选字段，renderFarewell 自动支持。
 */
export interface FarewellData {
  /** 当前对话 ID（用户退出时正在聊的会话标识，默认恢复机制会续接此对话）*/
  readonly conversationId: string;
}

/**
 * 渲染告别块为字符串 —— 含首尾空行让告别块上下不贴边。
 *
 * 调用方将返回值传给 `ScreenController.setFarewell(text)`，dispose 时 ScreenController
 * 在退出清屏序列之后 emit 此字符串。
 *
 * ─── 字节布局 ───
 *
 *   行 1: ""                                      ← 首空行（告别块不贴顶）
 *   行 2: "    ╲"                                 ← 天线
 *   行 3: "   " + ROW1                            ← 机器人头顶 ▄▄▄
 *   行 4: "  " + ROW2 + GAP + "知行"              ← 机器人脸 + 标识
 *   行 5: "   " + ROW3 + GAP + conversationId     ← 机器人下巴 + 对话 ID
 *   行 6: ""                                      ← 末空行（shell prompt 不贴脸）
 *
 * 注意：BRAND_ANCHOR_GLYPH_ROW1/2/3 字符常量内部已含前导空格（详见 tui/brand-anchor.ts），
 * 此处的额外 indent 在常量前补齐让三行视觉对齐 + 整段统一左边距。
 *
 * 列对齐（与 welcome chrome 内 inline 文字同款）：
 *   - 天线 `╲` 在 ROW1 ▄▄▄ 的中点正上方
 *   - "知行" 与 conversationId 起始列相同（受 BRAND_ANCHOR_INLINE_GAP 控制）
 */
export function renderFarewell(data: FarewellData): string {
  const robot1 = tone.brand.bold(BRAND_ANCHOR_GLYPH_ROW1);
  const robot2 = tone.brand.bold(BRAND_ANCHOR_GLYPH_ROW2);
  const robot3 = tone.brand.bold(BRAND_ANCHOR_GLYPH_ROW3);
  const antenna = tone.brand.bold(BRAND_ANCHOR_TOP_EDGE);
  // 与 welcome 内 "知行" 着色保持一致（品牌色 + 粗体），强化品牌身份签名
  const brand = tone.brand.bold("知行");
  const convId = data.conversationId;

  // 整段左 indent —— 3 空格，介于"贴左 2 空格"和"chrome 内 body 4 空格"之间，
  // 无框告别块的视觉重心略偏左但仍有呼吸空间。
  const INDENT = "   ";

  // 天线列对齐：BRAND_ANCHOR_GLYPH_ROW1 = " ▄▄▄"（前导 1 空格 + 3 字符 ▄▄▄）；
  // 天线 ╲ 单字符，对齐 ▄▄▄ 中点 = ROW1 起始 + 2 列偏移
  const antennaLine = INDENT + "  " + antenna;
  const robotRow1 = INDENT + robot1;
  const robotRow2 = INDENT + robot2 + BRAND_ANCHOR_INLINE_GAP + brand;
  const robotRow3 = INDENT + robot3 + BRAND_ANCHOR_INLINE_GAP + convId;

  return [
    "", // 首空行
    antennaLine,
    robotRow1,
    robotRow2,
    robotRow3,
    "", // 末空行
  ].join("\n") + "\n";
}
