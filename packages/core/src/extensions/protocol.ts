import { randomUUID } from "node:crypto";
import type { LogRecordPort, LogRef } from "../logging/contracts.js";

interface Request { readonly v: 1; readonly kind: "request"; readonly id: string; readonly method: string; readonly payload: unknown }
interface Response { readonly v: 1; readonly kind: "response"; readonly id: string; readonly ok: boolean; readonly payload?: unknown }
type Frame = Request | Response;

/** Duplex request/receipt transport. Acknowledgement follows completion, not dispatch. */
export class ExtensionPeer {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string; refs: readonly LogRef[] }>();
  private closed = false;
  constructor(private readonly send: (frame: Frame) => void, private readonly receive: (method: string, payload: unknown, requestId: string) => Promise<unknown>, private readonly records?: LogRecordPort) {}

  call(method: string, payload: unknown, timeoutMs = 30_000, links: readonly LogRef[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Extension transport closed"));
    if (this.pending.size >= 1024) return Promise.reject(new Error("Extension transport busy"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const refs = [{ kind: "extensionRequest", id }, ...links];
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.records?.record(() => ({ event: "uncertain", refs, result: "unknown", data: { method, error: "请求超时" } }));
        reject(new Error("Extension request timed out; outcome may be unknown"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, method, refs });
      if (method !== "control.health") this.records?.record(() => ({ event: "requested", refs, data: { method, direction: "outbound" } }));
      try { this.send({ v: 1, kind: "request", id, method, payload }); }
      catch {
        clearTimeout(timer); this.pending.delete(id);
        this.records?.record(() => ({ event: "uncertain", refs, result: "unknown", data: { method, error: "发送失败" } }));
        reject(new Error("Extension transport send failed"));
      }
    });
  }

  accept(value: unknown): void {
    if (this.closed || !value || typeof value !== "object") return;
    const frame = value as Frame;
    if (frame.v !== 1 || typeof frame.id !== "string") return;
    if (frame.kind === "response") {
      if (typeof frame.ok !== "boolean") {
        this.records?.record(() => ({ event: "uncertain", refs: [{ kind: "extensionRequest", id: frame.id }], result: "unknown", data: { error: "回执状态无效" } }));
        return;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) {
        this.records?.record(() => ({ event: "unmatched", refs: [{ kind: "extensionRequest", id: frame.id }], result: "unknown", data: { reportedOk: frame.ok } }));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (pending.method !== "control.health" || !frame.ok) this.records?.record(() => ({ event: "returned", refs: pending.refs, result: frame.ok ? "success" : "refused", data: { method: pending.method, direction: "outbound" } }));
      if (frame.ok) pending.resolve(frame.payload);
      else pending.reject(new Error("Extension request rejected"));
      return;
    }
    if (frame.kind !== "request" || typeof frame.method !== "string") return;
    this.records?.record(() => ({ event: "requested", refs: [{ kind: "extensionRequest", id: frame.id }], data: { method: frame.method, direction: "inbound" } }));
    // Independent requests are not serialized: control replies must pass a waiting Run.
    void this.receive(frame.method, frame.payload, frame.id).then(
      (payload) => this.reply({ v: 1, kind: "response", id: frame.id, ok: true, payload }),
      () => this.reply({ v: 1, kind: "response", id: frame.id, ok: false }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.records?.record({ event: "uncertain", refs: pending.refs, result: "unknown", data: { method: pending.method, error: "传输关闭" } });
      pending.reject(new Error("Extension transport closed; outcome may be unknown"));
    }
    this.pending.clear();
  }

  private reply(frame: Response): void {
    this.records?.record(() => ({ event: "returned", refs: [{ kind: "extensionRequest", id: frame.id }], result: frame.ok ? "success" : "refused", data: { direction: "inbound" } }));
    if (!this.closed) { try { this.send(frame); } catch { this.close(); } }
  }
}
