import type { TerminalView, TerminalSelectionCancelCause } from '@zhixing/terminal-ui/protocol';
import type { SelectionRequest, SelectionResult } from '../tui/selection/types.js';

export interface TerminalSelectionResponse { readonly itemId: string; readonly input?: string; readonly cancelCause?: TerminalSelectionCancelCause }
export type TerminalSelectionPage = Omit<TerminalView, 'generation' | 'requestId'>;
export type TerminalSelectionPort = (page: TerminalSelectionPage) => Promise<TerminalSelectionResponse | undefined>;

export function isSelectionCancelCause(value: unknown): value is TerminalSelectionCancelCause {
  return value === 'escape' || value === 'ctrl-c' || value === 'ctrl-d' || value === 'aborted';
}

/** N authorizes only actions declared by this bounded page; U owns no domain decision. */
export function terminalSelectionActions(page: TerminalSelectionPage): ReadonlySet<string> {
  const choices = page.choices ?? [];
  if (choices.length > 36 || (page.selectionLayer !== undefined && !['select', 'input', 'confirm', 'details'].includes(page.selectionLayer))) throw Error('terminal-selection-page');
  const ids = new Set<string>(), keys = new Set<string>(), allowed = new Set<string>();
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id);
  for (const choice of choices) {
    if (!validId(choice.id) || ids.has(choice.id)) throw Error('terminal-selection-choice');
    ids.add(choice.id);
    if (choice.hotkey !== undefined) {
      if (typeof choice.hotkey !== 'string' || !/^[!-~]$/u.test(choice.hotkey) || keys.has(choice.hotkey.toLowerCase())) throw Error('terminal-selection-hotkey');
      keys.add(choice.hotkey.toLowerCase());
    }
    if (!choice.disabled) allowed.add(choice.id);
  }
  for (const [id, enabled] of [[page.detailsActionId, true], ...choices.map(choice => [choice.detailsActionId, !choice.disabled] as const)] as const) {
    if (id === undefined) continue;
    if (!validId(id) || ids.has(id)) throw Error('terminal-selection-details');
    if (enabled) allowed.add(id);
  }
  if (page.initialItemId !== undefined && (!validId(page.initialItemId) || !choices.some(choice => choice.id === page.initialItemId && !choice.disabled))) throw Error('terminal-selection-initial');
  return allowed;
}

function cancellation(response: TerminalSelectionResponse | undefined): Extract<SelectionResult, { kind: 'cancelled' }> | undefined {
  if (response?.cancelCause) return { kind: 'cancelled', cause: response.cancelCause };
  return undefined;
}

/** Undefined remains the noninteractive port's safe dismissal. Inner Escape
 * returns to options; Ctrl+C/D or an invalidated request ends the interaction. */
export async function chooseTerminalSelection<T extends string>(request: SelectionRequest<T>, choose: TerminalSelectionPort): Promise<SelectionResult<T> | undefined> {
  const allText = [request.title, ...(request.body ?? []), ...(request.details?.body ?? []), ...request.options.flatMap(option =>
    [option.label, option.description ?? '', ...(option.details?.body ?? []), ...(option.confirm?.body ?? [])])];
  if (allText.reduce((bytes, text) => bytes + Buffer.byteLength(text) + 64, 0) > 2 * 1024 * 1024 || request.options.length > 32) {
    await choose({ kind: 'selection', title: '无法完整展示此请求', message: '内容超过当前安全展示容量，确认已禁用。可返回并保留待处理请求。', choices: [{ id: 'return', label: '返回' }] });
    return;
  }
  if (request.initialValue !== undefined && !request.options.some(option => option.value === request.initialValue && !option.disabled)) throw Error('terminal-selection-initial');
  const body = request.body ?? [];
  let page = 0;
  let active = request.options.find(option => option.value === request.initialValue && !option.disabled) ?? request.options.find(option => !option.disabled);
  for (;;) {
    const pages = pageCount(body);
    const view: TerminalSelectionPage = { kind: 'selection', selectionLayer: 'select', title: request.title,
      initialItemId: active ? `option:${active.value}` : 'return',
      ...(request.details ? { detailsActionId: 'request-details' } : {}),
      message: pageText(body, page) + (pages > 1 ? `\n（正文 ${page + 1}/${pages}）` : ''),
      choices: [
        ...request.options.map(option => ({ id: `option:${option.value}`, label: option.label, detail: option.description, disabled: option.disabled, danger: option.tone === 'danger', hotkey: option.hotkey,
          ...(option.details || request.details ? { detailsActionId: `details:${option.value}` } : {}) })),
        ...(page ? [{ id: 'previous', label: '上一页正文' }] : []),
        ...(page + 1 < pages ? [{ id: 'next', label: '下一页正文' }] : []),
        ...(request.details ? [{ id: 'details', label: request.details.title ?? '查看详情' }] : []),
        { id: 'return', label: request.cancelLabel ?? '收起，稍后处理' },
      ] };
    terminalSelectionActions(view);
    const response = await choose(view);
    if (!response) return;
    const cancelled = cancellation(response); if (cancelled) return cancelled;
    if (response.itemId === 'return') return { kind: 'cancelled', cause: 'escape' };
    if (response.itemId === 'previous' && page > 0) { page--; continue; }
    if (response.itemId === 'next' && page + 1 < pages) { page++; continue; }
    const detailOption = request.options.find(option => !option.disabled && `details:${option.value}` === response.itemId);
    const detail = detailOption ? detailOption.details ?? request.details : ['details', 'request-details'].includes(response.itemId) ? request.details : undefined;
    if (detail) {
      if (detailOption) active = detailOption;
      const outcome = await details(detail.title ?? detailOption?.label ?? '详情', detail.body, choose);
      if (outcome && outcome.cause !== 'escape') return outcome;
      continue;
    }
    const option = request.options.find(candidate => `option:${candidate.value}` === response.itemId && !candidate.disabled);
    if (!option) continue;
    active = option;
    if (option.confirm) {
      const confirmed = await choose({ kind: 'selection', selectionLayer: 'confirm', initialItemId: 'confirm', title: option.confirm.title, message: option.confirm.body?.join('\n'),
        choices: [{ id: 'back', label: option.confirm.cancelLabel ?? '返回' }, { id: 'confirm', label: option.confirm.confirmLabel ?? '确认', danger: true }] });
      const cancelled = cancellation(confirmed); if (cancelled && cancelled.cause !== 'escape') return cancelled;
      if (!confirmed) return;
      if (cancelled || confirmed.itemId !== 'confirm') continue;
    }
    if (option.input) {
      const entered = await choose({ kind: 'selection', selectionLayer: 'input', initialItemId: 'submit', title: option.label, message: option.description,
        field: { id: 'selection-input', label: option.input.placeholder, value: '', secret: false },
        choices: [{ id: 'submit', label: request.submitLabel ?? '提交说明' }, { id: 'back', label: '返回' }] });
      const cancelled = cancellation(entered); if (cancelled && cancelled.cause !== 'escape') return cancelled;
      if (!entered) return;
      if (cancelled || entered.itemId !== 'submit' || (!option.input.allowEmpty && !entered.input?.trim())) continue;
      return { kind: 'selected', value: option.value, input: entered.input ?? '' };
    }
    return { kind: 'selected', value: option.value };
  }
}

async function details(title: string, text: readonly string[], choose: TerminalSelectionPort): Promise<Extract<SelectionResult, { kind: 'cancelled' }> | undefined> {
  let page = 0;
  const count = pageCount(text);
  for (;;) {
    const response = await choose({ kind: 'selection', selectionLayer: 'details', initialItemId: 'return', title, message: `${pageText(text, page)}\n（${page + 1}/${count}）`, choices: [
      ...(page ? [{ id: 'previous', label: '上一页' }] : []), ...(page + 1 < count ? [{ id: 'next', label: '下一页' }] : []), { id: 'return', label: '返回选择' },
    ] });
    if (!response || response.itemId === 'return') return;
    const cancelled = cancellation(response); if (cancelled) return cancelled;
    if (response.itemId === 'next' && page + 1 < count) page++;
    else if (response.itemId === 'previous' && page > 0) page--;
  }
}

function pageCount(lines: readonly string[]): number { return Math.max(1, Math.ceil(lines.reduce((size, line, index) => size + line.length + (index ? 1 : 0), 0) / 4096)); }
function pageText(lines: readonly string[], page: number): string {
  const from = page * 4096, to = from + 4096;
  const parts: string[] = []; let offset = 0;
  for (let index = 0; index < lines.length && offset < to; index++) {
    if (index) { if (offset >= from && offset < to) parts.push('\n'); offset++; }
    const line = lines[index]!;
    if (offset + line.length > from && offset < to) {
      let start = Math.max(0, from - offset), end = Math.min(line.length, to - offset);
      if (start && /[\uDC00-\uDFFF]/u.test(line[start]!) && /[\uD800-\uDBFF]/u.test(line[start - 1]!)) start--;
      if (end < line.length && /[\uD800-\uDBFF]/u.test(line[end - 1]!) && /[\uDC00-\uDFFF]/u.test(line[end]!)) end--;
      parts.push(line.slice(start, end));
    }
    offset += line.length;
  }
  return parts.join('');
}
