/**
 * TextConfirmationRenderer —— 远程通道的纯文本确认渲染器
 *
 * 定位（[remote-confirmation-execution.md §3.4]）：
 *   订阅 Hub 的 request 事件 → 按 request.turnOrigin.target 解析通道 + 接收人
 *   → 调 adapter.send 发一条纯文本确认消息 → 结束。
 *
 * **不感知 resolved 事件**——RPC 推送由 ConfirmationBridge 统一处理；
 * 超时 / 取消场景下通道侧无需"更新已失效状态"，用户超时回复会收到 InboundRouter
 * 的"已处理"回执（§3.5 ok=false 分支）。
 *
 * 关键不变量：
 *   - **INV-T1**：同一 request 只发一次消息（Hub 的 request 事件对 broker FIFO
 *     首次 showing 语义天然保证）
 *   - **INV-T2**：adapter.send 失败不重试——记 warn 埋点；broker expiresAt 超时
 *     兜底 resolved 让系统自然收敛
 *   - **INV-T3**：无"已失效"通道侧更新——文本协议下消息就是消息
 *
 * 埋点契约（§3.10 事件表）：
 *   - `confirmation.remote.sent`
 *   - `confirmation.remote.send-failed`
 *   - `confirmation.remote.no-target`
 */

import type {
  ChannelLogger,
  ChannelRegistry,
  ConfirmationRequest,
  DeliveryTarget,
  DisplayBody,
} from "@zhixing/core";
import type { ConfirmationHub, HubEntry } from "./hub.js";

// ─── 选项 ───

export interface TextRendererOptions {
  hub: ConfirmationHub;
  channels: ChannelRegistry;
  logger: ChannelLogger;
  /**
   * 当 request.turnOrigin.target 为空时的兜底投递目标。
   * 主要场景：scheduler 任务未绑定通道（origin 为 null）且运维希望把确认消息
   * 发到一个固定会话（如 admin 的飞书 DM）。
   *
   * 未配置时无 target 的请求仅走 RPC Bridge（由 ConfirmationBridge 定向推送）。
   */
  defaultTarget?: DeliveryTarget;
}

// ─── Renderer ───

export class TextConfirmationRenderer {
  readonly name = "text-remote";
  private unsubHub?: () => void;

  constructor(private readonly opts: TextRendererOptions) {}

  start(): void {
    this.unsubHub = this.opts.hub.onEvent((event) => {
      if (event.type === "request") {
        // dispatch 内部处理错误（不抛出），await 以串行化同 target 的发送
        void this.dispatch(event.entry);
      }
      // resolved 事件由 Bridge 统一推 RPC；本渲染器不处理（§3.4 INV-T3）
    });
  }

  stop(): void {
    this.unsubHub?.();
    this.unsubHub = undefined;
  }

  private async dispatch(entry: HubEntry): Promise<void> {
    const target = entry.request.turnOrigin?.target ?? this.opts.defaultTarget;

    // 无 target：文本路径 skip（可能仍有 RPC Bridge 推送）
    if (!target) {
      this.opts.logger.info("confirmation.remote.no-target", {
        requestId: entry.request.id,
        conversationId: entry.conversationId,
      });
      return;
    }

    const adapter = this.opts.channels.get(target.channelId);
    if (!adapter) {
      this.opts.logger.warn("confirmation.remote.send-failed", {
        requestId: entry.request.id,
        channelId: target.channelId,
        conversationId: entry.conversationId,
        error: "adapter-not-found",
      });
      return;
    }

    try {
      await adapter.send(target, {
        text: formatConfirmationMessage(entry.request),
      });
      this.opts.logger.info("confirmation.remote.sent", {
        requestId: entry.request.id,
        channelId: target.channelId,
        conversationId: entry.conversationId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn("confirmation.remote.send-failed", {
        requestId: entry.request.id,
        channelId: target.channelId,
        conversationId: entry.conversationId,
        error: message,
      });
    }
  }
}

// ─── 格式化 ───

/**
 * 格式化确认消息为纯文本——通道无关。
 *
 * 格式：
 *   🔒 需要批准：<title>
 *
 *   <detail>
 *
 *   风险等级：<risk> · <minutes> 分钟内回复：
 *   • 允许本次：好 / y / yes / 可以 / 同意 / 干吧 / 1
 *   • 拒绝：   不 / n / no / 拒绝 / 算了 / 2
 *   • 或直接说明拒绝理由（会传给 AI 参考）
 */
export function formatConfirmationMessage(request: ConfirmationRequest): string {
  const detail = formatOperationDetail(request.display.body);
  const riskLevel = request.decision?.riskLevel ?? "medium";
  const minutes = Math.max(
    1,
    Math.round((request.expiresAt - Date.now()) / 60_000),
  );
  const lines = [
    `🔒 需要批准：${request.display.title}`,
    ``,
    detail,
  ];
  // 安全管家研判理由（needs-confirm 经管家时存在）——远程用户上下文更少，理由更关键
  if (request.display.stewardReason) {
    lines.push(``, `🛡 安全管家：${request.display.stewardReason}`);
  }
  lines.push(
    ``,
    `风险等级：${riskLevel} · ${minutes} 分钟内回复：`,
    `• 允许本次：好 / y / yes / 可以 / 同意 / 干吧 / 1`,
    `• 拒绝：   不 / n / no / 拒绝 / 算了 / 2`,
    `• 或直接说明拒绝理由（会传给 AI 参考）`,
  );
  return lines.join("\n");
}

/** 按 DisplayBody kind 构造详情段 */
function formatOperationDetail(body: DisplayBody): string {
  switch (body.kind) {
    case "bash":
      return "```\n" + body.commandPreview + "\n```";
    case "file-write":
      return (
        `文件：${body.path}` +
        (body.preview ? `\n内容预览：${body.preview.slice(0, 200)}` : "")
      );
    case "file-edit":
      return `文件：${body.path}`;
    case "file-read":
      return `文件：${body.path}`;
    case "network":
      return `网络：${body.direction === "outbound" ? "→" : "←"} ${body.host}`;
    case "messaging":
      return `发送给 ${body.recipient}：${body.content.slice(0, 200)}`;
    case "calendar":
      return `日历：${body.title}（${body.invitees.length} 位参与者）`;
    case "generic":
      return body.summary;
  }
}
