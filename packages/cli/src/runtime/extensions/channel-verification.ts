import { randomBytes } from "node:crypto";
import type { SecretStorePort } from "@zhixing/core/contracts";
import type { CredentialStoreCoordinator } from "@zhixing/providers";
import type { ExtensionApplication } from "@zhixing/core/extensions/application";
import type { ExtensionInstance, ExtensionOperation, ExtensionProcess } from "@zhixing/core/extensions/contracts";
import type { InboundMessage, DeliveryTarget } from "@zhixing/core/channels";
import { channelDeliveryResult } from "./channel-binding.js";

interface Verification {
  readonly from: string;
  readonly target: DeliveryTarget;
  readonly inboundId: string;
  readonly challenge: string;
  readonly confirmedId?: string;
}

/** Type-owned evidence. Neither a model assertion nor process health admits a channel. */
export class ChannelVerification {
  constructor(private readonly application: ExtensionApplication, private readonly secrets: SecretStorePort & CredentialStoreCoordinator,
    private readonly process: (id: string) => ExtensionProcess | undefined, private readonly changed: () => void) {}

  async code(operation: ExtensionOperation): Promise<string> {
    return this.secrets.runExclusive(async () => {
      const ref = { kind: "channel" as const, bindingId: `extension-verification/${operation.id}` };
      let value = await this.secrets.get(ref);
      if (!value) { value = randomBytes(16).toString("hex"); await this.secrets.put(ref, value); }
      return value;
    });
  }

  async accept(instance: ExtensionInstance, message: InboundMessage): Promise<boolean> {
    if (!instance.admission) return false;
    const operation = await this.application.operation(instance.admission.operationId);
    const target: DeliveryTarget = { channelId: instance.id, to: message.groupId ?? message.from,
      ...(message.threadId ? { threadId: message.threadId } : {}) };
    const matches = (proof: Verification) => message.from === proof.from && target.to === proof.target.to && target.threadId === proof.target.threadId;
    if (instance.admission.ready) {
      const proof = operation?.verification as Verification | undefined;
      return Boolean(proof && matches(proof) && ([proof.inboundId, proof.confirmedId].includes(message.messageId) ||
        message.text.trim() === `确认 ${proof.challenge}` || (/^连接 [a-f0-9]{32}$/.test(message.text.trim()) && message.text.trim() === `连接 ${await this.code(operation!)}`)));
    }
    if (!operation || operation.phase !== "verifying" || !instance.enabled || !message.messageId) throw new Error("连接尚未通过本人收发验证");
    let proof = operation.verification as Verification | undefined;
    const process = this.process(instance.id);
    if (!process || process.generation !== instance.generation) throw new Error("连接正在启动，请稍后重发验证消息");
    if (!proof) {
      if (message.text.trim() !== `连接 ${await this.code(operation)}`) throw new Error("请使用本机配置入口显示的验证指令");
      proof = { from: message.from, target, inboundId: message.messageId,
        challenge: randomBytes(16).toString("hex") };
      // Persist the exact route, identity and challenge before the external effect.
      await this.application.checkpoint(operation.id, operation.revision, proof);
    } else if (matches(proof) && message.text.trim() === `确认 ${proof.challenge}`) {
      await this.application.complete(operation.id, operation.revision, process.generation, { ...proof, confirmedId: message.messageId });
      this.changed();
      return true;
    } else if (!matches(proof) || (message.messageId !== proof.inboundId && message.text.trim() !== `连接 ${await this.code(operation)}`)) {
      throw new Error("请由验证发起人回复连接确认指令");
    }
    // This is verification traffic only. Business sends remain closed. A late
    // reply is checked against the committed operation/generation on re-entry.
    const current = await this.application.operation(operation.id);
    const latest = await this.application.get(instance.id);
    if (current?.phase !== "verifying" || !latest?.enabled || latest.generation !== process.generation) throw new Error("连接验证已撤销");
    const result = channelDeliveryResult(await process.call("channel.send", { target: proof.target,
      content: { text: `知行已收到验证消息。请回复：确认 ${proof.challenge}` }, meta: { idempotencyKey: `extension-verify:${operation.id}:${proof.challenge}` } }));
    if (!result.success) throw new Error("验证回复尚未送达；请重发原验证消息");
    return true;
  }
}
