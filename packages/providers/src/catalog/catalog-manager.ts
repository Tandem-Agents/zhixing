/**
 * 单一模型目录运行时协调器（设计 §4.1、§4.2）。
 *
 * 供宿主（`zhixing serve` / `ModelRuntimePort`）与无宿主首配 N 进程共用：
 * - 启动优先加载磁盘上已接纳且通过 Schema 校验的目录，异常/缺失时安全回落 `previous-catalog.json` 或随包基线
 *   （恢复只回退目标内容，绝不倒退已接纳的 TUF 信任根与元数据版本）；
 * - 后台默认每 6 小时检查一次，支持立即刷新与关闭自动检查；
 * - 进程内合并重复刷新请求，跨进程经 `acquireFileLock` 单写并持锁重读当前修订；
 * - 下载与验证不阻塞读口，原子激活后所有入口立即可读同一新修订；
 * - 断网、坏签名、过期、回滚或写中断均完整保留当前可用目录并记录脱敏状态。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeProviderErrorMessage } from "@zhixing-ai/core/resilience";
import { acquireFileLock } from "@zhixing-ai/core/persistence";
import {
  createModelCatalogPortFromBundle,
  type ModelCatalogPort,
} from "../catalog-port.js";
import { writeJsonAtomic } from "../internal/io.js";
import { BUILTIN_CURATED_CATALOG } from "./builtin-catalog.js";
import {
  type CatalogUpgradeNotice,
  type CuratedCatalogBundle,
} from "./schema.js";
import {
  DEFAULT_OFFICIAL_CATALOG_REPOSITORY,
  loadConfiguredCatalogRepository,
} from "./tuf/default-repository.js";
import {
  refreshCatalogWithTuf,
  verifyAcceptedDiskCatalog,
  type TufRepositorySource,
} from "./tuf/restricted-tuf-client.js";
import type { NetworkConfig } from "../types.js";

export const DEFAULT_CATALOG_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type CatalogSourceKind = "bundled" | "trusted-remote" | "recovered-previous";

export type CatalogRefreshStatusKind =
  | "idle"
  | "up-to-date"
  | "updated"
  | "offline"
  | "failed"
  | "disabled";

export interface CatalogManagerStatus {
  readonly source: CatalogSourceKind;
  readonly activeRevision: string;
  readonly publishedAt: string;
  readonly autoCheckEnabled: boolean;
  readonly repositoryConfigured: boolean;
  readonly repositoryMetadataUrl?: string;
  readonly lastCheckedAt?: string;
  readonly lastStatus: CatalogRefreshStatusKind;
  readonly lastError?: string;
  readonly rootVersion?: number;
  readonly upgradeNotice?: CatalogUpgradeNotice;
}

interface PersistedCatalogState {
  readonly schemaVersion: 1;
  readonly autoCheckEnabled: boolean;
  readonly lastCheckedAt?: string;
  readonly lastStatus: CatalogRefreshStatusKind;
  readonly lastError?: string;
  readonly lastAcceptedRevision?: string;
}

export interface ModelCatalogManagerOptions {
  readonly homeDir?: string;
  readonly storeDir?: string;
  readonly bundledCatalog?: CuratedCatalogBundle;
  /**
   * 可信 TUF 静态仓库源：
   * - 缺省（undefined）自动优先读取 `<storeDir>/repository-source.json`，否则绑定随包官方仓库源
   *   `DEFAULT_OFFICIAL_CATALOG_REPOSITORY`；
   * - 传入 `null` 仅用于显式离线纯随包基线模式。
   */
  readonly repository?: TufRepositorySource | null;
  readonly networkProxy?: NetworkConfig["proxy"];
  readonly autoCheckEnabled?: boolean;
  readonly autoCheckIntervalMs?: number;
  readonly now?: () => number;
  readonly customFetch?: typeof fetch;
  readonly writeInterceptor?: (
    stage: "metadata" | "candidate" | "active",
    name: string,
    bytes: Uint8Array,
  ) => Promise<void> | void;
}

export function resolveCatalogStoreDir(homeDir: string): string {
  return path.join(homeDir, "catalog");
}

export class ModelCatalogManager {
  readonly #storeDir: string;
  readonly #lockPath: string;
  readonly #statePath: string;
  readonly #bundledCatalog: CuratedCatalogBundle;
  readonly #explicitRepository?: TufRepositorySource | null;
  readonly #networkProxy?: NetworkConfig["proxy"];
  readonly #autoCheckIntervalMs: number;
  readonly #now: () => number;
  readonly #customFetch?: typeof fetch;
  readonly #writeInterceptor?: ModelCatalogManagerOptions["writeInterceptor"];

  #resolvedRepository?: TufRepositorySource;
  #autoCheckEnabled: boolean;
  #activeCatalog: CuratedCatalogBundle;
  #activePort: ModelCatalogPort;
  #source: CatalogSourceKind = "bundled";
  #lastCheckedAt?: string;
  #lastStatus: CatalogRefreshStatusKind = "idle";
  #lastError?: string;
  #rootVersion?: number;
  #inFlightRefresh?: Promise<CatalogRefreshResult>;
  #autoCheckTimer?: ReturnType<typeof setInterval>;
  #autoCheckAbort?: AbortController;
  #listeners = new Set<(port: ModelCatalogPort, status: CatalogManagerStatus) => void>();

  constructor(options: ModelCatalogManagerOptions) {
    if (!options.storeDir && !options.homeDir) {
      throw new Error("ModelCatalogManager requires homeDir or storeDir");
    }
    this.#storeDir = options.storeDir ?? resolveCatalogStoreDir(options.homeDir!);
    this.#lockPath = path.join(this.#storeDir, "catalog-refresh.lock");
    this.#statePath = path.join(this.#storeDir, "catalog-state.json");
    this.#bundledCatalog = options.bundledCatalog ?? BUILTIN_CURATED_CATALOG;
    this.#explicitRepository = options.repository;
    this.#networkProxy = options.networkProxy;
    if (options.repository === null) {
      this.#resolvedRepository = undefined;
    } else if (options.repository !== undefined) {
      this.#resolvedRepository = options.repository;
    } else {
      this.#resolvedRepository =
        options.networkProxy !== undefined
          ? { ...DEFAULT_OFFICIAL_CATALOG_REPOSITORY, networkProxy: options.networkProxy }
          : DEFAULT_OFFICIAL_CATALOG_REPOSITORY;
    }
    this.#autoCheckEnabled = options.autoCheckEnabled ?? true;
    this.#autoCheckIntervalMs =
      options.autoCheckIntervalMs ?? DEFAULT_CATALOG_AUTO_CHECK_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#customFetch = options.customFetch;
    this.#writeInterceptor = options.writeInterceptor;

    this.#activeCatalog = this.#bundledCatalog;
    this.#activePort = createModelCatalogPortFromBundle(this.#bundledCatalog);
  }

  get storeDir(): string {
    return this.#storeDir;
  }

  /** 当前原子生效的目录窄读口（与所有后端和终端入口同源）。 */
  port(): ModelCatalogPort {
    return this.#activePort;
  }

  status(): CatalogManagerStatus {
    return {
      source: this.#source,
      activeRevision: this.#activeCatalog.catalogRevision,
      publishedAt: this.#activeCatalog.publishedAt,
      autoCheckEnabled: this.#autoCheckEnabled,
      repositoryConfigured: Boolean(this.#resolvedRepository),
      ...(this.#resolvedRepository
        ? { repositoryMetadataUrl: this.#resolvedRepository.metadataBaseUrl }
        : {}),
      ...(this.#lastCheckedAt ? { lastCheckedAt: this.#lastCheckedAt } : {}),
      lastStatus: this.#lastStatus,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      ...(this.#rootVersion !== undefined ? { rootVersion: this.#rootVersion } : {}),
      ...(this.#activeCatalog.upgradeNotice
        ? { upgradeNotice: this.#activeCatalog.upgradeNotice }
        : {}),
    };
  }

  onUpdate(listener: (port: ModelCatalogPort, status: CatalogManagerStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 启动初始化：解析受控源配置并经真实 Ed25519 TUF 验签链加载已接纳目录（断网/损坏安全回落，绝不倒退信任根）。 */
  async initialize(): Promise<ModelCatalogPort> {
    await this.#resolveConfiguredRepositoryIfNeeded();
    await this.#reloadAcceptedFromDisk();
    await this.#loadStateFromDisk();
    return this.#activePort;
  }

  /** 是否已超过默认 6 小时自动检查间隔（仅在启用自动检查且配置了可信源时为 true）。 */
  isRefreshDue(): boolean {
    if (!this.#autoCheckEnabled || !this.#resolvedRepository) return false;
    if (!this.#lastCheckedAt) return true;
    const lastMs = Date.parse(this.#lastCheckedAt);
    if (!Number.isFinite(lastMs)) return true;
    return this.#now() - lastMs >= this.#autoCheckIntervalMs;
  }

  /** 仅在自动检查已开启且超过检查周期时执行一次非强制刷新。 */
  async checkIfDue(options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}): Promise<CatalogRefreshResult | undefined> {
    if (!this.isRefreshDue()) return undefined;
    return this.refresh({ force: false, ...options });
  }

  /**
   * 启动宿主周期后台检查（默认每 6 小时检查一次；定时器 `.unref()` 不阻塞进程退出，失败仅记状态不抛异常）。
   */
  startAutoCheck(options: {
    readonly checkOnStart?: boolean;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
  } = {}): void {
    this.stopAutoCheck();
    const abort = new AbortController();
    this.#autoCheckAbort = abort;
    const tick = () => {
      if (abort.signal.aborted) return;
      void this.checkIfDue({
        signal: abort.signal,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }).catch(() => {});
    };
    if (options.checkOnStart !== false) {
      queueMicrotask(tick);
    }
    const pollMs = Math.max(
      1_000,
      Math.min(options.pollIntervalMs ?? 30 * 60 * 1000, this.#autoCheckIntervalMs),
    );
    this.#autoCheckTimer = setInterval(tick, pollMs);
    this.#autoCheckTimer.unref?.();
  }

  /** 停止周期后台检查并中止未完成的后台检查请求。 */
  stopAutoCheck(): void {
    if (this.#autoCheckTimer) {
      clearInterval(this.#autoCheckTimer);
      this.#autoCheckTimer = undefined;
    }
    if (this.#autoCheckAbort) {
      this.#autoCheckAbort.abort();
      this.#autoCheckAbort = undefined;
    }
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    this.#autoCheckEnabled = enabled;
    if (!enabled && this.#lastStatus === "idle") {
      this.#lastStatus = "disabled";
    }
    await this.#persistStateBestEffort();
    this.#emit();
  }

  /**
   * 刷新可信远端目录：
   * - 进程内合并并发请求；
   * - 跨进程经 `acquireFileLock` 单写并在持锁后先重读磁盘当前修订；
   * - 失败/断网/验签失败时保留既有已接纳目录与 TUF 根，永不清空缓存。
   */
  async refresh(options: {
    readonly force?: boolean;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}): Promise<CatalogRefreshResult> {
    await this.#resolveConfiguredRepositoryIfNeeded();
    if (!options.force && !this.#autoCheckEnabled) {
      return {
        status: "disabled",
        changed: false,
        activeRevision: this.#activeCatalog.catalogRevision,
        port: this.#activePort,
        message: "自动检查更新已关闭；当前继续使用本地已接纳模型目录。",
      };
    }
    if (!this.#resolvedRepository) {
      return {
        status: "disabled",
        changed: false,
        activeRevision: this.#activeCatalog.catalogRevision,
        port: this.#activePort,
        message: "当前运行在显式离线纯随包基线模式，未启用远端目录更新。",
      };
    }
    if (this.#inFlightRefresh) {
      return this.#inFlightRefresh;
    }

    const task = this.#runRefreshLocked(options).finally(() => {
      if (this.#inFlightRefresh === task) {
        this.#inFlightRefresh = undefined;
      }
    });
    this.#inFlightRefresh = task;
    return task;
  }

  async #resolveConfiguredRepositoryIfNeeded(): Promise<void> {
    if (this.#explicitRepository !== undefined) return;
    const configured = await loadConfiguredCatalogRepository(this.#storeDir, this.#networkProxy);
    if (configured) {
      this.#resolvedRepository = configured;
    } else {
      this.#resolvedRepository =
        this.#networkProxy !== undefined
          ? { ...DEFAULT_OFFICIAL_CATALOG_REPOSITORY, networkProxy: this.#networkProxy }
          : DEFAULT_OFFICIAL_CATALOG_REPOSITORY;
    }
  }

  async #runRefreshLocked(options: {
    readonly force?: boolean;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<CatalogRefreshResult> {
    await fs.mkdir(this.#storeDir, { recursive: true, mode: 0o700 });
    const release = await acquireFileLock(this.#lockPath, {
      resourceName: "model-catalog-refresh",
      waitMs: 15_000,
      staleMs: 60_000,
    });
    try {
      // 持锁后先重读磁盘，吸收并发进程刚激活的新修订
      await this.#reloadAcceptedFromDisk();
      const previousRevision = this.#activeCatalog.catalogRevision;
      const checkedAt = new Date(this.#now()).toISOString();

      try {
        const outcome = await refreshCatalogWithTuf({
          storeDir: this.#storeDir,
          repository: this.#resolvedRepository!,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(this.#customFetch ? { customFetch: this.#customFetch } : {}),
          ...(this.#writeInterceptor ? { writeInterceptor: this.#writeInterceptor } : {}),
        });

        const changed = outcome.catalog.catalogRevision !== previousRevision;
        this.#activeCatalog = outcome.catalog;
        this.#activePort = createModelCatalogPortFromBundle(outcome.catalog);
        this.#source = "trusted-remote";
        this.#rootVersion = outcome.rootVersion;
        this.#lastCheckedAt = checkedAt;
        this.#lastStatus = changed ? "updated" : "up-to-date";
        this.#lastError = undefined;
        await this.#persistStateBestEffort();
        this.#emit();

        return {
          status: changed ? "updated" : "up-to-date",
          changed,
          activeRevision: outcome.catalog.catalogRevision,
          rootVersion: outcome.rootVersion,
          port: this.#activePort,
          message: changed
            ? `已更新可信模型目录至修订 ${outcome.catalog.catalogRevision}（根版本 v${outcome.rootVersion}）。`
            : `模型目录已是最新修订 ${outcome.catalog.catalogRevision}。`,
        };
      } catch (err) {
        // 刷新失败或写中断时，先从磁盘重读（只恢复经 TUF 验签的目标内容，绝不倒退已接纳 TUF 信任根）
        await this.#reloadAcceptedFromDisk();
        const rawMsg = err instanceof Error ? err.message : String(err);
        const sanitized = sanitizeProviderErrorMessage(rawMsg);
        const isOffline =
          /enotfound|econnrefused|econnreset|etimedout|network|fetch failed|timed out|offline|dns|ssrf|http 404/iu.test(
            rawMsg,
          );
        this.#lastCheckedAt = checkedAt;
        this.#lastStatus = isOffline ? "offline" : "failed";
        this.#lastError = sanitized;
        await this.#persistStateBestEffort();
        this.#emit();

        return {
          status: isOffline ? "offline" : "failed",
          changed: false,
          activeRevision: this.#activeCatalog.catalogRevision,
          ...(this.#rootVersion !== undefined ? { rootVersion: this.#rootVersion } : {}),
          port: this.#activePort,
          error: sanitized,
          message: isOffline
            ? `远端目录暂不可达，已保留本地模型目录（修订 ${this.#activeCatalog.catalogRevision}）。`
            : `可信目录更新校验未通过（${sanitized}），已保留原有可用目录（修订 ${this.#activeCatalog.catalogRevision}）。`,
        };
      }
    } finally {
      await release();
    }
  }

  async #reloadAcceptedFromDisk(): Promise<void> {
    // 显式离线纯随包模式（repository: null）不信任任何无固定根锚定的远端磁盘目录
    if (!this.#resolvedRepository) {
      this.#activeCatalog = this.#bundledCatalog;
      this.#activePort = createModelCatalogPortFromBundle(this.#bundledCatalog);
      this.#source = "bundled";
      return;
    }

    // 所有正式源（含默认官方源、repository-source.json 与显式传入源）一律按所选仓库的固定引导根锚定来源身份
    const verified = await verifyAcceptedDiskCatalog({
      storeDir: this.#storeDir,
      targetPath: this.#resolvedRepository.targetPath,
      pinnedBootstrapRootBytes: this.#resolvedRepository.bootstrapRootBytes,
    });

    if (verified.rootVersion !== undefined) {
      this.#rootVersion = verified.rootVersion;
    }

    if (verified.ok) {
      this.#activeCatalog = verified.catalog;
      this.#activePort = createModelCatalogPortFromBundle(verified.catalog);
      this.#source = verified.source;
      return;
    }

    // 磁盘目标缺失、来源根不匹配、未签名或篡改失配时安全回落随包基线（保留已接纳 TUF 根版本号，绝不倒退）
    this.#activeCatalog = this.#bundledCatalog;
    this.#activePort = createModelCatalogPortFromBundle(this.#bundledCatalog);
    this.#source = "bundled";
  }

  async #loadStateFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.#statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedCatalogState>;
      if (parsed && parsed.schemaVersion === 1) {
        if (typeof parsed.autoCheckEnabled === "boolean") {
          this.#autoCheckEnabled = parsed.autoCheckEnabled;
        }
        if (typeof parsed.lastCheckedAt === "string") {
          this.#lastCheckedAt = parsed.lastCheckedAt;
        }
        if (typeof parsed.lastStatus === "string") {
          this.#lastStatus = parsed.lastStatus as CatalogRefreshStatusKind;
        }
        if (typeof parsed.lastError === "string") {
          this.#lastError = parsed.lastError;
        }
      }
    } catch {
      // 首次无状态文件属正常
    }
  }

  async #persistStateBestEffort(): Promise<void> {
    const payload: PersistedCatalogState = {
      schemaVersion: 1,
      autoCheckEnabled: this.#autoCheckEnabled,
      ...(this.#lastCheckedAt ? { lastCheckedAt: this.#lastCheckedAt } : {}),
      lastStatus: this.#lastStatus,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      lastAcceptedRevision: this.#activeCatalog.catalogRevision,
    };
    try {
      await writeJsonAtomic(this.#statePath, payload);
    } catch {
      // 状态文件写入失败不影响已激活目录读口
    }
  }

  #emit(): void {
    const snapshotStatus = this.status();
    for (const listener of this.#listeners) {
      try {
        listener(this.#activePort, snapshotStatus);
      } catch {
        // 隔离单监听器异常
      }
    }
  }
}

export interface CatalogRefreshResult {
  readonly status: CatalogRefreshStatusKind;
  readonly changed: boolean;
  readonly activeRevision: string;
  readonly rootVersion?: number;
  readonly port: ModelCatalogPort;
  readonly error?: string;
  readonly message: string;
}
