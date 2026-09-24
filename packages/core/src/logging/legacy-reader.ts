import { LogRequestError } from "./errors.js";
import { safeText } from "./capture.js";
import { logDigest, type LocalLogStore } from "./storage.js";
import type { LogPage, LogReadContext } from "./contracts.js";
import { DEFAULT_LOG_POLICY } from "./policy.js";
import type { LegacyLogEntry } from "./legacy.js";

interface LegacyCursor { v: 1; binding: string; upper: number; after: string; retired: number; registration: string; snapshot?: string; offset?: number; bytes?: number; identity?: string; skipLine?: boolean }

/** Legacy remains explicitly unstructured, storage-manager only, and never becomes a LogRecord. */
export async function readLegacyLogs(
  store: LocalLogStore,
  address: { storeId?: string; id: string },
  view: "overview" | "timeline" | "detail",
  cursor: string | undefined,
  context: LogReadContext,
): Promise<LogPage & { detail?: unknown }> {
  if (!context.manageStorage) throw new LogRequestError("需要本机日志存储管理授权");
  const binding = logDigest(JSON.stringify({ address, view, context }));
  let previous: LegacyCursor | undefined;
  if (cursor) {
    try {
      if (cursor.length > 2048) throw Error("cursor");
      previous = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!previous || previous.v !== 1 || previous.binding !== binding || !Number.isSafeInteger(previous.upper) || previous.upper < 0 ||
        !/^(?:|legacy-[a-f0-9]{64}\.log)$/u.test(previous.after) || !Number.isSafeInteger(previous.retired) || previous.retired < 0 ||
        (address.id !== "catalog" && (!Number.isSafeInteger(previous.offset) || previous.offset! < 0 || !Number.isSafeInteger(previous.bytes) || previous.bytes! < previous.offset! || typeof previous.identity !== "string" || previous.identity.length > 256 || typeof previous.skipLine !== "boolean"))) throw Error("cursor");
    } catch { throw new LogRequestError("旧日志游标无效或授权已变化"); }
  }
  return store.inspectLegacy(async (state, files, names, current) => {
    const observed: { name: string; id: string; identity: string; bytes: number }[] = [];
    const collect = async (): Promise<LogPage & { detail?: unknown }> => {
      const policy = state?.policy.effective ?? DEFAULT_LOG_POLICY;
      const deadline = performance.now() + policy.queryMs;
      const registration = state?.storeId ?? "unregistered", snapshot = state ? undefined : logDigest(names.join("\n"));
      const page: LogPage = { records: [], gaps: [], coverage: { upper: previous?.upper ?? state?.generation ?? 0, scannedBytes: 0, complete: true } };
      if (address.storeId && address.storeId !== state?.storeId) return { ...page, gaps: [{ kind: "unavailable", reason: "different-store" }] };
      if (previous && (previous.registration !== registration || previous.snapshot !== snapshot || previous.upper > (state?.generation ?? 0))) throw new LogRequestError("旧日志清单或登记已变化，请重新查询");
      const gaps: LogPage["gaps"][number][] = [{ kind: "not-collected", reason: "legacy-unstructured" }];
      if (!state) gaps.push({ kind: "insufficient", reason: "legacy-unregistered-local-observation" });
      const marker = { registration, ...(snapshot ? { snapshot } : {}) };
      const entryAddress = (entry: { id: string; name: string }) => state ? `zxlog://${state.storeId}/legacy/${entry.id}` : `zxlog-local:legacy/${entry.name}`;
      type Entry = Omit<LegacyLogEntry, "registeredAt"> & { registeredAt?: number };
      if (address.id === "catalog") {
        const entries = (state?.legacy ?? []).filter((entry) => entry.generation <= page.coverage.upper && entry.name > (previous?.after ?? "")).sort((a, b) => a.name.localeCompare(b.name));
        const limit = Math.min(32, policy.queryRecords, Math.max(1, Math.floor(policy.queryResultBytes / 2048)));
        const selected: Entry[] = entries.slice(0, limit);
        const remaining = names.filter((name) => name > (previous?.after ?? ""));
        if (!state) for (const name of remaining.slice(0, limit)) {
          if (performance.now() >= deadline) break;
          selected.push({ name, ...await files.stat(name), id: name, generation: 0 });
        }
        const complete = selected.length === (state ? entries.length : remaining.length);
        observed.push(...selected);
        if (previous && previous.retired !== (state?.legacyRetired ?? 0)) gaps.push({ kind: "expired", reason: "legacy-catalog-changed" });
        return { ...page, gaps, coverage: { ...page.coverage, complete },
          ...(complete ? {} : { cursor: Buffer.from(JSON.stringify({ v: 1, binding, ...marker, upper: page.coverage.upper, after: selected.at(-1)?.name ?? previous?.after ?? "", retired: state?.legacyRetired ?? 0 })).toString("base64url") }),
          detail: { format: "legacy-catalog", registration: state ? "registered" : "unregistered", entries: selected.map((entry) => ({ address: entryAddress(entry), file: entry.legacyPath ?? entry.name, bytes: entry.bytes, ...(entry.registeredAt === undefined ? {} : { registeredAt: entry.registeredAt }) })) },
        };
      }
      const entry: Entry | undefined = state ? state.legacy?.find((item) => item.id === address.id) : names.includes(address.id) ? { name: address.id, id: address.id, ...await files.stat(address.id), generation: 0 } : undefined;
      if (!entry) return { ...page, gaps: [{ kind: "insufficient", reason: "legacy-not-retained-or-unknown" }] };
      observed.push(entry);
      const metadata = { format: "legacy", registration: state ? "registered" : "unregistered", file: entry.legacyPath ?? entry.name, bytes: entry.bytes, ...(entry.registeredAt === undefined ? {} : { registeredAt: entry.registeredAt }) };
      if (view !== "detail") return { ...page, gaps, detail: metadata };
      const offset = previous?.offset ?? 0;
      if (previous && (previous.identity !== entry.identity || previous.bytes !== entry.bytes)) return { ...page, gaps: [{ kind: "insufficient", reason: "legacy-changed-during-query" }] };
      const continuation = (next: number, skipLine: boolean) => Buffer.from(JSON.stringify({ v: 1, binding, ...marker, upper: page.coverage.upper, after: "", retired: state?.legacyRetired ?? 0, offset: next, bytes: entry.bytes, identity: entry.identity, skipLine })).toString("base64url");
      try {
        const info = await files.stat(entry.name);
        if (info.identity !== entry.identity || info.bytes !== entry.bytes) throw Error("legacy-changed");
        if (offset === entry.bytes) return { ...page, gaps, detail: { ...metadata, text: "", redacted: false, truncated: false } };
        if (performance.now() >= deadline) return { ...page, gaps, cursor: continuation(offset, previous?.skipLine ?? false), coverage: { ...page.coverage, complete: false } };
        if (offset && !previous?.skipLine) {
          const before = await files.read(entry.name, entry.bytes, offset - 1, 1, entry.identity);
          if (before[0] !== 10) throw new LogRequestError("旧日志游标必须指向完整行边界");
        }
        if (performance.now() >= deadline) return { ...page, gaps, cursor: continuation(offset, previous?.skipLine ?? false), coverage: { ...page.coverage, complete: false } };
        const limit = Math.min(entry.bytes - offset, policy.queryScanBytes - 1, Math.floor(policy.queryResultBytes / 16), 32768);
        const bytes = Buffer.from(await files.read(entry.name, entry.bytes, offset, limit, entry.identity));
        const eof = offset + bytes.length === entry.bytes;
        let start = 0, end = eof ? bytes.length : bytes.lastIndexOf(10) + 1, skipLine = false;
        if (previous?.skipLine) { const newline = bytes.indexOf(10); start = newline < 0 ? bytes.length : newline + 1; skipLine = newline < 0 && !eof; }
        if (!end && !eof) { end = bytes.length; start = end; skipLine = true; }
        if (previous?.skipLine || skipLine) gaps.push({ kind: "not-collected", reason: "legacy-oversized-line-omitted" });
        // Legacy has no field contract. Opaque standalone strings (including split PEM bodies)
        // are suppressed in addition to the common free-text filter, never emitted in pieces.
        const text = bytes.subarray(Math.min(start, end), end).toString("utf8");
        const opaque = text.replace(/^\s*["']?[A-Za-z0-9_+/=.-]{24,}["']?[,;]?\s*$/gmu, "[已脱敏]");
        const projection = safeText(opaque, limit);
        const next = offset + end, complete = next >= entry.bytes;
        return { ...page, gaps, ...(complete ? {} : { cursor: continuation(next, skipLine) }), coverage: { ...page.coverage, complete, scannedBytes: bytes.length + (offset && !previous?.skipLine ? 1 : 0) }, detail: { ...metadata, offset, text: projection.text, redacted: projection.redacted || opaque !== text, truncated: projection.truncated || skipLine } };
      } catch { return { ...page, gaps: [{ kind: "insufficient", reason: "legacy-missing-or-changed" }] }; }
    };
    const result = await collect();
    let physicallyChanged = false;
    for (const entry of observed) {
      try {
        const info = await files.stat(entry.name);
        if (info.identity !== entry.identity || info.bytes !== entry.bytes) physicallyChanged = true;
      } catch { physicallyChanged = true; }
    }
    // Governance is the last asynchronous observation, after body and identity reads.
    const latest = await current();
    if (latest.state?.storeId !== state?.storeId || latest.state?.policy.version !== state?.policy.version)
      throw new LogRequestError("旧日志登记或策略已变化，请重新查询");
    const changed = (kind: "expired" | "insufficient", reason: string): LogPage => ({
      records: [], gaps: [{ kind, reason }], coverage: { ...result.coverage, complete: false },
    });
    if (!state && logDigest(latest.names.join("\n")) !== logDigest(names.join("\n")))
      return changed("insufficient", "legacy-catalog-changed-during-query");
    for (const entry of observed) {
      if (state) {
        const retained = latest.state!.legacy?.find((item) => item.id === entry.id);
        if (!retained) {
          const retired = latest.state!.pending.some(item => item.name === entry.name && item.identity === entry.identity);
          return retired ? changed("expired", "legacy-retired-during-query") : changed("insufficient", "legacy-not-retained-or-changed");
        }
        if (retained.identity !== entry.identity || retained.bytes !== entry.bytes)
          return changed("insufficient", "legacy-changed-during-query");
      }
    }
    if (physicallyChanged) return changed("insufficient", "legacy-missing-or-changed");
    return result;
  });
}
