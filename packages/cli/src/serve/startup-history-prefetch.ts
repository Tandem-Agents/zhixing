export interface StartupHistorySource<T> {
  /** 按原路径读取一个会话的启动历史。 */
  load(conversationId: string, committedTurnCount: number | undefined): Promise<T>;
  /**
   * 读取结果所依赖的全部来源的身份（承诺轮数与存储的发布身份）；任何写入都会改变它。
   * 返回 undefined 表示此刻无法确定（例如旧格式尚未转换），这时不预读、不取用。
   */
  identity(conversationId: string, committedTurnCount: number | undefined): Promise<string | undefined>;
}

interface Entry<T> {
  readonly conversationId: string;
  readonly committedTurnCount: number;
  readonly identity: string;
  readonly result: Promise<T>;
}

/**
 * 宿主就绪前的启动历史预读：只持有一份结果。同一会话的首次装载在承诺轮数相同、来源身份未变时取用它，
 * 否则（或预读失败）按原路径读取；同一会话装载过即丢弃。读取会写派生缓存，关闭后不再发起、丢弃结果，
 * 并等在途读取结算——由装配 owner 在会话存储与权威关闭之前调用。
 */
export class StartupHistoryPrefetch<T> {
  #entry: Entry<T> | undefined;
  readonly #inFlight = new Set<Promise<void>>();
  #closed = false;

  constructor(private readonly source: StartupHistorySource<T>) {}

  /** 发起一次预读；已关闭或已有一份时不发起。读取结算后返回，失败不抛出、不留存。 */
  prefetch(conversationId: string, committedTurnCount: number): Promise<void> {
    if (this.#closed || this.#entry) return Promise.resolve();
    const task = (async () => {
      const identity = await this.source.identity(conversationId, committedTurnCount);
      if (identity === undefined || this.#closed || this.#entry) return;
      // 身份先于读取取得：读取期间若有写入，取用时身份已不同，只会多读一次，不会取到旧结果
      const entry: Entry<T> = { conversationId, committedTurnCount, identity, result: this.source.load(conversationId, committedTurnCount) };
      this.#entry = entry;
      try { await entry.result; } catch { if (this.#entry === entry) this.#entry = undefined; }
    })().catch(() => undefined);
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
    return task;
  }

  async load(conversationId: string, committedTurnCount: number | undefined): Promise<T> {
    const entry = this.#entry;
    if (entry?.conversationId === conversationId) {
      this.#entry = undefined;
      if (!this.#closed && entry.committedTurnCount === committedTurnCount &&
          await this.source.identity(conversationId, committedTurnCount).catch(() => undefined) === entry.identity) {
        try { return await entry.result; } catch { /* 预读失败按原路径读取 */ }
      }
    }
    return this.source.load(conversationId, committedTurnCount);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#entry = undefined;
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight);
  }
}
