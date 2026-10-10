import { createEffect, createMemo, createSignal, For, Show, ErrorBoundary } from 'solid-js';
import { createCliRenderer, TextBuffer, TextBufferView, type CliRenderer, type TextareaRenderable, type ScrollBoxRenderable, type BoxRenderable, type KeyEvent, type PasteEvent } from '@opentui/core';
import { render, extend } from '@opentui/solid';
import { normalizeLeadingSlashAlias, validateProcessView, type TerminalSelectionCancelCause, type TerminalAction, type TerminalMessage, type TerminalView, type TerminalDisplayPage, type TerminalTaskStatus, type TerminalProcessStatus } from './protocol.js';
import { ProcessView } from './process-view.js';
import { RecoveryInputBuffer, RECOVERY_INPUT_PART_BYTES } from './recovery-input.js';
import { TerminalInputSession, type TerminalAtomicRange } from './input-session.js';
import { setEditorAtomicWrap } from './editor-atomic-wrap.js';
import type { TerminalPasteSink } from './paste-stream.js';
import { TerminalCandidateSession } from './candidate-session.js';
import { TerminalTrustCandidateControls } from './trust-candidate-controls.js';
import { TerminalTextarea, editorUtf16Cursor, setEditorUtf16Cursor } from './editor-coordinates.js';
import { BodyView, TerminalScrollBox, type BodyViewHandle } from './body-view.js';
import { BODY_PAGE_BYTES, bodyWindows, decodeBodyPage, sameBodyPageContent, type BodyPageRevision, type BodyAnchor } from './body-model.js';
import { bodySelection } from './body-selection.js';
import { BodyReadingWindow } from './body-window.js';
import { SkillsView, type SkillsViewHandle } from './skills-view.js';
import { InformationBoard, informationLayout, type InformationSource } from './information-model.js';
import { interactionKey, inputRows, candidateLayout, initialChoiceIndex, nextChoiceIndex } from './surface-layout.js';
import { CandidateView, type CandidateViewHandle } from './candidate-view.js';
import { SurfaceChrome } from './surface-chrome.js';
import { ChoiceView } from './choice-view.js';
import { tone, spacing } from './theme.js';

extend({ textarea: TerminalTextarea, scrollbox: TerminalScrollBox });

const teal = tone.brand;
const frames = ['◇', '□', '◈', '▤', '◆', '▦', '◈', '▨', '◇', '▩'];
export interface TerminalRootOptions {
  readonly signal: AbortSignal;
  readonly request: (action: TerminalAction) => Promise<unknown>;
  readonly inputReady: (renderer: CliRenderer) => void;
  readonly usableFrame?: (frameId: number) => void;
  readonly exit: () => Promise<void>;
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
  const [bodyAnchor, setBodyAnchor] = createSignal<BodyAnchor>();
  // Configuration and other overlays may omit the conversation identity. They
  // do not replace the retained conversation or its reading position.
  let bodyConversationId: string | undefined;
  const [reading, setReading] = createSignal<{ below: boolean; loading: boolean; retry?: -1 | 1 }>({ below: false, loading: false },
    { equals: (a, b) => a.below === b.below && a.loading === b.loading && a.retry === b.retry });
  const isBody = () => ['conversation', 'history'].includes(view().kind);
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
  let candidateView: CandidateViewHandle | undefined;
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
      }
      value.focus();
      syncEditor();
    } });
  };
  const submit = async () => {
    const current = view();
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
  const fieldRows = () => view().field?.secret ? 1 : Math.max(1, Math.min(
    candidateOpen() ? candidateBudget().editor : Infinity,
    inputRows(editorLines(), size().height), size().height - contextHeight() - candidateHeight() - 6 - (isBody() ? 1 : 0),
  ));
  const computeInfo = () => {
    informationRevision();
    const current = view(), blocks = information.snapshot(interactionKey(current));
    const candidate = current.kind === 'conversation' ? candidateValue() : undefined;
    const left = [...blocks.left];
    const process = shownProcess();
    const operationNotice = process && current.message && current.connectionState !== 'starting' ? displayText(current.message) : '';
    if (operationNotice && !left.length) left.push(operationNotice);
    if (candidate?.error) left.push(candidate.error);
    else if (candidate?.argumentHint) left.push(candidate.argumentHint);
    else if (current.field) left.push(current.field.label + (current.field.configured ? ' · 已设置，留空保留' : ''));
    else if (current.kind === 'conversation' && editorEmpty() && !left.length) left.push('输入消息或 / 查看命令');
    const hint = (full: string, compact: string) => measureInformation(full) <= size().width - 4 ? full : compact;
    const keys = candidateOpen() && candidateError() ? 'Ctrl+R 重试 · Esc 返回'
      : candidateOpen() && candidateLoading() ? '正在读取候选 · Esc 返回'
      : candidateOpen() && !candidate?.items.length && !candidate?.ghost && !candidate?.mode ? 'Esc 返回'
      : candidate?.ghost ? hint(`Tab 补全 ${candidate.ghost.fullValue} · ↑↓ 选择 · Enter 接纳 · Esc 返回`, `Tab 补全 ${candidate.ghost.fullValue} · Esc 返回`)
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
  const displayRecoveryNotice = () => view().displayPaused || view().bodyRecovery === 'blocked'
    ? view().kind === 'history' ? '历史展示已暂停，存在缺口 · 请释放空间后重新打开历史' : '正文保留已暂停 · Ctrl+R 重试展示'
    : view().displayGap ? view().kind === 'history' ? '历史展示存在缺口 · 请重新打开历史核对' : '展示已恢复；原缺口保留，可查看历史与用量' : '';
  const footerFeedback = () => view().kind === 'history' ? { failures: [displayRecoveryNotice()].filter(Boolean), notice: displayText(view().message ?? '') } : ({ failures: [
    displayRecoveryNotice(),
    taskStatus().noticeGap ?? '',
    taskStatus().summary?.conversationId === view().conversationId && taskStatus().summary?.state === 'error' ? taskStatus().summary!.text : '',
    view().connectionState === 'unavailable' ? displayText(view().message ?? '') : '',
  ].filter(Boolean), details: !!taskStatus().summary && taskStatus().summary?.conversationId === view().conversationId && taskStatus().summary?.state !== 'error'
    ? [taskStatus().summary!.text] : [], notice: displayText(view().message || taskStatus().summary?.text || ''), candidateCompressed: candidateHeight() > 0 });
  const footerProcess = () => shownProcess() ?? { revision: 0, phase: view().busy ? view().connectionState === 'starting' ? '正在启动知行…' : '正在处理…' : '',
    activity: view().busy ? 'running' as const : 'complete' as const, tools: [], children: [], usage: {} };
  const ChoiceList = () => <box flexDirection="column" flexShrink={0} marginTop={view().message && choices().length ? 1 : 0}>
    <For each={choices()}>{(choice, index) => {
      const startsSection = () => !!choice.section && (index() === 0 || choices()[index() - 1]?.section !== choice.section);
      return <box id={`choice-${index() + choiceStart()}`} flexDirection="column" flexShrink={0}
        paddingTop={view().kind === 'configuration' && choice.presentation === 'button' && index() > 0 && choices()[index() - 1]?.presentation !== 'button' && !startsSection() ? 1 : 0}>
      <Show when={startsSection()}>
        <text marginTop={index() ? 1 : 0} marginBottom={1} fg={tone.brand}>{`▎ ${displayText(choice.section ?? '')}`}</text>
        <Show when={choice.sectionDescription}><text marginLeft={2} marginBottom={1} fg={tone.dim}>{displayText(choice.sectionDescription ?? '')}</text></Show>
      </Show>
      <ChoiceView choice={choice} selected={selected() === index() + choiceStart()} width={Math.max(1, bodySize().width - 1)} configuration={view().kind === 'configuration'} measure={measureInformation} />
    </box>;
    }}</For>
  </box>;
  const App = () => <box width="100%" height="100%" flexDirection="column" onMouseDown={event => {
    if (event.button === 2) { event.preventDefault(); event.stopPropagation(); void pasteClipboard(); }
  }}>
    <Show when={!isBody()}><SurfaceChrome view={view()} width={size().width} height={size().height} /></Show>
    <box ref={value => { bodyBox = value; }} marginX={isBody() ? 0 : spacing.content} flexGrow={1} minHeight={1}
      onSizeChange={function(this: BoxRenderable) {
        bodyView?.beforeUpdate(); setBodySize({ width: this.width, height: this.height });
      }}>
      <Show when={view().kind === 'skills' && view().skills} fallback={<Show when={isBody()} fallback={<scrollbox ref={value => { historyBox = value; }} flexGrow={1}>
        <Show when={view().message}><text selectable>{displayText(view().message ?? '')}</text></Show>
        <Show when={view().kind === 'recovery'}><text selectable fg="#111111" bg="#ffffff">{displayText(recoveryPage().text)}</text></Show>
        <Show when={view().kind !== 'configuration' && view().choices?.[selected()]?.detail}><text fg={tone.dim}>{displayText(view().choices?.[selected()]?.detail ?? '')}</text></Show>
        <Show when={view().kind === 'configuration'}><ChoiceList /></Show>
      </scrollbox>}>
        <BodyView page={display()} renderer={renderer} width={bodySize().width} height={bodySize().height}
          header={<SurfaceChrome view={view()} width={Math.max(1, bodySize().width - spacing.scrollbar)} height={size().height} />}
          hasEarlier={view().historyHasMore}
          anchor={bodyAnchor()} onAnchor={setBodyAnchor} onReady={bodyReady}
          requestPage={(start, follow) => options.request({ kind: 'display-page', start, follow })}
          requestPrevious={() => options.request({ kind: 'history-previous' })}
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
    <box flexDirection="column" flexShrink={0}>
    <Show when={isBody()}><text height={1} marginX={spacing.content} fg={reading().retry ? tone.warn : tone.dim} selectable={false} wrapMode="none" truncate
      onMouseDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
        if (view().bodyRecovery === 'blocked') { if (view().kind === 'history') setStatus(displayRecoveryNotice()); else void action({ kind: 'display-retry' }); return; }
        const retry = reading().retry; if (!retry && (!reading().below || reading().loading)) return;
        void (retry ? bodyView?.page(retry) : bodyView?.bottom())?.catch(setStatus); }}>
      {view().bodyRecovery === 'blocked' ? view().kind === 'history' ? '部分历史待恢复 · 请重新打开历史' : '部分正文待恢复 · 点击或 Ctrl+R 重试' : reading().retry ? '读取未完成 · 点击或原方向翻页重试' :
        view().bodyRecovery === 'retrying' || reading().loading ? '正在读取…' : reading().below ? process.platform === 'darwin' ? '↓ 下方还有内容 · 点击回到最新' : '↓ 下方还有内容 · Ctrl+End 回到最新' : ''}
    </text></Show>
    <box flexDirection="column" flexShrink={0} height={candidateHeight() ? candidateBudget().process : 'auto'} overflow="hidden" justifyContent="flex-end" onSizeChange={function(this: BoxRenderable) { setContextHeight(this.height); }}>
      <Show when={isBody()} fallback={<>
        <Show when={view().kind === 'recovery'}>
          <text marginX={spacing.content} height={1} wrapMode="none" truncate fg={tone.dim}>{'保密页 ' + (recoveryPage().page + 1) + '/' + (view().recovery?.pages ?? 1) + ' · PgUp/PgDn 翻页'}</text>
          <Show when={view().recovery?.input}><text marginX={spacing.content} height={1} fg={tone.dim}>{'恢复包输入：' + recoveryLength() + ' 字节'}</text></Show>
        </Show>
      </>}>
        <ProcessView view={footerProcess()} feedback={footerFeedback()} indicator={footerProcess().activity === 'running' ? animation() : '◆'} width={size().width}
          height={candidateHeight() ? candidateBudget().process : Math.max(1, Math.min(6, size().height - 6))} />
      </Show>
      <Show when={view().kind !== 'configuration'}><box marginX={spacing.content} flexShrink={0}><ChoiceList /></box></Show>
      <Show when={!safeAction()}><text fg={tone.warn}>窗口较小：可取消；放大后继续确认。</text></Show>
    </box>
    <Show when={view().kind === 'conversation' || view().field}>
      <box border borderStyle="rounded" borderColor={tone.border} height={fieldRows() + 2} flexShrink={0} marginX={spacing.frame} paddingX={spacing.frameInner} flexDirection="row">
        <text width={2} selectable={false} fg={teal}>❯ </text>
        <Show when={!view().field?.secret} fallback={<text height={1}>{'•'.repeat(Math.min(secretLength(), Math.max(1, size().width - 6)))}</text>}>
          <Show when={view().kind === 'conversation' ? 'conversation' : `${view().kind}:${view().editId ?? view().requestId}:${view().field?.id}`} keyed>
            {(owner: string) => <textarea selectionFg={tone.selectionFg} selectionBg={tone.selectionBg} ref={attach} initialValue={owner === 'conversation' ? draft.text : view().field?.value ?? ''} width={Math.max(1, size().width - 6)} height={fieldRows()} wrapMode="char" onSizeChange={syncEditor} onContentChange={() => { atomicLayoutDirty = true; if (view().field) fieldEditVersion++; preserveDraft(); }} onCursorChange={preserveCursor} />}
          </Show>
        </Show>
      </box>
    </Show>
    <Show when={candidateHeight() > 0}>
      <CandidateView value={candidateValue()} loading={candidateLoading()} error={candidateError()} selected={candidateSelected()} danger={candidateDanger()}
        width={size().width} height={candidateHeight()} renderer={renderer} measure={measureInformation} onReady={value => { candidateView = value; }} />
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
  const externalPaste = (): TerminalPasteSink | undefined => {
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
  const renderer = await createRenderer({ exitOnCtrlC: false, consoleMode: 'disabled', useMouse: true, useKittyKeyboard: null, useThread: false, screenMode: 'alternate-screen', stdinParserMaxBufferBytes: 64 * 1024, externalRecoveryOwner: true, externalPaste } as Parameters<typeof createCliRenderer>[0]);
  const informationBuffer = TextBuffer.create(renderer.widthMethod);
  const informationView = TextBufferView.create(informationBuffer);
  informationView.setWrapMode('none');
  const measureInformation = (text: string) => {
    informationBuffer.setText(text);
    return informationView.logicalLineInfo.lineWidthCols[0] ?? 0;
  };
  const info = createMemo(computeInfo);
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposed = true; input.activate(false); releaseSecret(); releaseRecovery(); clearInterval(animationTimer);
    information.dispose();
    candidates?.sync(false);
    renderer.off('resize', resize);
    renderer.off('frame', refreshCopy);
    renderer.keyInput.off('keypress', keypress); renderer.keyInput.off('paste', paste);
    disposing = (async () => {
      try { await bodyView?.close(); await Promise.all(bodyClosures); }
      finally { informationView.destroy(); informationBuffer.destroy(); renderer.destroy(); }
    })();
    return disposing;
  };
  const resize = () => { bodyView?.beforeUpdate(); setSize({ width: renderer.terminalWidth, height: renderer.terminalHeight }); };
  createEffect(() => {
    const index = selected(), current = view(), dimensions = size();
    if (current.kind !== 'configuration') return;
    // Native layout settles after the reactive page. Keep keyboard selection in
    // the scrollable configuration body without moving the input or footer.
    queueMicrotask(() => { if (!disposed && view() === current && size() === dimensions) historyBox?.scrollChildIntoView(`choice-${index}`); });
  });
  const keypress = (event: KeyEvent) => {
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
      if (view().kind === 'confirmation' || view().kind === 'selection') { void cancelPage('ctrl-c'); return; }
      if (view().kind === 'unavailable' || view().kind === 'history' || (view().kind === 'conversation' && view().connected === false)) { void options.exit(); return; }
      if (view().editId) { releaseSecret(); void action({ kind: 'configuration-action', editId: view().editId!, action: 'cancel' }); ctrlC = 0; return; }
      if (view().kind !== 'conversation') { void cancelPage(); ctrlC = 0; return; }
      const now = performance.now();
      if (ctrlC > 0 && now - ctrlC < 750) { void options.exit(); return; }
      ctrlC = now; void action({ kind: 'interrupt' }); return;
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
          if (operation === 'delete' && !candidates?.confirmDelete(view().generation)) { setStatus('再次按 Ctrl+D 删除当前候选；其他按键取消准备。'); return; }
          void candidates?.manage(operation).catch(reportStatus());
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
      if (view().kind === 'conversation' && draft.text) { input.clear(draft.version); return; }
      if (view().kind === 'conversation' && view().busy) void action({ kind: 'abort' }); else void cancelPage(); return;
    }
    if (view().kind === 'conversation' && candidateValue()?.ghost && event.name === 'tab' && !event.ctrl && !event.shift && !event.meta) {
      consume(); void candidates?.accept(true).catch(reportStatus()); return;
    }
    if (candidateOpen() && candidateHeight() && event.ctrl && event.name === 'r' && candidateValue()?.mode !== 'picker') { consume(); candidates?.refresh(); return; }
    if (candidateOpen() && candidateHeight() && !event.ctrl && !event.shift && !event.meta) {
      if (event.name === 'pageup' || event.name === 'pagedown') { consume(); candidateView?.page(event.name === 'pageup' ? -1 : 1); return; }
      if (event.name === 'up' || event.name === 'down') { consume(); candidates?.move(event.name === 'up' ? -1 : 1); return; }
      if (event.name === 'tab' || event.name === 'return') {
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
          const changedConversation = message.view.conversationId !== undefined && bodyConversationId !== message.view.conversationId;
          const selectedId = previous.choices?.[selected()]?.id;
          const refreshCandidates = view().kind === 'conversation' && message.view.kind === 'conversation';
          if (message.view.recovery?.requestId !== view().recovery?.requestId) releaseRecovery();
          if (message.view.recovery?.input && !recoveryInput) recoveryInput = new RecoveryInputBuffer();
          candidates?.resetDelete(); trustControls.reset();
          preserveDraft(); bodyView?.beforeUpdate();
          if (changedConversation) {
            bodyView?.resetReading();
            bodyConversationId = message.view.conversationId;
            bodyWindow.reset(); setBodyAnchor(undefined);
          }
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
          displayReceived = next; setDisplay(bodyWindow.accept(next.page, protectedRange?.from, protectedRange?.to));
          if (bodyWindow.notice) setStatus(bodyWindow.notice);
        } else if (message.type === 'display-page') {
          if (message.page.segments.length > 4 || Buffer.byteLength(JSON.stringify(message.page)) > BODY_PAGE_BYTES) throw Error('terminal-display-wire-size');
          bodyWindows(message.page); // Validate complete source/metadata/page before installing it.
          bodyView?.beforeUpdate();
          displayReceived = undefined;
          bodyWindow.reset(); setDisplay(bodyWindow.accept(message.page));
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
