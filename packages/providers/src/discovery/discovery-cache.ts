/**
 * 隔离派生探测状态与发现缓存（设计 §2.2.4、§3.3、实施期注意项 #2）。
 *
 * 硬边界：
 * - 独立存放在 `<ZHIXING_HOME>/cache/model-discovery-cache.json`，绝不写入公开 `config.jsonc`，绝不入 `SecretStore`；
 * - 按 `connectionId + endpoint + adapter + credentialRevision` 严格隔离分区；
 *   换 Key、改地址或换协议立即产生新分区键使旧缓存失效；
 * - 仅存脱敏结构化字段（绝不缓存原始 SDK/HTTP 响应或明文秘密）；
 * - 后续成功替换旧失败；过期（默认 15 分钟）仅标 `freshness: "stale"`（上次结果/待刷新），
 *   绝不冒充新鲜失败或充当永久禁用凭据的权威；
 * - 使用跨进程文件锁 `acquireFileLock` 与原始字节原子写 `writeBytesAtomic`。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelAdapterId } from "@zhixing-ai/core";
import type { ProviderErrorSubcode } from "@zhixing-ai/core/resilience";
import { acquireFileLock } from "@zhixing-ai/core/persistence";
import type { DiscoveredModelRecord } from "../catalog/synthesis.js";
import type { ModelConnectionConfig, ProviderCredentialProjection } from "../types.js";
import { writeBytesAtomic } from "../internal/io.js";

export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 15 * 60 * 1000;
const DISCOVERY_CACHE_SCHEMA_VERSION = 1 as const;
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

export type DiscoveryProbeStatus =
  | "discovered"
  | "unsupported"
  | "auth-rejected"
  | "restricted"
  | "unreachable";

export interface DiscoveryPartitionIdentity {
  readonly connectionId: string;
  readonly endpoint: string;
  readonly adapter: ModelAdapterId;
  readonly credentialRevision: string;
}

export interface GenerationVerificationReceipt {
  readonly modelId: string;
  readonly status: "verified" | "truncated" | "empty" | "failed";
  readonly verifiedAt: string;
  readonly latencyMs: number;
  readonly userMessage: string;
  readonly stopReason?: string;
  readonly errorSubcode?: ProviderErrorSubcode;
}

export interface ConnectionDiscoveryWatermark {
  readonly partitionKey: string;
  /** 连接级单调失效代际：每次 `invalidateConnection` 严格 +1，用于拦截失效前发起的在途探测晚写（即使同毫秒）。 */
  readonly invalidationEpoch?: number;
  /** 仅当请求归属特定编辑会话时记录，使会话局部 `draftRevision` 不跨会话阻断新开编辑器的合法刷新。 */
  readonly sessionId?: string;
  readonly generation?: number;
  /** 最近已接纳探测的发起时间戳（毫秒），用于拦截更早发起、较晚返回的跨会话在途写回。 */
  readonly startedAtMs?: number;
  /** 最近显式失效时间戳（毫秒），拦截任何早于该时刻的陈旧写入。 */
  readonly invalidatedAtMs?: number;
  readonly checkedAtMs: number;
  readonly updatedAtMs: number;
}

export interface DiscoveryCacheWriteOptions {
  /** 可选调用会话 ID（如配置编辑器单次生命周期 UUID）；仅在同一会话内比较局部 `generation`。 */
  readonly sessionId?: string;
  /** 单调请求/草稿代际：与 `sessionId` 配对时仅在同会话内防乱序；无 `sessionId` 时仅限显式跨调用单调代际。 */
  readonly generation?: number;
  /** 探测发起时间（ISO 字符串），先于网络请求记录以拦截更早发起的慢请求晚写覆盖。 */
  readonly startedAt?: string;
  /** 发起探测前从缓存读取的连接失效代际；若期间发生 `invalidateConnection`，写入被原子拒绝。 */
  readonly expectedEpoch?: number;
  /** 可选 CAS 期望当前分区键（不匹配则跳过晚写）。 */
  readonly expectedPartitionKey?: string;
}

export interface ConnectionDiscoveryFactsSnapshot {
  readonly models: readonly DiscoveredModelRecord[];
  readonly authoritativeNativeFacts: boolean;
  readonly checkedAt: string;
  readonly partitionKey: string;
}

export interface DiscoveryCacheEntry {
  readonly partitionKey: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly adapter: ModelAdapterId;
  readonly credentialRevision: string;
  readonly status: DiscoveryProbeStatus;
  readonly checkedAt: string;
  readonly generation?: number;
  readonly emptyList?: boolean;
  readonly authoritativeNativeFacts?: boolean;
  readonly models?: readonly DiscoveredModelRecord[];
  readonly errorSubcode?: ProviderErrorSubcode;
  readonly userMessage: string;
  readonly proxyRoute?: "inherit" | "direct";
  readonly generationVerifications?: Readonly<Record<string, GenerationVerificationReceipt>>;
}

export interface DiscoveryCacheReadResult {
  readonly entry: DiscoveryCacheEntry;
  readonly freshness: "fresh" | "stale";
  readonly ageMs: number;
  /** 面向展示的时效提示：新鲜结果原样，过期结果显式标注“上次结果（待刷新）”。 */
  readonly freshnessNote: string;
}

interface DiscoveryCacheFile {
  readonly schemaVersion: 1;
  readonly entries: Record<string, DiscoveryCacheEntry>;
  readonly watermarks: Record<string, ConnectionDiscoveryWatermark>;
}

export function resolveDiscoveryCachePath(homeDir: string): string {
  return path.join(homeDir, "cache", "model-discovery-cache.json");
}

/**
 * 计算不含明文秘密的凭据修订指纹：
 * - 免密模式返回 `"none"`；
 * - 密钥/自定义头模式对模式、头名与密钥做单向 SHA-256 截断摘要，换 Key 即变且绝不回显原秘密。
 */
export function computeCredentialRevisionToken(input: {
  readonly authMode: "none" | "api-key" | "header";
  readonly headerName?: string;
  readonly secretValue?: string;
  readonly explicitRevision?: string;
}): string {
  if (input.authMode === "none") return "none";
  if (input.explicitRevision) return `rev:${input.explicitRevision}`;
  const material = `${input.authMode}\0${(input.headerName ?? "").toLowerCase()}\0${input.secretValue ?? ""}`;
  const digest = crypto.createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24);
  return `sha256:${digest}`;
}

/** 规范化公开脱敏端点字符串（去尾斜杠、去 userinfo/query/hash），防止敏感片段进入缓存键或展示。 */
export function sanitizeEndpointForCache(rawEndpoint: string): string {
  try {
    const parsed = new URL(rawEndpoint.trim());
    const cleanPath = parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.origin.toLowerCase()}${cleanPath}`;
  } catch {
    return rawEndpoint.trim().replace(/[?#].*$/u, "").replace(/\/+$/u, "");
  }
}

export function computeDiscoveryPartitionKey(id: DiscoveryPartitionIdentity): string {
  const safeEndpoint = sanitizeEndpointForCache(id.endpoint);
  const raw = `${id.connectionId}\0${safeEndpoint}\0${id.adapter}\0${id.credentialRevision}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

export class ModelDiscoveryCache {
  readonly #cachePath: string;
  readonly #lockPath: string;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: {
    readonly homeDir?: string;
    readonly cachePath?: string;
    readonly ttlMs?: number;
    readonly now?: () => number;
  }) {
    if (!options.cachePath && !options.homeDir) {
      throw new Error("ModelDiscoveryCache requires homeDir or cachePath");
    }
    this.#cachePath = options.cachePath ?? resolveDiscoveryCachePath(options.homeDir!);
    this.#lockPath = `${this.#cachePath}.lock`;
    this.#ttlMs = options.ttlMs ?? DEFAULT_DISCOVERY_CACHE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  get cachePath(): string {
    return this.#cachePath;
  }

  /** 读取某连接当前的单调失效代际（供探测/验证在发请求前快照，用于拒绝失效前在途写回）。 */
  async readConnectionEpoch(connectionId: string): Promise<number> {
    const data = await this.#readFileSafe();
    return data.watermarks[connectionId]?.invalidationEpoch ?? 0;
  }

  async read(identity: DiscoveryPartitionIdentity): Promise<DiscoveryCacheReadResult | undefined> {
    const data = await this.#readFileSafe();
    const key = computeDiscoveryPartitionKey(identity);
    const entry = data.entries[key];
    if (!entry) return undefined;
    // 防御式二次核对分区四元组
    if (
      entry.connectionId !== identity.connectionId ||
      entry.endpoint !== sanitizeEndpointForCache(identity.endpoint) ||
      entry.adapter !== identity.adapter ||
      entry.credentialRevision !== identity.credentialRevision
    ) {
      return undefined;
    }
    const checkedMs = Date.parse(entry.checkedAt);
    const ageMs = Number.isFinite(checkedMs) ? Math.max(0, this.#now() - checkedMs) : Number.POSITIVE_INFINITY;
    const freshness: "fresh" | "stale" = ageMs <= this.#ttlMs ? "fresh" : "stale";
    return {
      entry,
      freshness,
      ageMs,
      freshnessNote:
        freshness === "fresh"
          ? "最新探测结果"
          : "上次结果（已过期，待刷新；不作为当前失败或禁用依据）",
    };
  }

  /**
   * 写入最新探测结果（分维防晚写闸门：连接失效代际 × 会话局部草稿代际 × 跨会话发起/完成时序）：
   * - 连接失效后，失效前发起的在途旧探测（即使同毫秒完成）一律被 `invalidationEpoch` / `invalidatedAtMs` 拦截；
   * - 同编辑会话内，较旧 `draftRevision` 晚写被拒；重开编辑器或新会话的合法刷新不被上一会话的局部计数器阻断；
   * - 跨会话并发中，更早发起的慢请求（`startedAt` 更早）不能覆盖更新发起并已落盘的结果；
   * - 合法新写入自动清理同连接旧分区，后续成功替换旧失败。
   */
  async writeProbeResult(
    identity: DiscoveryPartitionIdentity,
    payload: Omit<
      DiscoveryCacheEntry,
      "partitionKey" | "connectionId" | "endpoint" | "adapter" | "credentialRevision" | "generationVerifications" | "generation"
    >,
    options: DiscoveryCacheWriteOptions = {},
  ): Promise<DiscoveryCacheEntry | undefined> {
    return this.#withLock(async () => {
      const data = await this.#readFileSafe();
      const safeEndpoint = sanitizeEndpointForCache(identity.endpoint);
      const key = computeDiscoveryPartitionKey(identity);
      const existingWm = data.watermarks[identity.connectionId];
      const parsedCheckedAt = Date.parse(payload.checkedAt);
      const incomingCheckedAtMs = Number.isFinite(parsedCheckedAt) ? parsedCheckedAt : this.#now();
      const parsedStartedAt =
        options.startedAt !== undefined ? Date.parse(options.startedAt) : Number.NaN;
      const incomingStartedAtMs = Number.isFinite(parsedStartedAt) ? parsedStartedAt : undefined;

      if (
        this.#shouldRejectWrite(existingWm, {
          incomingCheckedAtMs,
          incomingStartedAtMs,
          options,
        })
      ) {
        return undefined;
      }

      const existingSamePartition = data.entries[key];

      // 清理同连接下已过时的其他分区键（仅在通过防晚写闸门后执行）
      for (const [existingKey, existingEntry] of Object.entries(data.entries)) {
        if (existingEntry.connectionId === identity.connectionId && existingKey !== key) {
          delete data.entries[existingKey];
        }
      }

      const nextEpoch = existingWm?.invalidationEpoch ?? 0;
      const entry: DiscoveryCacheEntry = {
        partitionKey: key,
        connectionId: identity.connectionId,
        endpoint: safeEndpoint,
        adapter: identity.adapter,
        credentialRevision: identity.credentialRevision,
        ...payload,
        ...(options.generation !== undefined ? { generation: options.generation } : {}),
        ...(existingSamePartition?.generationVerifications
          ? { generationVerifications: existingSamePartition.generationVerifications }
          : {}),
      };
      data.entries[key] = entry;
      data.watermarks[identity.connectionId] = {
        partitionKey: key,
        invalidationEpoch: nextEpoch,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.generation !== undefined ? { generation: options.generation } : {}),
        ...(incomingStartedAtMs !== undefined
          ? { startedAtMs: Math.max(incomingStartedAtMs, existingWm?.startedAtMs ?? 0) }
          : existingWm?.startedAtMs !== undefined
            ? { startedAtMs: Math.max(incomingCheckedAtMs, existingWm.startedAtMs) }
            : {}),
        ...(existingWm?.invalidatedAtMs !== undefined
          ? { invalidatedAtMs: existingWm.invalidatedAtMs }
          : {}),
        checkedAtMs: Math.max(incomingCheckedAtMs, existingWm?.checkedAtMs ?? 0),
        updatedAtMs: this.#now(),
      };
      this.#pruneEntries(data.entries);
      await this.#writeFileAtomic(data);
      return entry;
    });
  }

  /** 记录某模型在当前分区下的可选生成式验证结果（与列表发现状态严格分离，受同一套防晚写闸门约束）。 */
  async recordGenerationVerification(
    identity: DiscoveryPartitionIdentity,
    receipt: GenerationVerificationReceipt,
    options: DiscoveryCacheWriteOptions = {},
  ): Promise<boolean> {
    return this.#withLock(async () => {
      const data = await this.#readFileSafe();
      const safeEndpoint = sanitizeEndpointForCache(identity.endpoint);
      const key = computeDiscoveryPartitionKey(identity);
      const existingWm = data.watermarks[identity.connectionId];
      const parsedVerifiedAt = Date.parse(receipt.verifiedAt);
      const incomingMs = Number.isFinite(parsedVerifiedAt) ? parsedVerifiedAt : this.#now();
      const parsedStartedAt =
        options.startedAt !== undefined ? Date.parse(options.startedAt) : Number.NaN;
      const incomingStartedAtMs = Number.isFinite(parsedStartedAt) ? parsedStartedAt : undefined;

      if (
        this.#shouldRejectWrite(existingWm, {
          incomingCheckedAtMs: incomingMs,
          incomingStartedAtMs,
          options,
        })
      ) {
        return false;
      }

      // 若切换到新分区，清理同连接旧分区
      for (const [existingKey, existingEntry] of Object.entries(data.entries)) {
        if (existingEntry.connectionId === identity.connectionId && existingKey !== key) {
          delete data.entries[existingKey];
        }
      }

      const existing = data.entries[key];
      const nextVerifications: Record<string, GenerationVerificationReceipt> = {
        ...(existing?.generationVerifications ?? {}),
        [receipt.modelId]: receipt,
      };

      if (existing) {
        data.entries[key] = {
          ...existing,
          generationVerifications: nextVerifications,
        };
      } else {
        data.entries[key] = {
          partitionKey: key,
          connectionId: identity.connectionId,
          endpoint: safeEndpoint,
          adapter: identity.adapter,
          credentialRevision: identity.credentialRevision,
          status: "unsupported",
          checkedAt: receipt.verifiedAt,
          ...(options.generation !== undefined ? { generation: options.generation } : {}),
          userMessage: "尚未执行列表发现；已记录可选生成验证结果。",
          generationVerifications: nextVerifications,
        };
      }
      data.watermarks[identity.connectionId] = {
        partitionKey: key,
        invalidationEpoch: existingWm?.invalidationEpoch ?? 0,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.generation !== undefined ? { generation: options.generation } : {}),
        ...(incomingStartedAtMs !== undefined
          ? { startedAtMs: Math.max(incomingStartedAtMs, existingWm?.startedAtMs ?? 0) }
          : existingWm?.startedAtMs !== undefined
            ? { startedAtMs: Math.max(incomingMs, existingWm.startedAtMs) }
            : {}),
        ...(existingWm?.invalidatedAtMs !== undefined
          ? { invalidatedAtMs: existingWm.invalidatedAtMs }
          : {}),
        checkedAtMs: Math.max(incomingMs, existingWm?.checkedAtMs ?? 0),
        updatedAtMs: this.#now(),
      };
      this.#pruneEntries(data.entries);
      await this.#writeFileAtomic(data);
      return true;
    });
  }

  /**
   * 主动使某连接的全部缓存分区失效，并严格递增该连接的 `invalidationEpoch` 与记录失效时刻：
   * - 失效前发起的在途旧探测（无论何时返回、即使在同毫秒内）都会被拒绝；
   * - 失效后由新编辑会话或新请求发起的合法发现（即使 `draftRevision=0`）不被旧草稿计数器阻断。
   */
  async invalidateConnection(
    connectionId: string,
    options: {
      readonly sessionId?: string;
      readonly generation?: number;
      readonly nowMs?: number;
    } = {},
  ): Promise<void> {
    await this.#withLock(async () => {
      const data = await this.#readFileSafe();
      for (const [key, entry] of Object.entries(data.entries)) {
        if (entry.connectionId === connectionId) {
          delete data.entries[key];
        }
      }
      const prev = data.watermarks[connectionId];
      const nowMs = Math.max(this.#now(), options.nowMs ?? 0);
      const nextEpoch = (prev?.invalidationEpoch ?? 0) + 1;
      data.watermarks[connectionId] = {
        partitionKey: "",
        invalidationEpoch: nextEpoch,
        invalidatedAtMs: nowMs,
        startedAtMs: nowMs,
        checkedAtMs: Math.max(nowMs, prev?.checkedAtMs ?? 0),
        updatedAtMs: nowMs,
        ...(options.sessionId !== undefined && options.generation !== undefined
          ? { sessionId: options.sessionId, generation: options.generation }
          : {}),
      };
      await this.#writeFileAtomic(data);
    });
  }

  #shouldRejectWrite(
    existingWm: ConnectionDiscoveryWatermark | undefined,
    incoming: {
      readonly incomingCheckedAtMs: number;
      readonly incomingStartedAtMs?: number;
      readonly options: DiscoveryCacheWriteOptions;
    },
  ): boolean {
    if (!existingWm) return false;
    const { options, incomingCheckedAtMs, incomingStartedAtMs } = incoming;

    // 1. 连接失效代际闸门：失效前发起的在途请求（即使同毫秒）一律拦截
    const currentEpoch = existingWm.invalidationEpoch ?? 0;
    if (options.expectedEpoch !== undefined && options.expectedEpoch < currentEpoch) {
      return true;
    }

    // 2. 失效时间戳闸门：拦截早于显式失效时刻的陈旧写入（含手工时间戳无 expectedEpoch 路径）
    const orderMs = incomingStartedAtMs ?? incomingCheckedAtMs;
    if (existingWm.invalidatedAtMs !== undefined && orderMs < existingWm.invalidatedAtMs) {
      return true;
    }

    // 3. 会话内局部草稿代际闸门：仅在同一 sessionId（或双方均无 sessionId 的显式单调调用）内比较 generation，
    //    绝不用上一个编辑会话的 draftRevision 拒绝新开编辑器的 draftRevision=0
    const comparableGenerationScope =
      (options.sessionId !== undefined && existingWm.sessionId === options.sessionId) ||
      (options.sessionId === undefined && existingWm.sessionId === undefined);
    if (
      comparableGenerationScope &&
      options.generation !== undefined &&
      existingWm.generation !== undefined &&
      options.generation < existingWm.generation
    ) {
      return true;
    }

    // 4. 跨会话发起时序闸门：更早发起的慢请求不得覆盖更新发起并已落盘的结果
    if (
      incomingStartedAtMs !== undefined &&
      existingWm.startedAtMs !== undefined &&
      incomingStartedAtMs < existingWm.startedAtMs
    ) {
      return true;
    }

    // 5. 完成时间戳回退闸门（仅在未显式推进同域代际时判定，允许明确更高代际覆盖）
    const strictlyNewerGeneration =
      comparableGenerationScope &&
      options.generation !== undefined &&
      existingWm.generation !== undefined &&
      options.generation > existingWm.generation;
    if (!strictlyNewerGeneration && incomingCheckedAtMs < existingWm.checkedAtMs) {
      return true;
    }

    // 6. 可选分区 CAS 期望校验
    if (
      options.expectedPartitionKey !== undefined &&
      existingWm.partitionKey.length > 0 &&
      existingWm.partitionKey !== options.expectedPartitionKey
    ) {
      return true;
    }

    return false;
  }

  /**
   * 按当前生效的连接表与凭据投影读取可安全进入运行侧三层合成的已发现事实快照：
   * - 仅命中精确 `(connectionId, endpoint, adapter, credentialRevision)` 分区；
   * - 仅采纳 `status === "discovered"` 且含模型条目的发现事实，绝不将过期失败作为禁用权威；
   * - 绝不暴露任何明文秘密。
   */
  async loadConnectionDiscoveryFacts(
    connections: Readonly<Record<string, ModelConnectionConfig>>,
    credentials: ProviderCredentialProjection,
  ): Promise<Readonly<Record<string, ConnectionDiscoveryFactsSnapshot>>> {
    const data = await this.#readFileSafe();
    const result: Record<string, ConnectionDiscoveryFactsSnapshot> = {};
    for (const [connectionId, conn] of Object.entries(connections)) {
      const secretValue =
        conn.auth.mode === "api-key" || conn.auth.mode === "header"
          ? credentials.modelSecrets?.[conn.auth.secretRef]?.value
          : undefined;
      const credentialRevision = computeCredentialRevisionToken({
        authMode: conn.auth.mode,
        headerName: conn.auth.mode === "header" ? conn.auth.headerName : undefined,
        secretValue,
      });
      const identity: DiscoveryPartitionIdentity = {
        connectionId,
        endpoint: conn.endpoint,
        adapter: conn.adapter,
        credentialRevision,
      };
      const key = computeDiscoveryPartitionKey(identity);
      const entry = data.entries[key];
      if (!entry) continue;
      if (
        entry.connectionId !== connectionId ||
        entry.endpoint !== sanitizeEndpointForCache(conn.endpoint) ||
        entry.adapter !== conn.adapter ||
        entry.credentialRevision !== credentialRevision
      ) {
        continue;
      }
      if (entry.status !== "discovered" || !entry.models || entry.models.length === 0) {
        continue;
      }
      result[connectionId] = {
        models: entry.models,
        authoritativeNativeFacts: Boolean(entry.authoritativeNativeFacts),
        checkedAt: entry.checkedAt,
        partitionKey: entry.partitionKey,
      };
    }
    return result;
  }

  async #readFileSafe(): Promise<DiscoveryCacheFile> {
    try {
      const raw = await fs.readFile(this.#cachePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) {
        return { schemaVersion: DISCOVERY_CACHE_SCHEMA_VERSION, entries: {}, watermarks: {} };
      }
      const parsed = JSON.parse(raw) as Partial<DiscoveryCacheFile>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.schemaVersion !== DISCOVERY_CACHE_SCHEMA_VERSION ||
        !parsed.entries ||
        typeof parsed.entries !== "object"
      ) {
        return { schemaVersion: DISCOVERY_CACHE_SCHEMA_VERSION, entries: {}, watermarks: {} };
      }
      const watermarks =
        parsed.watermarks && typeof parsed.watermarks === "object" && !Array.isArray(parsed.watermarks)
          ? { ...parsed.watermarks }
          : {};
      return {
        schemaVersion: DISCOVERY_CACHE_SCHEMA_VERSION,
        entries: { ...parsed.entries },
        watermarks,
      };
    } catch {
      return { schemaVersion: DISCOVERY_CACHE_SCHEMA_VERSION, entries: {}, watermarks: {} };
    }
  }

  async #writeFileAtomic(data: DiscoveryCacheFile): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
    if (bytes.byteLength > MAX_CACHE_BYTES) {
      // 超出容量上限时仅保留最新条目，防止大网关列表膨胀磁盘
      const sorted = Object.entries(data.entries).sort(
        (a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt),
      );
      const trimmed: Record<string, DiscoveryCacheEntry> = {};
      for (const [k, v] of sorted.slice(0, 16)) {
        trimmed[k] = v;
      }
      await writeBytesAtomic(
        this.#cachePath,
        Buffer.from(
          JSON.stringify(
            {
              schemaVersion: DISCOVERY_CACHE_SCHEMA_VERSION,
              entries: trimmed,
              watermarks: data.watermarks,
            },
            null,
            2,
          ) + "\n",
          "utf8",
        ),
      );
      return;
    }
    await writeBytesAtomic(this.#cachePath, bytes);
  }

  #pruneEntries(entries: Record<string, DiscoveryCacheEntry>): void {
    const keys = Object.keys(entries);
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    const sorted = Object.entries(entries).sort(
      (a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt),
    );
    for (const [k] of sorted.slice(MAX_CACHE_ENTRIES)) {
      delete entries[k];
    }
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(this.#lockPath, {
      resourceName: "model-discovery-cache",
      waitMs: 10_000,
      staleMs: 30_000,
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}
