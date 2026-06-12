/**
 * 核心宿主装配档位（profile）—— profile 概念簇单一来源。
 *
 * 宿主只有一个形态:装什么由配置说了算,不由拉起方式决定——cli 自动拉起与
 * 显式 `zz serve` 是同一个宿主。接入面装配本身配置自适应(channel 无 messaging
 * 配置静默跳过、MCP 空配置 no-op),"档位"不再承载装配差异:
 * - 启动校验恒只查 model(messaging 凭证不全由 channel 装配警告跳过,非致命);
 * - 空闲回收恒装,判定 = 无 RPC 连接且无渠道挂载(开了远程接入即常驻,
 *   未开远程、无在场接入面则空闲退出——轻量与常驻由事实驱动)。
 *
 * 类型保留 union 形态作未来差异化档位的扩展位;新增 profile = 加一条 PROFILES
 * 记录,装配主干与 argv 编解码一律读此处、绝不枚举 profile 名。
 */

/** 装配档位。 */
export type ServerProfile = "full";

/**
 * 默认档位。**单一来源**——runServerProcess 兜底解析 / argv 透传 / CLI
 * 入口解析共用。
 */
export const DEFAULT_PROFILE: ServerProfile = "full";

/** profile 行为画像描述符。 */
export interface ProfileSpec {
  /** 启用的接入面 name 集合（装配顺序由 ACCESS_SURFACES 数组定，见 access-surface.ts）。 */
  readonly surfaces: readonly string[];
}

export const PROFILES: Record<ServerProfile, ProfileSpec> = {
  full: {
    surfaces: [
      "mcp",
      "conversation",
      "channel",
      "delivery",
      "text-renderer",
      "confirmation-bridge",
    ],
  },
};
