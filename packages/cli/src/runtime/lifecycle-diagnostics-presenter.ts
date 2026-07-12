import {
  SESSION_NOTIFICATIONS,
  type SessionEventEnvelope,
} from "@zhixing/rpc";
import {
  createLifecycleWarningDeduper,
  renderLifecycleWarningLine,
  type LifecycleWarningDeduper,
} from "../lifecycle-diagnostics-presentation.js";
import type { CliWriter } from "../screen/index.js";
import type { CoreHostLink } from "./core-host-connection.js";
import type { AgentEventMap } from "@zhixing/core";

export interface LifecycleDiagnosticsPresenterOptions {
  readonly link: CoreHostLink;
  readonly writer: Pick<CliWriter, "ensureSegmentBreak" | "line">;
  readonly filter?: (envelope: SessionEventEnvelope) => boolean;
  readonly flushOutput?: () => void;
  readonly deduper?: LifecycleWarningDeduper;
}

export class LifecycleDiagnosticsPresenter {
  private readonly unsubscribe: () => void;
  private readonly deduper: LifecycleWarningDeduper;
  private disposed = false;

  constructor(private readonly opts: LifecycleDiagnosticsPresenterOptions) {
    this.deduper = opts.deduper ?? createLifecycleWarningDeduper();
    this.unsubscribe = opts.link.onNotification(
      SESSION_NOTIFICATIONS.event,
      (params) => this.handleEnvelope(params as SessionEventEnvelope),
    );
  }

  private handleEnvelope(envelope: SessionEventEnvelope): void {
    if (this.disposed) return;
    if (envelope.scope !== "control") return;
    if (envelope.event !== "lifecycle:warning") return;
    if (this.opts.filter && !this.opts.filter(envelope)) return;
    const payload = envelope.payload as AgentEventMap["lifecycle:warning"];
    if (!this.deduper.shouldShow(payload)) return;

    this.opts.flushOutput?.();
    this.opts.writer.ensureSegmentBreak();
    this.opts.writer.line(renderLifecycleWarningLine(payload));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
}

export function createLifecycleDiagnosticsPresenter(
  opts: LifecycleDiagnosticsPresenterOptions,
): LifecycleDiagnosticsPresenter {
  return new LifecycleDiagnosticsPresenter(opts);
}
