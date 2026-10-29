import type { AuthorityCommitLog, DurableProjectionReadContext } from '../authority/index.js';
import type { JsonValue } from '../contracts/index.js';

/** Test-only domain query materialization. Source preparation is deliberately
 * outside this counter and must be reported separately with physical IO. */
export function observeProjectionQueryWork(log: AuthorityCommitLog) {
  const counts = { decisions: 0, keys: 0, scans: 0, rows: 0, valueBytes: 0 };
  const account = (value: JsonValue | undefined) => {
    if (value !== undefined) { counts.rows++; counts.valueBytes += Buffer.byteLength(JSON.stringify(value)); }
    return value;
  };
  const wrap = (view: DurableProjectionReadContext): DurableProjectionReadContext => ({
    async get(key) { counts.keys++; return account(await view.get(key)); },
    async getMany(keys) {
      counts.keys += keys.length;
      const values = view.getMany ? await view.getMany(keys) : await Promise.all(keys.map(key => view.get(key)));
      return values.map(account);
    },
    async scan(...args) {
      counts.scans++; const page = await view.scan(...args);
      for (const row of page.entries) account(row.value);
      return page;
    },
    releaseContinuation: cursor => view.releaseContinuation?.(cursor),
  });
  const method = log.transactDurableProjection;
  const original = method.bind(log) as typeof method;
  log.transactDurableProjection = (id, decide, options) => original(id, (view, context) => {
    counts.decisions++; return decide(wrap(view), context);
  }, options);
  return { snapshot: () => ({ ...counts }), restore: () => { log.transactDurableProjection = method; } };
}
