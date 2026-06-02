/**
 * AI 编辑屏的视图层 + 按键映射 + alt-screen 事件循环 —— 与控制器(editor-controller)
 * 的状态机分离:渲染是纯函数(view → 帧文本行,可直接断言),按键映射把按键翻成"动作"
 * (由循环执行异步副作用),外壳只管 Renderer / KeyEventStream 的进退与每帧 flush。
 *
 * **一个草稿屏,四个状态**(灵魂屏即一切,不堆独立页面):
 *   - 等意图(editing + 无草稿):开场 + 输入框,只在没东西可起草时出现。
 *   - 显影(drafting):草稿区先摆灰色骨架(░),印鉴流转 ◈▣■◆,字段就地长出来 —— 不切到
 *     另一屏干等;顶部「收自:X」立刻给出"在收哪件事"的知情。
 *   - 策展(editing + 有草稿):唯一要审的正文 + 脱敏可见 + 教学"我来改",底部说句话就改 / Ctrl+S 存。
 *   - 外部编辑(external):已交给用户自己的编辑器,等读回。
 *
 * 它是一个**专门写的对话式编辑器**,不复用 config-editor 的 panel-stack、也不复用 loading
 * 的全屏 spinner(那会盖掉内容预览):起草是异步且可取消的,等待期间保留内容区、就地重画。
 * 全建在中性 tui/ 原语上(同 /skills 管理器、同 config-editor runner 的三层退出防御)。
 *
 * 底部输入区走 `renderInputBox`(主输入区 / `/work` 新建场景框同一原语)。
 */

import {
  Renderer,
  createKeyEventStream,
  renderChrome,
  tone,
  glyph,
  layout,
  stringWidth,
  padEndDisplay,
  wrapToWidth,
  clampLine,
  composeViewport,
  type KeyEvent,
  type KeyEventStream,
  type KeyHint,
} from "../tui/index.js";
import { renderInputBox } from "../input-box.js";
import {
  SkillEditorController,
  type SkillEditorDeps,
  type SkillEditorView,
} from "./editor-controller.js";

/** 重画 tick 间隔(ms)—— 起草中据此定时重画,推进笔的闪烁帧。 */
const REDRAW_TICK_MS = 250;
/** 笔明灭周期(ms)—— 2 个 tick 一明一灭,从容不抖(与 tick 整除、采样均匀)。 */
const PEN_BLINK_MS = REDRAW_TICK_MS * 2;
/** 保存成功后退屏前闪一帧成功的停留(ms)—— 让"画面消失"有明确收尾,而非静默抹掉。 */
const SAVE_FLASH_MS = 450;

/** "奋笔疾书"的笔 —— 明(brand)灭(dim)交替闪烁,像笔尖在快速书写。注入渲染、可断言。 */
function penFrame(now: number): string {
  return Math.floor(now / PEN_BLINK_MS) % 2 === 0
    ? tone.brand("✎")
    : tone.dim("✎");
}

/** 字段标签列宽 —— 「名称」「什么时候用」按显示宽度对齐到同一列(CJK 安全)。 */
const FIELD_LABEL_COLS = Math.max(stringWidth("名称"), stringWidth("什么时候用"));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 等意图态 hint:左 = 起草(主操作)+ 退出、右 = 外部编辑(逃生口)。 */
function seedHintBar(canExternal: boolean): {
  hints: KeyHint[];
  rightHints: KeyHint[];
} {
  return {
    hints: [
      { label: "起草", key: "Enter" },
      { label: "退出", key: "Esc" },
    ],
    rightHints: canExternal ? [{ label: "外部编辑", key: "Ctrl+E" }] : [],
  };
}

/** 策展态 hint:左 = 发送(主交互,最高频、放最左最顺手)+ 退出、右 = 保存 / 外部编辑。 */
function curateHintBar(canExternal: boolean): {
  hints: KeyHint[];
  rightHints: KeyHint[];
} {
  const rightHints: KeyHint[] = [{ label: "保存", key: "Ctrl+S" }];
  if (canExternal) rightHints.push({ label: "外部编辑", key: "Ctrl+E" });
  return {
    hints: [
      { label: "发送", key: "Enter" },
      { label: "退出", key: "Esc" },
    ],
    rightHints,
  };
}

/**
 * 全宽小节分隔线 —— `── 正文 ────────`。label 左嵌,横线填到内容区(width - 4)。
 */
function renderBodyDivider(label: string, width: number): string {
  const head = `── ${label} `;
  const fill = Math.max(0, width - 4 - stringWidth(head));
  return tone.dim(`  ${head}${glyph.horizontal.repeat(fill)}`);
}

/**
 * 把一段文本(可含硬换行 \n)按可用宽折行,每行加缩进 + 可选染色 —— 守 alt-screen 行宽
 * 不变量(每行 ≤ width)。wrap 在剥色前的 raw 文本上做、再逐行套色(line-width 约定:
 * 含 \n 必须先按 \n 切段、否则 \n 被当 0 宽控制符,续行丢缩进、还可能超宽)。
 */
function wrapBlock(
  text: string,
  width: number,
  color: (s: string) => string = (s) => s,
  indent: string = layout.contentPrefix,
): string[] {
  const avail = Math.max(1, width - stringWidth(indent));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const wrapped = para.length > 0 ? wrapToWidth(para, avail) : [""];
    for (const l of wrapped) out.push(indent + color(l));
  }
  return out;
}

/** 一行字段:`<标签 dim 对齐列>  <值>`,值可加粗(名称用);clamp 兜底守行宽不变量。 */
function fieldLine(
  label: string,
  value: string,
  width: number,
  bold = false,
): string {
  return clampLine(
    `${layout.contentPrefix}${padEndDisplay(tone.dim(label), FIELD_LABEL_COLS)}  ${
      bold ? tone.bold(value) : value
    }`,
    width,
  );
}

/**
 * 草稿字段区:名称(bold)/ 什么时候用 + 正文 + 脱敏可见(真抹过才显)。
 * mode 不在创建屏暴露 —— 它是内部分发概念(决定技能在哪个场景被自动检索),用户创建时
 * 不需要也不该被迫理解;系统按建技能时所在场景默认定,要改去 /skills 管理器。
 */
function renderDraftFields(
  draft: SkillEditorView["draft"] & object,
  width: number,
  redactionCount: number,
): string[] {
  const lines: string[] = [
    fieldLine("名称", draft.name, width, true),
    fieldLine("什么时候用", draft.description, width),
    "",
    renderBodyDivider("正文", width),
    "",
    ...wrapBlock(draft.body, width),
  ];
  // 脱敏可见(真抹过才显):前加一个空行与正文分隔。正文区与下方区块(进度行 / 输入框)的
  // 间距由 caller 统一加一个空行 —— 各态间距一致,切换时不跳。
  if (redactionCount > 0) {
    lines.push(
      "",
      ...wrapBlock(
        `· 已自动抹掉对话里的 ${redactionCount} 处密钥，不会写进技能`,
        width,
        tone.dim,
      ),
    );
  }
  return lines;
}

/** 编辑屏一帧的三段:固定顶部(chrome) / 滚动中间(内容) / 固定底部(输入区)。 */
export interface EditorFrame {
  readonly top: readonly string[];
  readonly scroll: readonly string[];
  readonly bottom: readonly string[];
}

/**
 * 纯渲染:`controller.view()` + 注入的笔帧 / 库为空标志 → 三段帧。一屏四态(见文件头)。
 * 分段是分区布局的关键:top/bottom 钉死、scroll 随内容滚动,由 composeViewport 合成 ——
 * 输入区永远固定在屏幕底部、内容超屏在中间区滚动。penChar 作参数注入(纯函数、可断言);
 * libraryEmpty 决定等意图态是否顶认知解释。
 */
export function renderSkillEditor(
  view: SkillEditorView,
  width: number,
  title: string,
  opts: { penChar?: string; libraryEmpty?: boolean } = {},
): EditorFrame {
  const {
    draft,
    input,
    inputCursor,
    phase,
    error,
    canExternal,
    subject,
    redactionCount,
    pendingDiscard,
    revisions,
  } = view;
  const penChar = opts.penChar ?? "✎";
  // 收自:有主题显示"收自：X";首次纯对话提炼、主题未定时显示"提炼中"占位(不露空"收自：")。
  const subjectLine = subject ? `收自：${subject}` : "正在从最近的对话里提炼…";

  // ── 外部编辑暂停态(提示页,无输入区)──
  if (phase === "external") {
    const top = renderChrome({
      title: `${title} · 草稿`,
      body: [subject ? `收自：${subject}` : "从你说的话里收一个技能"],
      width,
    });
    // 自动拉起失败:不假装已打开,把草稿文件路径直接给用户、请他手动打开(同一条 mtime 重读闭环)。
    const scroll =
      view.external && !view.external.opened
        ? [
            "",
            ...wrapBlock(
              "◇ 没能自动打开编辑器。草稿已存到下面这个文件，你用编辑器打开它改：",
              width,
              tone.dim,
            ),
            "",
            ...wrapBlock(view.external.file, width),
            "",
            ...wrapBlock("改完保存，回来按任意键读回。", width, tone.dim),
          ]
        : [
            "",
            ...wrapBlock(
              "◇ 已用你的编辑器打开草稿。改完保存，回来按任意键读回。",
              width,
              tone.dim,
            ),
          ];
    return { top, scroll, bottom: [] };
  }

  // ── 起草中(显影)态 —— 内容区滚动、输入区固定底部(不消失,标题行换成笔)──
  if (phase === "drafting") {
    const top = renderChrome({ title: `${title} · 草稿`, body: [subjectLine], width });
    // 内容区:首次=简洁占位(去骨架,把"在写"交给底部那支笔);改写=保留旧草稿就地刷新。
    const scroll =
      draft === null
        ? ["", ...wrapBlock("正在落笔…", width, tone.dim)]
        : ["", ...renderDraftFields(draft, width, redactionCount)];
    // 输入区固定、不消失:标题行换成 笔 + "奋笔疾书中...",框占位,操作收成 Esc 取消。
    const box = renderInputBox({
      titleGlyph: `${penChar} `, // 笔后留一格,不贴住"奋笔疾书"(▎默认紧贴、笔需留白)
      title: "奋笔疾书中...",
      draft: "",
      cursor: 0,
      placeholder: "正在按你说的写，稍候…",
      hintBar: { hints: [{ label: "取消", key: "Esc" }] },
      width,
    });
    return { top, scroll, bottom: box.lines };
  }

  // ── 等意图态(editing + 无草稿)──
  if (draft === null) {
    const top = renderChrome({
      title,
      body: [
        opts.libraryEmpty
          ? "把你的一套做法，收成一个以后能一句话唤起的技能。"
          : "把刚做的事，收成一个以后能一句话唤起的技能。",
      ],
      width,
    });
    const scroll: string[] = [];
    if (opts.libraryEmpty) {
      scroll.push(
        "",
        ...wrapBlock(
          "技能 = 教我一次「这类事这么做」，往后照做、不用重讲。",
          width,
          tone.dim,
        ),
      );
    }
    if (error) {
      scroll.push(
        "",
        ...wrapBlock(
          "⚠ 这次没起草出来（偶尔会抽风），照原来的意思再说一遍就行。",
          width,
          tone.warn,
        ),
      );
    }
    const box = renderInputBox({
      title: error ? "再说一遍想收什么？" : "想收个什么技能？说一句，我来写成草稿。",
      draft: input,
      cursor: inputCursor,
      placeholder: "比如：我审查 PR 的固定清单",
      hintBar: seedHintBar(canExternal),
      width,
    });
    return { top, scroll, bottom: box.lines };
  }

  // ── 策展态(editing + 有草稿)——唯一的灵魂屏 ──
  const top = renderChrome({ title: `${title} · 草稿`, body: [subjectLine], width });
  const scroll = ["", ...renderDraftFields(draft, width, redactionCount)];
  const bottom: string[] = [];
  // 放弃二次确认(Esc)提示在输入区上方。教学行已去掉(与输入框标题 / placeholder / hint 重复)。
  if (pendingDiscard) {
    bottom.push(
      ...wrapBlock(
        `退出会丢掉这份草稿（改了 ${revisions} 轮，没保存就没了）。再按 Esc 确认，或 Ctrl+S 保存。`,
        width,
        tone.warn,
      ),
    );
  }
  const box = renderInputBox({
    title: "想怎么改？",
    draft: input,
    cursor: inputCursor,
    placeholder: "比如：描述再具体点 / 补一条回滚的坑",
    hintBar: curateHintBar(canExternal),
    width,
  });
  bottom.push(...box.lines);
  return { top, scroll, bottom };
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
 *   - external 暂停态:任意键 = 读回。
 *   - Esc:走控制器分层(`pressEscape`)—— 输入框非空先清空、为空且有草稿先二次确认、
 *     为空且无草稿直接退;只有 discard / exit 才退出循环。
 *   - 其余键先解除放弃确认(`resetDiscard`),再各司其职。Ctrl+C 仍直接退(强终端语义、底层兜底)。
 *   - Ctrl+E 放宽:无草稿也可进外部编辑(手写直通车),只要本地 TTY 注入了 openExternal。
 */
export function handleEditorKey(
  controller: SkillEditorController,
  key: KeyEvent,
): EditorAction {
  if (controller.currentPhase() === "external") {
    return { kind: "resume" };
  }
  if (key.type === "escape") {
    const outcome = controller.pressEscape();
    return outcome === "discard" || outcome === "exit"
      ? { kind: "cancel" }
      : { kind: "continue" };
  }
  controller.resetDiscard();
  switch (key.type) {
    case "ctrl-c":
      return { kind: "cancel" };
    case "ctrl-s":
      return controller.hasDraft() ? { kind: "save" } : { kind: "continue" };
    case "ctrl-e":
      return controller.view().canExternal
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
    case "arrow-left":
      controller.moveCursorLeft();
      return { kind: "continue" };
    case "arrow-right":
      controller.moveCursorRight();
      return { kind: "continue" };
    default:
      return { kind: "continue" };
  }
}

export interface SkillEditorRunDeps extends SkillEditorDeps {
  title: string;
  /** 自动起草时作首句意图(对话入口的"附一句指向");冷启动留空。 */
  initialInstruction?: string;
  /** 技能库是否为空 —— 等意图态据此决定是否顶一句"技能=…"认知解释(新手降门槛、老手不啰嗦)。 */
  isLibraryEmpty: boolean;
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

  // 印鉴帧由当前时间推算(每帧重画时取),显影期间靠 ticker 定时重画推进 —— 渲染纯函数注入。
  const draw = (): void => {
    renderer.clear();
    const frame = renderSkillEditor(
      controller.view(),
      renderer.terminalWidth(),
      deps.title,
      { penChar: penFrame(Date.now()), libraryEmpty: deps.isLibraryEmpty },
    );
    // 分区合成:固定顶部(chrome)+ 滚动内容 + 固定底部(输入区),正好填满终端高度;writeFrame
    // 满屏整帧写(末尾不带 \n、不触发终端滚动)—— 输入区永远钉在屏幕底部、内容超屏中间滚动。
    renderer.writeFrame(
      composeViewport({
        height: renderer.terminalHeight(),
        top: frame.top,
        scroll: frame.scroll,
        bottom: frame.bottom,
        overflowHint: tone.dim("  ⋯ 内容较长，已折叠"),
      }),
    );
    renderer.flush();
  };

  stream.start();
  renderer.enterAlternateScreen();
  renderer.hideCursor();
  renderer.flush();

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
          // 退屏前就地闪一帧成功(rank9):alt-screen 退出会整屏抹掉草稿,给"消失"一个
          // 明确的成功收尾,而非静默蒸发 —— 让用户确信是"存好了"不是"丢了"。
          renderer.clear();
          renderer.writeLines(["", `${layout.contentPrefix}${tone.success("◆ 存好了")}`]);
          renderer.flush();
          await sleep(SAVE_FLASH_MS);
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
 * 起草 / 改写,并把"等结果"与"等取消键"race:起草期间保留内容区、显影动效就地重画,
 * 用户按 Ctrl+C / Esc 即放弃等待(后台结果丢弃、保留原草稿 / 首次落回等意图态),否则结果
 * 回来就地重画。显影动效靠一个独立 ticker 定时重画(不扰 keyP race 的取消逻辑)。
 */
export async function runDraftWithCancel(
  controller: SkillEditorController,
  instruction: string,
  stream: KeyEventStream,
  draw: () => void,
): Promise<void> {
  const editAc = new AbortController();
  const editP = controller.runEdit(instruction, editAc.signal);
  draw(); // runEdit 同步段已置 phase=drafting,先画出"显影"首帧

  // 显影期间定时重画推进印鉴帧。独立 ticker,与下方 keyP race 解耦 —— 不必每帧 abort 重建
  // 等键 promise,避免扰动取消逻辑。finally 必清,杜绝循环外泄漏。
  const ticker = setInterval(draw, REDRAW_TICK_MS);

  let done = false;
  const doneP = editP.then(() => {
    done = true;
  });

  try {
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
          draw(); // 立即回 editing 重画(首次取消落回等意图态、预填意图)
          return; // finally 清 ticker
        }
        // 起草中的其它键忽略,继续等(re-race)
      }
    }
  } finally {
    clearInterval(ticker);
  }

  // 仅正常完成路径到此 → editP 已 settle,await 即时返回。
  await editP.catch(() => {});
  draw();
}
