/**
 * 复制意图的选区判定：屏上任一时刻只有渲染器的一个当前选区（鼠标拖选与键盘扩选都经由它建立），
 * 这里按选中叶节点的实际归属决定怎么取文字。
 * - 拖动中：还不是可复制的选区，由调用方说明，不复制也不落到中止或退出；
 * - 选中叶节点全是正文文字：交给正文按源文映射取（装饰不混入）；
 * - 只选中了当前编辑器：取编辑器自己的选中文字；
 * - 其余或跨区域：与原生 Selection.getSelectedText 同样按显示行分组、行内按横向顺序直接拼接、行间换行，
 *   只取仍在屏上的叶节点（未销毁、自身与祖先都可见、父链连到根）。
 * 文字长度大于 0 即可复制，纯空白不会被当成没有选区。
 */
export interface SelectionLeaf {
  readonly x: number;
  readonly y: number;
  readonly isDestroyed: boolean;
  readonly visible: boolean;
  readonly parent: SelectionLeaf | null;
  getSelectedText(): string;
}
export interface SelectionState {
  readonly isDragging: boolean;
  readonly selectedRenderables: readonly SelectionLeaf[];
}
export type CopySource =
  | { readonly kind: 'dragging' }
  | { readonly kind: 'body' }
  | { readonly kind: 'text'; readonly text: string };

/** 叶节点仍在屏上：未销毁、自身与祖先都可见、父链连到根 */
export function onScreen(leaf: SelectionLeaf, root: SelectionLeaf): boolean {
  for (let current: SelectionLeaf | null = leaf; current; current = current.parent) {
    if (current.isDestroyed || current.visible === false) return false;
    if (current === root) return true;
  }
  return false;
}

/** 与原生 Selection.getSelectedText 相同的拼接：同一显示行按横向顺序直接拼接，行与行之间换行 */
export function joinSelectedLeaves(leaves: readonly SelectionLeaf[]): string {
  const lines = new Map<number, { x: number; text: string }[]>();
  for (const leaf of [...leaves].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const text = leaf.getSelectedText();
    if (!text) continue;
    text.split('\n').forEach((part, index) => {
      const line = lines.get(leaf.y + index) ?? [];
      line.push({ x: leaf.x, text: part }); lines.set(leaf.y + index, line);
    });
  }
  return [...lines.entries()].sort(([a], [b]) => a - b)
    .map(([, line]) => line.sort((a, b) => a.x - b.x).map(segment => segment.text).join('')).join('\n');
}

/** 语义文字节点：每个节点是一段完整的语义文字（原生折行，选中文字即源文）；after 指向它所跟随的节点，joiner 是两者之间的连接（缺省为制表符） */
export interface SemanticLeafInfo { readonly key: object; readonly after?: object; readonly joiner?: string }

/**
 * 语义文字节点的拼接：节点按阅读顺序排列，各取自己选中的源文（跨软折行不含换行与缩进）；
 * 跟随关系（标签后的值、标题后的侧注之间是制表符，同一串并列条目之间是空格）按各自的连接符，其余段落之间换行。
 */
export function joinSemanticLeaves(leaves: readonly SelectionLeaf[], info: (leaf: SelectionLeaf) => SemanticLeafInfo): string {
  let text = '', previous: SemanticLeafInfo | undefined;
  for (const leaf of [...leaves].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const part = leaf.getSelectedText();
    if (!part) continue;
    const current = info(leaf);
    text += previous ? (current.after && current.after === previous.key ? current.joiner ?? '\t' : '\n') + part : part;
    previous = current;
  }
  return text;
}

export function copySource(selection: SelectionState | null | undefined, options: {
  readonly root: SelectionLeaf;
  readonly isBodyLeaf: (leaf: SelectionLeaf) => boolean;
  /** 正文自己是否认定有选区：它的源文映射认可纯换行的选区，这时渲染器里一个选中的字符叶节点也没有 */
  readonly bodySelected: boolean;
  readonly editor?: SelectionLeaf;
  /** 语义文字节点（如信息分节）的关系；全部选中节点都有关系时按语义拼接 */
  readonly semanticLeaf?: (leaf: SelectionLeaf) => SemanticLeafInfo | undefined;
}): CopySource | undefined {
  if (!selection) return undefined;
  if (selection.isDragging) return { kind: 'dragging' };
  const leaves = selection.selectedRenderables.filter(leaf => onScreen(leaf, options.root));
  // 选中叶节点全在正文里（含一个也没有的纯换行选区）：以正文的判断为准；混入正文以外的叶节点才整段读取
  if (leaves.every(options.isBodyLeaf)) return options.bodySelected ? { kind: 'body' } : undefined;
  const semantic = options.semanticLeaf;
  const text = options.editor && leaves.length === 1 && leaves[0] === options.editor ? options.editor.getSelectedText()
    : semantic && leaves.every(leaf => semantic(leaf)) ? joinSemanticLeaves(leaves, leaf => semantic(leaf)!)
    : joinSelectedLeaves(leaves);
  return text.length ? { kind: 'text', text } : undefined;
}
