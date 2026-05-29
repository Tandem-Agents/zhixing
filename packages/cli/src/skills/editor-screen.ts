/**
 * AI 编辑屏的视图层 + 按键映射 + alt-screen 事件循环 —— 与控制器(editor-controller)
 * 的状态机分离:渲染是纯函数(view → 帧文本行,可直接断言),按键映射把按键翻成"动作"
 * (由循环执行异步副作用),外壳只管 Renderer / KeyEventStream 的进退与每帧 flush。
 *
 * 它是一个**专门写的对话式编辑器**,不复用 config-editor 的 panel-stack 循环、也不复用
 * loading 的全屏 spinner 帧(那会盖掉内容预览):起草是异步且可取消的,等待期间**保留
 * 内容区**、底部只切到"起草中"提示,改完就地重画 —— 这是与现成 loading 的关键区别。
 * 全建在中性 tui/ 原语上(同 /skills 管理器、同 config-editor runner 的三层退出防御),
 * 进 alternate screen buffer 由终端原子保存 / 恢复主对话历史,不靠纪律手工清屏。
 */

import { skillNameToId } from "@zhixing/core";
import {
  Renderer,
  createKeyEventStream,
  renderChrome,
  renderFooter,
  tone,
  wrapToWidth,
  type KeyEvent,
  type KeyEventStream,
} from "../tui/index.js";
import {
  SkillEditorController,
  type SkillEditorDeps,
  type SkillEditorView,
  type EditorPhase,
} from "./editor-controller.js";

function footerHints(phase: EditorPhase, canExternal: boolean): string[] {
  if (phase === "drafting") return ["Ctrl+C 取消起草"];
  if (phase === "external") return ["任意键 读回改动"];
  const hints = ["回车 提交", "Ctrl+S 保存"];
  if (canExternal) hints.push("Ctrl+E 外部编辑器");
  hints.push("Esc 放弃");
  return hints;
}

/** 纯渲染:`controller.view()` → 帧文本行。顶部内容区(字段 + 正文预览)+ 底部输入 / 状态区。 */
export function renderSkillEditor(
  view: SkillEditorView,
  width: number,
  title: string,
): string[] {
  const { draft, input, phase, error, canExternal } = view;
  const lines: string[] = [
    ...renderChrome({
      title,
      body: [
        draft
          ? `落点 own/${skillNameToId(draft.name)}`
          : "从你说的话里收一个技能",
      ],
      width,
    }),
    "",
  ];

  if (!draft) {
    lines.push(
      tone.dim("  还没有草稿 —— 在下面说说你想要个什么技能,回车让我起草。"),
    );
  } else {
    lines.push(`  ${tone.dim("名称")}  ${draft.name}`);
    lines.push(`  ${tone.dim("触发")}  ${draft.description}`);
    lines.push(`  ${tone.dim("模式")}  [${draft.mode}]`);
    lines.push("");
    lines.push(tone.dim("  ── 正文 ──"));
    for (const l of wrapToWidth(draft.body, Math.max(width - 4, 20))) {
      lines.push(`  ${l}`);
    }
  }

  lines.push("");
  if (error) lines.push(tone.error(`  ⚠ ${error}`));

  if (phase === "drafting") {
    lines.push(tone.dim("  起草中…(Ctrl+C 取消)"));
  } else if (phase === "external") {
    lines.push(tone.dim("  外部编辑器已打开 —— 改完保存后按任意键读回。"));
  } else {
    lines.push("  说点什么改它(回车提交):");
    lines.push(`  › ${input}`);
  }

  lines.push("");
  lines.push(...renderFooter({ width, hints: footerHints(phase, canExternal) }));
  return lines;
}

/** 按键映射产出的"动作"—— 异步副作用(起草 / 保存 / 外部编辑)由循环执行,保持映射可纯断言。 */
export type EditorAction =
  | { kind: "continue" }
  | { kind: "submit"; instruction: string }
  | { kind: "save" }
  | { kind: "external" }
  | { kind: "resume" }
  | { kind: "cancel" };

/**
 * 按键映射(editing / external 阶段;drafting 阶段的按键由循环的起草 race 单独处理)。
 * 外部编辑暂停态下任意键即"读回";editing 态下 char/backspace 改输入缓冲,回车提交指令,
 * Ctrl+S 保存、Ctrl+E 外部编辑器(均需已有草稿),Ctrl+C / Esc 放弃。
 */
export function handleEditorKey(
  controller: SkillEditorController,
  key: KeyEvent,
): EditorAction {
  if (controller.currentPhase() === "external") {
    return { kind: "resume" };
  }
  switch (key.type) {
    case "ctrl-c":
    case "escape":
      return { kind: "cancel" };
    case "ctrl-s":
      return controller.hasDraft() ? { kind: "save" } : { kind: "continue" };
    case "ctrl-e":
      return controller.hasDraft() && controller.view().canExternal
        ? { kind: "external" }
        : { kind: "continue" };
    case "enter": {
      const instruction = controller.takeInput();
      return instruction ? { kind: "submit", instruction } : { kind: "continue" };
    }
    case "char":
      controller.typeChar(key.ch);
      return { kind: "continue" };
    case "backspace":
      controller.backspace();
      return { kind: "continue" };
    default:
      return { kind: "continue" };
  }
}

export interface SkillEditorRunDeps extends SkillEditorDeps {
  title: string;
  /** 自动起草时作首句意图(对话入口的"附一句指向");冷启动留空。 */
  initialInstruction?: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
  isTTY: boolean;
}

export type SkillEditorResult = "saved" | "cancelled" | "non-tty";

/**
 * alt-screen 事件循环。进 alternate screen buffer + 三层退出防御(finally 复位 +
 * `process.once("exit")` 兜底 emit `\x1b[?1049l`)保证主对话历史不被毁。非 TTY 直接返回。
 */
export async function runSkillEditor(
  deps: SkillEditorRunDeps,
): Promise<SkillEditorResult> {
  if (!deps.isTTY) return "non-tty";

  const controller = new SkillEditorController(deps);
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

  const draw = (): void => {
    renderer.clear();
    renderer.writeLines(
      renderSkillEditor(controller.view(), renderer.terminalWidth(), deps.title),
    );
    renderer.flush();
  };

  try {
    // 对话入口:进屏即从上下文起草(可取消);冷启动等用户第一句、不自动起草。
    if (deps.autoDraft) {
      await runDraftWithCancel(controller, deps.initialInstruction ?? "", stream, draw);
    }
    while (true) {
      draw();
      const key = await stream.next();
      const action = handleEditorKey(controller, key);
      switch (action.kind) {
        case "submit":
          await runDraftWithCancel(controller, action.instruction, stream, draw);
          break;
        case "save":
          await controller.save();
          return "saved";
        case "external":
          await controller.openExternalAndPause();
          break;
        case "resume":
          await controller.resumeFromExternal();
          break;
        case "cancel":
          return "cancelled";
        case "continue":
          break;
      }
    }
  } finally {
    stream.stop();
    renderer.showCursor();
    renderer.exitAlternateScreen();
    renderer.flush();
    process.off("exit", onProcessExit);
  }
}

/**
 * 起草 / 改写,并把"等结果"与"等取消键"race:起草期间保留内容区、底部显示"起草中",
 * 用户按 Ctrl+C / Esc 即放弃等待(后台结果丢弃、保留原草稿),否则结果回来就地重画。
 */
export async function runDraftWithCancel(
  controller: SkillEditorController,
  instruction: string,
  stream: KeyEventStream,
  draw: () => void,
): Promise<void> {
  const editAc = new AbortController();
  const editP = controller.runEdit(instruction, editAc.signal);
  draw(); // runEdit 同步段已置 phase=drafting,先画出"起草中"帧

  let done = false;
  const doneP = editP.then(() => {
    done = true;
  });

  while (!done) {
    const keyAc = new AbortController();
    const keyP = stream
      .next(keyAc.signal)
      .then((key) => ({ key }) as const)
      .catch(() => ({ aborted: true }) as const);
    const winner = await Promise.race([
      doneP.then(() => ({ done: true }) as const),
      keyP,
    ]);

    if ("done" in winner) {
      keyAc.abort(); // 取消尚挂起的等键(keyP 走 catch、不悬挂)
      await keyP;
      break;
    }
    if ("key" in winner) {
      const k = winner.key;
      if (k.type === "ctrl-c" || k.type === "escape") {
        editAc.abort(); // 放弃等待:底层 LLM 不中断,结果由 runEdit 的 signal 守门丢弃
        controller.cancelDraft();
        draw(); // 立即回 editing 重画 —— 不能等后台 LLM 返回,否则取消形同无响应
        // editP 不 await:留作后台 settle。runEdit 见 signal.aborted 即不改状态,
        // 且只 resolve 不 reject,无悬挂 promise / 无未处理拒绝。
        return;
      }
      // 起草中的其它键忽略,继续等(re-race)
    }
  }

  // 仅正常完成路径到此(while 因 done=true 退出)→ editP 已 settle,await 即时返回。
  await editP.catch(() => {});
  draw();
}
