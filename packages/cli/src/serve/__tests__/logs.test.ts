import { describe, expect, it, vi } from "vitest";
import type { LogPage, LogRecord } from "@zhixing/core/logging";
import { runLogsCommand } from "../logs.js";

const record = (seq: number): LogRecord => ({ storeId: "store-a", id: `record-${seq}`, seq, message: `记录 ${seq}` }) as LogRecord;
const page = (records: LogRecord[], upper = records.length, cursor?: string): LogPage => ({ records, gaps: [], coverage: { upper, complete: !cursor }, ...(cursor ? { cursor } : {}) }) as LogPage;
const output = () => ({ log: vi.fn(), error: vi.fn() });

describe("serve logs compatibility through the unified reader", () => {
  it("keeps the last N records across bounded query pages", async () => {
    const con = output();
    const query = vi.fn().mockResolvedValueOnce(page([record(1), record(2)], 4, "next")).mockResolvedValueOnce(page([record(3), record(4)], 4));
    await runLogsCommand({ home: "isolated", lines: 2, deps: { query, console: con } });
    expect(query.mock.calls).toEqual([["isolated", {}, undefined], ["isolated", {}, "next"]]);
    expect(con.log.mock.calls.map(([line]) => JSON.parse(line).seq)).toEqual([3, 4]);
  });
  it("follows the publication watermark, including late records with old wall time", async () => {
    const con = output();
    const query = vi.fn().mockResolvedValueOnce(page([record(1)], 1)).mockResolvedValueOnce(page([{ ...record(2), occurredAt: 0 }], 2));
    await runLogsCommand({ home: "isolated", tail: true, stopCondition: () => query.mock.calls.length === 2, deps: { query, sleep: async () => {}, console: con } });
    expect(query.mock.calls[1]).toEqual(["isolated", { afterSequence: 1 }, undefined]);
    expect(con.log.mock.calls.map(([line]) => JSON.parse(line).seq)).toEqual([1, 2]);
  });
  it("reports query failure, retention gaps and identity changes honestly", async () => {
    const con = output();
    const query = vi.fn().mockResolvedValueOnce({ ...page([record(1)], 1), gaps: [{ kind: "expired", reason: "retained-prefix" }] }).mockResolvedValueOnce(page([{ ...record(2), storeId: "replacement" }], 2));
    await runLogsCommand({ tail: true, deps: { query, sleep: async () => {}, console: con } });
    expect(con.error.mock.calls.flat().join(" ")).toMatch(/expired.*身份/s);
    const error = output();
    await runLogsCommand({ deps: { query: async () => { throw Error("denied"); }, console: error } });
    expect(error.error).toHaveBeenCalledWith("denied");
    expect(error.log).not.toHaveBeenCalled();
  });
  it("stops scanning at the page budget and exposes a continuation", async () => {
    const query = vi.fn(async () => page([record(1)], 99, "next"));
    const con = output();
    await runLogsCommand({ deps: { query, console: con } });
    expect(query).toHaveBeenCalledTimes(16);
    expect(con.error).toHaveBeenCalledWith(expect.stringContaining("--cursor next"));
  });
  it("keeps pre-migration legacy evidence explicitly local and read-only", async () => {
    const con = output();
    const query = vi.fn(async () => ({ ...page([]), detail: { address: "zxlog-local:legacy/catalog" } }));
    await runLogsCommand({ tail: true, deps: { query, console: con } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(con.log).toHaveBeenCalledWith(expect.stringContaining("zxlog-local:legacy/catalog"));
    expect(con.error).toHaveBeenCalledWith(expect.stringContaining("尚未登记"));
  });
  it("validates the requested line count before invoking the reader", async () => {
    for (const lines of [0, -1, 1.5, 5001, NaN, Infinity]) {
      const query = vi.fn();
      await expect(runLogsCommand({ lines, deps: { query, console: output() } })).rejects.toThrow(/--lines/);
      expect(query).not.toHaveBeenCalled();
    }
  });
});
