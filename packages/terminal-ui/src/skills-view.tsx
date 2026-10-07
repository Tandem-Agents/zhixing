import { createEffect, createMemo, For, onCleanup, Show } from 'solid-js';
import {
  skillsActionForKey, skillsDisplayText, skillsPageSize, skillsVisibleItems, validateSkillsView,
  type SkillsKey, type TerminalSkillsAction, type TerminalSkillsView,
} from './skills-model.js';

export interface SkillsViewHandle { key(event: SkillsKey): boolean }
export interface SkillsViewProps {
  readonly view: TerminalSkillsView;
  readonly width: number;
  readonly height: number;
  readonly send: (action: TerminalSkillsAction) => Promise<unknown>;
  readonly onError: (message: string) => void;
  readonly onReady?: (handle: SkillsViewHandle | undefined) => void;
}

/** Pure page composition in the existing root. No key listener, renderer,
 * terminal mode, Catalog client or separate draft is created here. */
export function SkillsView(props: SkillsViewProps) {
  let disposed = false, pending = false, closing = false, requestedSize = '';
  const view = createMemo(() => {
    if (!validateSkillsView(props.view)) throw Error('terminal-skills-view');
    return props.view;
  });
  const safe = () => props.width >= 30 && props.height >= 7;
  // These fixed hints contain only ASCII, arrows, separators and Han text.
  // Count Han as two terminal cells; string.length undercounts Chinese labels.
  const hint = (...variants: string[]) => variants.find(text =>
    Array.from(text).reduce((cells, char) => cells + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0) <= props.width) ?? 'Esc';
  const items = createMemo(() => skillsVisibleItems(view(), props.height));
  const send = (action: TerminalSkillsAction) => {
    if (disposed || closing || (pending && action.kind !== 'cancel')) return;
    const ownsPending = action.kind !== 'cancel';
    if (ownsPending) pending = true; else closing = true;
    void props.send(action).catch(() => {
      if (!ownsPending) closing = false;
      if (!disposed) props.onError('技能操作暂未完成，可按 r 重试或 Esc 返回。');
    }).finally(() => {
      if (ownsPending) pending = false;
      if (!disposed) syncSize();
    });
  };
  const syncSize = () => {
    if (disposed || closing || pending || view().busy) return;
    const current = view(), pageSize = skillsPageSize(props.height), token = `${current.sessionId}:${pageSize}`;
    if (current.pageSize === pageSize || requestedSize === token) return;
    requestedSize = token;
    send({ sessionId: current.sessionId, revision: current.revision, kind: 'resize', pageSize });
  };
  const handle: SkillsViewHandle = {
    key(event) {
      if (disposed) return false;
      const action = skillsActionForKey(view(), event, safe());
      if (action) send(action);
      else if (!safe() && !event.ctrl && !event.meta && /^[pdma]$/iu.test(event.name)) props.onError('请放大窗口后操作；仍可按 Esc 返回。');
      // The root gives this page exclusive input ownership. An unknown key must
      // not fall through to global Enter, scroll, draft editing or application exit.
      return true;
    },
  };
  props.onReady?.(handle);
  createEffect(syncSize);
  onCleanup(() => { disposed = true; props.onReady?.(undefined); });
  return <box flexGrow={1} flexDirection="column" overflow="hidden" onMouseScroll={event => {
    const direction = event.scroll?.direction;
    if (direction !== 'up' && direction !== 'down') return;
    event.preventDefault(); event.stopPropagation();
    const action = skillsActionForKey(view(), { name: direction }, safe());
    if (action) send(action);
  }}>
    <text height={1} fg="#69b5a5">共 {view().total} 个技能{view().total ? ` · ${view().selectedIndex + 1}/${view().total}` : ''}{view().busy ? ' · 正在处理…' : ''}</text>
    <Show when={safe()} fallback={<text height={1} wrapMode="none" truncate>{hint('Esc 返回 · 请放大窗口以浏览技能', 'Esc 返回 · 请放大窗口', 'Esc 返回')}</text>}>
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <Show when={view().total > 0} fallback={<text>{view().state === 'loading' ? '正在读取技能…' : view().state === 'error' ? '技能暂不可用，按 r 重试。' : '还没有技能 —— 让 agent 把某摊事的做法沉淀成一个技能，即可在此管理。'}</text>}>
          <For each={items()}>{item => <box flexDirection="column" height={2} backgroundColor={item.id === view().selectedId ? '#304c45' : undefined}>
            <text height={1} wrapMode="none" truncate fg={item.id === view().selectedId ? '#69b5a5' : '#e1e7e4'}>{item.id === view().selectedId ? '› ' : '  '}{item.pinned ? '★' : ' '}{item.disabled ? '⊘' : ' '} {skillsDisplayText(item.id)}</text>
            <text height={1} wrapMode="none" truncate fg="#9aa8a1">  [{item.mode}] {item.source}{item.hitCount === null ? '' : ` · ${item.hitCount} 次`} · {skillsDisplayText(item.description)}</text>
          </box>}</For>
        </Show>
      </box>
      <Show when={view().message}><text height={2} fg={view().state === 'error' ? '#e7ba70' : '#9aa8a1'}>{skillsDisplayText(view().message ?? '')}</text></Show>
      <text height={1} wrapMode="none" truncate fg="#9aa8a1">{hint('Esc 返回 · ↑↓ 导航 · PgUp/PgDn 翻页 · r 刷新', 'Esc返回 ↑↓选择 PgUp/Dn翻页 r刷新', 'Esc返回 ↑↓选择 r刷新')}</text>
      <text height={1} wrapMode="none" truncate fg="#9aa8a1">{hint('p 置顶 · d 禁用 · m 改 mode · a 归档', 'p置顶 d禁用 m模式 a归档')}</text>
    </Show>
  </box>;
}
