/**
 * PasteRegistry — REPL session 级粘贴附件存储。
 *
 * 用户粘贴的多行内容超过折叠阈值时，原文存进 registry、buffer.draft 里只放
 * 紧凑占位符 token；提交时 expand 还原原文喂给 agent。
 *
 * 三处共用 token 格式契约（单一真相源）：
 *   - format(id) 输出 token 字符串
 *   - PASTE_TOKEN_PATTERN 是 regex（带 `g` flag）
 *   - 所有 caller（expandPastes / extractAliveIds / typeahead trigger 的 word
 *     terminator）import 同一 PASTE_TOKEN_PATTERN 来源，避免格式漂移
 *
 * 同 hash 复用 id：用户重复粘贴同段内容时 registry 不爆。FNV-1a 32-bit 碰撞
 * 概率 ~1/2^32 可忽略；万一碰撞（hash 同但 content 不同）走独立 id 不复用，
 * 不影响正确性。
 *
 * Cleanup（orphan 回收）：buffer 改动后 caller 调 cleanup(aliveIds)，registry
 * 中不在 alive set 的 id 被删——把"占位符在 buffer 里是否仍存在"作为生死信号。
 */

/**
 * Token 格式契约（与 format(id) 输出严格对齐）：
 *   `[Pasted #N +M lines · KB]`
 *
 *   - N: registry id（数值）
 *   - M: 行数（不含末尾空行）
 *   - byteSize: ASCII 三档量化 `\d+B` / `\d+(\.\d+)?KB` / `\d+(\.\d+)?MB`
 *
 * 带 `g` flag 供 matchAll / replace 用。caller 不要自己拼这个 regex。
 */
export const PASTE_TOKEN_PATTERN =
  /\[Pasted #(\d+) \+(\d+) lines · (\d+(?:\.\d+)?)(B|KB|MB)\]/g;

export function createPasteTokenPattern(): RegExp {
  return new RegExp(PASTE_TOKEN_PATTERN.source, PASTE_TOKEN_PATTERN.flags);
}

export interface PasteEntry {
  readonly id: number;
  readonly content: string;
  readonly lineCount: number;
  readonly byteSize: number;
  readonly hash: number;
}

export class PasteRegistry {
  private nextId = 1;
  private readonly byId = new Map<number, PasteEntry>();
  private readonly byHash = new Map<number, number>();

  /**
   * 注册新粘贴内容，返回 id。同 hash + 同 content 复用既有 id。
   */
  register(content: string): number {
    const hash = fnv1a32(content);
    const existingId = this.byHash.get(hash);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (existing && existing.content === content) {
        return existingId;
      }
    }
    const id = this.nextId++;
    const entry: PasteEntry = {
      id,
      content,
      lineCount: countLines(content),
      byteSize: byteLength(content),
      hash,
    };
    this.byId.set(id, entry);
    this.byHash.set(hash, id);
    return id;
  }

  get(id: number): PasteEntry | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * 渲染占位符 token 字符串。id 不存在返回字面 "[Pasted #N +0 lines · 0B]"
   * 是无效契约——caller 应只对 register 返回的 id 调 format。
   */
  format(id: number): string {
    const entry = this.byId.get(id);
    if (!entry) return `[Pasted #${id} +0 lines · 0B]`;
    return `[Pasted #${entry.id} +${entry.lineCount} lines · ${formatByteSize(entry.byteSize)}]`;
  }

  /**
   * 删除不在 aliveIds 集合中的 entry（orphan 回收）。
   * caller 通常从 buffer.draft 用 PASTE_TOKEN_PATTERN matchAll 抽出 alive id。
   */
  cleanup(aliveIds: ReadonlySet<number>): void {
    for (const [id, entry] of this.byId) {
      if (aliveIds.has(id)) continue;
      this.byId.delete(id);
      if (this.byHash.get(entry.hash) === id) {
        this.byHash.delete(entry.hash);
      }
    }
  }

  /** REPL session 退出时一次性清空。 */
  clearAll(): void {
    this.byId.clear();
    this.byHash.clear();
    this.nextId = 1;
  }

  /** 测试 / 诊断用 */
  get size(): number {
    return this.byId.size;
  }
}

/**
 * FNV-1a 32-bit 哈希——deterministic、零依赖。用于 register 时同内容复用 id 的
 * 相等性判断（碰撞罕见且不影响正确性，仅放弃复用机会）。不参与 token 字面渲染。
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 行数计数——剥末尾空行后 split('\n')。空内容计 0。
 *
 * "+30 lines" 语义：用户对"我粘了几行"的直觉理解，与编辑器行号一致。末尾的
 * trailing newline 不算独立一行（许多文件以 \n 结尾，不应让 lineCount 多 1）。
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const trimmed = content.replace(/\n+$/, "");
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

/** UTF-8 字节长度——Buffer.byteLength 在 Node 环境是规范实现。 */
function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * byteSize 量化：ASCII 三档锁定 `123B` / `1.2KB` / `1.5MB`。
 *
 * 不本地化、不带千分位、不带空格——格式必须与 PASTE_TOKEN_PATTERN 严格对齐。
 * KB / MB 用一位小数；B 用整数。
 */
function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
