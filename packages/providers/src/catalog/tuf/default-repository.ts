/**
 * 随包绑定的官方可信静态模型目录仓库描述与初始 TUF 信任根（设计 §4.1、§4.2）。
 *
 * - 仅内嵌公开 Ed25519 公钥与自签 `root.json` 原始字节（绝不含任何私钥）；
 * - 指向官方兼容通道 `catalog-v1` 的静态 metadata / targets 地址与目标文件 `catalog-v1.json`；
 * - 正式部署或离线自建静态镜像时可通过受控 `repository` 参数或受验 `<ZHIXING_HOME>/catalog/repository-source.json`
 *   替换仓库地址与配套固定根（更换前强制经 `validateTufMetadataBytes` 校验）。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ConnectionNetworkConfig, NetworkConfig } from "../../types.js";
import { validateTufMetadataBytes, type TufRepositorySource } from "./restricted-tuf-client.js";

export const OFFICIAL_CATALOG_SCHEMA_CHANNEL = "v1" as const;
export const OFFICIAL_CATALOG_METADATA_BASE_URL =
  "https://raw.githubusercontent.com/Tandem-Agents/zhixing/catalog-v1/metadata";
export const OFFICIAL_CATALOG_TARGETS_BASE_URL =
  "https://raw.githubusercontent.com/Tandem-Agents/zhixing/catalog-v1/targets";
export const OFFICIAL_CATALOG_TARGET_PATH = "catalog-v1.json";

/**
 * 随包固定的官方 TUF 1.0.37 v1 信任根（仅公钥与根签名，4 独立 Ed25519 角色密钥，无委托）。
 *
 * 托管入口与发布闭环见 `docs/modules/providers/catalog-maintenance-runbook.md` 及
 * `.github/workflows/catalog-maintenance.yml`：
 * - 首次公开开通 `origin/catalog-v1` 分支前，维护者在本机执行
 *   `node scripts/catalog-maintenance.mjs init-ceremony <repoDir> <offlineKeysDir>`
 *   并将生成的 `bootstrap-root.snippet.txt` 写入此处常量、离线封存 `root-key.offline.json`、
 *   经用户授权推送 `origin/catalog-v1` 分支并配置在线三角色密钥 `CATALOG_TUF_ONLINE_KEYS_JSON`；
 * - 后续通过 TUF 1.0.37 双阈值连续根轮换（`rotate-root-local`）演进，日常更新与 6 小时续签全程不触碰离线根私钥。
 */
export const OFFICIAL_BOOTSTRAP_ROOT_JSON = `{
  "signed": {
    "_type": "root",
    "spec_version": "1.0.31",
    "version": 1,
    "expires": "2027-11-20T10:17:21Z",
    "consistent_snapshot": false,
    "keys": {
      "d6e02f54bf7e76f39768c9e5227ea381d08bed545a459c8d3a498b60ece4dc7a": {
        "keytype": "ed25519",
        "scheme": "ed25519",
        "keyval": {
          "public": "e9f622892aeef2c07fe8431aa9962ee3cf275da80cf1308ef701729785fca7e1"
        }
      },
      "ab6b703478ae863a7f78bda341151ebad2ab2320468bf0e929524fe9ebbad9a6": {
        "keytype": "ed25519",
        "scheme": "ed25519",
        "keyval": {
          "public": "a160205297b53b29f207152eb927e3d0b8ed8e40c7177f464a3b65b5b93ac7ef"
        }
      },
      "4ea23eda588804124067d077c7d0daec8abf1a6d8f63acbfd2e830452ea01c40": {
        "keytype": "ed25519",
        "scheme": "ed25519",
        "keyval": {
          "public": "0cd4f4f7f20b54bc87eca4db595fa9b13c72fe22638573e8d554b3e2ae28e497"
        }
      },
      "eae263d0e7f0cc3c339a4e35be542581fc6551aef23f670e8c975008c5ef5bbc": {
        "keytype": "ed25519",
        "scheme": "ed25519",
        "keyval": {
          "public": "cd49d4cae524ecc1645b6d8f2a25a4997aa7e960692735f1cf184cb114c801d6"
        }
      }
    },
    "roles": {
      "root": {
        "keyids": [
          "d6e02f54bf7e76f39768c9e5227ea381d08bed545a459c8d3a498b60ece4dc7a"
        ],
        "threshold": 1
      },
      "timestamp": {
        "keyids": [
          "ab6b703478ae863a7f78bda341151ebad2ab2320468bf0e929524fe9ebbad9a6"
        ],
        "threshold": 1
      },
      "snapshot": {
        "keyids": [
          "4ea23eda588804124067d077c7d0daec8abf1a6d8f63acbfd2e830452ea01c40"
        ],
        "threshold": 1
      },
      "targets": {
        "keyids": [
          "eae263d0e7f0cc3c339a4e35be542581fc6551aef23f670e8c975008c5ef5bbc"
        ],
        "threshold": 1
      }
    }
  },
  "signatures": [
    {
      "keyid": "d6e02f54bf7e76f39768c9e5227ea381d08bed545a459c8d3a498b60ece4dc7a",
      "sig": "43b6bdb61b9870f1c8c6eebdc1345f1efb1b4298223d65c9a47448e5adcff044a843fbcd794e1859fe02cdda3dc8920422f5877c8fccff3d04d8e824afc7550a"
    }
  ]
}
`;

export const OFFICIAL_BOOTSTRAP_ROOT_BYTES: Uint8Array = Buffer.from(
  OFFICIAL_BOOTSTRAP_ROOT_JSON,
  "utf8",
);

// 模块装载即自校验内置引导根满足全部受限四角色 TUF 策略
validateTufMetadataBytes(OFFICIAL_BOOTSTRAP_ROOT_BYTES, "root");

export const DEFAULT_OFFICIAL_CATALOG_REPOSITORY: TufRepositorySource = Object.freeze({
  metadataBaseUrl: OFFICIAL_CATALOG_METADATA_BASE_URL,
  targetsBaseUrl: OFFICIAL_CATALOG_TARGETS_BASE_URL,
  targetPath: OFFICIAL_CATALOG_TARGET_PATH,
  bootstrapRootBytes: OFFICIAL_BOOTSTRAP_ROOT_BYTES,
  network: Object.freeze({ proxy: "inherit" as const }),
});

/** 受控自定义静态 TUF 仓库覆盖文件（如企业内网镜像或本机验收静态仓库），存放在 `<storeDir>/repository-source.json`。 */
export interface PersistedCatalogRepositorySourceFile {
  readonly schemaVersion: 1;
  readonly metadataBaseUrl: string;
  readonly targetsBaseUrl: string;
  readonly targetPath: string;
  readonly bootstrapRootBase64?: string;
  readonly bootstrapRootJson?: string;
  readonly network?: ConnectionNetworkConfig;
}

export function resolveCatalogRepositorySourcePath(storeDir: string): string {
  return path.join(storeDir, "repository-source.json");
}

/**
 * 尝试读取 `<storeDir>/repository-source.json` 中显式配置的受控镜像/自托管仓库源；
 * 仅在 URL 合法且内嵌引导根（`bootstrapRootBase64` 或 `bootstrapRootJson`）通过完整受限 TUF 根校验时采用，否则忽略并返回 undefined。
 */
export async function loadConfiguredCatalogRepository(
  storeDir: string,
  networkProxy?: NetworkConfig["proxy"],
): Promise<TufRepositorySource | undefined> {
  const filePath = resolveCatalogRepositorySourcePath(storeDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedCatalogRepositorySourceFile>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.metadataBaseUrl !== "string" ||
      typeof parsed.targetsBaseUrl !== "string" ||
      typeof parsed.targetPath !== "string" ||
      (typeof parsed.bootstrapRootBase64 !== "string" && typeof parsed.bootstrapRootJson !== "string")
    ) {
      return undefined;
    }
    const metaUrl = new URL(parsed.metadataBaseUrl);
    const tgtUrl = new URL(parsed.targetsBaseUrl);
    if (
      (metaUrl.protocol !== "https:" && metaUrl.protocol !== "http:") ||
      (tgtUrl.protocol !== "https:" && tgtUrl.protocol !== "http:") ||
      metaUrl.username ||
      metaUrl.password ||
      tgtUrl.username ||
      tgtUrl.password
    ) {
      return undefined;
    }
    const rootBytes =
      typeof parsed.bootstrapRootBase64 === "string"
        ? Buffer.from(parsed.bootstrapRootBase64, "base64")
        : Buffer.from(parsed.bootstrapRootJson!, "utf8");
    validateTufMetadataBytes(rootBytes, "root");
    const network: ConnectionNetworkConfig =
      parsed.network &&
      (parsed.network.proxy === "inherit" || parsed.network.proxy === "direct")
        ? {
            proxy: parsed.network.proxy,
            ...(parsed.network.allowPrivateOrigin ? { allowPrivateOrigin: true } : {}),
          }
        : { proxy: "inherit" };
    return {
      metadataBaseUrl: parsed.metadataBaseUrl,
      targetsBaseUrl: parsed.targetsBaseUrl,
      targetPath: parsed.targetPath,
      bootstrapRootBytes: rootBytes,
      network,
      ...(networkProxy !== undefined ? { networkProxy } : {}),
    };
  } catch {
    return undefined;
  }
}
