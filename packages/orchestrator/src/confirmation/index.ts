/**
 * @zhixing/orchestrator/confirmation — 子 agent confirmation 装配 helper 公共 API
 *
 * 当前仅暴露 `resolveSubAgentResolver` —— 把 `SubAgentConfirmationPolicy` 映射到
 * `NonInteractiveResolver`,供 `runChildAgent` 内部装配 child broker 时调用。
 *
 * v2+ 若引入 `inherit-or-prompt`(把子 confirmation 弹回父用户)需要 hub
 * 双向 UI 路由,会在本模块新增 `subscribeChildBrokerToHub(...)` 等 helper,
 * 仍走显式 export 控制公共 API 表面。
 */

export { resolveSubAgentResolver } from "./child-broker.js";
