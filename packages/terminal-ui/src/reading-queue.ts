export type ReadingIntent = { kind: 'page'; start?: number; follow: boolean } | { kind: 'previous' };
/** One physical read and one latest intent, shared by display and disk history.
 * Repeated wheel events join an identical active read, not a queue of readers. */
export class ReadingQueue {
  #active?: { intent: ReadingIntent; generation: number };
  #next?: { intent: ReadingIntent; generation: number };
  #work?: Promise<void>;
  #generation = 0;
  constructor(readonly execute: (intent: ReadingIntent) => Promise<unknown>) {}
  reset(): void { this.#generation++; this.#next = undefined; }
  request(intent: ReadingIntent): Promise<void> {
    const equal = (a: ReadingIntent, b: ReadingIntent) => a.kind === b.kind &&
      (a.kind === 'previous' || b.kind === 'page' && a.start === b.start && a.follow === b.follow);
    if (this.#active?.generation === this.#generation && equal(this.#active.intent, intent)) this.#next = undefined;
    else this.#next = { intent, generation: this.#generation };
    if (!this.#work) this.#work = Promise.resolve().then(async () => {
      try { while (this.#next) {
        const next = this.#next; this.#next = undefined; this.#active = next;
        try { await this.execute(next.intent); }
        catch (error) { if (!this.#next && next.generation === this.#generation) throw error; }
        finally { this.#active = undefined; }
      } } finally { this.#work = undefined; }
    });
    return this.#work;
  }
}
