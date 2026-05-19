/**
 * 档位推荐 —— "某档位首选哪一对 (provider, model)" 的单一事实源。
 *
 * 这是 provider-model 物理层【之上】的语义抽象层。物理层（PROVIDER_PRESETS）
 * 只回答"这家 provider 怎么连、登记过哪些 model 的元信息"，不回答"推荐用哪个"
 * —— "推荐"是一项产品价值判断，属于档位维度，不属于任何单个 provider。
 *
 * 单向依赖：本层引用物理层（拿 provider id 的编译期约束），物理层不反向感知
 * 本层。同样的 (provider, model) 二元组也可被未来直接 pin 模型的场景复用。
 */

import type { PROVIDER_PRESETS } from "./presets.js";
import type { RoleId } from "./role-spec.js";

/**
 * 一条档位推荐 —— 把档位钉死到一对【具体】的 (provider, model)。
 *
 * 推荐的是一对二元组，不是抽象的 model 名：同一个 model 可能被多个 provider
 * 提供，且各 provider 上的 id 不同（直连 vs 中转平台），消费者不应再做"用哪家
 * 跑这个 model"的二次决策。
 *
 * - `provider`：约束为已注册 preset 的 id。无 preset 就没有 baseUrl/protocol，
 *   根本连不上 —— 写一个不存在的 provider 在编译期即被 TS 拦下。这是本类型
 *   唯一需要、也唯一能做的客观校验。
 * - `model`：provider 范畴内的透传字符串。**不校验它是否在该 provider 的
 *   knownModels 里** —— knownModels 是 budget 解析的数据源，不是该 provider
 *   的合法 model 全集（网关型 provider 无法列举其全集）；catalog 之外的 model
 *   照常能请求。把推荐合法性绑到 knownModels 会让档位层反向依赖物理层的
 *   budget 结构，破坏两层解耦。model 的正确性由"定义这条推荐时"的产品决策
 *   保证，写错的后果是该 provider 请求时报 model 不存在，错误清晰可定位。
 */
export interface RoleRecommendation {
  readonly provider: keyof typeof PROVIDER_PRESETS;
  readonly model: string;
}

/**
 * 三档推荐表。当前只定义 `main`；`light` / `power` 是预留扩展位 —— 何时推荐
 * 什么是未定的产品决策，结构上不堵死，加一行即生效。
 *
 * 刻意用显式 `Partial<Record<RoleId, RoleRecommendation>>` 标注，而非
 * `as const satisfies`：
 *   - 消费者统一按 `ROLE_RECOMMENDATIONS[role]` 取值，类型恒为
 *     `RoleRecommendation | undefined`，强制每个消费点显式处理"无推荐"分支
 *     （light/power 未定义、或当前 provider 非推荐 provider 都走这个分支）。
 *   - 加一行 `light: {...}` 后类型不变，所有消费者零代码改动自动响应。
 *   - provider 写错仍被编译期拦下（赋值需满足 RoleRecommendation.provider 的
 *     keyof 约束）。
 * 反例 `as const` 会让 typeof 只含已写出的键，消费者访问未定义键变成编译错误
 * 而非 undefined —— 既堵死扩展位，又丢掉"显式处理无推荐"的语义。
 *
 * 不提供运行时校验函数：provider 由编译期 keyof 完全锁死，model 无客观全集
 * 可校验，任何运行时校验都是无依据的自造约束。
 */
export const ROLE_RECOMMENDATIONS: Partial<Record<RoleId, RoleRecommendation>> = {
  main: { provider: "deepseek", model: "deepseek-v4-pro" },
};
