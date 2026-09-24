import { getZhixingHome } from "@zhixing/core/paths";
import type { LogFilter, LogPage, LogRecord } from "@zhixing/core/logging";
import { queryLocalLogs } from "../logging/local-query.js";
import { normalizeLogLineCount } from "./log-line-count.js";

export interface LogsOptions {
  lines?: number;
  tail?: boolean;
  pollMs?: number;
  home?: string;
  stopCondition?: () => boolean;
  deps?: {
    query?: typeof queryLocalLogs;
    sleep?: (ms: number) => Promise<void>;
    console?: Pick<Console, "log" | "error">;
  };
}

/** Compatibility command, using the same bounded reader and published store watermark. */
export async function runLogsCommand(opts: LogsOptions = {}): Promise<void> {
  const lines = normalizeLogLineCount(opts.lines);
  const query = opts.deps?.query ?? queryLocalLogs;
  const con = opts.deps?.console ?? console;
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const home = opts.home ?? getZhixingHome();
  let filter: LogFilter = {}, cursor: string | undefined, storeId: string | undefined;
  let ring: LogRecord[] = [], bytes = 0, first = true, pages = 0, byteTruncated = false;
  do {
    let page: LogPage & { detail?: unknown };
    try { page = await query(home, filter, cursor); }
    catch (error) { con.error(error instanceof Error ? error.message : "日志暂不可读"); return; }
    if (page.detail !== undefined) {
      con.log(JSON.stringify(page));
      con.error("历史日志尚未登记，按上方 address 使用 zz logs read --view detail 查阅；续页附加 --cursor。此视图仅定位当前本机。");
      return;
    }
    const observedStore = page.records[0]?.storeId;
    if ((storeId && observedStore && observedStore !== storeId) || page.coverage.upper < (filter.afterSequence ?? 0)) { con.error("日志存储身份或水位已变化，请重新查询。"); return; }
    storeId = observedStore ?? storeId;
    for (const record of page.records) {
      if (!first) con.log(JSON.stringify(record));
      else {
        ring.push(record); bytes += Buffer.byteLength(JSON.stringify(record));
        while (ring.length > lines || bytes > 2 * 1024 * 1024) {
          if (bytes > 2 * 1024 * 1024 && ring.length <= lines) byteTruncated = true;
          bytes -= Buffer.byteLength(JSON.stringify(ring.shift()!));
        }
      }
    }
    for (const gap of page.gaps) con.error(`日志缺口：${gap.kind}（${gap.reason}）`);
    cursor = page.cursor;
    pages++;
    if (!cursor || pages >= 16) {
      if (byteTruncated) con.error("显示达到字节限额；可用 zz logs search 按页读取完整保留范围。");
      for (const record of ring) con.log(JSON.stringify(record));
      ring = []; bytes = 0; first = false; pages = 0;
      if (cursor && !opts.tail) con.error(`本次扫描达到限额，继续：zz logs search --cursor ${cursor}`);
      if (!opts.tail) return;
    }
    if (!cursor) filter = { afterSequence: page.coverage.upper };
    if (opts.stopCondition?.()) return;
    if (opts.tail) await sleep(Math.min(60_000, Math.max(100, opts.pollMs ?? 1000)));
  } while (true);
}
