/** Finite Skill surface projection. No Catalog implementation, renderer or I/O. */
export const SKILLS_PAGE_MAX = 24;
export const SKILLS_PAGE_DEFAULT = 8;
export interface TerminalSkillItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly pinned: boolean;
  readonly disabled: boolean;
  readonly mode: 'main' | 'work';
  readonly source: 'own' | 'linked';
  readonly hitCount: number | null;
}
export interface TerminalSkillsView {
  readonly sessionId: string;
  readonly revision: number;
  readonly state: 'loading' | 'ready' | 'error';
  readonly busy: boolean;
  readonly message?: string;
  readonly items: readonly TerminalSkillItem[];
  readonly total: number;
  readonly offset: number;
  readonly pageSize: number;
  /** Absolute Catalog position; identity, rather than this position, authorizes actions. */
  readonly selectedIndex: number;
  readonly selectedId?: string;
}
export type TerminalSkillsAction = { readonly sessionId: string; readonly revision: number } & (
  | { readonly kind: 'move'; readonly direction: -1 | 1; readonly page?: boolean }
  | { readonly kind: 'resize'; readonly pageSize: number }
  | { readonly kind: 'pin' | 'disable' | 'mode' | 'archive'; readonly skillId: string }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'cancel' }
);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const identity = (value: unknown): value is string => text(value, 480) && value.length > 0;
const keys = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
export function validateSkillsAction(value: unknown): value is TerminalSkillsAction {
  if (!object(value) || !identity(value.sessionId) || !integer(value.revision)) return false;
  const base = ['sessionId', 'revision', 'kind'];
  switch (value.kind) {
    case 'move': return keys(value, [...base, 'direction', 'page']) && (value.direction === -1 || value.direction === 1) && (value.page === undefined || typeof value.page === 'boolean');
    case 'resize': return keys(value, [...base, 'pageSize']) && integer(value.pageSize) && value.pageSize >= 1 && value.pageSize <= SKILLS_PAGE_MAX;
    case 'pin': case 'disable': case 'mode': case 'archive': return keys(value, [...base, 'skillId']) && identity(value.skillId);
    case 'refresh': case 'cancel': return keys(value, base);
    default: return false;
  }
}
export function validateSkillsView(value: unknown): value is TerminalSkillsView {
  if (!object(value) || !keys(value, ['sessionId', 'revision', 'state', 'busy', 'message', 'items', 'total', 'offset', 'pageSize', 'selectedIndex', 'selectedId']) ||
      !identity(value.sessionId) || !integer(value.revision) || !['loading', 'ready', 'error'].includes(value.state as string) || typeof value.busy !== 'boolean' ||
      (value.message !== undefined && !text(value.message, 1024)) || !integer(value.total) || !integer(value.offset) || !integer(value.pageSize) ||
      value.pageSize < 1 || value.pageSize > SKILLS_PAGE_MAX || !Array.isArray(value.items) || value.items.length > value.pageSize ||
      value.offset + value.items.length > value.total) return false;
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!object(item) || !keys(item, ['id', 'name', 'description', 'pinned', 'disabled', 'mode', 'source', 'hitCount']) ||
        !identity(item.id) || !text(item.name, 480) || !text(item.description, 1024) || typeof item.pinned !== 'boolean' || typeof item.disabled !== 'boolean' ||
        !['main', 'work'].includes(item.mode as string) || !['own', 'linked'].includes(item.source as string) || (item.hitCount !== null && !integer(item.hitCount)) || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  if (value.total === 0) return value.selectedIndex === -1 && value.selectedId === undefined && value.offset === 0;
  return integer(value.selectedIndex) && value.selectedIndex >= value.offset && value.selectedIndex < value.offset + value.items.length &&
    value.items[value.selectedIndex - value.offset]?.id === value.selectedId;
}

export interface SkillsKey { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean }
export function skillsPageSize(height: number): number {
  return Math.max(1, Math.min(SKILLS_PAGE_MAX, Math.floor((height - 6) / 2) || 1));
}
/** The root passes its existing key event here; the page never subscribes to stdin. */
export function skillsActionForKey(view: TerminalSkillsView, key: SkillsKey, safe = true): TerminalSkillsAction | undefined {
  const base = { sessionId: view.sessionId, revision: view.revision };
  if (key.name === 'escape' || (key.ctrl && key.name.toLowerCase() === 'c')) return { ...base, kind: 'cancel' };
  if (key.ctrl || key.meta || view.busy) return;
  if (key.name.toLowerCase() === 'r') return { ...base, kind: 'refresh' };
  if (key.name === 'up' || key.name === 'down' || key.name === 'pageup' || key.name === 'pagedown') return {
    ...base, kind: 'move', direction: key.name === 'up' || key.name === 'pageup' ? -1 : 1, page: key.name === 'pageup' || key.name === 'pagedown',
  };
  if (!safe || view.state !== 'ready' || !view.selectedId) return;
  const kind = ({ p: 'pin', d: 'disable', m: 'mode', a: 'archive' } as const)[key.name.toLowerCase() as 'p' | 'd' | 'm' | 'a'];
  if (kind) return { ...base, kind, skillId: view.selectedId };
}

/** Resize can arrive before the new Node page: retain the selected identity onscreen. */
export function skillsVisibleItems(view: TerminalSkillsView, height: number): readonly TerminalSkillItem[] {
  const count = skillsPageSize(height), selected = Math.max(0, view.selectedIndex - view.offset);
  const start = Math.max(0, Math.min(selected - count + 1, view.items.length - count));
  return view.items.slice(start, start + count);
}
export function skillsDisplayText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}
