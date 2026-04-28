/**
 * IntentClassifier 协议层类型。
 *
 * 把入站 channel message 分类到三种意图(control / non-control)的纯函数 API,
 * `inbound-router.handleMessage` 在 `tryHandleAsConfirmationReply` 之前做控制意图
 * 前置识别。识别为 non-control 时让原 confirmation / agent 路径接管。
 *
 * 用判别联合而非字符串 enum:`switch (intent.kind)` 在 strict 模式下能穷尽检查;
 * 未来扩 help / status 等意图时,所有未覆盖分支编译报错。
 */

import type { InboundMessage } from "@zhixing/core";

/**
 * 控制意图 — 当前仅 cancel,后续按需扩。
 *
 * 不预先定义未实现的 kind(如 help / status),避免 dead branch 污染代码。
 * 扩展时直接加新 case 在判别联合,所有 consumer 编译期捕获。
 */
export type ControlIntent = {
  readonly kind: "cancel";
  /** 命中的关键词字面值,便于诊断 + 后续按钮 callback 复用同一字段 */
  readonly matchedKeyword: string;
};

export type Intent =
  | { readonly kind: "control"; readonly control: ControlIntent }
  | { readonly kind: "non-control" };

export interface IntentClassifier {
  classify(msg: InboundMessage): Intent;
}
