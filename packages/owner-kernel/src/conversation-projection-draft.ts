/**
 * 会话投影的私有事务草稿。Map 的键表到首次写入才复制，对象值到首次读取才隔离；
 * 事实数组只追加不可变记录，使用浅副本。失败直接丢弃草稿，已验前缀无需重新读盘。
 * 此类型只服务会话 owner 的归约，不作为持久格式或跨 owner 的共享状态。
 */
export function createConversationProjectionDraft<State extends object>(base: State): {
  readonly state: State;
  finish(): State;
} {
  const state = { ...base };
  const fields = state as Record<string, unknown>;
  const finishers: Array<() => void> = [];
  for (const [key, value] of Object.entries(base)) {
    if (value instanceof Map) {
      const draft = new ConversationDraftMap(value);
      fields[key] = draft;
      finishers.push(() => { if (fields[key] === draft) fields[key] = draft.finish(); });
    } else if (value instanceof Set) {
      const draft = new ConversationDraftSet(value);
      fields[key] = draft;
      finishers.push(() => { if (fields[key] === draft) fields[key] = draft.finish(); });
    } else if (Array.isArray(value)) {
      fields[key] = value.slice();
    } else if (value !== null && typeof value === "object") {
      // task-list、channel interaction等当前可变子状态保留完整隔离。
      fields[key] = structuredClone(value);
    }
  }
  return { state, finish: () => { for (const finish of finishers) finish(); return state; } };
}

class ConversationDraftMap<Key, Value> extends Map<Key, Value> {
  readonly #base: Map<Key, Value>;
  #copy: Map<Key, Value> | undefined;
  readonly #isolated = new Set<Key>();
  constructor(base: Map<Key, Value>) { super(); this.#base = base; }
  #write(): Map<Key, Value> { return this.#copy ??= new Map(this.#base); }
  finish(): Map<Key, Value> { return this.#copy ?? this.#base; }
  override get size(): number { return (this.#copy ?? this.#base).size; }
  override has(key: Key): boolean { return (this.#copy ?? this.#base).has(key); }
  override get(key: Key): Value | undefined {
    const value = (this.#copy ?? this.#base).get(key);
    if (value === null || typeof value !== "object" || this.#isolated.has(key)) return value;
    const copy = structuredClone(value);
    this.#write().set(key, copy);
    this.#isolated.add(key);
    return copy;
  }
  override set(key: Key, value: Value): this {
    this.#write().set(key, value); this.#isolated.add(key); return this;
  }
  override delete(key: Key): boolean {
    if (!this.has(key)) return false;
    this.#isolated.delete(key); return this.#write().delete(key);
  }
  override clear(): void { this.#copy = new Map(); this.#isolated.clear(); }
  override keys(): MapIterator<Key> { return this.#write().keys(); }
  override *entries(): MapIterator<[Key, Value]> {
    for (const key of this.#write().keys()) yield [key, this.get(key)!];
  }
  override *values(): MapIterator<Value> { for (const [, value] of this.entries()) yield value; }
  override [Symbol.iterator](): MapIterator<[Key, Value]> { return this.entries(); }
  override forEach(callback: (value: Value, key: Key, map: Map<Key, Value>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

/** 会话根集合只存不可变标识符；按实际变更复制键集合。 */
class ConversationDraftSet<Value> extends Set<Value> {
  readonly #base: Set<Value>;
  #copy: Set<Value> | undefined;
  constructor(base: Set<Value>) { super(); this.#base = base; }
  #write(): Set<Value> { return this.#copy ??= new Set(this.#base); }
  finish(): Set<Value> { return this.#copy ?? this.#base; }
  override get size(): number { return (this.#copy ?? this.#base).size; }
  override has(value: Value): boolean { return (this.#copy ?? this.#base).has(value); }
  override add(value: Value): this { if (!this.has(value)) this.#write().add(value); return this; }
  override delete(value: Value): boolean { return this.has(value) ? this.#write().delete(value) : false; }
  override clear(): void { this.#copy = new Set(); }
  override entries(): SetIterator<[Value, Value]> { return this.#write().entries(); }
  override keys(): SetIterator<Value> { return this.#write().keys(); }
  override values(): SetIterator<Value> { return this.#write().values(); }
  override [Symbol.iterator](): SetIterator<Value> { return this.values(); }
  override forEach(callback: (value: Value, key: Value, set: Set<Value>) => void, thisArg?: unknown): void {
    for (const value of this.values()) callback.call(thisArg, value, value, this);
  }
}
