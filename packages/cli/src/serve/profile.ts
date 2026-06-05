/**
 * 核心宿主装配档位（profile）—— profile 概念簇单一来源：类型 / 默认 / 完整行为画像描述符。
 *
 * profile 是核心宿主的「装配档位」一等概念（随 schedule→full 升格 / unified-core 演化增长）。
 * 它决定的**全部**行为差异收进 `PROFILES` 描述符；装配主干与 argv 编解码一律读此处、**绝不
 * 枚举 profile 名**（杜绝「加一档逐处回改」的声明面领先生效面复发，也避免 profile 定义散落
 * 多处、改一档漏一处即 bug）。新增 profile = 加一条 PROFILES 记录，其余零改。
 *
 * 独立成模块（而非塞进 command.ts 或 access-surface.ts）的原因：profile 既被装配主干
 * （command.ts）、接入面遍历（access-surface.ts）、又被 CLI 入口 argv 解析（index.ts）消费；
 * 收成叶子模块让三者单向依赖它、消除 command ↔ access-surface 的概念循环。
 */

/** 装配档位。 */
export type ServerProfile = "schedule" | "full";

/**
 * 默认档位（显式 `zz serve`）。**单一来源**——runServerProcess 兜底解析 / argv 透传 / CLI
 * 入口解析共用，避免 "full" 字面散落多处、改默认漏一处。
 */
export const DEFAULT_PROFILE: ServerProfile = "full";

/** profile 行为画像描述符 —— profile 决定的全部行为差异。 */
export interface ProfileSpec {
  /** 启用的接入面 name 集合（装配顺序由 ACCESS_SURFACES 数组定，见 access-surface.ts）。 */
  readonly surfaces: readonly string[];
  /** 启动校验模式：server 校 model + messaging；schedule 只校 model（最小宿主无需通道凭证）。 */
  readonly startupMode: "server" | "schedule";
  /** 生命周期：true = 空闲退出（按需拉起的最小宿主要轻）；false = 长驻。 */
  readonly idleReap: boolean;
}

/**
 * 全部 profile 的描述符表。
 * - schedule：恒定核心 only，零接入面、只校 model、空闲退出（ensure 拉起的轻量定时宿主）。
 * - full：全部接入面、校 model + messaging、长驻（显式 `zz serve`）。
 */
export const PROFILES: Record<ServerProfile, ProfileSpec> = {
  schedule: {
    surfaces: [],
    startupMode: "schedule",
    idleReap: true,
  },
  full: {
    surfaces: [
      "mcp",
      "conversation",
      "channel",
      "delivery",
      "text-renderer",
      "confirmation-bridge",
    ],
    startupMode: "server",
    idleReap: false,
  },
};
