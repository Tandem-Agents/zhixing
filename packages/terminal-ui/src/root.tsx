import { batch, createEffect, createMemo, createSignal, For, Show, ErrorBoundary, onCleanup } from 'solid-js';
import { createCliRenderer, TextBuffer, TextBufferView, type CliRenderer, type TextareaRenderable, type ScrollBoxRenderable, type BoxRenderable, type KeyEvent, type PasteEvent } from '@opentui/core';
import { render, extend } from '@opentui/solid';
import { normalizeLeadingSlashAlias, validateProcessView, type TerminalSelectionCancelCause, type TerminalAction, type TerminalMessage, type TerminalView, type TerminalDisplayPage, type TerminalReading, type TerminalTaskStatus, type TerminalProcessStatus, type TerminalStopTarget } from './protocol.js';
import { ProcessView } from './process-view.js';
import { processViewRows } from './process-model.js';
import { RecoveryInputBuffer, RECOVERY_INPUT_PART_BYTES } from './recovery-input.js';
import { TerminalInputSession, type TerminalAtomicRange } from './input-session.js';
import { setEditorAtomicWrap } from './editor-atomic-wrap.js';
import type { TerminalPasteSink } from './paste-stream.js';
import { TerminalCandidateSession } from './candidate-session.js';
import { TerminalTrustCandidateControls } from './trust-candidate-controls.js';
import { TerminalTextarea, editorUtf16Cursor, setEditorUtf16Cursor } from './editor-coordinates.js';
import { BodyView, TerminalScrollBox, type BodyViewHandle, type BodyReadingState } from './body-view.js';
import { BODY_PAGE_BYTES, decodeBodyPage, sameBodyPageContent, type BodyPageRevision, type BodyAnchor } from './body-model.js';
import { bodySelection } from './body-selection.js';
import { BodyReadingWindow } from './body-window.js';
import { SkillsView, type SkillsViewHandle } from './skills-view.js';
import { InformationBoard, informationLayout, type InformationSource } from './information-model.js';
import { interactionKey, inputRows, candidateLayout, initialChoiceIndex, nextChoiceIndex } from './surface-layout.js';
import { CandidateView } from './candidate-view.js';
import { SurfaceChrome } from './surface-chrome.js';
import { ChoiceView } from './choice-view.js';
import { tone, spacing, surfaceGeometry } from './theme.js';

extend({ textarea: TerminalTextarea, scrollbox: TerminalScrollBox });

const teal = tone.brand;
const frames = ['◇', '□', '◈', '▤', '◆', '▦', '◈', '▨', '◇', '▩'];
export interface TerminalRootOptions {
  readonly signal: AbortSignal;
  readonly request: (action: TerminalAction) => Promise<unknown>;
  readonly inputReady: (renderer: CliRenderer) => void;
  readonly usableFrame?: (frameId: number) => void;
  readonly exit: () => Promise<void>;
  /** 入口在经典控制台实测当前字体缺 ❯ 字形时改用 ASCII 提示符；其余情况保持 ❯。 */
  readonly promptGlyph?: 'ascii';
}

export async function createTerminalRoot(options: TerminalRootOptions, createRenderer = createCliRenderer) {
  let usableReported = false, usableScheduled = false;
  options.signal.throwIfAborted();
  const [view, setView] = createSignal<TerminalView>({ generation: 0, kind: 'conversation', title: '知行', connectionState: 'starting', connected: false, busy: true });
  const [informationRevision, setInformationRevision] = createSignal(0);
  const information = new InformationBoard(() => setInformationRevision(value => value + 1));
  let statusSource = information.source(interactionKey(view()));
  const statusSources = new Map([[interactionKey(view()), statusSource]]);
  let conversationScope = interactionKey(view());
  const activateInformation = (next: TerminalView) => {
    const previous = interactionKey(view()), key = interactionKey(next);
    const release = (scope: string) => { information.release(scope); statusSources.delete(scope); };
    // A modal pauses the main input; it does not end that interaction.
    if (previous !== key && view().kind !== 'conversation') release(previous);
    if (next.kind === 'conversation' && conversationScope !== key) {
      release(conversationScope); conversationScope = key;
    }
    statusSource = statusSources.get(key) ?? information.source(key);
    statusSources.set(key, statusSource);
  };
  const setStatus = (text: string) => statusSource.set('left', 'status', text || null);
  const fieldPastes = new Map<InformationSource, number>();
  const beginFieldPaste = (source: InformationSource) => {
    fieldPastes.set(source, (fieldPastes.get(source) ?? 0) + 1);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const left = (fieldPastes.get(source) ?? 1) - 1;
      if (left) fieldPastes.set(source, left); else fieldPastes.delete(source);
    };
  };
  const reportStatus = () => {
    const source = statusSource;
    return (error: unknown) => source.set('left', 'status', error instanceof Error ? error.message : String(error));
  };
  const [taskStatus, setTaskStatus] = createSignal<TerminalTaskStatus>({});
  const [processStatus, setProcessStatus] = createSignal<TerminalProcessStatus>();
  const [recoveryPage, setRecoveryPage] = createSignal({ page: 0, text: '' });
  const [recoveryLength, setRecoveryLength] = createSignal(0);
  let recoveryInput: RecoveryInputBuffer | undefined, recoverySubmitting = false;
  const releaseRecovery = () => { recoveryInput?.close(); recoveryInput = undefined; setRecoveryLength(0); setRecoveryPage({ page: 0, text: '' }); };
  const appendRecovery = (bytes: Uint8Array) => {
    if (!recoveryInput || recoverySubmitting) return false;
    try {
      for (let offset = 0; offset < bytes.length; offset += RECOVERY_INPUT_PART_BYTES) recoveryInput.append(bytes.subarray(offset, offset + RECOVERY_INPUT_PART_BYTES));
      setRecoveryLength(recoveryInput.length);
      return true;
    } catch { recoveryInput.close(); recoveryInput = new RecoveryInputBuffer(); setRecoveryLength(0); setStatus('恢复包超过允许长度，已清空保密输入。'); return false; }
  };
  const submitRecovery = async () => {
    const current = view().recovery, buffer = recoveryInput;
    if (!current?.input || !buffer || recoverySubmitting) return;
    const report = reportStatus();
    recoverySubmitting = true;
    try {
      for (let index = 0, offset = 0; ; index++, offset += RECOVERY_INPUT_PART_BYTES) {
        if (disposed || view().recovery?.requestId !== current.requestId) return;
        const bytes = buffer.part(offset), final = offset + bytes.length === buffer.length;
        try { await options.request({ kind: 'recovery-part', requestId: current.requestId, index, encoded: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'), final }); }
        finally { bytes.fill(0); }
        if (final) break;
      }
    } catch { if (!disposed) report('保密回读未完成，请重新打开输入。'); }
    finally { buffer.close(); if (recoveryInput === buffer) { recoveryInput = undefined; setRecoveryLength(0); } recoverySubmitting = false; }
  };
  const [copyAvailable, setCopyAvailable] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  const [size, setSize] = createSignal({ width: 80, height: 24 });
  const [animation, setAnimation] = createSignal('◆');
  const [secretLength, setSecretLength] = createSignal(0);
  const [editorLines, setEditorLines] = createSignal(1);
  const [editorEmpty, setEditorEmpty] = createSignal(true);
  let atomicLayoutDirty = true;
  let atomicLayoutEditor: TextareaRenderable | undefined;
  let atomicLayoutRanges: readonly TerminalAtomicRange[] | undefined;
  const noAtomicRanges: readonly TerminalAtomicRange[] = [];
  const syncEditor = () => {
    if (!editor || editor.isDestroyed || changingDraft) return;
    const text = editor.plainText;
    const ranges = view().kind === 'conversation' ? input.atomicRanges() : noAtomicRanges;
    if (atomicLayoutDirty || atomicLayoutEditor !== editor || atomicLayoutRanges !== ranges) {
      try {
        setEditorAtomicWrap(editor, text, ranges, renderer.widthMethod);
        atomicLayoutDirty = false; atomicLayoutEditor = editor; atomicLayoutRanges = ranges;
      } catch (error) { reportStatus()(error); }
    }
    setEditorLines(editor.editorView.getTotalVirtualLineCount());
    setEditorEmpty(text.length === 0);
  };
  const [display, setDisplay] = createSignal<TerminalDisplayPage>({ first: 0, last: 0, start: 0, follow: true, segments: [] });
  let displayReceived: BodyPageRevision | undefined;
  const bodyWindow = new BodyReadingWindow();
  let historyBox: ScrollBoxRenderable | undefined;
  let bodyView: BodyViewHandle | undefined;
  let bodyBox: BoxRenderable | undefined;
  const bodyClosures = new Set<Promise<void>>();
  const [bodySize, setBodySize] = createSignal({ width: 78, height: 10 });
  const [contextHeight, setContextHeight] = createSignal(0);
  const [readingArea, setReadingArea] = createSignal(0);
  const [bodyAnchor, setBodyAnchor] = createSignal<BodyAnchor>();
  // 已安装正文的身份（来自本代完整基准）与基准给出的“还有更早”。视图只声明期望的身份，不清掉已收到的正文
  const [bodyReading, setBodyReading] = createSignal<TerminalReading>();
  const [bodyEarlier, setBodyEarlier] = createSignal<boolean>();
  const sameReading = (left?: TerminalReading, right?: TerminalReading) => left?.conversationId === right?.conversationId && left?.generation === right?.generation;
  // 视图声明的会话与代次都与已安装正文相同才显示正文；否则正文区只有目标自己的欢迎区（壳态）
  const bodyMatches = createMemo(() => sameReading(view().reading, bodyReading()));
  const shellPage: TerminalDisplayPage = { first: 0, last: 0, start: 0, follow: true, segments: [] };
  // 阅读键只在换代、进出壳态时变化（字符串比较，页更新不触发）；正文组件据此在新页就位后重置阅读状态，欢迎块起点按新页起算
  const readingKey = createMemo(() => bodyMatches() ? `reading:${bodyReading()?.conversationId ?? ''}:${bodyReading()?.generation ?? ''}`
    : `shell:${view().reading?.conversationId ?? ''}:${view().reading?.generation ?? ''}`);
  const bodyPage = createMemo(() => bodyMatches() ? display() : shellPage);
  // 已就绪的会话页在壳态停留超过 200 ms（目标首页仍在读取）才提示读取中，不和正常空会话混淆
  const [shellLoading, setShellLoading] = createSignal(false);
  createEffect(() => {
    const current = view();
    if (bodyMatches() || current.kind !== 'conversation' || !current.readyForInput || current.connected === false || current.connectionState) { setShellLoading(false); return; }
    const timer = setTimeout(() => setShellLoading(true), 200);
    onCleanup(() => clearTimeout(timer));
  });
  const [reading, setReading] = createSignal<BodyReadingState>({ below: false, belowShown: false, above: false, loading: false },
    { equals: (a, b) => a.below === b.below && a.belowShown === b.belowShown && a.above === b.above && a.loading === b.loading && a.retry === b.retry });
  const isBody = () => ['conversation', 'history'].includes(view().kind);
  // 阅读导航行只在有阅读信息时占行；“下方还有内容”由正文按不含这一行时的完整高度判定，
  // 所以这一行出现或消失不会反过来改变它自己的条件
  const navigationShown = () => isBody() && (view().bodyRecovery === 'blocked' || view().bodyRecovery === 'retrying' ||
    !!reading().retry || reading().loading || reading().below || reading().above || shellLoading());
  // 后台补邻页只在可输入且空闲时进行：输入框为空、无候选、无待受理的提交、没有运行；发送路径从不等待它
  const prefetchAllowed = () => {
    const current = view();
    if (!isBody() || !bodyMatches() || !editorEmpty() || candidateOpen() || input.pendingSubmissionId) return false;
    return current.kind === 'history' ? !current.busy : !!current.readyForInput && current.connected !== false && !current.connectionState && !current.busy;
  };
  // 阅读导航行：左侧是方向与读取状态（故障优先），右侧在实际视口下面还有正文时给“回到最新”
  const readingLeft = () => view().bodyRecovery === 'blocked' ? view().kind === 'history' ? '部分历史待恢复 · 请重新打开历史' : '部分正文待恢复 · 点击或 Ctrl+R 重试'
    : reading().retry ? '读取未完成 · 点击或原方向翻页重试'
    : view().bodyRecovery === 'retrying' || reading().loading || shellLoading() ? '正在读取…'
    : reading().above ? '↑ 上方还有内容' : '';
  const readingRight = () => view().bodyRecovery === 'blocked' || !reading().belowShown ? ''
    : process.platform === 'darwin' || size().width < 60 ? '↓ 回到最新' : '↓ 回到最新 Ctrl+End';
  const bodyReady = (value: BodyViewHandle | undefined) => {
    const previous = bodyView; bodyView = value;
    if (!value && previous) {
      const work = previous.close(); bodyClosures.add(work);
      void work.then(() => bodyClosures.delete(work), () => {});
    }
  };
  let secret = '', editor: TextareaRenderable | undefined, disposed = false, ctrlC = 0, fieldEditVersion = 0;
  let skillsView: SkillsViewHandle | undefined;
  let operationCount = 0;
  let changingDraft = false;
  let editorHistoryBytes = 0, editorHistoryEntries = 0;
  const [candidateRevision, setCandidateRevision] = createSignal(0);
  const trustControls = new TerminalTrustCandidateControls();
  let candidates: TerminalCandidateSession | undefined;
  const input = new TerminalInputSession(options.request, () => {
    if (view().kind === 'conversation' && editor && !editor.isDestroyed) {
      changingDraft = true;
      try {
        if (editor.plainText !== draft.text) { editor.setText(draft.text); editorHistoryBytes = 0; editorHistoryEntries = 0; }
        setEditorUtf16Cursor(editor, draft.text, draft.cursor, renderer.widthMethod);
      } finally { changingDraft = false; }
      syncEditor();
    }
    if (candidates?.deleteArmed || trustControls.armedId) setStatus('');
    candidates?.sync(view().kind === 'conversation');
  });
  const draft = input.draft;
  candidates = new TerminalCandidateSession(input, options.request, () => setCandidateRevision(value => value + 1));
  const candidateItems = () => { candidateRevision(); return candidates?.value?.items ?? []; };
  const candidateOpen = () => { candidateRevision(); return view().kind === 'conversation' && !!candidates?.open; };
  const candidateLoading = () => { candidateRevision(); return !!candidates?.loading; };
  const candidateSelected = () => { candidateRevision(); return candidates?.selected ?? 0; };
  const candidateError = () => { candidateRevision(); return candidates?.error; };
  const candidateDanger = () => { candidateRevision(); return !!candidates?.deleteArmed; };
  const candidateValue = () => { candidateRevision(); return candidates?.value; };
  const trustSnapshot = () => ({ mode: candidateValue()?.mode, revision: candidateValue()?.revision ?? 0,
    items: candidateItems(), selected: candidates?.selected ?? 0, draftVersion: draft.version, cursor: draft.cursor,
    pageKey: view().generation, canDelete: candidateValue()?.canDelete === true, busy: candidates?.busy,
    error: candidateValue()?.error, safe: view().connected !== false && size().height >= 18 && size().width >= 40 });
  createEffect(() => { if (trustControls.sync(trustSnapshot())) setStatus(''); });
  const editorValue = () => editor && !editor.isDestroyed ? editor.plainText : '';
  const preserveDraft = () => {
    if (!changingDraft && view().kind === 'conversation' && editor && !editor.isDestroyed) {
      const text = editor.plainText, cursor = editorUtf16Cursor(editor);
      try {
        if (text !== draft.text) {
          setStatus('');
          // A conservative finite bound on retained undo payload and entries.
          // setText rebuilds the native text store as well as clearing undo.
          editorHistoryBytes += Buffer.byteLength(text) + Buffer.byteLength(draft.text); editorHistoryEntries++;
        }
        input.edit(text, cursor);
        if (editorHistoryBytes >= 1024 * 1024 || editorHistoryEntries >= 1024) {
          changingDraft = true;
          try { editor.setText(text); setEditorUtf16Cursor(editor, text, cursor, renderer.widthMethod); editorHistoryBytes = 0; editorHistoryEntries = 0; }
          finally { changingDraft = false; }
        }
        void input.compact().catch(reportStatus());
      } catch (error) {
        changingDraft = true;
        try { editor.setText(draft.text); setEditorUtf16Cursor(editor, draft.text, draft.cursor, renderer.widthMethod); editorHistoryBytes = 0; editorHistoryEntries = 0; }
        finally { changingDraft = false; }
        setStatus(error instanceof Error ? error.message : '输入暂不可用，草稿保留。');
      }
    }
    syncEditor();
    candidates?.sync(view().kind === 'conversation');
  };
  const preserveCursor = () => {
    if (!changingDraft && view().kind === 'conversation' && editor && !editor.isDestroyed) input.edit(draft.text, editorUtf16Cursor(editor));
    candidates?.sync(view().kind === 'conversation');
  };
  const releaseSecret = () => { secret = ''; setSecretLength(0); };
  const action = async (value: TerminalAction) => {
    if (operationCount >= 8) { setStatus('操作处理中，请稍候。'); return; }
    operationCount++;
    const report = reportStatus();
    try { return await options.request(value); }
    catch (error) { if (!disposed) report(error); }
    finally { operationCount--; }
  };
  // Keep the current action visible while the independently scrollable body
  // contains a long connection target, consequence, or selected-item detail.
  const pageRows = () => view().kind === 'configuration' ? Math.max(1, view().choices?.length ?? 0) : Math.max(1, Math.min(8, size().height - (view().field ? 17 : 13)));
  const choiceStart = () => Math.max(0, selected() - pageRows() + 1);
  const choices = () => (view().choices ?? []).slice(choiceStart(), choiceStart() + pageRows());
  const safeAction = () => size().width >= 40 && size().height >= 12;
  const displayText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    char => String.fromCharCode(char.charCodeAt(0) === 127 ? 0x2421 : 0x2400 + char.charCodeAt(0)));
  const pageHistory = async (direction: -1 | 1) => {
    if (isBody()) await bodyView?.page(direction);
  };
  const attach = (value: TextareaRenderable) => {
    editor = value; atomicLayoutDirty = true;
    queueMicrotask(() => { if (!value.isDestroyed) {
      if (view().kind === 'conversation') {
        changingDraft = true; try { setEditorUtf16Cursor(value, draft.text, draft.cursor, renderer.widthMethod); } finally { changingDraft = false; }
      } else if (view().field && !view().field!.secret) {
        // 预填的字段（改名、模型 id 等）光标放在末尾：退格直接修改原值，输入接在原值后面
        const initial = view().field!.value ?? '';
        setEditorUtf16Cursor(value, initial, initial.length, renderer.widthMethod);
      }
      value.focus();
      syncEditor();
    } });
  };
  const submit = async () => {
    let current = view();
    if (current.kind === 'conversation' && input.pasting) {
      preserveDraft();
      const source = statusSource, report = reportStatus();
      setStatus('正在处理粘贴，完成后发送…');
      try {
        const ready = await input.waitForPastes();
        if (disposed || statusSource !== source || view().kind !== 'conversation') return;
        if (!ready) { setStatus('草稿已更改，请按 Enter 发送。'); return; }
      } catch (error) { if (!disposed) report(error); return; }
      current = view();
    }
    const report = reportStatus();
    if (current.field && fieldPastes.has(statusSource)) { setStatus('粘贴仍在处理，请完成后再确认。'); return; }
    if (current.field && current.requestId) {
      if (!safeAction()) { setStatus('请放大窗口后提交；仍可按 Esc 取消。'); return; }
      const value = editorValue();
      if (Buffer.byteLength(value) > 8192) { setStatus('说明过长，请缩短后再提交。'); return; }
      const choice = current.choices?.[selected()];
      if (!choice || choice.disabled) return;
      const itemId = choice.id;
      if (current.kind === 'confirmation') await action({ kind: 'confirmation', requestId: current.requestId, action: itemId, note: value });
      else await action({ kind: 'selection', requestId: current.requestId, itemId, input: value }); return;
    }
    if (current.field && current.editId) {
      if (!safeAction()) { setStatus('请放大窗口后提交；仍可按 Esc 取消。'); return; }
      if (current.field.secret) {
        const value = secret; releaseSecret();
        await action({ kind: 'secret-value', editId: current.editId, fieldId: current.field.id, value });
      } else await action({ kind: 'configuration-action', editId: current.editId, action: 'field', value: editorValue() });
      return;
    }
    const choice = current.kind !== 'conversation' || !editorValue().trim() ? current.choices?.[selected()] : undefined;
    if (choice) {
      if (choice.disabled || (!safeAction() && choice.id !== 'cancel' && choice.id !== 'reject')) { setStatus('请放大窗口以完整阅读后果；仍可取消或退出。'); return; }
      if (current.kind === 'confirmation') await action({ kind: 'confirmation', requestId: current.requestId!, action: choice.id });
      else if (current.kind === 'selection') await action({ kind: 'selection', requestId: current.requestId!, itemId: choice.id });
      else if (current.editId) await action({ kind: 'configuration-action', editId: current.editId, action: choice.id });
      else if (choice.id === 'retry') await action({ kind: 'retry-connection' });
      else if (choice.id === 'exit') await options.exit();
      else if (choice.id === 'history-open' || choice.id === 'history-close' || choice.id === 'rubric-resume' || choice.id === 'confirmation-retry') await action({ kind: choice.id });
      else await action({ kind: 'command', name: choice.id, argument: '' });
      return;
    }
    if (current.kind === 'conversation') {
      preserveDraft();
      if (current.connectionState === 'starting') { setStatus('正在启动，输入已保留。'); return; }
      if (current.connectionState === 'unavailable') { await action({ kind: 'retry-connection' }); return; }
      if (candidateValue()?.mode === 'management') return;
      const text = draft.text;
      if (input.completeWindow && !text.trim()) return;
      const controlText = normalizeLeadingSlashAlias(text.trim());
      if (input.completeWindow && controlText.startsWith('/')) {
        const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(controlText);
        const version = draft.version;
        if (match) {
          const route = await action({ kind: 'command-route', name: match[1]! }) as { route?: 'input' | 'local' } | undefined;
          if (!route || disposed || draft.version !== version || view().kind !== 'conversation') return;
          if (route?.route === 'input') {
            try { setStatus('正在保存并提交输入…'); await input.submit(); }
            catch (error) { if (!disposed) report(error); }
            return;
          }
          const result = await action({ kind: 'command', name: match[1]!, argument: match[2] ?? '' }) as { accepted?: boolean } | undefined;
          if (result?.accepted && draft.version === version) {
            input.clear(version);
            if (view().kind === 'conversation') { changingDraft = true; try { editor?.setText(''); } finally { changingDraft = false; } syncEditor(); }
            candidates?.dismiss();
          }
        }
      } else {
        try { setStatus('正在保存并提交输入…'); await input.submit(); }
        catch (error) { if (!disposed) report(error); }
      }
    }
  };
  const cancelPage = async (cause: TerminalSelectionCancelCause = 'escape') => {
    const current = view(); releaseSecret();
    if (current.requestId === 'workscene-preparing' && current.busy) { await action({ kind: 'abort' }); return; }
    if (current.kind === 'history') await action({ kind: 'history-close' });
    else if (current.editId) await action({ kind: 'configuration-action', editId: current.editId, action: 'back' });
    else if (current.kind === 'confirmation') await action({ kind: 'confirmation', requestId: current.requestId!, action: 'cancelled', cancelCause: cause });
    else if (current.kind === 'selection') await action({ kind: 'selection', requestId: current.requestId!, cancelled: true, cancelCause: cause });
  };
  const refreshCopy = () => {
    if (disposed) return;
    syncEditor();
    setCopyAvailable(isBody() && !!bodyView?.hasSelection());
  };
  let bodyCopyPending = false;
  const copyBody = async () => {
    if (disposed || !isBody()) return;
    if (!bodyView?.hasSelection()) { setStatus('请重新选择要复制的正文。'); return; }
    const text = bodyView?.selectedText() ?? '';
    if (!text) return;
    if (bodyCopyPending) return;
    const request = { kind: 'clipboard-write' as const, text };
    if (Buffer.byteLength(JSON.stringify(request)) > BODY_PAGE_BYTES) { setStatus('选区过大，请分段复制。'); return; }
    const report = reportStatus();
    bodyCopyPending = true; ctrlC = 0;
    try {
      const result = await options.request(request) as { state?: string };
      if (result.state === 'copied') report('已复制。');
      else if (result.state === 'provider') report('已复制，关闭知行前请完成粘贴。');
      else if (result.state === 'unavailable') report(renderer.copyToClipboardOSC52(text) ? '已发送复制请求，终端尚未确认。' : '当前终端无法执行复制请求，选区已保留。');
      else report('未能确认复制结果，选区已保留。');
    } catch { report('复制请求未完成，选区已保留。'); }
    finally { bodyCopyPending = false; }
  };
  const copyRecovery = () => {
    if (disposed || view().kind !== 'recovery') return;
    const text = bodySelection(renderer, bodyBox)?.getSelectedText();
    if (!text) { setStatus('请选择本页要复制的保密内容。'); return; }
    if (Buffer.byteLength(text) > 32 * 1024) { setStatus('请分段复制。'); return; }
    try { setStatus(renderer.copyToClipboardOSC52(text) ? '已发送复制请求。' : '当前终端无法执行复制请求。'); }
    catch { setStatus('复制请求未完成。'); }
  };
  const candidateBudget = () => candidateLayout(size().height);
  const candidateHeight = () => candidateOpen() ? candidateBudget().rows : 0;
  // Reserve compact chrome (2), a body row, input borders (2), the footer
  // and the fixed reading-navigation row on body surfaces.
  // Measure only the preceding context, so editor resizing cannot feed itself.
  // 阅读导航行按需显隐，这里始终按它在场预留：这只是编辑框的高度上限，不随导航行显隐来回变化
  const fieldRows = () => view().field?.secret ? 1 : Math.max(1, Math.min(
    candidateOpen() ? candidateBudget().editor : Infinity,
    inputRows(editorLines(), size().height), size().height - contextHeight() - candidateHeight() - 6 - (isBody() ? 1 : 0),
  ));
  const computeInfo = () => {
    informationRevision();
    const current = view(), blocks = information.snapshot(interactionKey(current));
    const candidate = current.kind === 'conversation' ? candidateValue() : undefined;
    // 同一句说明可能经提交结清写进这里的状态槽；过程区已完整显示它时不再重复
    const shownOperation = operationShown() ? displayText(current.message ?? '') : '';
    const left = current.inputReceiptPending ? [displayText(current.message ?? "输入结果待核对；草稿已保留。")]
      : blocks.left.filter(text => !shownOperation || displayText(text) !== shownOperation);
    // 当前说明已在过程区完整显示时不再重复；过程区被候选压缩、放不下或未显示时仍在这里保留可见说明
    // 断线时这句已作为必须的失败显示在过程区
    const operationNotice = isBody() && current.message && current.connectionState !== 'starting' && current.connectionState !== 'unavailable' && !current.inputReceiptPending && !operationShown()
      ? displayText(current.message) : '';
    if (operationNotice && !left.length) left.push(operationNotice);
    if (candidate?.error) left.push(candidate.error);
    // 列表为空时提示已显示在列表里，底部不再重复
    else if (candidate?.argumentHint && !(candidateOpen() && !candidate.items.length)) left.push(candidate.argumentHint);
    else if (current.field) left.push(current.field.label + (current.field.configured ? ' · 已设置，留空保留' : ''));
    else if (current.kind === 'conversation' && editorEmpty() && !left.length) left.push('输入消息或 / 查看命令');
    const hint = (full: string, compact: string) => measureInformation(full) <= size().width - 4 ? full : compact;
    const keys = current.inputReceiptPending ? hint('Ctrl+R 核对 · Ctrl+C 中止 · 连按退出', 'Ctrl+R 核对 · Ctrl+C 中止')
      : candidateOpen() && candidateError() ? 'Ctrl+R 重试 · Esc 返回'
      : candidateOpen() && candidateLoading() ? '正在读取候选 · Esc 返回'
      : candidateOpen() && !candidate?.items.length && !candidate?.ghost && !candidate?.mode ? 'Esc 返回'
      : candidate?.ghost ? hint(`Tab 补全 ${candidate.ghost.fullValue} · ↑↓ 选择 · Enter 接纳 · Esc 返回`, `Tab 补全 ${candidate.ghost.fullValue} · Esc 返回`)
      // 删除准备态：左侧说明下一步，右侧让出位置
      : candidate?.mode === 'picker' && candidates?.deleteArmed ? 'Esc 返回'
      : candidate?.hint ? candidate.hint
      : candidate?.items.length || candidate?.mode ? hint('↑↓ 选择 · Tab/Enter 接纳 · Esc 返回', '↑↓ 选择 · Enter 接纳 · Esc 返回')
      : current.kind === 'skills' ? '' // The skill surface owns its two contextual hint rows.
      : current.kind === 'recovery' ? (current.recovery?.input ? 'Enter 回读 · Esc 取消' : 'Esc 返回')
      : current.selectionLayer === 'details' ? hint('↑↓ 阅读 · ←/Enter/Esc 返回 · PgUp/PgDn 翻阅', '↑↓ 阅读 · Esc 返回')
      : current.field ? 'Enter 确认 · Esc 返回'
      : current.kind === 'configuration' ? hint('↑↓ 选择 · Enter 确认 · Ctrl+S 完成 · Esc 返回', '↑↓ 选择 · Enter 确认 · Esc 返回')
      : current.connectionState === 'starting' ? '可先输入 · Ctrl+C 退出'
      : current.connectionState === 'unavailable' ? hint('Enter 重试 · F2 历史 · F3 配置 · Ctrl+C 退出', 'Enter 重试 · F2 历史 · F3 配置')
      : current.kind === 'conversation' ? hint('Enter 发送 · Esc 清空 · Ctrl+C 中止/退出', 'Enter 发送 · Ctrl+C 退出')
      // 权限确认外层：Esc 即拒绝本次授权，不是一般面板的返回；内层（二次确认、理由、详情）仍先返回选择
      : current.kind === 'confirmation' && (current.selectionLayer ?? 'select') === 'select'
        ? (current.detailsActionId || current.choices?.some(choice => choice.detailsActionId))
          ? hint('Enter 确认 · → 详情 · Esc 拒绝 · PgUp/PgDn 阅读', 'Enter 确认 · → 详情 · Esc 拒绝')
          : hint('Enter 确认 · Esc 拒绝 · PgUp/PgDn 阅读', 'Enter 确认 · Esc 拒绝')
      : (current.detailsActionId || current.choices?.some(choice => choice.detailsActionId)) ? hint('Enter 确认 · → 详情 · Esc 返回 · PgUp/PgDn 阅读', 'Enter 确认 · → 详情 · Esc 返回')
      : hint('Enter 确认 · Esc 返回 · PgUp/PgDn 阅读', 'Enter 确认 · Esc 返回');
    const copy = copyAvailable() && size().width >= 12 ? '复制选区' : '';
    const copyWidth = copy ? measureInformation(copy) : 0;
    return { ...informationLayout({ left, right: [...blocks.right, keys] }, size().width - (copy ? copyWidth + 2 : 0), measureInformation), copy, copyWidth };
  };
  let clipboardPending = false;
  // A paste may arrive after more editing. Page identity alone cannot authorize
  // applying an old result to a new cursor or selection in the same field.
  const fieldPasteContext = () => {
    const scope = statusSource, version = fieldEditVersion;
    const target = view().field?.secret || editor?.isDestroyed ? undefined : editor;
    const cursor = target?.cursorOffset, selected = target?.getSelection();
    return () => {
      if (disposed || scope !== statusSource || version !== fieldEditVersion) return false;
      if (view().field?.secret) return true;
      if (!editor || editor.isDestroyed || editor !== target) return false;
      const selection = editor.getSelection();
      return editor.cursorOffset === cursor && selected?.start === selection?.start && selected?.end === selection?.end;
    };
  };
  const pasteClipboard = async () => {
    const current = view(), scope = statusSource;
    if (clipboardPending || current.kind !== 'conversation' && !current.field) return;
    clipboardPending = true;
    const report = reportStatus();
    const finish = current.field ? beginFieldPaste(scope) : undefined;
    const applicable = fieldPasteContext();
    try {
      if (current.kind === 'conversation') {
        preserveDraft(); await input.pasteClipboard();
      } else {
        const value = await options.request({ kind: 'clipboard-read', inputId: crypto.randomUUID(), target: 'field' }) as { text?: unknown };
        // Compare the mounted interaction, not refresh generations. A late read
        // must never paste into another field or a reopened instance of this one.
        if (disposed || scope !== statusSource) return;
        if (typeof value?.text !== 'string' || Buffer.byteLength(value.text) > 8192) throw Error('字段粘贴未完成，请检查内容。');
        if (!value.text) return;
        if (!applicable()) {
          report('字段已继续编辑，本次粘贴未应用。'); return;
        }
        if (current.field?.secret) {
          if (Buffer.byteLength(secret) + Buffer.byteLength(value.text) > 8192) throw Error('字段输入过长，请检查内容。');
          secret += value.text; fieldEditVersion++; setSecretLength(Array.from(secret).length);
        } else if (editor && !editor.isDestroyed) {
          if (Buffer.byteLength(editor.plainText) + Buffer.byteLength(value.text) > 8192) throw Error('字段输入过长，请检查内容。');
          editor.insertText(value.text); syncEditor();
        }
      }
    } catch { report('剪贴板粘贴未完成，原输入保留；可使用终端的粘贴快捷键。'); }
    finally { finish?.(); clipboardPending = false; }
  };
  const shownProcess = () => view().kind === 'conversation' && processStatus()?.conversationId === view().conversationId ? processStatus()?.view : undefined;
  // 按键时屏上显示的运行：停止请求带上它所在的对话与过程状态里的身份，由 N 按权威状态决定能否停；屏上空闲时不带
  const stopTarget = (): TerminalStopTarget | undefined => {
    const current = view(), shown = shownProcess(), status = processStatus();
    const running = shown?.activity === 'running' || shown?.activity === 'reconciling';
    if (current.kind !== 'conversation' || !current.conversationId || (!running && !current.busy)) return undefined;
    // 输入身份只在屏上还没有轮次/运行身份时代表“正在提交的这一次”（协议 TerminalStopTarget 与 N 的绑定规则一致）；
    // 屏上已有运行身份时只按它停，另一份在途提交的身份不随带，免得与所停运行的身份互相否决
    const turnId = running ? status?.turnId : undefined, runId = running ? status?.runId : undefined;
    const inputId = turnId || runId ? undefined : input.pendingSubmissionId;
    return { conversationId: current.conversationId, ...(turnId ? { turnId } : {}), ...(runId ? { runId } : {}), ...(inputId ? { inputId } : {}) };
  };
  const displayRecoveryNotice = () => view().displayPaused || view().bodyRecovery === 'blocked'
    ? view().kind === 'history' ? '历史展示已暂停，存在缺口 · 请释放空间后重新打开历史' : '正文保留已暂停 · Ctrl+R 重试展示'
    : view().displayGap ? view().kind === 'history' ? '历史展示存在缺口 · 请重新打开历史核对' : '展示已恢复；原缺口保留，可查看历史与用量' : '';
  // 当前操作的说明（结果、未接纳原因、输入是否保留、下一步）按宽度完整显示；待核对与启动中各有自己的位置
  const operationText = () => view().inputReceiptPending || view().connectionState === 'starting' ? '' : displayText(view().message ?? '');
  const footerFeedback = () => view().kind === 'history' ? { failures: [displayRecoveryNotice()].filter(Boolean), operation: operationText() } : ({ failures: [
    displayRecoveryNotice(),
    taskStatus().noticeGap ?? '',
    taskStatus().summary?.conversationId === view().conversationId && taskStatus().summary?.state === 'error' ? taskStatus().summary!.text : '',
    view().connectionState === 'unavailable' ? displayText(view().message ?? '') : '',
  // 任务进度只在“已就绪且有文字”时占行：就绪但为空（无待办或全部完成）是合法的成功结果、读取中不是有效摘要，
  // 都不占行（否则启动后“正在读取任务列表…”一闪，会把导航行与跟随中的正文顶上一行再落回）；读取失败仍按失败显示
  ].filter(Boolean), details: !!taskStatus().summary?.text.trim() && taskStatus().summary?.conversationId === view().conversationId && taskStatus().summary?.state === 'ready'
    ? [taskStatus().summary!.text] : [], notice: displayText(view().inputReceiptPending || view().connectionState === 'starting' ? view().message || taskStatus().summary?.text || '' : taskStatus().summary?.text || ''),
    operation: operationText(), candidateCompressed: candidateHeight() > 0 });
  const footerProcess = () => view().inputReceiptPending ? { revision: 0, phase: '原输入结果待核对，草稿已保留', activity: 'reconciling' as const, tools: [], children: [], usage: {} } : shownProcess() ?? { revision: 0, phase: view().busy ? view().connectionState === 'starting' ? '正在启动知行…' : '正在处理…' : '',
    activity: view().busy ? 'running' as const : 'complete' as const, tools: [], children: [], usage: {} };
  const processHeight = () => candidateHeight() ? candidateBudget().process : Math.max(1, Math.min(6, size().height - 6));
  /** 过程区正在显示，且整段当前说明都在其中（此时输入框下不再重复） */
  const operationShown = () => isBody() && processRows().some(row => row.operation);
  const ChoiceList = () => <box flexDirection="column" flexShrink={0} marginTop={view().message && choices().length ? 1 : 0}>
    <For each={choices()}>{(choice, index) => {
      const startsSection = () => !!choice.section && (index() === 0 || choices()[index() - 1]?.section !== choice.section);
      return <box id={`choice-${index() + choiceStart()}`} flexDirection="column" flexShrink={0}
        paddingTop={view().kind === 'configuration' && choice.presentation === 'button' && index() > 0 && choices()[index() - 1]?.presentation !== 'button' && !startsSection() ? 1 : 0}>
      <Show when={startsSection()}>
        <text marginTop={index() ? 1 : 0} marginBottom={1} fg={tone.brand}>{`▎ ${displayText(choice.section ?? '')}`}</text>
        <Show when={choice.sectionDescription}><text marginLeft={2} marginBottom={1} fg={tone.dim}>{displayText(choice.sectionDescription ?? '')}</text></Show>
      </Show>
      <ChoiceView choice={choice} selected={selected() === index() + choiceStart()} width={Math.max(1, bodySize().width - 1 - spacing.content * 2)} configuration={view().kind === 'configuration'} measure={measureInformation} />
    </box>;
    }}</For>
  </box>;
  const App = () => <box width="100%" height="100%" flexDirection="column" onMouseDown={event => {
    if (event.button === 2) { event.preventDefault(); event.stopPropagation(); void pasteClipboard(); }
  }}>
    <Show when={!isBody()}><SurfaceChrome view={view()} width={size().width} height={size().height} /></Show>
    {/* 正文与阅读导航行共处一个区域：区域高度不随导航行显隐变化，正文据此判断下方是否还有内容 */}
    <box flexDirection="column" flexGrow={1} minHeight={1} onSizeChange={function(this: BoxRenderable) { setReadingArea(this.height); }}>
    <box ref={value => { bodyBox = value; }} marginX={0} flexGrow={1} minHeight={1}
      onSizeChange={function(this: BoxRenderable) {
        bodyView?.beforeUpdate(); setBodySize({ width: this.width, height: this.height });
      }}>
      <Show when={view().kind === 'skills' && view().skills} fallback={<Show when={isBody()} fallback={<scrollbox ref={value => { historyBox = value; }} flexGrow={1}><box marginX={spacing.content} flexDirection="column">
        <Show when={view().message}><text selectable>{displayText(view().message ?? '')}</text></Show>
        <Show when={view().kind === 'recovery'}><text selectable fg="#111111" bg="#ffffff">{displayText(recoveryPage().text)}</text></Show>
        <Show when={view().kind !== 'configuration' && view().choices?.[selected()]?.detail}><text fg={tone.dim}>{displayText(view().choices?.[selected()]?.detail ?? '')}</text></Show>
        <Show when={view().kind === 'configuration'}><ChoiceList /></Show>
      </box></scrollbox>}>
        <BodyView page={bodyPage()} readingKey={readingKey()} renderer={renderer} width={bodySize().width} height={bodySize().height}
          header={<SurfaceChrome view={view()} width={bodySize().width} height={size().height} bottomGap={false} />}
          hasEarlier={bodyMatches() ? view().historyHasMore ?? bodyEarlier() : undefined}
          fullHeight={readingArea()}
          anchor={bodyAnchor()} onAnchor={setBodyAnchor} onReady={bodyReady}
          requestPage={(start, follow) => options.request({ kind: 'display-page', start, follow, generation: bodyReading()?.generation })}
          requestEarlier={before => options.request({ kind: 'display-earlier', before, generation: bodyReading()?.generation ?? 0 })}
          reveal={page => {
            if (disposed) return;
            const protectedRange = bodyView?.selectionRange();
            const next = bodyWindow.reveal(page, protectedRange?.from, protectedRange?.to);
            if (next) setDisplay(next);
            if (bodyWindow.notice) setStatus(bodyWindow.notice);
          }}
          prefetch={prefetchAllowed()}
          onReading={setReading}
          onError={error => { if (!disposed) setStatus(error instanceof Error ? error.message : typeof error === 'string' ? error : '正文暂不可用，已保留内容仍可回看。'); }} />
      </Show>}>
        <SkillsView view={view().skills!} width={bodySize().width} height={bodySize().height}
          send={async value => {
            const reply = await action({ kind: 'skills-action', action: value });
            if (reply === undefined) throw Error('terminal-skills-action-unconfirmed');
            return reply;
          }} onError={setStatus}
          onReady={value => { skillsView = value; }} />
      </Show>
    </box>
    <Show when={navigationShown()}><box height={1} flexShrink={0} flexDirection="row" marginX={spacing.content}
      onMouseScroll={event => {
        // 阅读行上的滚轮照常滚正文
        const direction = event.scroll?.direction;
        if (direction !== 'up' && direction !== 'down') return;
        event.preventDefault(); event.stopPropagation();
        void bodyView?.page(direction === 'up' ? -1 : 1, 3).catch(setStatus);
      }}>
      <text height={1} flexShrink={1} fg={reading().retry || view().bodyRecovery === 'blocked' ? tone.warn : tone.dim} selectable={false} wrapMode="none" truncate
        onMouseDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
          if (view().bodyRecovery === 'blocked') { if (view().kind === 'history') setStatus(displayRecoveryNotice()); else void action({ kind: 'display-retry' }); return; }
          const retry = reading().retry;
          if (retry) { void bodyView?.page(retry)?.catch(setStatus); return; }
          if (!reading().loading && reading().above) void bodyView?.page(-1)?.catch(setStatus); }}>{readingLeft()}</text>
      <box flexGrow={1} minWidth={1} />
      <Show when={readingRight()}><text height={1} flexShrink={0} fg={tone.dim} selectable={false} wrapMode="none"
        onMouseDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); void bodyView?.bottom()?.catch(setStatus); }}>{readingRight()}</text></Show>
    </box></Show>
    </box>
    <box flexDirection="column" flexShrink={0}>
    <box flexDirection="column" flexShrink={0} height={candidateHeight() ? candidateBudget().process : 'auto'} overflow="hidden" justifyContent="flex-end" onSizeChange={function(this: BoxRenderable) { setContextHeight(this.height); }}>
      <Show when={isBody()} fallback={<>
        <Show when={view().kind === 'recovery'}>
          <text marginX={spacing.content} height={1} wrapMode="none" truncate fg={tone.dim}>{'保密页 ' + (recoveryPage().page + 1) + '/' + (view().recovery?.pages ?? 1) + ' · PgUp/PgDn 翻页'}</text>
          <Show when={view().recovery?.input}><text marginX={spacing.content} height={1} fg={tone.dim}>{'恢复包输入：' + recoveryLength() + ' 字节'}</text></Show>
        </Show>
      </>}>
        <ProcessView rows={processRows()} indicator={footerProcess().activity === 'running' ? animation() : '◆'} />
      </Show>
      <Show when={view().kind !== 'configuration'}><box marginX={spacing.content} flexShrink={0}><ChoiceList /></box></Show>
      {/* 有待确认的选项时才说“可取消、放大后确认”；主对话等没有确认项的页面只提示放大 */}
      <Show when={!safeAction()}><text fg={tone.warn}>{view().choices?.length ? '窗口较小：可取消；放大后继续确认。' : '窗口较小：放大后可完整显示与操作。'}</text></Show>
    </box>
    <Show when={view().kind === 'conversation' || view().field}>
      <box border borderStyle="rounded" borderColor={tone.border} height={fieldRows() + 2} flexShrink={0} marginX={surfaceGeometry(size().width).margin} paddingX={spacing.frameInner} flexDirection="row">
        <text width={2} selectable={false} fg={teal}>{options.promptGlyph === 'ascii' ? '> ' : '❯ '}</text>
        <Show when={!view().field?.secret} fallback={<text height={1}>{'•'.repeat(Math.min(secretLength(), surfaceGeometry(size().width).editorWidth))}</text>}>
          <Show when={view().kind === 'conversation' ? 'conversation' : `${view().kind}:${view().editId ?? view().requestId}:${view().field?.id}`} keyed>
            {(owner: string) => <textarea selectionFg={tone.selectionFg} selectionBg={tone.selectionBg} ref={attach} initialValue={owner === 'conversation' ? draft.text : view().field?.value ?? ''} width={surfaceGeometry(size().width).editorWidth} height={fieldRows()} wrapMode="char" onSizeChange={syncEditor} onContentChange={() => { atomicLayoutDirty = true; if (view().field) fieldEditVersion++; preserveDraft(); }} onCursorChange={preserveCursor} />}
          </Show>
        </Show>
      </box>
    </Show>
    <Show when={candidateHeight() > 0}>
      <CandidateView value={candidateValue()} loading={candidateLoading()} error={candidateError()} selected={candidateSelected()} danger={candidateDanger()}
        width={size().width} height={candidateHeight()} renderer={renderer} measure={measureInformation} />
    </Show>
    <box height={1} flexShrink={0} flexDirection="row" paddingX={info().inset}>
      <text height={1} wrapMode="none" fg={tone.dim}>{info().left}</text>
      <box width={info().gap} />
      <text height={1} wrapMode="none" fg={tone.dim}>{info().right}</text>
      <Show when={info().copy}><box width={2} /><text height={1} width={info().copyWidth} selectable={false} fg={teal} bg={tone.selected}
        onMouseDown={event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation(); copyBody(); } }}>{info().copy}</text></Show>
    </box>
    </box>
  </box>;
  const externalPasteSink = (): TerminalPasteSink | undefined => {
    if (disposed) return;
    const current = view(), scope = statusSource, report = reportStatus();
    if (current.kind === 'recovery') {
      if (!current.recovery?.input || recoverySubmitting) return;
      let active = true;
      return { write: bytes => { if (active && view().recovery?.requestId === current.recovery?.requestId && !appendRecovery(bytes)) active = false; },
        end: () => { active = false; }, abort: () => {
          active = false;
          if (view().recovery?.requestId === current.recovery?.requestId) {
            recoveryInput?.close(); recoveryInput = new RecoveryInputBuffer(); setRecoveryLength(0);
            setStatus('粘贴已中断，保密输入已清空；可以重新输入。');
          }
        } };
    }
    if (current.kind === 'conversation') {
      preserveDraft();
      try {
        const stream = input.beginPaste();
        void stream.done.catch(reportStatus());
        return stream;
      } catch (error) { setStatus(error instanceof Error ? error.message : '粘贴未完成；草稿保留。'); return; }
    }
    if (!current.field) return;
    // Dedicated fields never enter ordinary draft storage, including secrets.
    // Replay this small complete paste through the original focused handler.
    let buffer = new Uint8Array(8192), used = 0, failed = false;
    const finish = beginFieldPaste(scope);
    const applicable = fieldPasteContext();
    const abort = () => { buffer.fill(0); buffer = new Uint8Array(0); used = 0; failed = true; finish(); };
    return {
      write(bytes) {
        if (failed) return;
        if (used + bytes.length > buffer.length) { abort(); report('字段输入过长，请检查内容。'); return; }
        buffer.set(bytes, used); used += bytes.length;
      },
      end() {
        try {
          if (used && !failed && !disposed && statusSource === scope) {
            if (applicable()) renderer.keyInput.processPaste(buffer.subarray(0, used));
            else report('字段已继续编辑，本次粘贴未应用。');
          }
        }
        finally { abort(); }
      },
      abort,
    };
  };
  const externalPaste = (): TerminalPasteSink | undefined => {
    const sink = externalPasteSink(); if (!sink) return;
    let started = false;
    return { write(bytes) { if (bytes.length && !started) { pointerTakeover(); started = true; } return sink.write(bytes); }, end: () => sink.end(), abort: () => sink.abort() };
  };
  const renderer = await createRenderer({ exitOnCtrlC: false, consoleMode: 'disabled', useMouse: true, useKittyKeyboard: null, useThread: false, screenMode: 'alternate-screen', stdinParserMaxBufferBytes: 64 * 1024, externalRecoveryOwner: true, externalPaste } as Parameters<typeof createCliRenderer>[0]);
  const informationBuffer = TextBuffer.create(renderer.widthMethod);
  const informationView = TextBufferView.create(informationBuffer);
  informationView.setWrapMode('none');
  const measureInformation = (text: string) => {
    informationBuffer.setText(text);
    return informationView.logicalLineInfo.lineWidthCols[0] ?? 0;
  };
  // 过程区按渲染器自己的字素宽度折行（歧义宽度字符与渲染截断同一口径）；按字素缓存，条数有界
  const graphemeWidths = new Map<string, number>();
  const graphemeWidth = (grapheme: string) => {
    let width = graphemeWidths.get(grapheme);
    if (width === undefined) { width = measureInformation(grapheme); if (graphemeWidths.size < 4096) graphemeWidths.set(grapheme, width); }
    return width;
  };
  const processRows = createMemo(() => processViewRows(footerProcess(), Math.max(1, size().width - 4), processHeight(), footerFeedback(), graphemeWidth));
  const info = createMemo(computeInfo);
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposed = true; input.activate(false); releaseSecret(); releaseRecovery(); clearInterval(animationTimer);
    information.dispose();
    candidates?.sync(false);
    renderer.off('resize', resize);
    renderer.off('frame', refreshCopy);
    renderer.off('pointer-takeover', pointerTakeover); renderer.off('blur', pointerTakeover);
    renderer.keyInput.off('keypress', keypress); renderer.keyInput.off('paste', paste);
    disposing = (async () => {
      try { await bodyView?.close(); await Promise.all(bodyClosures); }
      finally { informationView.destroy(); informationBuffer.destroy(); renderer.destroy(); }
    })();
    return disposing;
  };
  const resize = () => { bodyView?.beforeUpdate(); setSize({ width: renderer.terminalWidth, height: renderer.terminalHeight }); };
  const pointerTakeover = () => { renderer.releasePointerCapture?.(); renderer.emit('terminal-pointer-cancel'); bodyView?.inputTakeover(); };
  let followedSize = size();
  createEffect(() => {
    const index = selected(), current = view(), dimensions = size();
    if (current.kind !== 'configuration') return;
    // Native layout settles after the reactive page. Keep keyboard selection in
    // the scrollable configuration body without moving the input or footer.
    // 窗口尺寸变化后，选项文字按新宽度重新折行，布局要经过几帧才落定；只在下一帧定位一次，
    // 选中项会按旧行高停在可视区外。缩放后连续几帧跟随（每帧定位并请求重绘），直到布局落定。
    const resized = dimensions !== followedSize; followedSize = dimensions;
    const current_ = () => !disposed && view() === current && size() === dimensions;
    const follow = () => { if (current_()) historyBox?.scrollChildIntoView(`choice-${index}`); };
    const followFrames = (left: number) => renderer.once('frame', () => {
      if (!current_()) return;
      follow();
      if (left > 1) { followFrames(left - 1); renderer.requestRender(); }
    });
    if (resized) followFrames(3); else queueMicrotask(follow);
  });
  const keypress = (event: KeyEvent) => {
    pointerTakeover();
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if (view().kind === 'recovery' && view().recovery) {
      const current = view().recovery!;
      if (event.ctrl && event.shift && event.name === 'c') { consume(); copyRecovery(); return; }
      consume();
      if (event.name === 'escape' || event.ctrl && event.name === 'c') { releaseRecovery(); void action({ kind: 'recovery-cancel', requestId: current.requestId }); if (!current.input && !current.settled) void options.exit(); return; }
      if (event.name === 'pageup' || event.name === 'pagedown') {
        const page = Math.max(0, Math.min(current.pages - 1, recoveryPage().page + (event.name === 'pageup' ? -1 : 1)));
        void action({ kind: 'recovery-page', requestId: current.requestId, page }); return;
      }
      if (!current.input || recoverySubmitting) return;
      if (event.name === 'return') { void submitRecovery(); return; }
      if (event.name === 'backspace') { recoveryInput?.backspace(); setRecoveryLength(recoveryInput?.length ?? 0); return; }
      if (!event.ctrl && !event.meta && event.sequence && !event.sequence.startsWith('\x1b')) appendRecovery(new TextEncoder().encode(event.sequence));
      return;
    }
    if (view().kind === 'skills') { consume(); skillsView?.key(event); return; }
    if (view().inputReceiptPending && event.ctrl && event.name === 'r') { consume(); void action({ kind: 'retry-connection' }); return; }
    if (view().connectionState === 'unavailable') {
      if (event.name === 'f2') { consume(); void action({ kind: 'history-open' }); return; }
      if (event.name === 'f3') { consume(); void action({ kind: 'configuration-open' }); return; }
      if (event.ctrl && event.name === 'r') { consume(); void action({ kind: 'retry-connection' }); return; }
    }
    if (event.ctrl && event.name === 'c' && isBody() && (event.shift || bodyView?.hasSelection())) { consume(); void copyBody(); return; }
    if ((view().displayPaused || view().bodyRecovery === 'blocked') && ['conversation', 'history'].includes(view().kind) && event.ctrl && event.name === 'r') {
      consume(); if (view().kind === 'history') setStatus(displayRecoveryNotice()); else void action({ kind: 'display-retry' }); return;
    }
    if (event.ctrl && event.name === 'c') {
      consume();
      // 页面上的 Ctrl+C 只作用于当时的页面，不算主对话双击退出的首击
      if (view().kind === 'confirmation' || view().kind === 'selection') { ctrlC = 0; void cancelPage('ctrl-c'); return; }
      if (view().kind === 'unavailable' || view().kind === 'history' || (view().kind === 'conversation' && view().connected === false)) { void options.exit(); return; }
      if (view().editId) { releaseSecret(); void action({ kind: 'configuration-action', editId: view().editId!, action: 'cancel' }); ctrlC = 0; return; }
      if (view().kind !== 'conversation') { void cancelPage(); ctrlC = 0; return; }
      const now = performance.now();
      if (ctrlC > 0 && now - ctrlC < 750) { void options.exit(); return; }
      ctrlC = now;
      // 发送尚未交出：本地取消，草稿保留（提示由提交的失败回报给出）；已交出才请求中止运行
      if (input.cancelPreparedSubmit()) return;
      const stop = stopTarget();
      void action({ kind: 'interrupt', ...(stop ? { stop } : {}) }); return;
    }
    if (event.ctrl && event.name === 'd' && (view().kind === 'selection' || view().kind === 'confirmation')) { consume(); void cancelPage('ctrl-d'); return; }
    if (view().kind === 'conversation') {
      if (!(event.ctrl && event.name === 'd')) { if (candidates?.deleteArmed) setStatus(''); candidates?.resetDelete(); }
      const value = candidateValue();
      if (value?.mode === 'picker' && event.ctrl && !event.meta && !event.shift && ['d', 'r', 'n'].includes(event.name)) {
        const operation = event.name === 'd' ? 'delete' : event.name === 'r' ? 'rename' : 'create';
        const supported = operation === 'delete' ? value.canDelete : operation === 'rename' ? value.canRename : value.canCreate;
        if (supported) {
          consume();
          if (size().height < 18 || size().width < 40) { candidates?.resetDelete(); setStatus('请放大窗口后管理；Esc 返回。'); return; }
          if (operation === 'delete' && !candidates?.confirmDelete(view().generation)) {
            // 说清删的是哪一项；名字过长时截短，说明本身不能被右侧提示挤掉（准备态右侧只留 Esc）
            const name = Array.from(value.items[candidates?.selected ?? 0]?.label ?? '');
            setStatus(candidates?.deleteArmed ? `再次按 Ctrl+D 删除「${name.slice(0, 24).join('')}${name.length > 24 ? '…' : ''}」；其他键取消。` : '');
            return;
          }
          setStatus(operation === 'delete' ? '正在删除…' : '');
          void candidates?.manage(operation).then(deleted => {
            if (operation === 'delete') setStatus(deleted ? '已删除。' : '');
          }).catch(reportStatus());
          return;
        }
      }
      const snapshot = trustSnapshot();
      if (snapshot.mode === 'management' && event.ctrl && event.name === 'r') {
        consume(); trustControls.reset(); candidates?.refresh(); return;
      }
      const wasArmed = trustControls.armedId;
      const intent = trustControls.key(snapshot, event);
      if (wasArmed && intent.kind !== 'armed') setStatus('');
      if (intent.kind !== 'unhandled') {
        consume();
        if (intent.kind === 'dismiss') { candidates?.escape(); setStatus(''); }
        else if (intent.kind === 'move') {
          for (let index = 0; index < (intent.page ? 5 : 1); index++) candidates?.move(intent.direction);
        } else if (intent.kind === 'armed' || intent.kind === 'none') { if (intent.message) setStatus(intent.message); }
        else if (intent.kind === 'revoke') {
          const report = reportStatus();
          void candidates?.revoke(intent.revision, intent.id).then(message => { if (message && !disposed) report(message); }).catch(report);
        }
        return;
      }
    }
    if (event.name === 'escape') {
      consume();
      if (candidateOpen()) { candidates?.escape(); return; }
      // 发送尚未交出时 Esc 取消这次发送而不是清空草稿
      if (view().kind === 'conversation' && input.cancelPreparedSubmit()) return;
      if (view().kind === 'conversation' && draft.text) { input.clear(draft.version); return; }
      if (view().kind === 'conversation' && view().busy) { const stop = stopTarget(); void action({ kind: 'abort', ...(stop ? { stop } : {}) }); } else void cancelPage(); return;
    }
    if (view().kind === 'conversation' && candidateValue()?.ghost && event.name === 'tab' && !event.ctrl && !event.shift && !event.meta) {
      consume(); void candidates?.accept(true).catch(reportStatus()); return;
    }
    if (candidateOpen() && candidateHeight() && event.ctrl && event.name === 'r' && candidateValue()?.mode !== 'picker') { consume(); candidates?.refresh(); return; }
    if (candidateOpen() && candidateHeight() && !event.ctrl && !event.shift && !event.meta) {
      // 翻页移动选中项（一页约为可见行数减一），视图随选中项跟随；只滚视图会让 Enter 作用到看不见的条目
      if (event.name === 'pageup' || event.name === 'pagedown') { consume(); candidates?.move(event.name === 'pageup' ? -1 : 1, Math.max(1, candidateHeight() - 5)); return; }
      if (event.name === 'up' || event.name === 'down') { consume(); candidates?.move(event.name === 'up' ? -1 : 1); return; }
      if (event.name === 'tab' || event.name === 'return') {
        // 没有匹配项时 Enter 照常提交：未知命令由宿主说明"命令不可用"，草稿保留供修改。
        // 管理面板里 Enter 仍不提交（面板靠两次 Ctrl+D 与 Esc 操作）
        if (event.name === 'return' && !candidateLoading() && !candidateItems().length && candidateValue()?.mode !== 'management') {
          consume(); candidates?.dismiss(); void submit().catch(reportStatus()); return;
        }
        if (candidateLoading() || !candidateItems().length) { consume(); return; }
        consume(); void candidates?.accept().then(execute => { if (execute) return submit(); }).catch(reportStatus()); return;
      }
    }
    if (view().kind === 'conversation' && !event.ctrl && !event.shift && !event.meta && !editor?.hasSelection()) {
      preserveDraft();
      if (['backspace', 'delete', 'left', 'right'].includes(event.name) && input.atomic(event.name as 'backspace' | 'delete' | 'left' | 'right')) { consume(); return; }
      if (((event.name === 'left' || event.name === 'backspace') && draft.cursor === 0 && input.beforeWindow) ||
          ((event.name === 'right' || event.name === 'delete') && draft.cursor === draft.text.length && input.afterWindow)) {
        consume(); void input.navigate(event.name as 'left' | 'right' | 'backspace' | 'delete').catch(reportStatus()); return;
      }
      if (editor && ((event.name === 'up' && editor.scrollY + editor.visualCursor.visualRow === 0) ||
          (event.name === 'down' && editor.scrollY + editor.visualCursor.visualRow === editor.editorView.getTotalVirtualLineCount() - 1))) {
        consume();
        const next = event.name === 'up' ? input.beforeWindow : input.afterWindow;
        void (next ? input.navigate(event.name as 'up' | 'down', () => {
          if (editor && !editor.isDestroyed && view().kind === 'conversation') {
            if (event.name === 'up') editor.moveCursorUp(); else editor.moveCursorDown();
            preserveCursor();
          }
        }) : input.history(event.name === 'up' ? -1 : 1)).catch(reportStatus()); return;
      }
    }
    if (event.name === 'pageup' || event.name === 'pagedown') {
      consume();
      const direction = event.name === 'pageup' ? -1 : 1;
      if (view().selectionLayer === 'details') {
        const current = view(), itemId = direction < 0 ? 'previous' : 'next';
        if (current.choices?.some(choice => choice.id === itemId && !choice.disabled)) {
          if (current.kind === 'confirmation') void action({ kind: 'confirmation', requestId: current.requestId!, action: itemId });
          else void action({ kind: 'selection', requestId: current.requestId!, itemId });
        }
        return;
      }
      if (['conversation', 'history'].includes(view().kind)) void pageHistory(direction);
      else if (historyBox) historyBox.scrollBy(direction * Math.max(1, historyBox.viewport.height - 2));
      return;
    }
    if (['conversation', 'history'].includes(view().kind) && event.ctrl && event.name === 'end') {
      consume(); void bodyView?.bottom(); return;
    }
    const selectionView = view();
    if ((selectionView.kind === 'selection' || selectionView.kind === 'confirmation') && !event.ctrl && !event.meta) {
      const sendChoice = (itemId: string) => selectionView.kind === 'confirmation'
        ? action({ kind: 'confirmation', requestId: selectionView.requestId!, action: itemId })
        : action({ kind: 'selection', requestId: selectionView.requestId!, itemId });
      if (selectionView.selectionLayer === 'details' && !event.shift) {
        if (event.name === 'left' || event.name === 'return') { consume(); void sendChoice('return'); return; }
        if (event.name === 'up' || event.name === 'down') { consume(); historyBox?.scrollBy(event.name === 'up' ? -1 : 1); return; }
      }
      if (!selectionView.field && (selectionView.selectionLayer === undefined || selectionView.selectionLayer === 'select')) {
        if (event.name === 'right' && !event.shift) {
          const choice = selectionView.choices?.[selected()];
          const detailId = choice?.disabled ? undefined : choice?.detailsActionId ?? selectionView.detailsActionId;
          if (detailId) { consume(); void sendChoice(detailId); return; }
        }
        const key = /^[!-~]$/u.test(event.sequence) ? event.sequence : /^[!-~]$/u.test(event.name) ? event.name : undefined;
        const hotkey = key === undefined ? -1 : selectionView.choices?.findIndex(choice => !choice.disabled && choice.hotkey?.toLowerCase() === key.toLowerCase()) ?? -1;
        if (hotkey >= 0) { consume(); setSelected(hotkey); void submit(); return; }
      }
    }
    if (event.name === 'return' && !event.shift) { consume(); void submit(); return; }
    if (event.ctrl && event.name === 's' && view().editId) {
      consume();
      if (fieldPastes.has(statusSource)) setStatus('粘贴仍在处理，请完成后再保存。');
      else if (!safeAction()) setStatus('请放大窗口后保存；仍可按 Esc 取消。');
      else void action({ kind: 'configuration-action', editId: view().editId!, action: 'complete' });
      return;
    }
    if (view().field?.secret) {
      consume();
      const previous = secret;
      if (event.name === 'backspace') secret = Array.from(secret).slice(0, -1).join('');
      else if (!event.ctrl && !event.meta && event.sequence && !event.sequence.startsWith('\x1b')) {
        if (Buffer.byteLength(secret) + Buffer.byteLength(event.sequence) <= 8192) secret += event.sequence;
        else setStatus('字段输入过长，请检查内容。');
      }
      if (secret !== previous) fieldEditVersion++;
      setSecretLength(Array.from(secret).length); return;
    }
    if (view().choices?.length && (event.name === 'up' || event.name === 'down')) {
      consume(); setSelected(current => nextChoiceIndex(view(), current, event.name === 'up' ? -1 : 1));
      if (!isBody()) {
        const current = view(), index = selected();
        queueMicrotask(() => { if (!disposed && view() === current) historyBox?.scrollChildIntoView(`choice-${index}`); });
      }
    }
  };
  const paste = (event: PasteEvent) => {
    if (!event.bytes.byteLength) { event.preventDefault(); event.stopPropagation(); return; }
    pointerTakeover();
    if (view().kind === 'recovery') { event.preventDefault(); event.stopPropagation(); appendRecovery(event.bytes); return; }
    if (!view().field?.secret && view().kind !== 'conversation') return;
    event.preventDefault(); event.stopPropagation();
    if (view().kind === 'conversation') {
      preserveDraft();
      void input.paste(event.bytes).catch(reportStatus()); return;
    }
    if (Buffer.byteLength(secret) + event.bytes.byteLength > 8192) { setStatus('字段输入过长，请检查内容。'); return; }
    secret += new TextDecoder().decode(event.bytes); fieldEditVersion++; setSecretLength(Array.from(secret).length);
  };
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  const syncAnimation = () => {
    if (!(shownProcess() ? shownProcess()!.activity === 'running' : view().busy)) { clearInterval(animationTimer); animationTimer = undefined; }
    else if (!animationTimer) {
      const tick = () => setAnimation(frames[Math.floor(performance.now() / 300) % frames.length]!);
      tick(); animationTimer = setInterval(tick, 300);
    }
  };
  syncAnimation();
  try {
    if (renderer.useThread) throw Error('Current-frame output must be synchronous');
    options.signal.throwIfAborted();
    let renderFailure: unknown;
    await render(() => <ErrorBoundary fallback={(error: unknown) => { renderFailure = error; return <text>界面初始化失败</text>; }}><App /></ErrorBoundary>, renderer);
    if (renderFailure) throw renderFailure;
    resize(); renderer.on('resize', resize);
    renderer.on('frame', refreshCopy);
    renderer.on('pointer-takeover', pointerTakeover); renderer.on('blur', pointerTakeover);
    renderer.keyInput.on('keypress', keypress); renderer.keyInput.on('paste', paste);
    options.inputReady(renderer);
    const firstFrameId = await new Promise<number>((resolve, reject) => {
      const clean = () => { renderer.off('frame', complete); options.signal.removeEventListener('abort', abortFrame); };
      const complete = (frame: { frameId: number }) => { clean(); resolve(frame.frameId); };
      const abortFrame = () => { clean(); reject(Error('terminal-first-frame-cancelled')); };
      renderer.once('frame', complete); options.signal.addEventListener('abort', abortFrame, { once: true });
      if (options.signal.aborted) abortFrame(); else renderer.requestRender();
    });
    return {
      firstFrameId, dispose, information,
      receive(message: Extract<TerminalMessage, { type: 'view' | 'chunk' | 'invalidate' | 'display-page' | 'display-patch' | 'submission' | 'task-status' | 'process-status' | 'recovery-page' }>) {
        if (disposed) return;
        if (message.type === 'view') {
          if (message.view.generation < view().generation) return;
          const previous = view(), sameInteraction = interactionKey(previous) === interactionKey(message.view);
          const selectedId = previous.choices?.[selected()]?.id;
          const refreshCandidates = view().kind === 'conversation' && message.view.kind === 'conversation';
          if (message.view.recovery?.requestId !== view().recovery?.requestId) releaseRecovery();
          if (message.view.recovery?.input && !recoveryInput) recoveryInput = new RecoveryInputBuffer();
          candidates?.resetDelete(); trustControls.reset();
          preserveDraft(); bodyView?.beforeUpdate();
          if (!sameInteraction) {
            activateInformation(message.view); releaseSecret(); setEditorLines(1); setEditorEmpty(!message.view.field?.value);
          }
          setSelected(initialChoiceIndex(message.view, sameInteraction ? selectedId : undefined));
          setView(message.view);
          if (!usableReported && !usableScheduled && message.view.kind === 'conversation' && message.view.readyForInput && message.view.connected && !message.view.busy && !message.view.connectionState) {
            usableScheduled = true;
            renderer.once('frame', (frame: { frameId: number }) => {
              usableScheduled = false;
              if (disposed || view().kind !== 'conversation' || !view().readyForInput || !view().connected || view().busy || view().connectionState) return;
              usableReported = true; options.usableFrame?.(frame.frameId);
            });
            renderer.requestRender();
          }
          syncAnimation();
          input.activate(message.view.kind === 'conversation');
          candidates?.sync(message.view.kind === 'conversation');
          if (refreshCandidates) candidates?.refresh();
          if (!isBody() && !sameInteraction) renderer.once('frame', () => {
            if (!disposed && historyBox && !historyBox.isDestroyed) historyBox.scrollTo(0);
          });
        } else if (message.type === 'task-status') {
          setTaskStatus(message.status);
        } else if (message.type === 'process-status') {
          if (message.status && !validateProcessView(message.status.view)) throw Error('terminal-process-view-invalid');
          setProcessStatus(message.status);
          syncAnimation();
        } else if (message.type === 'recovery-page') {
          if (message.requestId !== view().recovery?.requestId) return;
          if (!Number.isSafeInteger(message.page) || message.page < 0 || message.page >= view().recovery!.pages || Buffer.byteLength(message.text) > 32 * 1024) throw Error('terminal-recovery-page-invalid');
          setRecoveryPage({ page: message.page, text: message.text });
        } else if (message.type === 'submission') {
          preserveDraft();
          if (input.settle(message) && view().kind === 'conversation') setStatus(message.message ?? (message.accepted ? '' : '本次输入未接纳；草稿已保留。'));
        } else if (message.type === 'display-patch') {
          const next = decodeBodyPage(message.patch, displayReceived);
          if (!sameBodyPageContent(display(), next.page)) bodyView?.beforeUpdate();
          const protectedRange = bodyView?.selectionRange();
          // N 的补丁不让挂载窗口向前扩展：更早的内容只由用户动作揭示，静默阅读的画面不被前插挪动
          displayReceived = next; setDisplay(bodyWindow.accept(next.page, protectedRange?.from, protectedRange?.to, true));
          if (bodyWindow.notice) setStatus(bodyWindow.notice);
        } else if (message.type === 'display-page') {
          // 本代完整基准：自带修订号、不引用旧页；校验通过后整页安装，同代后续补丁以它为基址
          const reading = message.reading;
          if (!reading || typeof reading.conversationId !== 'string' || !Number.isSafeInteger(reading.generation) ||
              (message.hasEarlier !== undefined && typeof message.hasEarlier !== 'boolean')) throw Error('terminal-display-reading');
          const base = decodeBodyPage({ ...message.page, revision: message.revision, segments: message.page.segments }, undefined);
          bodyView?.beforeUpdate();
          displayReceived = base;
          // 换代时一并换身份：页与身份同批生效，正文组件随阅读键重置（旧手势、已备页、在途读取作废，欢迎块按新页起算）
          batch(() => {
            bodyWindow.reset(); setDisplay(bodyWindow.accept(base.page));
            if (!sameReading(bodyReading(), reading)) { setBodyAnchor(undefined); setBodyReading({ conversationId: reading.conversationId, generation: reading.generation }); }
            setBodyEarlier(message.hasEarlier);
          });
        } else if (message.type === 'invalidate' && view().requestId === message.requestId) {
          releaseSecret();
          const next: TerminalView = { generation: view().generation, kind: 'conversation', title: '知行', conversationId: view().conversationId, message: '该请求已由其他入口处理或已失效。' };
          activateInformation(next); setView(next);
          input.activate(true); candidates?.sync(true);
        }
      },
    };
  } catch (error) { await dispose(); throw error; }
}
