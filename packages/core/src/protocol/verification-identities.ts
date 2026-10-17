import type { DeviceIdentity } from "../contracts/index.js";
import { AsyncLocalStorage } from "node:async_hooks";

const UNTRUSTED_DEVICE = "Protocol signature belongs to an untrusted device";
interface StepCache {
  readonly source: string | undefined;
  readonly identities: Map<string, DeviceIdentity>;
  readonly attempted: Set<string>;
}
const verificationStep = new AsyncLocalStorage<Map<ProtocolVerificationIdentityCache, StepCache>>();
// Preserve a resolver's source/capacity failure through validation catch blocks
// without teaching protocol validators about storage or acquiring any new lock.
const identityResolutionFailures = new WeakSet<object>();

/** Retry only a pure validator or an attempt-local delta builder. Previously
 * completed records and effects are outside this callback. Pins last for this
 * step, so a legal multi-signer object cannot evict its own verification keys. */
export async function verifyProtocolStep<T>(operation: () => T | Promise<T>, owner?: ProtocolVerificationIdentityCache): Promise<T> {
  return verificationStep.run(new Map(), async () => {
    for (;;) {
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof ProtocolIdentityNotLoaded) || owner && error.cache !== owner) throw error;
        await error.cache.resolveMissingOnce(error);
      }
    }
  });
}

/**
 * 验签身份尚未载入本进程缓存。它从不表示验签通过：纯校验步骤在已验来源上按 keyId
 * 精确补齐，再重跑该未提交步骤。同源使用当前绑定视图；跨源只作非阻塞读取。
 * 找不到即按原有不受信失败。未包在这类边界里的调用方看到的是普通的不受信拒绝。
 */
export class ProtocolIdentityNotLoaded extends TypeError {
  constructor(readonly keyId: string, readonly cache: ProtocolVerificationIdentityCache) {
    super(`${UNTRUSTED_DEVICE} (verification identity is not loaded)`);
    this.name = "ProtocolIdentityNotLoaded";
  }
}

/** 校验器里“任何异常都视为记录无效”的 catch 必须先放行补齐信号，否则合法历史记录会被永久判错。 */
export function rethrowUnloadedProtocolIdentity(error: unknown): void {
  if (error instanceof ProtocolIdentityNotLoaded ||
      typeof error === "object" && error !== null && identityResolutionFailures.has(error)) throw error;
}

export function untrustedProtocolSignature(): TypeError {
  return new TypeError(UNTRUSTED_DEVICE);
}

/**
 * 按 keyId 精确解析一个已验证的公开身份；在读取方自己的日志边界内执行，返回 undefined 表示
 * 信任来源里没有这个身份。解析方必须复用同源已验视图，不能重入同一日志锁；
 * 跨源尚未准备或锁忙时返回背压，由持锁步骤退出后再准备。
 */
export type ProtocolIdentityResolver = (keyId: string, signal: ProtocolIdentityNotLoaded) =>
  Promise<DeviceIdentity | undefined>;

/**
 * home 级的已验公开身份缓存，只存正向结果：
 * - 当前信任成员、当前签发密钥与本机受保护身份常驻（数量即当前功能规模）；
 * - 历史身份（已撤销设备、换钥前的签发密钥）按需精确补齐，按最近使用保留有限条数；
 * - 不缓存“不受信”结果，同一 keyId 不允许被另一把公钥静默替换；
 * - 绑定信任来源（权威日志身份），来源变化时整体作废。
 * 缓存只回答“这个签名身份是谁”，当前授权仍由各自的信任/授权检查裁决。
 */
export class ProtocolVerificationIdentityCache {
  readonly #resident = new Map<string, DeviceIdentity>();
  readonly #historical = new Map<string, DeviceIdentity>();
  readonly #protected = new Set<string>();
  #source: string | undefined;
  #resolver: ProtocolIdentityResolver | undefined;
  #sourceReader: (() => string | undefined) | undefined;

  constructor(readonly historicalCapacity = 256) {
    if (!Number.isSafeInteger(historicalCapacity) || historicalCapacity < 1) {
      throw new TypeError("Verification cache capacity is invalid");
    }
  }

  /** 信任来源（权威日志身份）改变时丢弃全部旧条目；同一来源重复绑定不影响缓存。 */
  bindSource(sourceId: string): void {
    if (sourceId.length === 0) throw new TypeError("Verification trust source is invalid");
    if (this.#source !== undefined && this.#source !== sourceId) {
      this.#resident.clear();
      this.#historical.clear();
      this.#protected.clear();
    }
    this.#source = sourceId;
  }

  setResolver(resolver: ProtocolIdentityResolver): void {
    this.#resolver = resolver;
  }

  setSourceReader(read: () => string | undefined): void { this.#sourceReader = read; }
  #refreshSource(): void {
    const source = this.#sourceReader?.();
    if (source !== undefined) this.bindSource(source);
  }

  #stepCache(): StepCache {
    const scope = verificationStep.getStore();
    if (!scope) throw new TypeError("Protocol verification step is not active");
    let step = scope.get(this);
    if (!step) {
      step = { source: this.#source, identities: new Map(), attempted: new Set() };
      scope.set(this, step);
    }
    if (step.source !== this.#source) throw new TypeError(UNTRUSTED_DEVICE + " (trust source changed during verification)");
    return step;
  }

  /** Resolve one signal within a pure step; never exposes mutable cache state. */
  async resolveMissingOnce(signal: ProtocolIdentityNotLoaded): Promise<void> {
    if (signal.cache !== this) throw new TypeError("Verification identity signal belongs to another cache");
    const step = this.#stepCache();
    if (step.attempted.has(signal.keyId)) throw untrustedProtocolSignature();
    step.attempted.add(signal.keyId);
    let hydrated: boolean;
    try { hydrated = await this.hydrate(signal); }
    catch (error) {
      if (typeof error === "object" && error !== null) identityResolutionFailures.add(error);
      throw error;
    }
    if (!hydrated) throw untrustedProtocolSignature();
    this.#stepCache();
  }

  /** resident=true 的身份常驻；身份只能由调用方在其已验信任状态里读出后登记。 */
  remember(identity: DeviceIdentity, resident = false): void {
    const keyId = identity.deviceId;
    const step = verificationStep.getStore() ? this.#stepCache() : undefined;
    const previous = step?.identities.get(keyId) ?? this.#resident.get(keyId) ?? this.#historical.get(keyId);
    if (previous && previous.publicKey !== identity.publicKey) {
      throw new TypeError("A verified public key identity cannot be replaced");
    }
    const saved = previous ?? Object.freeze({ ...identity });
    step?.identities.set(keyId, saved);
    if (resident) {
      this.#historical.delete(keyId);
      this.#resident.set(keyId, saved);
      return;
    }
    if (this.#resident.has(keyId)) return;
    this.#historical.delete(keyId);
    this.#historical.set(keyId, saved);
    while (this.#historical.size > this.historicalCapacity) {
      this.#historical.delete(this.#historical.keys().next().value!);
    }
  }

  /** The protected local key is independent of current remote membership. */
  rememberProtected(identity: DeviceIdentity): void {
    this.remember(identity, true);
    this.#protected.add(identity.deviceId);
  }

  /** A removed live member remains verifiable only through the bounded history. */
  demote(keyId: string): void {
    if (this.#protected.has(keyId)) return;
    const identity = this.#resident.get(keyId);
    if (!identity) return;
    this.#resident.delete(keyId);
    this.remember(identity);
  }

  /** Replace the live set; former members become bounded historical entries. */
  replaceResidents(identities: readonly DeviceIdentity[]): void {
    const live = new Set(identities.map(identity => identity.deviceId));
    for (const identity of identities) this.remember(identity, true);
    for (const keyId of this.#resident.keys()) {
      if (live.has(keyId) || this.#protected.has(keyId)) continue;
      this.demote(keyId);
    }
  }

  /** 供同步验签器调用；未载入时抛出补齐信号。 */
  identityFor(keyId: string): DeviceIdentity {
    this.#refreshSource();
    const step = verificationStep.getStore() ? this.#stepCache() : undefined;
    const pinned = step?.identities.get(keyId);
    if (pinned) return pinned;
    const resident = this.#resident.get(keyId);
    if (resident) { step?.identities.set(keyId, resident); return resident; }
    const historical = this.#historical.get(keyId);
    if (!historical) throw new ProtocolIdentityNotLoaded(keyId, this);
    this.#historical.delete(keyId);
    this.#historical.set(keyId, historical);
    step?.identities.set(keyId, historical);
    return historical;
  }

  /** 精确补齐一个身份；返回 false 表示信任来源里没有它。 */
  async hydrate(signal: ProtocolIdentityNotLoaded): Promise<boolean> {
    if (signal.cache !== this) throw new TypeError("Verification identity signal belongs to another cache");
    if (this.#resident.has(signal.keyId) || this.#historical.has(signal.keyId)) return true;
    const source = this.#source;
    const identity = await this.#resolver?.(signal.keyId, signal);
    if (!identity) return false;
    if (identity.deviceId !== signal.keyId) throw new TypeError("Resolved verification identity does not match its key");
    // 解析期间来源已切换：这次结果属于旧来源，交给调用方按新来源重跑。
    this.#refreshSource();
    if (this.#source !== source) return true;
    this.remember(identity);
    return true;
  }

  /**
   * 日志外的验签入口：操作内可能遇到未载入的历史身份时用它包裹。操作必须可整体重跑
   * （纯校验或只写私有草稿）；同一个缺失身份只补齐一次，找不到即不受信。
   */
  async verifying<T>(operation: () => T | Promise<T>): Promise<T> {
    return verifyProtocolStep(operation, this);
  }
}
