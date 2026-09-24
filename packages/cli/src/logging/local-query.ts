import path from "node:path";
import { LOG_SEARCH, LOG_READ, LogStoreNotInitializedError } from "@zhixing/core/logging/application";
import type { LogFilter, LogPage } from "@zhixing/core/logging";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import { createLogAccess, createLocalLogProductApi, LOCAL_LOG_OWNER } from "./access.js";

/** Existing local consumers use the same authorization, page and physical budgets. */
export async function queryLocalLogs(home: string, filter: LogFilter, cursor?: string): Promise<LogPage & { detail?: unknown }> {
  const capacity = createDeviceCapacityRuntime(path.resolve(home), { createDirectory: false });
  const access = createLogAccess(path.resolve(home), capacity.arbiter);
  try {
    const api = createLocalLogProductApi(access), context = () => LOCAL_LOG_OWNER;
    try { return await api.query(LOG_SEARCH, { context, request: { filter, cursor } }); }
    catch (error) {
      if (!(error instanceof LogStoreNotInitializedError) || cursor) throw error;
      const catalog = await api.query(LOG_READ, { context, request: { address: "zxlog-local:legacy/catalog", view: "overview" } });
      const entries = (catalog.detail as { entries?: { address: string }[] })?.entries;
      if (!entries?.length) return catalog;
      // Read a bounded first legacy page. Other files and continuation retain explicit locators.
      const legacy = await api.query(LOG_READ, { context, request: { address: entries[0]!.address, view: "detail" } });
      return { ...legacy, detail: { catalog: catalog.detail, evidence: legacy.detail, address: entries[0]!.address } };
    }
  } finally { await access.close(); }
}
