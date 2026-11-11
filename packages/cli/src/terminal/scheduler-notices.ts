import { readFile, stat } from 'node:fs/promises';
import { acquireFileLock } from '@zhixing-ai/core/persistence';
import { recoverOrphanTmp, writeAtomic } from '@zhixing-ai/core/transcript';
import type { SchedulerNoticePage, SchedulerNoticeView } from '../runtime/rpc-scheduler-facade.js';

/**
 * 本机第一方终端对定时通知的消费进度：是展示进度，不是调度执行回执。位置是连续的复合位置——
 * watermark 及之前的修订都已处理，watermark 之后紧接的那个含通知的信封里前 skip 条也已处理。
 * 大小固定，不随同一信封的通知条数增长。
 */
export interface SchedulerNoticeProgress {
  /** 通知源代际；换代后旧位置不再适用。 */
  readonly source: string;
  readonly watermark: number;
  readonly skip: number;
}

export interface SchedulerNoticeProgressStore {
  load(): Promise<SchedulerNoticeProgress | undefined>;
  /** 写入或按同代合并；返回 false 表示文件已是另一代且这次写入不能换代（未写）。 */
  save(progress: SchedulerNoticeProgress): Promise<boolean>;
}

export interface TerminalSchedulerNoticesOptions {
  readonly read: (after: number, skip: number, source?: string) => Promise<SchedulerNoticePage>;
  /** 实时通知只作补读触发；返回退订。 */
  readonly subscribe: (arrived: () => void) => () => void;
  readonly progress: SchedulerNoticeProgressStore;
  /** 确认显示才返回 true；不在可显示状态时返回 false，进度停在它之前。 */
  readonly show: (message: string) => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly failed?: (error: unknown) => void;
}

const MAX_PAGES_PER_PASS = 64;
const MAX_RETIRED_SOURCES = 8;
const PROGRESS_FILE_BYTES = 16 * 1024;

/** 终端只认领调度 owner 标明为第一方的错过汇总；通道来源与其他种类不在这里显示。 */
export function terminalSchedulerNoticeMessage(notice: SchedulerNoticeView): string | undefined {
  if (notice.kind !== 'missed-summary' || notice.audience !== 'first-party') return undefined;
  return notice.reason.slice(0, 2048);
}

/**
 * 就绪后补读第一方定时通知并按自己的进度去重。实时通知与补读同源：实时到达只触发补读，
 * 显示内容一律来自权威分页；补读串行，进行中再次触发就在本轮结束后再走一轮。
 */
export class TerminalSchedulerNotices {
  readonly #unsubscribe: () => void;
  #progress?: SchedulerNoticeProgress;
  #loaded = false;
  #running?: Promise<void>;
  #again = false;
  #disposed = false;

  constructor(readonly options: TerminalSchedulerNoticesOptions) {
    // 先接好实时触发，再补历史：补读开始前到达的通知也会被这一轮或下一轮读到
    this.#unsubscribe = options.subscribe(() => this.catchUp());
  }

  /** 异步接续，不等待；失败保留进度，下次触发（重连、换对话、新通知）再续。 */
  catchUp(): void {
    if (this.#disposed || this.options.signal.aborted) return;
    if (this.#running) { this.#again = true; return; }
    this.#running = (async () => {
      do {
        this.#again = false;
        try { await this.#pass(); }
        catch (error) { if (!this.options.signal.aborted) this.options.failed?.(error); return; }
      } while (this.#again && !this.#disposed && !this.options.signal.aborted);
    })().finally(() => { this.#running = undefined; });
  }

  /** 供测试与收尾等待当前一轮。 */
  idle(): Promise<void> { return this.#running ?? Promise.resolve(); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#unsubscribe();
  }

  async #pass(): Promise<void> {
    if (!this.#loaded) { this.#progress = await this.options.progress.load(); this.#loaded = true; }
    for (let pages = 0; pages < MAX_PAGES_PER_PASS; pages++) {
      if (this.#disposed || this.options.signal.aborted) return;
      const requested = this.#progress;
      // 游标的代际与位置一起交给源端：属于另一代时源端从这一代起点读并标明 reset
      const page = await this.options.read(requested?.watermark ?? 0, requested?.skip ?? 0, requested?.source);
      // 调度源尚未就绪：不推进，等下一次触发
      if (!page.source) return;
      // 这一页实际读的位置
      const after = page.reset ? 0 : requested?.watermark ?? 0, skip = page.reset ? 0 : requested?.skip ?? 0;
      if (requested?.source !== page.source) {
        // 新的通知源代际：别的终端已接上这一代就沿它的位置，否则从头读；旧位置读到的这一页作废
        const stored = await this.options.progress.load();
        this.#progress = stored?.source === page.source ? stored : { source: page.source, watermark: 0, skip: 0 };
        // 采纳的位置正是这次请求的位置时，这一页仍然有效
        if (this.#progress.watermark !== after || this.#progress.skip !== skip) continue;
      }
      const source = page.source;
      // 本页里正在处理的信封（以修订标识）与其中已处理的条数；续读时接着请求位置
      let envelope = skip > 0 ? after + 1 : undefined, count = skip, stopped = false;
      for (const notice of page.notices) {
        if (notice.revision !== envelope) { envelope = notice.revision; count = 0; }
        const message = terminalSchedulerNoticeMessage(notice);
        if (message && !await this.options.show(message)) { stopped = true; break; }
        count++;
        // 只在确实显示了一条时落盘：重进时从这条之后的条目边界续读
        if (message) await this.#save({ source, watermark: envelope - 1, skip: count });
        else this.#progress = { source, watermark: envelope - 1, skip: count };
      }
      if (!stopped) await this.#save({ source, watermark: page.next, skip: page.skip });
      else await this.#save(this.#progress!);
      // 没有前进的“还有更多”不再续读，避免空转
      if (stopped || !page.more || page.next < after || (page.next === after && page.skip <= skip)) return;
    }
    // 单轮页数有上限：剩余的留给下一轮，从已落盘的复合位置接着读
    this.#again = true;
  }

  async #save(progress: SchedulerNoticeProgress): Promise<void> {
    this.#progress = progress;
    const saved = this.#saved;
    if (saved && saved.source === progress.source && samePosition(saved, progress)) return;
    if (await this.options.progress.save(progress)) { this.#saved = progress; return; }
    // 文件已是另一代且这次不能换代：沿文件里同一代的位置（若有），不覆盖别人的进度
    const stored = await this.options.progress.load();
    if (stored?.source === progress.source && compare(stored, progress) > 0) { this.#progress = stored; this.#saved = stored; }
  }
  #saved?: SchedulerNoticeProgress;
}

function samePosition(left: SchedulerNoticeProgress, right: SchedulerNoticeProgress): boolean {
  return left.watermark === right.watermark && left.skip === right.skip;
}

/** 同代复合位置按（修订，条数）字典序比较。 */
function compare(left: SchedulerNoticeProgress, right: SchedulerNoticeProgress): number {
  return left.watermark - right.watermark || left.skip - right.skip;
}

interface StoredProgress extends SchedulerNoticeProgress {
  /** 已被换下的代际：日志身份不会复用，换下的代际不会再成为当前，迟到的旧代写入据此拒收。 */
  readonly retired: readonly string[];
}

function validProgress(value: unknown): value is StoredProgress & { readonly v: 2 } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const token = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 256;
  return record.v === 2 && token(record.source) &&
    Number.isSafeInteger(record.watermark) && (record.watermark as number) >= 0 &&
    Number.isSafeInteger(record.skip) && (record.skip as number) >= 0 &&
    Array.isArray(record.retired) && record.retired.length <= MAX_RETIRED_SOURCES && record.retired.every(token);
}

export interface SchedulerNoticeProgressFileOptions {
  /** 仅供测试：在锁内读到现值之后、写入之前调用，用来构造交错。 */
  readonly beforeWrite?: () => Promise<void>;
}

/**
 * 进度存在 home 下的一个小文件，绑定这个 home 的第一方终端，跨进程重开可用。读、比较代际、合并与写入在同一把
 * 跨进程文件锁里完成（临时文件恢复也只在锁内做，避开活跃写者）：
 * - 同一代按复合位置取大；
 * - 换代只允许从文件现有那一代出发（本实例上次读到或写入的就是它），且目标不是已被换下的代际；
 * - 被拒的写入不改变本实例的出发代际，迟到的旧代写入无论几次都不能覆盖新代。
 * 文件缺失、过大或损坏都按新进度处理。
 */
export function schedulerNoticeProgressFile(filePath: string, options: SchedulerNoticeProgressFileOptions = {}): SchedulerNoticeProgressStore {
  // 本实例最后一次真实读到或写入成功的代际：换代须从文件现状出发
  let basis: string | undefined;
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    const release = await acquireFileLock(`${filePath}.lock`, {
      staleMs: 30_000, waitMs: 5_000, resourceName: 'Terminal scheduler notice progress',
    });
    try { return await work(); } finally { await release(); }
  };
  const read = async (): Promise<StoredProgress | undefined> => {
    await recoverOrphanTmp(filePath).catch(() => {});
    try {
      if ((await stat(filePath)).size > PROGRESS_FILE_BYTES) return undefined;
      const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      if (!validProgress(value)) return undefined;
      return { source: value.source, watermark: value.watermark, skip: value.skip, retired: [...value.retired] };
    } catch { return undefined; }
  };
  const write = (progress: StoredProgress) => writeAtomic(filePath, JSON.stringify({
    v: 2, consumer: 'first-party-terminal', source: progress.source, watermark: progress.watermark, skip: progress.skip, retired: progress.retired,
  }));
  return {
    load: () => locked(async () => {
      const stored = await read();
      basis = stored?.source;
      return stored && { source: stored.source, watermark: stored.watermark, skip: stored.skip };
    }),
    save: progress => locked(async () => {
      const stored = await read();
      await options.beforeWrite?.();
      if (stored && stored.source === progress.source) {
        await write(compare(stored, progress) >= 0 ? stored : { ...progress, retired: stored.retired });
      } else if (!stored) {
        await write({ ...progress, retired: [] });
      } else if (stored.source === basis && !stored.retired.includes(progress.source)) {
        await write({ ...progress, retired: [stored.source, ...stored.retired].slice(0, MAX_RETIRED_SOURCES) });
      } else {
        // 拒收：不改变出发代际，下一次同样的旧写入照样拒收
        return false;
      }
      basis = progress.source;
      return true;
    }),
  };
}
