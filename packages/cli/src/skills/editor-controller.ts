/**
 * AI 编辑屏控制器 —— UI 无关的"大脑":持有当前草稿 + 底部输入缓冲 + 阶段态,把"按指令
 * 起草 / 改写""保存落 Store""跳外部编辑器 + 回读"这些操作落到注入的访问器上,供 alt-screen
 * 外壳渲染与按键驱动。与渲染、按键解码彻底分离(注入轻量 stub 即可单测)。
 *
 * 所有草稿修改都经 AI(屏内不设手动可编辑字段)—— 用户用自然语言说意图,引擎落笔。起草
 * 是异步且可取消的:取消语义按底层范本 = 上层放弃等待、后台结果丢弃(不中断 LLM),故
 * `runEdit` 在 await 后用 `signal.aborted` 守门,放弃时不污染当前草稿。
 *
 * 底部输入缓冲复用 `InputBuffer`(主输入区 / `/work` 输入框同一底层件):字符级光标、
 * 左右移动、CJK / emoji 安全 —— 与手搓字符串拼接相比,行为与主交互一致、零重复实现。
 *
 * 两路编辑、文件单一真相源:跳外部编辑器前先把草稿交给注入方落文件并记 mtime,进"外部
 * 编辑中"暂停态(不收 AI 指令);回屏时按 mtime 比对、变了才一次性重读 —— 不做持续 watch、
 * 任何时刻只一面在写。
 */

import type { SkillDraft } from "@zhixing/core";
import { InputBuffer } from "../input-buffer.js";

/** 编辑屏阶段:等指令 / 起草中(可取消)/ 外部编辑中(暂停)。 */
export type EditorPhase = "editing" | "drafting" | "external";

/** 控制器对外部能力的依赖(全部注入,可 stub 单测)。 */
export interface SkillEditorDeps {
  /**
   * 起草 / 改写访问器(屏不感知 LLM):`current` 为 null → 从绑定的上下文 + 本次指令起草;
   * 否则按指令改写。`signal` 取消 = 放弃等待(底层 LLM 不中断,结果丢弃)。
   */
  edit: (
    current: SkillDraft | null,
    instruction: string,
    signal: AbortSignal,
  ) => Promise<SkillDraft>;
  /** 确认落盘:把草稿写进 Store(create / update,注入)。 */
  save: (draft: SkillDraft) => Promise<void>;
  /**
   * 跳外部编辑器:把草稿落到文件 + 拉起编辑器,返回文件路径与当时 mtime。本地 TTY 专用,
   * 远程 / 无头不注入 → 屏内不提供该入口(对话式 AI 编辑屏哪儿都能用)。
   */
  openExternal?: (draft: SkillDraft) => Promise<{ file: string; mtime: number }>;
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
}

export class SkillEditorController {
  private draft: SkillDraft | null = null;
  private readonly buffer = new InputBuffer();
  private phase: EditorPhase = "editing";
  private error: string | null = null;
  private external: { file: string; mtime: number } | null = null;

  constructor(private readonly deps: SkillEditorDeps) {}

  view(): SkillEditorView {
    return {
      draft: this.draft,
      input: this.buffer.draft,
      inputCursor: this.buffer.cursor,
      phase: this.phase,
      error: this.error,
      canExternal: Boolean(this.deps.openExternal),
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
   * 按指令起草 / 改写。进 drafting 态、await 访问器、用 signal 守门:被取消(放弃等待)则
   * 不改草稿、不报错,只复位阶段;成功换草稿、清错;失败留原草稿、记错供展示。
   */
  async runEdit(instruction: string, signal: AbortSignal): Promise<void> {
    this.phase = "drafting";
    this.error = null;
    try {
      const next = await this.deps.edit(this.draft, instruction, signal);
      if (signal.aborted) return;
      this.draft = next;
    } catch (err) {
      if (signal.aborted) return;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (!signal.aborted) this.phase = "editing";
    }
  }

  /** 用户在起草中途取消等待:复位到 editing、保留原草稿。 */
  cancelDraft(): void {
    this.phase = "editing";
  }

  /** 确认落盘。无草稿时不操作(由 caller 在 view 上守门,不该走到这)。 */
  async save(): Promise<void> {
    if (this.draft) await this.deps.save(this.draft);
  }

  /** 跳外部编辑器:落文件 + 拉起 + 进暂停态。无草稿 / 未注入入口则不操作。 */
  async openExternalAndPause(): Promise<void> {
    if (!this.draft || !this.deps.openExternal) return;
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
