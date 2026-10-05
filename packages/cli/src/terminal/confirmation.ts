import type { ConfirmationDecision, ConfirmationOption, ConfirmationRequest } from '@zhixing/core/confirmation';
import { translate } from '../security/confirmation-decision.js';
import type { SelectionRequest } from '../tui/selection/types.js';
import { chooseTerminalSelection, type TerminalSelectionPort } from './selection.js';
import { boundedControlProjection } from '../runtime/control-projection.js';

export interface TerminalConfirmation {
  readonly id: string;
  readonly selection: SelectionRequest;
  readonly options: ReadonlyMap<string, ConfirmationOption>;
}

/** Drops tool input immediately; the decision surface retains only its bounded
 * required consequences and the exact options supplied by the authority. */
export function projectTerminalConfirmation(request: ConfirmationRequest): TerminalConfirmation {
  const display = request.display, body = display.body;
  const lines = display.stewardReason ? [`安全助理察觉风险：${display.stewardReason}`, ''] : [];
  switch (body.kind) {
    case 'bash': lines.push(display.commandFull ?? body.command); break;
    case 'file-write': lines.push(`写入 ${body.path}`, body.preview ?? ''); break;
    case 'file-edit': lines.push(`编辑 ${body.path}`, body.diff ?? ''); break;
    case 'file-read': lines.push(`读取 ${body.path}`); break;
    case 'network': lines.push(`${body.direction === 'inbound' ? '入站' : '出站'}网络：${body.host}`); break;
    case 'messaging': lines.push(`消息 → ${body.recipient}`, body.content); break;
    case 'calendar': lines.push(body.title, ...body.invitees); break;
    case 'generic': lines.push(body.summary); for (const [key, value] of Object.entries(body.details ?? {})) lines.push(`${key}：${value}`); break;
  }
  const budget = lines.reduce((size, line) => size + line.length * 2, 0);
  const complete = budget <= 1024 * 1024 + 64 * 1024 && request.options.length <= 32;
  const options = new Map<string, ConfirmationOption>();
  const choices: SelectionRequest['options'][number][] = [];
  request.options.forEach((option, index) => {
    if (option.kind === 'show-full' || option.kind === 'edit-then-allow') return;
    if (!complete && option.kind !== 'deny' && option.kind !== 'deny-with-reason') return;
    const value = `decision:${index}`;
    options.set(value, option);
    const persistent = option.kind === 'allow-session' || option.kind === 'allow-context' || option.kind === 'allow-global';
    const basic = { value, label: option.label, ...(persistent ? { description: '这会保存授权规则，后续匹配的操作可按该规则执行。', tone: 'danger' as const } : {}) };
    if (option.kind === 'allow-with-note' || option.kind === 'deny-with-reason') choices.push({ ...basic, input: { placeholder: option.placeholder, allowEmpty: true } });
    else if (persistent) choices.push({ ...basic, confirm: { title: '保存这条授权规则？', body: ['后续匹配的操作可按该规则执行。', option.pattern.label, `${option.pattern.pattern.tool} ${option.pattern.pattern.argument}`], confirmLabel: '确认保存并允许', cancelLabel: '返回' } });
    else choices.push(basic);
  });
  if (!choices.some(choice => options.get(choice.value)?.kind === 'deny')) {
    options.set('deny', { kind: 'deny', label: '拒绝本次操作' }); choices.push({ value: 'deny', label: '拒绝本次操作' });
  }
  const projection = { id: request.id, options, selection: { title: request.display.title,
    body: complete ? lines : ['无法在安全展示容量内完整呈现此次请求，允许已禁用。可以拒绝或退出。'],
    options: choices,
  } };
  // Both the selection's copied labels/details and exact decision patterns
  // belong to the same control detail slot, including hidden option fields.
  boundedControlProjection({ id: projection.id, selection: projection.selection, options: [...options] }, 1536 * 1024);
  return projection;
}

class Dismissed extends Error { constructor(readonly decision: ConfirmationDecision) { super('terminal-confirmation-dismissed'); } }
export async function resolveTerminalConfirmation(projection: TerminalConfirmation, choose: TerminalSelectionPort): Promise<ConfirmationDecision> {
  try {
    const selected = await chooseTerminalSelection(projection.selection, async page => {
      const hasDenial = page.choices?.some(choice => choice.id.startsWith('option:') && projection.options.get(choice.id.slice(7))?.kind === 'deny');
      const result = await choose({ ...page, kind: 'confirmation', choices: page.choices
        ?.filter(choice => choice.id !== 'return' || !hasDenial)
        .map(choice => choice.id === 'return' ? { ...choice, label: '拒绝本次操作' } : choice) });
      if (!result || result.itemId === 'return') throw new Dismissed({ kind: 'deny' });
      if (result.itemId === 'cancelled') throw new Dismissed({ kind: 'cancelled', cause: 'user-ctrl-c' });
      return result;
    });
    if (!selected) return { kind: 'deny' };
    return translate({ kind: 'selected', value: selected.value, ...('input' in selected ? { note: selected.input } : {}) }, new Map(projection.options));
  } catch (error) { if (error instanceof Dismissed) return error.decision; throw error; }
}
