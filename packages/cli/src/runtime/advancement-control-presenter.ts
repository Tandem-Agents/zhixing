/**
 * 推进控制面监听器 —— session.event 带外通道的第二条腿。
 *
 * RpcEventBus 只还原 scope:"run" 的信封（渲染订阅集）；scope:"control" 的
 * 推进事件（advancement:*）由本监听器消费，渲染为对话流里的系统行：
 * 验收摘要、自动续推提示、收场报告、验收挂起与恢复提示——推进运行期的
 * 用户知情面。文案与投影全部来自 advancement-presentation（纯函数层），
 * 这里只做订阅、过滤与写出。
 *
 * 「当前对话」是接入面 UI 态，经 filter 注入——与 RpcEventBus 同构，
 * 本监听器自身不持有对话指针。
 */

import { SESSION_NOTIFICATIONS, type SessionEventEnvelope } from "@zhixing/rpc";
import { renderAdvancementControlEventLines } from "../advancement-presentation.js";
import type { CliWriter } from "../screen/index.js";
import type { CoreHostNotificationLink } from "./core-host-connection.js";

export interface AdvancementControlPresenterOptions {
  /** 进程级共享的核心宿主连接。 */
  link: CoreHostNotificationLink;
  writer: Pick<CliWriter, "ensureSegmentBreak" | "line">;
  /** 信封级过滤（如「只呈现当前对话」）。缺省全收。 */
  filter?: (envelope: SessionEventEnvelope) => boolean;
  /** 呈现前的输出流收束（关闭流式渲染批处理，避免系统行插进半截输出）。 */
  flushOutput?: () => void;
  width?: () => number;
}

export class AdvancementControlPresenter {
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly opts: AdvancementControlPresenterOptions) {
    this.unsubscribe = opts.link.onNotification(
      SESSION_NOTIFICATIONS.event,
      (params) => this.handleEnvelope(params as SessionEventEnvelope),
    );
  }

  private handleEnvelope(envelope: SessionEventEnvelope): void {
    if (this.disposed) return;
    if (envelope.scope !== "control") return;
    if (this.opts.filter && !this.opts.filter(envelope)) return;

    const width =
      this.opts.width?.() ?? process.stdout.columns ?? 80;
    const lines = renderAdvancementControlEventLines(
      envelope.event,
      envelope.payload,
      width,
    );
    if (lines.length === 0) return;

    this.opts.flushOutput?.();
    this.opts.writer.ensureSegmentBreak();
    for (const line of lines) {
      this.opts.writer.line(line);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
}

export function createAdvancementControlPresenter(
  opts: AdvancementControlPresenterOptions,
): AdvancementControlPresenter {
  return new AdvancementControlPresenter(opts);
}
