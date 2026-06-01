/**
 * AI 编辑屏控制器 —— UI 无关的"大脑":持有当前草稿 + 底部输入缓冲 + 阶段态 + 起草元信息
 * (收自主题 / 脱敏计数),把"按指令起草 / 改写""保存落 Store""跳外部编辑器 + 回读"这些操作
 * 落到注入的访问器上,供 alt-screen 外壳渲染与按键驱动。与渲染、按键解码彻底分离(注入轻量
 * stub 即可单测)。
 *
 * 所有草稿修改都经 AI(屏内不设手动可编辑字段)—— 用户用自然语言说意图,引擎落笔。起草
 * 是异步且可取消的:取消语义按底层范本 = 上层放弃等待、后台结果丢弃(不中断 LLM),故
 * `runEdit` 在 await 后用 `signal.aborted` 守门,放弃时不污染当前草稿。
 *
 * 状态机:`phase` 只建模三个**真正不同的模式**(等指令 editing / 起草中 drafting /
 * 外部编辑 external);`pendingDiscard`(Esc 放弃的二次确认)是 editing 内的**叠加标志**、
 * 不升格为大态;`subject`/`redactionCount`/`lastIntent`/`revisions` 是派生状态,服务草稿屏
 * 呈现(收自 / 脱敏可见)、失败与取消的意图预填、放弃确认的"改了 N 轮"文案。
 *
 * 底部输入缓冲复用 `InputBuffer`(主输入区 / `/work` 输入框同一底层件):字符级光标、
 * 左右移动、CJK / emoji 安全。
 *
 * 两路编辑、文件单一真相源:跳外部编辑器前先把草稿交给注入方落文件并记 mtime,进"外部
 * 编辑中"暂停态;回屏时按 mtime 比对、变了才一次性重读 —— 不做持续 watch、任何时刻只一面在写。
 */

import type {
  SkillDraft,
  SkillDraftResult,
  SkillReviseResult,
} from "@zhixing/core";
import { InputBuffer } from "../input-buffer.js";

/** 编辑屏阶段:等指令 / 起草中(可取消)/ 外部编辑中(暂停)。 */
export type EditorPhase = "editing" | "drafting" | "external";

/** 控制器对外部能力的依赖(全部注入,可 stub 单测)。 */
export interface SkillEditorDeps {
  /**
   * 首次起草(屏不感知 LLM):从绑定的上下文 + 本次意图蒸馏出草稿 + 主题 + 脱敏计数。
   * `signal` 取消 = 放弃等待(底层 LLM 不中断,结果丢弃)。
   */
  draft: (intent: string, signal: AbortSignal) => Promise<SkillDraftResult>;
  /** 按指令改写已有草稿。主题不变,故无 subject;仍回传本次脱敏计数。 */
  revise: (
    current: SkillDraft,
    instruction: string,
    signal: AbortSignal,
  ) => Promise<SkillReviseResult>;
  /** 确认落盘:把草稿写进 Store(create / update,注入)。 */
  save: (draft: SkillDraft) => Promise<void>;
  /**
   * 跳外部编辑器:把草稿落到文件 + 拉起编辑器,返回文件路径与当时 mtime。本地 TTY 专用,
   * 远程 / 无头不注入 → 屏内不提供该入口。`draft` 为 null = 手写直通车(还没起草),由注入方
   * 落一个空骨架文件交编辑器。
   */
  openExternal?: (draft: SkillDraft | null) => Promise<{ file: string; mtime: number }>;
  /** 回屏重读:文件 mtime 比 `since` 新则重读返回新草稿,未变返回 null。 */
  rereadExternal?: (
    file: string,
    since: number,
  ) => Promise<{ draft: SkillDraft; mtime: number } | null>;
  /** 进屏即从上下文自动起草(对话入口 true);冷启动 false,等用户第一句。 */
  autoDraft: boolean;
}

/** 渲染所需的视图快照。 */
export interface SkillEditorView {
  readonly draft: SkillDraft | null;
  /** 底部输入缓冲的当前文本。 */
  readonly input: string;
  /** 输入缓冲的光标字符 offset —— 渲染层据此画框内软件光标。 */
  readonly inputCursor: number;
  readonly phase: EditorPhase;
  /** 上次操作的错误(起草失败等),展示后由下一次成功操作清除。 */
  readonly error: string | null;
  /** 是否提供"外部编辑器"入口(注入了 openExternal 才有)。 */
  readonly canExternal: boolean;
  /** 收自 —— AI / 用户判定的"这个草稿收的是哪件事",草稿屏顶部呈现;空 = 还没起草。 */
  readonly subject: string;
  /** 本次起草脱敏抹掉的密钥数 —— >0 时草稿屏显示"已抹掉 N 处密钥"灰字。 */
  readonly redactionCount: number;
  /** Esc 放弃的二次确认态 —— true 时草稿屏显示确认行,再按 Esc 才真放弃。 */
  readonly pendingDiscard: boolean;
  /** 已改写轮数 —— 放弃确认文案"改了 N 轮"用。 */
  readonly revisions: number;
}

export class SkillEditorController {
  private draft: SkillDraft | null = null;
  private readonly buffer = new InputBuffer();
  private phase: EditorPhase = "editing";
  private error: string | null = null;
  private external: { file: string; mtime: number } | null = null;
  private subject = "";
  private redactionCount = 0;
  /** 最近一次提交的意图 —— 失败 / 取消时预填回输入框,接住"我刚说的还在"。 */
  private lastIntent = "";
  private revisions = 0;
  private pendingDiscard = false;

  constructor(private readonly deps: SkillEditorDeps) {}

  view(): SkillEditorView {
    return {
      draft: this.draft,
      input: this.buffer.draft,
      inputCursor: this.buffer.cursor,
      phase: this.phase,
      error: this.error,
      canExternal: Boolean(this.deps.openExternal),
      subject: this.subject,
      redactionCount: this.redactionCount,
      pendingDiscard: this.pendingDiscard,
      revisions: this.revisions,
    };
  }

  currentPhase(): EditorPhase {
    return this.phase;
  }

  // ─── 底部输入缓冲(仅 editing 阶段可改)———— 委托 InputBuffer:写入 / 删除 /
  // 光标移动都走它,字符级 offset、CJK 安全,与主输入区行为一致。

  typeChar(ch: string): void {
    if (this.phase === "editing") this.buffer.insertText(ch);
  }

  backspace(): void {
    if (this.phase === "editing") this.buffer.deleteBackward();
  }

  moveCursorLeft(): void {
    if (this.phase === "editing") this.buffer.moveCursorLeft();
  }

  moveCursorRight(): void {
    if (this.phase === "editing") this.buffer.moveCursorRight();
  }

  /** 取走并清空当前输入(提交指令时用)。 */
  takeInput(): string {
    const text = this.buffer.draft.trim();
    this.buffer.clear();
    return text;
  }

  hasDraft(): boolean {
    return this.draft !== null;
  }

  // ─── 异步操作 ───

  /**
   * 按意图起草(首次)/ 按指令改写(已有草稿)。进 drafting 态、await 访问器、用 signal 守门:
   * 被取消(放弃等待)则不改草稿、不报错,只复位阶段;成功换草稿 / 主题 / 脱敏计数、清错;
   * 失败留原草稿、记错供展示,并把意图预填回输入框(只在带意图时)。
   */
  async runEdit(instruction: string, signal: AbortSignal): Promise<void> {
    this.phase = "drafting";
    this.error = null;
    this.pendingDiscard = false;
    this.lastIntent = instruction; // 开头即记,供取消 / 失败预填
    // 首次起草:开头即定"收自"——带意图用用户原话(显影期间立刻可见、不必等 LLM 返回);
    // 无意图(纯对话提炼)留空,待 LLM 返回主题后补,渲染层对空收自显示"提炼中"占位。
    if (this.draft === null) this.subject = instruction.trim();
    try {
      if (this.draft === null) {
        const r = await this.deps.draft(instruction, signal);
        if (signal.aborted) return;
        this.draft = r.draft;
        if (!this.subject) this.subject = r.subject; // 无意图:用 AI 同次产出的主题
        this.redactionCount = r.redactionCount;
        this.revisions = 0;
      } else {
        const r = await this.deps.revise(this.draft, instruction, signal);
        if (signal.aborted) return;
        this.draft = r.draft;
        this.redactionCount = r.redactionCount;
        this.revisions++;
      }
    } catch (err) {
      if (signal.aborted) return;
      this.error = err instanceof Error ? err.message : String(err);
      if (instruction.trim()) this.buffer.setDraft(instruction); // 失败预填意图
    } finally {
      if (!signal.aborted) this.phase = "editing";
    }
  }

  /**
   * 用户在起草中途取消等待:复位到 editing。首次起草取消时没有原草稿可保留 → 落回"等意图"
   * 态,把刚才的意图预填回输入框,让用户接得上"我刚说的还在",而非被甩回空屏(rank3 黑洞)。
   */
  cancelDraft(): void {
    this.phase = "editing";
    if (this.draft === null && this.lastIntent.trim()) {
      this.buffer.setDraft(this.lastIntent);
    }
  }

  /**
   * Esc 分层处理(editing 态):输入框非空先清空(符合终端"Esc 清行"肌肉记忆);为空且有草稿
   * 先落二次确认(避免一键销毁满意草稿);为空且无草稿(什么都没起草)直接退、无需确认。
   * 返回本次动作,供按键层决定是否退出循环。
   */
  pressEscape(): "cleared-input" | "confirm-discard" | "discard" | "exit" {
    if (!this.buffer.isEmpty) {
      this.buffer.clear();
      return "cleared-input";
    }
    if (this.draft === null) return "exit";
    if (!this.pendingDiscard) {
      this.pendingDiscard = true;
      return "confirm-discard";
    }
    return "discard";
  }

  /** 任何非 Esc 的有意义操作都解除待确认态,避免确认行黏住。 */
  resetDiscard(): void {
    this.pendingDiscard = false;
  }

  /** 确认落盘。无草稿时不操作(由 caller 在 view 上守门,不该走到这)。 */
  async save(): Promise<void> {
    if (this.draft) await this.deps.save(this.draft);
  }

  /**
   * 跳外部编辑器:落文件 + 拉起 + 进暂停态。未注入入口则不操作;草稿可为 null(手写直通车:
   * 还没起草也能直接进编辑器,注入方落空骨架)。
   */
  async openExternalAndPause(): Promise<void> {
    if (!this.deps.openExternal) return;
    this.external = await this.deps.openExternal(this.draft);
    this.phase = "external";
  }

  /** 回屏:mtime 变了重读换草稿,未变保持;无论如何复位到 editing。 */
  async resumeFromExternal(): Promise<void> {
    if (this.external && this.deps.rereadExternal) {
      const res = await this.deps.rereadExternal(
        this.external.file,
        this.external.mtime,
      );
      if (res) this.draft = res.draft;
    }
    this.external = null;
    this.phase = "editing";
  }
}
