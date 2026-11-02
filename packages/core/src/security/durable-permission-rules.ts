/**
 * 持久权限规则所有者
 *
 * 一个宿主进程内、一个权限目录只有一个所有者：context/global 规则的加载、校验、
 * 耐久写入与内存索引都在这里，同进程全部 PermissionStore 共享它，因此一处写入或
 * 撤销，其他运行时的后续快照与匹配立即可见，不靠文件戳猜测。跨进程的唯一写者由
 * 宿主端点与本机工作区 owner 租约这类进程寿命边界保证，不在本模块内。
 *
 * 有效性的权威：一条持久规则生效，当且仅当它已被接纳（直接发布的规则以写盘为接纳；
 * 显式批准以匹配的耐久决定为接纳）且不在撤销终结集合里。范围文件里的规则是接纳结果的
 * 物化；撤销先耐久记入终结集合、再从范围文件删除，所以删除失败或崩溃后重开，旧规则
 * 也不会再生效，任何重放都不能把已撤销的规则 id 写回。
 *
 * 显式批准的待生效记录与规则放在同一个范围文件里：赢得仲裁的决定先写待生效记录
 * （不生效），耐久决定提交后接纳（立即生效），物化把规则移入规则列表并在同一次原子写
 * 里删掉待生效记录；物化失败时已接纳项照常生效，由该文件的下一次写入补做。重开时
 * 待生效记录先不生效，交给宿主按耐久决定核对后再接纳。
 *
 * 写入顺序：先耐久落盘（临时文件 sync → 原子替换 → 目录同步），成功后才发布新的
 * 内存状态；写失败时内存不变并把错误交给调用方。Windows 上目录元数据由 NTFS 日志
 * 保证，`syncDirectory` 不做单独的目录同步。
 *
 * 读取：每个范围第一次使用时同步读一次文件，之后匹配只读内存。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { ensureDurableDirectory, replaceFile, syncDirectory } from "../persistence/index.js";
import type {
  PermissionContextId,
  PermissionRule,
  PermissionScope,
  TrustContribution,
} from "./types.js";

const STORAGE_VERSION = 1;
const GLOBAL_FILE = "global.json";
const REVOKED_FILE = "revoked.json";
/** 全局规则所在桶的内部键（不会与范围存储键冲突）。 */
export const GLOBAL_PERMISSION_BUCKET = "\u0000global";

/** 显式批准的待生效记录：带完整规则，以便重开后按耐久决定摘要核对并接纳。 */
export interface PendingPermissionApproval {
  readonly requestId: string;
  readonly conversationId?: string;
  /** job 指派来的沉淀：重开后按该任务日志的镜像核对。 */
  readonly taskId?: string;
  readonly assignmentId?: string;
  /** 与执行端耐久交互结果里的决定摘要同一算法。 */
  readonly decisionDigest: string;
  readonly rule: PermissionRule;
}

export type PermissionRulePublication = "published" | "exists" | "revoked";

export type PendingApprovalAcceptance =
  /** 规则已在范围文件里。 */
  | "materialized"
  /** 已接纳、已生效，物化写失败，由该范围文件的下一次写入补做。 */
  | "accepted"
  /** 规则 id 已被撤销终结，接纳无效。 */
  | "revoked"
  /** 没有该请求的待生效记录。 */
  | "missing";

export interface DurablePermissionRuleStoreOptions {
  /** 某个桶首次加载时发现待生效记录：交宿主按耐久决定核对（异步，不阻塞读取）。 */
  readonly onPendingLoaded?: (bucket: string, pending: readonly PendingPermissionApproval[]) => void;
}

/**
 * 磁盘 JSON 文件 schema。
 *
 * `contextStorageKey` 是范围的存储键，仅供人工查看；运行时范围身份由文件名决定。
 * `context` 记该范围的身份描述（工作区范围带绑定的设备与 bindingRef），供管理视图
 * 找回显示名称，不参与匹配。
 */
interface StorageFile {
  version: number;
  scope?: "global";
  contextStorageKey?: string;
  context?: PermissionContextId;
  contextPath?: string;
  rules: PermissionRule[];
  pending?: PendingPermissionApproval[];
}

interface RevokedFile {
  version: number;
  ruleIds: string[];
}

interface Bucket {
  /** 范围文件里已物化的规则（未滤撤销）。 */
  readonly rules: readonly PermissionRule[];
  /** 范围文件里的待生效记录（含内存里已接纳、尚未物化的）。 */
  readonly pending: readonly PendingPermissionApproval[];
  /** 已按耐久决定接纳的请求 id（只在内存；重开后由宿主重新核对）。 */
  readonly accepted: ReadonlySet<string>;
  /** 生效视图：已物化 ∪ 已接纳 − 已撤销。 */
  readonly effective: readonly PermissionRule[];
}

export class DurablePermissionRuleStore {
  readonly rootDir: string | null;
  readonly #buckets = new Map<string, Bucket>();
  readonly #onPendingLoaded: DurablePermissionRuleStoreOptions["onPendingLoaded"];
  #revoked: ReadonlySet<string> | undefined;
  // 同一所有者的写入串行执行：每次写都基于上一次已发布的状态
  #writes: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string | null, options: DurablePermissionRuleStoreOptions = {}) {
    this.rootDir = rootDir;
    this.#onPendingLoaded = options.onPendingLoaded;
  }

  /** 某范围生效的落盘规则（首次使用时同步读文件）。 */
  context(storageKey: string): readonly PermissionRule[] {
    return this.#bucket(storageKey).effective;
  }

  global(): readonly PermissionRule[] {
    return this.#bucket(GLOBAL_PERMISSION_BUCKET).effective;
  }

  /** 已加载的范围（撤销只在已读过的范围里找；管理面先 list 再撤销）。 */
  loadedContexts(): readonly string[] {
    return [...this.#buckets.keys()].filter((key) => key !== GLOBAL_PERMISSION_BUCKET);
  }

  /**
   * 有落盘文件的范围存储键（不含全局），按字典序；管理面分页用。只读目录文件名，
   * 不读文件内容。
   */
  async bucketKeys(): Promise<readonly string[]> {
    if (!this.rootDir) return [];
    const entries = await fsp.readdir(this.rootDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    return entries
      .filter((entry) => entry.endsWith(".json") && entry !== GLOBAL_FILE && entry !== REVOKED_FILE)
      .map((entry) => entry.slice(0, -".json".length))
      .sort();
  }

  isRevoked(ruleId: string): boolean {
    return this.#revokedSet().has(ruleId);
  }

  /** 某桶里尚未接纳的待生效记录（宿主重开后核对用）。 */
  unacceptedApprovals(bucket: string): readonly PendingPermissionApproval[] {
    const current = this.#bucket(bucket);
    return current.pending.filter((entry) => !current.accepted.has(entry.requestId));
  }

  addContextRule(storageKey: string, rule: PermissionRule): Promise<void> {
    return this.publish(storageKey, rule).then((outcome) => {
      if (outcome === "revoked") throw new Error(`Permission rule ${rule.id} has been revoked`);
    });
  }

  addGlobalRule(rule: PermissionRule): Promise<void> {
    return this.addContextRule(GLOBAL_PERMISSION_BUCKET, rule);
  }

  /**
   * 发布一条已接纳的规则（幂等）：同 id 同内容视为已存在；同 id 不同内容拒绝；
   * 已撤销的 id 不再写回。
   */
  publish(bucket: string, rule: PermissionRule): Promise<PermissionRulePublication> {
    return this.#serialize(async () => {
      if (this.#revokedSet().has(rule.id)) return "revoked";
      const current = this.#bucket(bucket);
      const existing = current.rules.find((entry) => entry.id === rule.id) ??
        current.pending.find((entry) => entry.rule.id === rule.id && current.accepted.has(entry.requestId))?.rule;
      if (existing) {
        if (!sameRuleContent(existing, rule)) {
          throw new Error(`Permission rule ${rule.id} already exists with different content`);
        }
        return "exists";
      }
      await this.#write(bucket, { ...current, rules: [...current.rules, rule] });
      return "published";
    });
  }

  /**
   * 写显式批准的待生效记录（不生效）。同一请求同一决定复用；尚未接纳的旧决定被替换；
   * 已接纳后换决定拒绝。写失败上抛，调用方据此让决定回到待确认。
   */
  preparePending(bucket: string, entry: PendingPermissionApproval): Promise<void> {
    return this.#serialize(async () => {
      if (this.#revokedSet().has(entry.rule.id)) {
        throw new Error(`Permission rule ${entry.rule.id} has been revoked`);
      }
      const current = this.#bucket(bucket);
      const existing = current.pending.find((item) => item.requestId === entry.requestId);
      if (existing) {
        if (existing.decisionDigest === entry.decisionDigest && sameRuleContent(existing.rule, entry.rule)) return;
        if (current.accepted.has(entry.requestId)) {
          throw new Error(`Permission approval ${entry.requestId} is already accepted with another decision`);
        }
      }
      await this.#write(bucket, {
        ...current,
        pending: [...current.pending.filter((item) => item.requestId !== entry.requestId), entry],
      });
    });
  }

  /**
   * 耐久决定已提交：接纳并立即生效，再尝试物化。物化写失败不上抛（决定已固定），
   * 返回 "accepted"，由该范围文件的下一次写入补做。
   */
  acceptPending(bucket: string, requestId: string): Promise<PendingApprovalAcceptance> {
    return this.#serialize(async () => {
      const current = this.#bucket(bucket);
      const entry = current.pending.find((item) => item.requestId === requestId);
      if (!entry) return "missing";
      if (this.#revokedSet().has(entry.rule.id)) {
        await this.#write(bucket, { ...current, pending: current.pending.filter((item) => item !== entry) })
          .catch(() => undefined);
        return "revoked";
      }
      const accepted = new Set(current.accepted).add(requestId);
      this.#buckets.set(bucket, this.#bucketView(current.rules, current.pending, accepted));
      try {
        await this.#write(bucket, this.#buckets.get(bucket)!);
        return "materialized";
      } catch {
        return "accepted";
      }
    });
  }

  /** 删掉某请求尚未接纳的待生效记录（决定改为别的、取消或过期）。 */
  discardPending(bucket: string, requestId: string): Promise<void> {
    return this.#serialize(async () => {
      const current = this.#bucket(bucket);
      if (current.accepted.has(requestId)) return;
      if (!current.pending.some((item) => item.requestId === requestId)) return;
      await this.#write(bucket, {
        ...current,
        pending: current.pending.filter((item) => item.requestId !== requestId),
      });
    });
  }

  /**
   * 撤销：先把规则 id 耐久记入撤销终结集合（之后任何读取、物化与接纳都不再让它生效），
   * 再从范围文件删除。终结已提交而删除失败时照常返回 true，残留由读取过滤、下一次
   * 写入清掉。
   */
  revoke(ruleId: string): Promise<boolean> {
    return this.#serialize(async () => {
      let owner: string | undefined;
      for (const [key, bucket] of this.#buckets) {
        if (bucket.effective.some((rule) => rule.id === ruleId)) {
          owner = key;
          break;
        }
      }
      if (owner === undefined && this.global().some((rule) => rule.id === ruleId)) {
        owner = GLOBAL_PERMISSION_BUCKET;
      }
      if (owner === undefined) return false;
      const revoked = new Set(this.#revokedSet()).add(ruleId);
      await this.#writeRevoked(revoked);
      this.#revoked = revoked;
      for (const [key, bucket] of this.#buckets) {
        this.#buckets.set(key, this.#bucketView(bucket.rules, bucket.pending, bucket.accepted));
      }
      await this.#write(owner, this.#buckets.get(owner)!).catch(() => undefined);
      return true;
    });
  }

  resetContext(storageKey: string): Promise<void> {
    return this.#serialize(async () => {
      await this.#write(storageKey, this.#bucketView([], [], new Set()));
    });
  }

  resetAll(): Promise<void> {
    return this.#serialize(async () => {
      if (this.rootDir && fs.existsSync(this.rootDir)) {
        for (const entry of await fsp.readdir(this.rootDir)) {
          // 撤销终结集合保留：重置后旧的批准或沉淀重放也不能写回已撤销的规则
          if (entry === REVOKED_FILE) continue;
          if (entry.endsWith(".json") || entry.endsWith(".tmp")) {
            await fsp.rm(path.join(this.rootDir, entry), { force: true });
          }
        }
        await syncDirectory(this.rootDir);
      }
      this.#buckets.clear();
      this.#buckets.set(GLOBAL_PERMISSION_BUCKET, this.#bucketView([], [], new Set()));
    });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(work, work);
    this.#writes = run.catch(() => undefined);
    return run;
  }

  #bucket(key: string): Bucket {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      const data = this.#readBucket(key);
      const scope: PermissionScope = key === GLOBAL_PERMISSION_BUCKET ? "global" : "context";
      const rules = data ? sanitizeStoredRules(data.rules ?? [], scope) : [];
      const pending = data ? sanitizePendingApprovals(data.pending, scope) : [];
      bucket = this.#bucketView(rules, pending, new Set());
      this.#buckets.set(key, bucket);
      if (pending.length > 0) this.#onPendingLoaded?.(key, pending);
    }
    return bucket;
  }

  #bucketView(
    rules: readonly PermissionRule[],
    pending: readonly PendingPermissionApproval[],
    accepted: ReadonlySet<string>,
  ): Bucket {
    // 空桶不需要撤销集合：没有授权规则的目录在首次派发时不多读一次文件
    if (rules.length === 0 && pending.length === 0) return { rules, pending, accepted, effective: [] };
    const revoked = this.#revokedSet();
    const effective = [
      ...rules.filter((rule) => !revoked.has(rule.id)),
      ...pending
        .filter((entry) => accepted.has(entry.requestId) && !revoked.has(entry.rule.id))
        .map((entry) => entry.rule),
    ];
    return { rules, pending, accepted, effective };
  }

  #revokedSet(): ReadonlySet<string> {
    if (!this.#revoked) {
      const data = this.rootDir ? readJsonFile<RevokedFile>(path.join(this.rootDir, REVOKED_FILE)) : undefined;
      this.#revoked = new Set(
        Array.isArray(data?.ruleIds) ? data.ruleIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [],
      );
    }
    return this.#revoked;
  }

  #readBucket(key: string): StorageFile | undefined {
    if (!this.rootDir) return undefined;
    return readStorageFile(path.join(this.rootDir, bucketFile(key)));
  }

  /**
   * 写一个桶并发布：已接纳的待生效记录在这次写里一并物化，已撤销的规则与待生效记录
   * 一并清掉。写失败时内存保持写前状态。
   */
  async #write(key: string, next: Pick<Bucket, "rules" | "pending" | "accepted">): Promise<void> {
    const revoked = this.#revokedSet();
    const materialized = next.pending.filter((entry) => next.accepted.has(entry.requestId));
    const rules = [
      ...next.rules,
      ...materialized.map((entry) => entry.rule).filter((rule) => !next.rules.some((existing) => existing.id === rule.id)),
    ].filter((rule) => !revoked.has(rule.id));
    const pending = next.pending.filter(
      (entry) => !next.accepted.has(entry.requestId) && !revoked.has(entry.rule.id),
    );
    if (this.rootDir) {
      const file = path.join(this.rootDir, bucketFile(key));
      if (key === GLOBAL_PERMISSION_BUCKET) {
        await writeJsonFileDurably(this.rootDir, file, {
          version: STORAGE_VERSION,
          scope: "global",
          rules: [...rules],
          ...(pending.length > 0 ? { pending: [...pending] } : {}),
        });
      } else {
        // contextPath 与范围描述取首条带有该字段的规则（同一范围内一致）
        const described = [...rules, ...pending.map((entry) => entry.rule)];
        const context = described.find((rule) => rule.contextId)?.contextId;
        await writeJsonFileDurably(this.rootDir, file, {
          version: STORAGE_VERSION,
          contextStorageKey: key,
          ...(context ? { context } : {}),
          contextPath: described.find((rule) => rule.contextPath)?.contextPath,
          rules: [...rules],
          ...(pending.length > 0 ? { pending: [...pending] } : {}),
        });
      }
    }
    this.#buckets.set(key, this.#bucketView(rules, pending, new Set()));
  }

  async #writeRevoked(revoked: ReadonlySet<string>): Promise<void> {
    if (!this.rootDir) return;
    await writeJsonFileDurably(this.rootDir, path.join(this.rootDir, REVOKED_FILE), {
      version: STORAGE_VERSION,
      ruleIds: [...revoked],
    } satisfies RevokedFile);
  }
}

function bucketFile(key: string): string {
  return key === GLOBAL_PERMISSION_BUCKET ? GLOBAL_FILE : `${key}.json`;
}

function sameRuleContent(left: PermissionRule, right: PermissionRule): boolean {
  return left.decision === right.decision &&
    left.scope === right.scope &&
    left.pattern.tool === right.pattern.tool &&
    left.pattern.argument === right.pattern.argument;
}

function sanitizePendingApprovals(raw: unknown, scope: PermissionScope): PendingPermissionApproval[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingPermissionApproval[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<PendingPermissionApproval>;
    if (typeof entry.requestId !== "string" || !entry.requestId) continue;
    if (typeof entry.decisionDigest !== "string" || !entry.decisionDigest) continue;
    const [rule] = sanitizeStoredRules([entry.rule], scope);
    if (!rule || rule.scope !== scope) continue;
    out.push({
      requestId: entry.requestId,
      ...(typeof entry.conversationId === "string" && entry.conversationId ? { conversationId: entry.conversationId } : {}),
      ...(typeof entry.taskId === "string" && entry.taskId ? { taskId: entry.taskId } : {}),
      ...(typeof entry.assignmentId === "string" && entry.assignmentId ? { assignmentId: entry.assignmentId } : {}),
      decisionDigest: entry.decisionDigest,
      rule,
    });
  }
  return out;
}

function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}


function readStorageFile(file: string): StorageFile | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as StorageFile;
  } catch {
    // 缺失或损坏：视为空，不中断程序
    return undefined;
  }
}

async function writeJsonFileDurably(directory: string, file: string, data: unknown): Promise<void> {
  await ensureDurableDirectory(directory);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf-8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await replaceFile(temporary, file);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

/**
 * 对从磁盘读取的规则做基本校验：过滤掉结构不对的条目，防止损坏数据传染到后续决策；
 * 同时恢复 contributors / contextId / contextPath 字段。
 *
 * scope：session / context / global 通过白名单；builtin 显式拒绝（只在内存注入）；
 * 其他未知 scope 一律跳过。global 文件不应包含其他作用域规则。
 */
export function sanitizeStoredRules(
  rules: unknown[],
  expectedScope: PermissionScope,
): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<PermissionRule>;
    if (
      typeof r.id !== "string" ||
      !r.pattern ||
      typeof r.pattern.tool !== "string" ||
      typeof r.pattern.argument !== "string" ||
      (r.decision !== "allow" && r.decision !== "deny") ||
      (r.scope !== "session" && r.scope !== "context" && r.scope !== "global")
    ) {
      continue;
    }
    if (r.scope !== expectedScope && expectedScope === "global") continue;
    out.push({
      id: r.id,
      pattern: { tool: r.pattern.tool, argument: r.pattern.argument },
      decision: r.decision,
      scope: r.scope,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      lastMatchedAt: typeof r.lastMatchedAt === "number" ? r.lastMatchedAt : 0,
      matchCount: typeof r.matchCount === "number" ? r.matchCount : 0,
      contextId: sanitizePermissionContextId(r.contextId),
      contextPath: typeof r.contextPath === "string" ? r.contextPath : undefined,
      contributors: sanitizeContributors(r.contributors),
    });
  }
  return out;
}

/** 单条结构错的贡献丢弃，不污染其余条目；非数组整体降级为 undefined。 */
function sanitizeContributors(raw: unknown): TrustContribution[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TrustContribution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Partial<TrustContribution>;
    if ((c.origin !== "user" && c.origin !== "steward") || typeof c.timestamp !== "number") continue;
    out.push({ origin: c.origin, timestamp: c.timestamp });
  }
  return out;
}

/** 不合法（非 object / kind 不在白名单 / 字段类型错）返回 undefined。 */
export function sanitizePermissionContextId(raw: unknown): PermissionContextId | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as { kind?: unknown; hash?: unknown; revision?: unknown; sceneId?: unknown };
  switch (c.kind) {
    case "main":
      return { kind: "main" };
    case "workspace": {
      if (typeof c.hash !== "string" || !c.hash) return undefined;
      return {
        kind: "workspace",
        hash: c.hash,
        ...(Number.isSafeInteger(c.revision) && (c.revision as number) > 0 ? { revision: c.revision as number } : {}),
      };
    }
    case "scene": {
      if (typeof c.sceneId !== "string" || !c.sceneId) return undefined;
      return { kind: "scene", sceneId: c.sceneId };
    }
    default:
      return undefined;
  }
}
