import type { TerminalView } from '@zhixing/terminal-ui/protocol';
import type { SelectionRequest, SelectionSelectedResult } from '../tui/selection/types.js';

export interface TerminalSelectionResponse { readonly itemId: string; readonly input?: string }
export type TerminalSelectionPage = Omit<TerminalView, 'generation' | 'requestId'>;
export type TerminalSelectionPort = (page: TerminalSelectionPage) => Promise<TerminalSelectionResponse | undefined>;

/** One bounded selection slot. Bodies remain available through explicit pages;
 * destructive confirmation and free text never share the option activation. */
export async function chooseTerminalSelection<T extends string>(request: SelectionRequest<T>, choose: TerminalSelectionPort): Promise<SelectionSelectedResult<T> | undefined> {
  const allText = [request.title, ...(request.body ?? []), ...(request.details?.body ?? []), ...request.options.flatMap(option =>
    [option.label, option.description ?? '', ...(option.details?.body ?? []), ...(option.confirm?.body ?? [])])];
  if (allText.reduce((bytes, text) => bytes + Buffer.byteLength(text) + 64, 0) > 2 * 1024 * 1024 || request.options.length > 32) {
    await choose({ kind: 'selection', title: '无法完整展示此请求', message: '内容超过当前安全展示容量，确认已禁用。可返回并保留待处理请求。', choices: [{ id: 'return', label: '返回' }] });
    return;
  }
  const body = request.body ?? [];
  let page = 0;
  for (;;) {
    const pages = pageCount(body);
    const response = await choose({ kind: 'selection', title: request.title,
      message: pageText(body, page) + (pages > 1 ? `\n（正文 ${page + 1}/${pages}）` : ''),
      choices: [
        ...request.options.map(option => ({ id: `option:${option.value}`, label: option.label, detail: option.description, disabled: option.disabled, danger: option.tone === 'danger' })),
        ...(page ? [{ id: 'previous', label: '上一页正文' }] : []),
        ...(page + 1 < pages ? [{ id: 'next', label: '下一页正文' }] : []),
        ...(request.details ? [{ id: 'details', label: request.details.title ?? '查看详情' }] : []),
        { id: 'return', label: '收起，稍后处理' },
      ] });
    if (!response || response.itemId === 'return') return;
    if (response.itemId === 'previous' || response.itemId === 'next') { page += response.itemId === 'next' ? 1 : -1; continue; }
    if (response.itemId === 'details' && request.details) { await details(request.details.title ?? '详情', request.details.body, choose); continue; }
    const option = request.options.find(candidate => `option:${candidate.value}` === response.itemId && !candidate.disabled);
    if (!option) continue;
    if (option.details) await details(option.details.title ?? option.label, option.details.body, choose);
    if (option.confirm) {
      const confirmed = await choose({ kind: 'selection', title: option.confirm.title, message: option.confirm.body?.join('\n'),
        choices: [{ id: 'back', label: option.confirm.cancelLabel ?? '返回' }, { id: 'confirm', label: option.confirm.confirmLabel ?? '确认', danger: true }] });
      if (confirmed?.itemId !== 'confirm') continue;
    }
    if (option.input) {
      const entered = await choose({ kind: 'selection', title: option.label, message: option.description,
        field: { id: 'selection-input', label: option.input.placeholder, value: '', secret: false },
        choices: [{ id: 'submit', label: '提交说明' }, { id: 'back', label: '返回' }] });
      if (entered?.itemId !== 'submit' || (!option.input.allowEmpty && !entered.input?.trim())) continue;
      return { kind: 'selected', value: option.value, input: entered.input ?? '' };
    }
    return { kind: 'selected', value: option.value };
  }
}

async function details(title: string, text: readonly string[], choose: TerminalSelectionPort): Promise<void> {
  let page = 0;
  const count = pageCount(text);
  for (;;) {
    const response = await choose({ kind: 'selection', title, message: `${pageText(text, page)}\n（${page + 1}/${count}）`, choices: [
      ...(page ? [{ id: 'previous', label: '上一页' }] : []), ...(page + 1 < count ? [{ id: 'next', label: '下一页' }] : []), { id: 'return', label: '返回选择' },
    ] });
    if (!response || response.itemId === 'return') return;
    page += response.itemId === 'next' ? 1 : -1;
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
