/**
 * 工作台启动 Welcome —— 进入 REPL 时一次性输出的"我已就绪"信号。
 *
 * 设计原则：
 *   - 极致克制：用户每天打开 N 次，每次只展示必要的运行环境信息
 *   - 视觉一致：复用初始配置的浮灵品牌锚 + chrome 容器，让"知行"在两个场景下
 *     有同一身份签名
 *   - 静态瞬时：不做打字动画——每次启动累积的视觉干扰在长期使用里很快变烦
 *   - 行式输出：纯函数返回 string[]，caller 用 console.log 顺序写出，不进
 *     alt-screen（与 config-editor 的 Renderer 全屏模式区分）
 *
 * 锚 body 三行的语义（每一行都有清晰角色：天线 / 心脏 / 脚）：
 *   row1（锚天线）  —— ` ▄▄▄`：仅 glyph，与顶边 ╲ 构成完整天线意象。
 *                      文字不放此行——紧贴顶边的文字视觉局促，glyph 才是天线延伸
 *   row2（产品身份）—— `▌●●▐    知行`：inline 品牌签名，brand bold；"知行"
 *                      落在心脏 ●● 位置，是稳定的产品身份签名
 *   row3（会话状态）—— ` ▀▀     已恢复对话 X`：inline 当前接续的会话身份，dim；
 *                      新会话或无 resumedConversationName 时仅 glyph 优雅退化
 *
 * 与初始配置 welcome 的区别：
 *   - 初始配置三行都 inline，是因为有"初始配置 / 标题 / 欢迎语"附加层级
 *   - 工作台 row1 留给天线、row2 = 产品身份、row3 = 会话状态——三层职责分明
 *
 * /help 提示不在 chrome 内——已迁移到 prompt placeholder，让"启动 welcome
 * = 运行环境快照，prompt = 行动入口"职责清晰分离。
 *
 * 主动告知（任务 / 待办 / 提醒）有意省略——本产品当前定位是被动响应工具，
 * 用户按需通过斜杠命令拉取信息。
 */

import {
  getTerminalWidth,
  renderChrome,
  tone,
  type BrandAnchor,
} from "../tui/index.js";

export interface WorkbenchHomeInfo {
  /** 当前主模型 provider id（label 内部组装为 "<provider> · <model>"） */
  providerId: string;
  /** 当前主模型 model id */
  model: string;
  /** 工作目录绝对路径；省略表示 fallback 到 cwd——该行不渲染 */
  workspaceRoot?: string;
  /**
   * 当前 REPL 接续的对话名称——锚 row2 inline "已恢复对话 X"。
   * 省略 = 新会话或会话恢复失败，row2 退化为仅锚 glyph。
   * 故意不带轮数（避免视觉繁琐；轮数信息用户可走 /status 查询）。
   */
  resumedConversationName?: string;
}

// 品牌锚的物理形状常量——产品身份的不变部分，与组装逻辑分离
const ANCHOR_TOP_EDGE = "╲";
const ANCHOR_GLYPH_ROW1 = " ▄▄▄";
const ANCHOR_GLYPH_ROW2 = "▌●●▐";
const ANCHOR_GLYPH_ROW3 = " ▀▀ ";
/** 锚 glyph 与右侧 inline 文字之间的列间距——所有 inline row 共用同一 gap */
const ANCHOR_INLINE_GAP = "    ";

function buildHomeBrandAnchor(info: WorkbenchHomeInfo): BrandAnchor {
  const row1 = tone.brand.bold(ANCHOR_GLYPH_ROW1);
  const row2 =
    tone.brand.bold(ANCHOR_GLYPH_ROW2) +
    ANCHOR_INLINE_GAP +
    tone.brand.bold("知行");
  const row3 = info.resumedConversationName
    ? tone.brand.bold(ANCHOR_GLYPH_ROW3) +
      ANCHOR_INLINE_GAP +
      tone.dim(`已恢复对话 ${info.resumedConversationName}`)
    : tone.brand.bold(ANCHOR_GLYPH_ROW3);

  return {
    topEdge: ANCHOR_TOP_EDGE,
    bodyLines: [row1, row2, row3],
  };
}

/**
 * 渲染工作台启动 welcome 的整段行。
 *
 * caller 用 `for (const line of result) console.log(line)` 写出。
 * chrome 之后的空行 / 其他启动告知由 caller 自己决定。
 */
export function renderHomeWelcome(info: WorkbenchHomeInfo): string[] {
  const body: string[] = [];

  if (info.workspaceRoot) {
    body.push(tone.dim(`工作目录    ${info.workspaceRoot}`));
  }
  body.push(tone.dim(`模型        ${info.providerId} · ${info.model}`));

  return renderChrome({
    brandAnchor: buildHomeBrandAnchor(info),
    body,
    width: getTerminalWidth(),
  });
}
