import { createSignal, For, Show, ErrorBoundary } from 'solid-js';
import { createCliRenderer, type CliRenderer, type TextareaRenderable, type ScrollBoxRenderable, type BoxRenderable, type KeyEvent, type PasteEvent } from '@opentui/core';
import { render, extend } from '@opentui/solid';
import type { TerminalAction, TerminalMessage, TerminalView, TerminalDisplayPage } from './protocol.js';
import { TerminalInputSession } from './input-session.js';
import type { TerminalPasteSink } from './paste-stream.js';
import { TerminalCandidateSession } from './candidate-session.js';
import { TerminalTextarea, editorUtf16Cursor, setEditorUtf16Cursor } from './editor-coordinates.js';
import { BodyView, type BodyViewHandle } from './body-view.js';
import { BODY_PAGE_BYTES, bodyWindows, type BodyAnchor } from './body-model.js';
import { bodySelection } from './body-selection.js';
import { SkillsView, type SkillsViewHandle } from './skills-view.js';

extend({ textarea: TerminalTextarea });

const teal = '#69b5a5';
const frames = ['◇', '□', '◈', '▤', '◆', '▦', '◈', '▨', '◇', '▩'];
export interface TerminalRootOptions {
  readonly signal: AbortSignal;
  readonly request: (action: TerminalAction) => Promise<unknown>;
  readonly inputReady: (renderer: CliRenderer) => void;
  readonly exit: () => Promise<void>;
}

export async function createTerminalRoot(options: TerminalRootOptions) {
  options.signal.throwIfAborted();
  const [view, setView] = createSignal<TerminalView>({ generation: 0, kind: 'conversation', title: '知行', message: '正在连接…', busy: true });
  const [status, setStatus] = createSignal('');
  const [copyAvailable, setCopyAvailable] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  const [size, setSize] = createSignal({ width: 80, height: 24 });
  const [animation, setAnimation] = createSignal('◆');
  const [secretLength, setSecretLength] = createSignal(0);
  const [display, setDisplay] = createSignal<TerminalDisplayPage>({ first: 0, last: 0, start: 0, follow: true, segments: [] });
  let historyBox: ScrollBoxRenderable | undefined;
  let bodyView: BodyViewHandle | undefined;
  let bodyBox: BoxRenderable | undefined;
  const bodyClosures = new Set<Promise<void>>();
  const [bodySize, setBodySize] = createSignal({ width: 78, height: 10 });
  const [bodyAnchor, setBodyAnchor] = createSignal<BodyAnchor>();
  const isBody = () => ['conversation', 'history'].includes(view().kind);
  const bodyReady = (value: BodyViewHandle | undefined) => {
    const previous = bodyView; bodyView = value;
    if (!value && previous) {
      const work = previous.close(); bodyClosures.add(work);
      void work.then(() => bodyClosures.delete(work), () => {});
    }
  };
  let secret = '', editor: TextareaRenderable | undefined, disposed = false, ctrlC = 0;
  let skillsView: SkillsViewHandle | undefined;
  let operationCount = 0;
  let changingDraft = false;
  let editorHistoryBytes = 0, editorHistoryEntries = 0;
  const [candidateRevision, setCandidateRevision] = createSignal(0);
  let candidates: TerminalCandidateSession | undefined;
  const input = new TerminalInputSession(options.request, () => {
    if (view().kind === 'conversation' && editor && !editor.isDestroyed) {
      changingDraft = true;
      try {
        if (editor.plainText !== draft.text) { editor.setText(draft.text); editorHistoryBytes = 0; editorHistoryEntries = 0; }
        setEditorUtf16Cursor(editor, draft.text, draft.cursor, renderer.widthMethod);
      } finally { changingDraft = false; }
    }
    candidates?.sync(view().kind === 'conversation');
  });
  const draft = input.draft;
  candidates = new TerminalCandidateSession(input, options.request, () => setCandidateRevision(value => value + 1));
  const candidateItems = () => { candidateRevision(); return candidates?.value?.items ?? []; };
  const candidateStart = () => { candidateRevision(); return Math.max(0, (candidates?.selected ?? 0) - 4); };
  const editorValue = () => editor && !editor.isDestroyed ? editor.plainText : '';
  const preserveDraft = () => {
    if (!changingDraft && view().kind === 'conversation' && editor && !editor.isDestroyed) {
      const text = editor.plainText, cursor = editorUtf16Cursor(editor);
      try {
        if (text !== draft.text) {
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
        void input.compact().catch(error => { if (!disposed) setStatus(error instanceof Error ? error.message : '输入保存未完成，草稿保留。'); });
      } catch (error) {
        changingDraft = true;
        try { editor.setText(draft.text); setEditorUtf16Cursor(editor, draft.text, draft.cursor, renderer.widthMethod); editorHistoryBytes = 0; editorHistoryEntries = 0; }
        finally { changingDraft = false; }
        setStatus(error instanceof Error ? error.message : '输入暂不可用，草稿保留。');
      }
    }
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
    try { return await options.request(value); }
    catch (error) { if (!disposed) setStatus(error instanceof Error ? error.message : '操作失败'); }
    finally { operationCount--; }
  };
  // Keep the current action visible while the independently scrollable body
  // contains a long connection target, consequence, or selected-item detail.
  const pageRows = () => Math.max(1, Math.min(8, size().height - (view().field ? 17 : 13)));
  const choiceStart = () => Math.max(0, selected() - pageRows() + 1);
  const choices = () => (view().choices ?? []).slice(choiceStart(), choiceStart() + pageRows());
  const safeAction = () => size().width >= 40 && size().height >= 12;
  const displayText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    char => String.fromCharCode(char.charCodeAt(0) === 127 ? 0x2421 : 0x2400 + char.charCodeAt(0)));
  const pageHistory = async (direction: -1 | 1) => {
    if (isBody()) await bodyView?.page(direction);
  };
  const attach = (value: TextareaRenderable) => {
    editor = value;
    queueMicrotask(() => { if (!value.isDestroyed) {
      if (view().kind === 'conversation') {
        changingDraft = true; try { setEditorUtf16Cursor(value, draft.text, draft.cursor, renderer.widthMethod); } finally { changingDraft = false; }
      }
      value.focus();
    } });
  };
  const submit = async () => {
    const current = view();
    if (current.field && current.requestId) {
      if (!safeAction()) { setStatus('请放大窗口后提交；仍可按 Esc 取消。'); return; }
      const value = editorValue();
      if (Buffer.byteLength(value) > 8192) { setStatus('说明过长，请缩短后再提交。'); return; }
      const itemId = current.choices?.[selected()]?.id ?? 'submit';
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
      const text = draft.text;
      if (input.completeWindow && !text.trim()) return;
      if (input.completeWindow && text.startsWith('/')) {
        const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
        const version = draft.version;
        if (match) {
          const route = await action({ kind: 'command-route', name: match[1]! }) as { route?: 'input' | 'local' } | undefined;
          if (!route || disposed || draft.version !== version || view().kind !== 'conversation') return;
          if (route?.route === 'input') {
            try { setStatus('正在保存并提交输入…'); await input.submit(); }
            catch (error) { if (!disposed) setStatus(error instanceof Error ? error.message : '提交未完成；草稿保留。'); }
            return;
          }
          const result = await action({ kind: 'command', name: match[1]!, argument: match[2] ?? '' }) as { accepted?: boolean } | undefined;
          if (result?.accepted && draft.version === version) {
            input.clear(version);
            if (view().kind === 'conversation') { changingDraft = true; try { editor?.setText(''); } finally { changingDraft = false; } }
            candidates?.dismiss();
          }
        }
      } else {
        try { setStatus('正在保存并提交输入…'); await input.submit(); }
        catch (error) { if (!disposed) setStatus(error instanceof Error ? error.message : '提交未完成；草稿保留。'); }
      }
    }
  };
  const cancelPage = async () => {
    const current = view(); releaseSecret();
    if (current.kind === 'history') await action({ kind: 'history-close' });
    else if (current.editId) await action({ kind: 'configuration-action', editId: current.editId, action: 'back' });
    else if (current.kind === 'confirmation') await action({ kind: 'confirmation', requestId: current.requestId!, action: 'reject' });
    else if (current.kind === 'selection') await action({ kind: 'selection', requestId: current.requestId!, cancelled: true });
  };
  const refreshCopy = () => setCopyAvailable(!disposed && isBody() && !!bodySelection(renderer, bodyBox));
  const copyBody = () => {
    if (disposed || !isBody()) return;
    const selection = bodySelection(renderer, bodyBox);
    if (!selection) { setStatus('请重新选择要复制的正文。'); return; }
    const text = selection.getSelectedText();
    if (!text) return;
    if (Buffer.byteLength(text) > BODY_PAGE_BYTES) { setStatus('选区过大，请分段复制。'); return; }
    try {
      setStatus(renderer.copyToClipboardOSC52(text) ? '已发送复制请求。' : '当前终端无法执行复制请求，选区已保留。');
    } catch { setStatus('复制请求未完成，选区已保留。'); }
  };
  const App = () => <box width="100%" height="100%" flexDirection="column" paddingX={1}>
    <box height={4} flexDirection="column">
      <text fg={teal}> ╲</text>
      <text fg={teal}> ▄▄▄    {displayText(view().title)}</text>
      <text fg={teal}>▌●●▐    {view().connected === false ? '离线 · 本机配置与历史仍可用' : '知行 · 伴你行动'}</text>
      <text fg={teal}> ▀▀</text>
    </box>
    <box ref={value => { bodyBox = value; }} flexGrow={1} minHeight={1} backgroundColor="#202626"
      onSizeChange={function(this: BoxRenderable) {
        bodyView?.beforeUpdate(); setBodySize({ width: this.width, height: this.height });
      }}>
      <Show when={view().kind === 'skills' && view().skills} fallback={<Show when={isBody()} fallback={<scrollbox ref={value => { historyBox = value; }} flexGrow={1}>
        <text selectable>{displayText(view().message ?? '')}</text>
        <Show when={view().choices?.[selected()]?.detail}><text fg="#9aa8a1">{displayText(view().choices?.[selected()]?.detail ?? '')}</text></Show>
      </scrollbox>}>
        <BodyView page={display()} renderer={renderer} width={bodySize().width} height={bodySize().height}
          anchor={bodyAnchor()} onAnchor={setBodyAnchor} onReady={bodyReady}
          requestPage={(start, follow) => action({ kind: 'display-page', start, follow })}
          requestPrevious={() => action({ kind: 'history-previous' })}
          onError={error => { if (!disposed) setStatus(error instanceof Error ? error.message : '正文暂不可用，已保留内容仍可回看。'); }} />
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
    <Show when={isBody() && view().message}><text height={2} selectable>{displayText(view().message ?? '')}</text></Show>
    <Show when={['conversation', 'history'].includes(view().kind) && view().displayGap}>
      <text fg="#e7ba70">正文保留已暂停，后续内容存在缺口。草稿保留；可处理确认、中止工作或退出后重试。</text>
    </Show>
    <box flexDirection="column" flexShrink={0}>
      <For each={choices()}>{(choice, index) => <box height={1} backgroundColor={selected() === index() + choiceStart() ? '#304c45' : undefined}>
        <text fg={choice.disabled ? '#808b87' : selected() === index() + choiceStart() ? teal : '#d5ddd9'}>{selected() === index() + choiceStart() ? '▌ ' : '  '}{displayText(choice.label)}</text>
      </box>}</For>
    </box>
    <Show when={!safeAction()}><text fg="#e7ba70">窗口较小：可取消；放大后继续确认。</text></Show>
    <Show when={view().kind === 'conversation' && candidateItems().length > 0 && size().height >= 18}>
      <box height={Math.min(6, candidateItems().length + 1)} flexDirection="column" backgroundColor="#263b34">
        <For each={candidateItems().slice(candidateStart(), candidateStart() + 5)}>{(item, index) =>
          <text height={1} fg={index() + candidateStart() === candidates?.selected ? teal : '#b8c7bf'}>
            {index() + candidateStart() === candidates?.selected ? '▌ ' : '  '}{displayText(item.label)}  {displayText(item.detail ?? '')}
          </text>}</For>
        <text height={1} fg="#9aa8a1">↑↓ 选择 · Tab/Enter 接纳 · Esc 收起</text>
      </box>
    </Show>
    <Show when={view().kind === 'conversation' || view().field}>
      <box border borderStyle="rounded" borderColor={teal} height={5} paddingX={1}>
        <Show when={!view().field?.secret} fallback={<box flexDirection="column"><text>{view().field?.label} {'•'.repeat(Math.min(secretLength(), Math.max(1, size().width - 16)))}</text><Show when={view().field?.configured}><text fg="#9aa8a1">已设置，留空保留。</text></Show></box>}>
          <Show when={view().kind === 'conversation' ? 'conversation' : view().editId ?? view().requestId} keyed>
            {() => <textarea ref={attach} initialValue={view().field ? view().field?.value ?? '' : draft.text} flexGrow={1} height={3} placeholder={view().field?.label ?? '输入消息，或 / 查看命令'} onContentChange={preserveDraft} onCursorChange={preserveCursor} />}
          </Show>
        </Show>
      </box>
    </Show>
    <box height={1} flexDirection="row">
      <text flexGrow={1} height={1} fg={teal}>{view().busy ? animation() : '◆'} {status() || (view().busy ? '正在处理…' : view().kind === 'skills' ? 'Esc 返回 · ↑↓ 选择 · p/d/m/a 管理 · r 刷新' : view().kind === 'conversation' ? 'Enter 确认 · Esc 返回 · Ctrl+C 中止/退出' : 'Enter 确认 · Esc 返回 · PgUp/PgDn 阅读')}</text>
      <Show when={copyAvailable()}><text width={12} selectable={false} fg={teal} bg="#304c45"
        onMouseDown={event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation(); copyBody();
        }}> 复制选区 </text></Show>
    </box>
  </box>;
  const externalPaste = (): TerminalPasteSink | undefined => {
    if (disposed) return;
    const current = view();
    if (current.kind === 'conversation') {
      preserveDraft();
      try {
        const stream = input.beginPaste();
        void stream.done.catch(error => { if (!disposed) setStatus(error instanceof Error ? error.message : '粘贴未完成；草稿保留。'); });
        return stream;
      } catch (error) { setStatus(error instanceof Error ? error.message : '粘贴未完成；草稿保留。'); return; }
    }
    if (!current.field) return;
    // Dedicated fields never enter ordinary draft storage, including secrets.
    // Replay this small complete paste through the original focused handler.
    let buffer = new Uint8Array(8192), used = 0, failed = false;
    const abort = () => { buffer.fill(0); buffer = new Uint8Array(0); used = 0; failed = true; };
    return {
      write(bytes) {
        if (failed) return;
        if (used + bytes.length > buffer.length) { abort(); setStatus('字段输入过长，请检查内容。'); return; }
        buffer.set(bytes, used); used += bytes.length;
      },
      end() {
        try { if (!failed && !disposed && view().generation === current.generation) renderer.keyInput.processPaste(buffer.subarray(0, used)); }
        finally { abort(); }
      },
      abort,
    };
  };
  const renderer = await createCliRenderer({ exitOnCtrlC: false, consoleMode: 'disabled', useMouse: true, useKittyKeyboard: null, useThread: false, screenMode: 'alternate-screen', stdinParserMaxBufferBytes: 64 * 1024, externalRecoveryOwner: true, externalPaste } as Parameters<typeof createCliRenderer>[0]);
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposed = true; input.activate(false); releaseSecret(); clearInterval(animationTimer);
    candidates?.sync(false);
    renderer.off('resize', resize);
    renderer.off('frame', refreshCopy);
    renderer.keyInput.off('keypress', keypress); renderer.keyInput.off('paste', paste);
    disposing = (async () => {
      try { await bodyView?.close(); await Promise.all(bodyClosures); }
      finally { renderer.destroy(); }
    })();
    return disposing;
  };
  const resize = () => { bodyView?.beforeUpdate(); setSize({ width: renderer.terminalWidth, height: renderer.terminalHeight }); };
  const keypress = (event: KeyEvent) => {
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if (view().kind === 'skills') { consume(); skillsView?.key(event); return; }
    if (event.ctrl && event.name === 'c') {
      consume();
      if (view().kind === 'confirmation') { void action({ kind: 'confirmation', requestId: view().requestId!, action: 'cancelled' }); return; }
      if (view().kind === 'unavailable' || view().kind === 'history' || (view().kind === 'conversation' && view().connected === false)) { void options.exit(); return; }
      if (view().editId) { releaseSecret(); void action({ kind: 'configuration-action', editId: view().editId!, action: 'cancel' }); ctrlC = 0; return; }
      if (view().kind !== 'conversation') { void cancelPage(); ctrlC = 0; return; }
      const now = performance.now();
      if (ctrlC > 0 && now - ctrlC < 750) { void options.exit(); return; }
      ctrlC = now; void action({ kind: 'interrupt' }); return;
    }
    if (event.name === 'escape') {
      consume();
      if (candidateItems().length) { candidates?.dismiss(); return; }
      if (view().kind === 'conversation' && view().busy) void action({ kind: 'abort' }); else void cancelPage(); return;
    }
    if (view().kind === 'conversation' && candidateItems().length && size().height >= 18 && !event.ctrl && !event.shift && !event.meta) {
      if (event.name === 'up' || event.name === 'down') { consume(); candidates?.move(event.name === 'up' ? -1 : 1); return; }
      if (event.name === 'tab' || event.name === 'return') {
        consume(); void candidates?.accept().then(execute => { if (execute) return submit(); }).catch(error => setStatus(error instanceof Error ? error.message : '补全未完成，草稿保留。')); return;
      }
    }
    if (view().kind === 'conversation' && !event.ctrl && !event.shift && !event.meta && !editor?.hasSelection()) {
      preserveDraft();
      if (['backspace', 'delete', 'left', 'right'].includes(event.name) && input.atomic(event.name as 'backspace' | 'delete' | 'left' | 'right')) { consume(); return; }
      if (((event.name === 'left' || event.name === 'backspace') && draft.cursor === 0 && input.beforeWindow) ||
          ((event.name === 'right' || event.name === 'delete') && draft.cursor === draft.text.length && input.afterWindow)) {
        consume(); void input.navigate(event.name as 'left' | 'right' | 'backspace' | 'delete').catch(error => setStatus(error instanceof Error ? error.message : '输入窗口暂不可用。')); return;
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
        }) : input.history(event.name === 'up' ? -1 : 1)).catch(error => setStatus(error instanceof Error ? error.message : '历史输入暂不可用。')); return;
      }
    }
    if (event.name === 'pageup' || event.name === 'pagedown') {
      consume();
      const direction = event.name === 'pageup' ? -1 : 1;
      if (['conversation', 'history'].includes(view().kind)) void pageHistory(direction);
      else if (historyBox) historyBox.scrollBy(direction * Math.max(1, historyBox.viewport.height - 2));
      return;
    }
    if (['conversation', 'history'].includes(view().kind) && event.ctrl && event.name === 'end') {
      consume(); void bodyView?.bottom(); return;
    }
    if (event.name === 'return' && !event.shift) { consume(); void submit(); return; }
    if (event.ctrl && event.name === 's' && view().editId) {
      consume();
      if (!safeAction()) setStatus('请放大窗口后保存；仍可按 Esc 取消。');
      else void action({ kind: 'configuration-action', editId: view().editId!, action: 'complete' });
      return;
    }
    if (view().field?.secret) {
      consume();
      if (event.name === 'backspace') secret = Array.from(secret).slice(0, -1).join('');
      else if (!event.ctrl && !event.meta && event.sequence && !event.sequence.startsWith('\x1b')) {
        if (Buffer.byteLength(secret) + Buffer.byteLength(event.sequence) <= 8192) secret += event.sequence;
        else setStatus('字段输入过长，请检查内容。');
      }
      setSecretLength(Array.from(secret).length); return;
    }
    if (view().choices?.length && (event.name === 'up' || event.name === 'down')) {
      consume(); setSelected(current => Math.max(0, Math.min(view().choices!.length - 1, current + (event.name === 'up' ? -1 : 1))));
    }
  };
  const paste = (event: PasteEvent) => {
    if (!view().field?.secret && view().kind !== 'conversation') return;
    event.preventDefault(); event.stopPropagation();
    if (view().kind === 'conversation') {
      preserveDraft();
      void input.paste(event.bytes).catch(error => { if (!disposed) setStatus(error instanceof Error ? error.message : '粘贴未完成；草稿保留。'); }); return;
    }
    if (Buffer.byteLength(secret) + event.bytes.byteLength > 8192) { setStatus('字段输入过长，请检查内容。'); return; }
    secret += new TextDecoder().decode(event.bytes); setSecretLength(Array.from(secret).length);
  };
  const animationTimer = setInterval(() => { if (view().busy) setAnimation(frames[Math.floor(performance.now() / 300) % frames.length]!); }, 300);
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
      firstFrameId, dispose,
      receive(message: Extract<TerminalMessage, { type: 'view' | 'chunk' | 'invalidate' | 'display-page' | 'submission' }>) {
        if (disposed) return;
        if (message.type === 'view') {
          if (message.view.generation < view().generation) return;
          preserveDraft(); releaseSecret(); bodyView?.beforeUpdate(); setSelected(0); setStatus(''); setView(message.view);
          input.activate(message.view.kind === 'conversation');
          candidates?.sync(message.view.kind === 'conversation');
          if (!isBody()) renderer.once('frame', () => {
            if (!disposed && historyBox && !historyBox.isDestroyed) historyBox.scrollTo(0);
          });
        } else if (message.type === 'submission') {
          preserveDraft();
          if (input.settle(message)) setStatus(message.accepted ? '输入已接纳。' : '本次输入未接纳；草稿已保留。');
        } else if (message.type === 'display-page') {
          bodyWindows(message.page); // Validate complete source/metadata/page before installing it.
          bodyView?.beforeUpdate();
          setDisplay(message.page);
        } else if (message.type === 'invalidate' && view().requestId === message.requestId) {
          releaseSecret(); setView({ generation: view().generation, kind: 'conversation', title: '知行', message: '该请求已由其他入口处理或已失效。' });
        }
      },
    };
  } catch (error) { await dispose(); throw error; }
}
