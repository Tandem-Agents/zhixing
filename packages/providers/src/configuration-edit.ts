import { runtimeConfigurationObservation } from "./configuration-logging.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireFileLock, ensureDurableDirectory, syncDirectory } from "@zhixing/core/persistence";
import { canonicalize } from "@zhixing/core/protocol";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { applyConfigPatch, assertAbsoluteWorkspaceRoot, assertNoConfigurationCommit, loadConfig, writeConfigUnlocked } from "./config-loader.js";
import { applyCredentialEdits, assertNoConfigurationEdit, commitCredentialsUnlocked, CONFIGURATION_EDIT_REF,
  loadCredentialsUnlocked, loadCredentialSnapshotUnlocked, mutationCoordinator, type CredentialSnapshotOptions } from "./credentials-loader.js";
import { writeJsonAtomic } from "./internal/io.js";
import type { ZhixingConfig, ZhixingCredentials } from "./types.js";
import type { LogRecordPort, LogSource } from "@zhixing/core/logging";

export const CONFIGURATION_LOG_SOURCE: LogSource = { id: "configuration", version: 1, events: {
  saved: { message: "配置保存已完成", level: "info", tier: "critical", fields: { scope: "text", selectionVersion: "text", selectionDigest: "text", omitted: "text" } },
  uncertain: { message: "配置保存尚未确认完成", level: "warn", tier: "critical", fields: { error: "text" } },
  recovered: { message: "配置保存恢复已完成", level: "info", tier: "critical", fields: { selectionVersion: "text", selectionDigest: "text", omitted: "text" } },
  effective: { message: "宿主已接纳运行配置", level: "info", tier: "critical", fields: { mode: "text", roles: { items: "text", maxItems: 8 }, selectionVersion: "text", selectionDigest: "text", omitted: "text" } },
} };
import { validateConfigSemantics } from "./config-validator.js";

type Snapshot = { config: ZhixingConfig; credentials: ZhixingCredentials };
type SecretUpdate = { readonly ref: SecretRef; readonly value: string };
type Options = CredentialSnapshotOptions & { readonly configPath: string; readonly records?: LogRecordPort };
interface SavedEdit extends Snapshot {
  readonly v: 1;
  readonly id: string;
  readonly configPath: string;
  readonly secretUpdates: readonly SecretUpdate[];
}

/** Config/Secret own one recoverable local save. Only its random id goes to disk in plaintext. */
export async function editConfiguration(expected: Snapshot, next: Snapshot, options: Options & {
  readonly scope?: "mcp";
  /** Prepare encrypted publication records after both source baselines have been checked. */
  readonly prepare?: (store: SecretStorePort, source: Snapshot) => Promise<readonly SecretUpdate[]>;
}): Promise<void> {
  await recoverConfigurationEdit(options);
  const configPath = path.resolve(options.configPath);
  const release = await lockConfiguration(configPath);
  try {
    await mutationCoordinator(options).runExclusive(async () => {
      assertNoConfigurationCommit(configPath);
      await assertNoConfigurationEdit(options.store);
      const currentConfig = loadConfig({ configPath, noAutoCreate: true });
      const beforeConfig = options.scope === "mcp" ? expected.config.mcp ?? {} : expected.config;
      const observedConfig = options.scope === "mcp" ? currentConfig.mcp ?? {} : currentConfig;
      if (canonicalize(beforeConfig) !== canonicalize(observedConfig)) throw new Error("配置在编辑期间已变更，未覆盖；请重新打开配置面板");
      const currentCredentials = await loadCredentialsUnlocked({ store: options.store });
      const credentials = applyCredentialEdits(currentCredentials,
        options.scope === "mcp" ? { mcp: expected.credentials.mcp ?? {} } : expected.credentials,
        options.scope === "mcp" ? { mcp: next.credentials.mcp ?? {} } : next.credentials);
      const config = options.scope === "mcp" ? { ...currentConfig, mcp: next.config.mcp ?? {} }
        : applyConfigPatch(currentConfig, next.config, "replace");
      assertAbsoluteWorkspaceRoot(config, configPath);
      if (validateConfigSemantics(config).length) throw new Error("配置含有不支持的字段，未保存；请通过配置入口修正");
      const edit: SavedEdit = { v: 1, id: randomUUID(), configPath, config, credentials,
        secretUpdates: await options.prepare?.(options.store, { config, credentials }) ?? [] };
      await options.store.put(CONFIGURATION_EDIT_REF, JSON.stringify(edit));
      // This marker is the durable acceptance point. No source has changed before it.
      try { await writeJsonAtomic(markerPath(configPath), { id: edit.id }); }
      catch (cause) {
        options.records?.record({ event: "uncertain", refs: [{ kind: "configurationEdit", id: edit.id }], result: "unknown", data: { error: "配置接纳未确认" } });
        throw new Error("配置接纳结果尚未确认；重新打开配置入口将核对保存状态，未逆向覆盖", { cause });
      }
      try { await applySavedEdit(edit, options.store); }
      catch (cause) {
        options.records?.record({ event: "uncertain", refs: [{ kind: "configurationEdit", id: edit.id }], result: "unknown", data: { error: "配置已接纳，保存收尾未确认" } });
        throw new Error("配置修改已接纳，保存收尾尚未完成；重新打开配置入口或重启将继续恢复", { cause });
      }
      options.records?.record(() => { const context = runtimeConfigurationObservation(edit.config); return { event: "saved", refs: [{ kind: "configurationEdit", id: edit.id }, { kind: "configuration", id: context.selectionDigest }], result: "success", data: { scope: options.scope ?? "configuration", ...context } }; });
    });
  } finally { await release(); }
}

/** Recover first, then issue the config and credentials from the same locked source pair. */
export async function loadConfigurationSnapshot(options: Options): Promise<Snapshot & { generation: string | null }> {
  await recoverConfigurationEdit(options);
  const release = await lockConfiguration(path.resolve(options.configPath));
  try {
    return await mutationCoordinator(options).runExclusive(async () => {
      assertNoConfigurationCommit(path.resolve(options.configPath));
      const secrets = await loadCredentialSnapshotUnlocked(options);
      return { config: loadConfig({ configPath: options.configPath }), ...secrets };
    });
  } finally { await release(); }
}

async function recoverConfigurationEdit(options: Options): Promise<void> {
  const encoded = await options.store.get(CONFIGURATION_EDIT_REF);
  if (!encoded) return;
  const observed = parseEdit(encoded);
  const release = await lockConfiguration(observed.configPath);
  try {
    await mutationCoordinator(options).runExclusive(async () => {
      const current = await options.store.get(CONFIGURATION_EDIT_REF);
      if (!current) return;
      const edit = parseEdit(current);
      if (edit.id !== observed.id || edit.configPath !== observed.configPath) throw new Error("配置保存已由另一编辑接续，请重试");
      const marker = await readMarker(edit.configPath);
      // A visible absence may be an unlink whose directory sync was interrupted.
      // Make that absence durable before retiring the only recovery material.
      if (!marker) { await syncDirectory(path.dirname(edit.configPath)); await options.store.delete(CONFIGURATION_EDIT_REF); return; }
      if (marker.id !== edit.id) throw new Error("配置恢复标识不一致，未改写配置或凭据");
      // A marker rename can be visible even when its original directory sync failed.
      await syncDirectory(path.dirname(edit.configPath));
      await applySavedEdit(edit, options.store);
      options.records?.record(() => { const context = runtimeConfigurationObservation(edit.config); return { event: "recovered", refs: [{ kind: "configurationEdit", id: edit.id }, { kind: "configuration", id: context.selectionDigest }], result: "success", data: context }; });
    });
  } finally { await release(); }
}

async function applySavedEdit(edit: SavedEdit, store: SecretStorePort): Promise<void> {
  for (const update of edit.secretUpdates) await store.put(update.ref, update.value);
  await commitCredentialsUnlocked(store, edit.credentials);
  await writeConfigUnlocked(edit.config, edit.configPath);
  await fs.promises.unlink(markerPath(edit.configPath));
  await syncDirectory(path.dirname(edit.configPath));
  await store.delete(CONFIGURATION_EDIT_REF);
}

function markerPath(configPath: string): string { return `${configPath}.edit.pending`; }
async function lockConfiguration(configPath: string) {
  await ensureDurableDirectory(path.dirname(configPath));
  return acquireFileLock(`${configPath}.write.lock`, { staleMs: 30_000, waitMs: 5_000, resourceName: "Configuration" });
}
async function readMarker(configPath: string): Promise<{ id: string } | undefined> {
  try { return JSON.parse(await fs.promises.readFile(markerPath(configPath), "utf8")) as { id: string }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function parseEdit(encoded: string): SavedEdit {
  const edit = JSON.parse(encoded) as SavedEdit;
  if (edit.v !== 1 || typeof edit.id !== "string" || !path.isAbsolute(edit.configPath) || !Array.isArray(edit.secretUpdates)) {
    throw new Error("配置恢复记录无效，未改写配置或凭据");
  }
  return edit;
}
