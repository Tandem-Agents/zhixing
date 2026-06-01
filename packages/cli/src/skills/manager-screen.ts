/**
 * 技能管理器的**视图层 + 按键派发** —— 与 alt-screen I/O 循环(runSkillManager,
 * 后续单元)分离:渲染是纯函数(view → 帧文本行,不触终端、可直接断言),按键派发
 * 把按键映射到控制器方法(注入控制器即可单测)。外壳只负责 Renderer / KeyEventStream
 * 的进退与每帧 flush,逻辑全在这两支纯函数里 —— 仿 config-editor 的 render / dispatch
 * 与 loop 分层。
 */

import type { KeyEvent } from "../tui/index.js";
import {
  Renderer,
  createKeyEventStream,
  renderChrome,
  renderListRow,
  renderFooter,
  wrapToWidth,
  layout,
  tone,
} from "../tui/index.js";
import { SkillManagerController } from "./manager-controller.js";
import type {
  SkillManagerStore,
  SkillManagerView,
} from "./manager-controller.js";

// Footer 两端对齐分区:左 = 基础 / 导航操作(不改数据)、右 = 功能 / 变更操作
// (对选中技能落 Store)。语义分组让"通用怎么动"与"对这个技能做什么"一眼分立。
const FOOTER_HINTS_BASIC = ["↑↓ 导航", "Esc 退出"] as const;
const FOOTER_HINTS_ACTION = ["p 置顶", "d 禁用", "m 改 mode", "a 归档"] as const;

/** 空库引导:替代技术性"无项"占位,给出下一步去向。 */
const EMPTY_HINT = "还没有技能 —— 让 agent 把某摊事的做法沉淀成一个技能,即可在此管理。";

/**
 * 纯渲染:`controller.view()` → 帧文本行。状态徽标一眼可读:
 *   `★` 置顶 / `⊘` 禁用 / `[mode]` 模式 / `own`·`linked` 来源 / 使用次数。
 * 不依赖终端(返回行数组),便于断言徽标 / 行 / 排序。
 */
export function renderSkillManager(
  view: SkillManagerView,
  width: number,
): string[] {
  const lines: string[] = [
    ...renderChrome({
      title: "技能管理",
      body: [`共 ${view.items.length} 个技能`],
      width,
    }),
    "",
  ];

  if (view.items.length === 0) {
    // 走公用左边距 token,与列表行 / footer hint 同列对齐(否则顶到 col 0);按可用
    // 宽度折行,守住 alt-screen 行宽不变量(每行 ≤ width、续行同缩进),与 renderListRow
    // 一致——wrap 在剥色前的 raw 文本上做,再对每行整段套 dim(line-width.ts 约定)。
    const avail = Math.max(1, width - layout.contentIndent);
    for (const ln of wrapToWidth(EMPTY_HINT, avail)) {
      lines.push(layout.contentPrefix + tone.dim(ln));
    }
  } else {
    view.items.forEach((s, i) => {
      const star = s.pinned ? "★" : " ";
      const off = s.disabled ? "⊘" : " ";
      const usage = s.usage ? ` · ${s.usage.hitCount} 次` : "";
      lines.push(
        ...renderListRow({
          label: `${star}${off} ${s.id}`,
          description: `[${s.mode}] ${s.source} · ${s.description}${usage}`,
          selected: i === view.selectedIndex,
          width,
        }),
      );
    });
  }

  lines.push(
    "",
    ...renderFooter({
      width,
      hints: FOOTER_HINTS_BASIC,
      rightHints: FOOTER_HINTS_ACTION,
    }),
  );
  return lines;
}

/**
 * 按键派发:映射到控制器方法,返回是否退出循环。纯逻辑(注入控制器可测)。
 *   ↑↓ 导航;p 置顶 / d 禁用 / m 改 mode / a 归档(→ 控制器,内部落 Store + 重读);
 *   Esc / Ctrl+C 退出。其余按键忽略。
 */
export async function handleSkillManagerKey(
  controller: SkillManagerController,
  key: KeyEvent,
): Promise<"exit" | "continue"> {
  switch (key.type) {
    case "ctrl-c":
    case "escape":
      return "exit";
    case "arrow-up":
      controller.moveUp();
      return "continue";
    case "arrow-down":
      controller.moveDown();
      return "continue";
    case "char":
      switch (key.ch.toLowerCase()) {
        case "p":
          await controller.togglePin();
          break;
        case "d":
          await controller.toggleDisabled();
          break;
        case "m":
          await controller.cycleMode();
          break;
        case "a":
          await controller.archiveSelected();
          break;
      }
      return "continue";
    default:
      return "continue";
  }
}

export interface SkillManagerRunDeps {
  store: SkillManagerStore;
  /** 技能集变更后回调(接 registry.refresh,让 /<name> 补全即时反映,§5.1)。 */
  onMutate?: () => void | Promise<void>;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
  isTTY: boolean;
}

/**
 * alt-screen 事件循环:渲染 view → flush → 等键 → 派发 → 重渲染,直到 Esc/Ctrl+C。
 *
 * 仿 config-editor `runEventLoop`(单列表、无 panel 栈):进 alternate screen buffer
 * 由终端原子保存主对话历史;**三层退出防御**(finally 复位 + `process.once("exit")`
 * 兜底 emit `\x1b[?1049l`)保证 alt buffer 必复位、不毁主历史。非 TTY 直接返回。
 */
export async function runSkillManager(deps: SkillManagerRunDeps): Promise<void> {
  if (!deps.isTTY) return;

  const controller = new SkillManagerController(deps.store, deps.onMutate);
  await controller.load();

  const renderer = new Renderer(deps.stdout);
  const stream = createKeyEventStream(deps.stdin);
  const onProcessExit = (): void => {
    deps.stdout.write("\x1b[?1049l\x1b[?25h");
  };
  process.once("exit", onProcessExit);

  stream.start();
  renderer.enterAlternateScreen();
  renderer.hideCursor();
  renderer.flush();

  try {
    while (true) {
      renderer.clear();
      renderer.writeLines(
        renderSkillManager(controller.view(), renderer.terminalWidth()),
      );
      renderer.flush();

      const key = await stream.next();
      if ((await handleSkillManagerKey(controller, key)) === "exit") return;
    }
  } finally {
    stream.stop();
    renderer.showCursor();
    renderer.exitAlternateScreen();
    renderer.flush();
    process.off("exit", onProcessExit);
  }
}
