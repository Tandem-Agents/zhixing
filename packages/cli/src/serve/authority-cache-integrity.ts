import { randomBytes } from "node:crypto";
import { AuthorityCacheIntegrity } from "@zhixing/core/authority";
import type { SecretStorePort } from "@zhixing/core/contracts";

const REFERENCE = { kind: "authority-integrity", bindingId: "startup-proofs:v1" } as const;

/**
 * 写者在打开日志前取得本 home 的缓存完整性密钥：沿保险库既有跨进程锁原子 get-or-create，
 * 仅缺失时创建，已有值从不覆盖。写者入口在此之前都已按自身流程确认保险库可用，这里不再重复
 * 探测平台后端。只读访问者可取得已有密钥；取不到时仍能严格读取事实。写者不能悄悄丢弃
 * 固定投影和尾部预算的持久性保证：原子取钥失败原样报告，调用方可另开严格只读入口。
 */
export async function loadAuthorityCacheIntegrity(
  store: SecretStorePort | undefined,
  readOnly = false,
): Promise<AuthorityCacheIntegrity | undefined> {
  let encoded: string | null;
  if (readOnly) {
    if (!store?.getExisting) return undefined;
    try { encoded = await store.getExisting(REFERENCE); } catch { return undefined; }
    if (encoded === null) return undefined;
  } else {
    if (!store?.getOrCreate) throw new Error("Authority writer requires atomic cache integrity key creation");
    encoded = await store.getOrCreate(REFERENCE, () => randomBytes(32).toString("base64"));
  }
  const key = Buffer.from(encoded, "base64");
  try {
    if (key.byteLength < 32 || key.toString("base64") !== encoded) {
      if (readOnly) return undefined;
      throw new Error("Authority cache integrity key is invalid");
    }
    return new AuthorityCacheIntegrity(key);
  } finally {
    key.fill(0);
  }
}
