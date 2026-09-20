import { randomUUID } from "node:crypto";

interface Request { readonly v: 1; readonly kind: "request"; readonly id: string; readonly method: string; readonly payload: unknown }
interface Response { readonly v: 1; readonly kind: "response"; readonly id: string; readonly ok: boolean; readonly payload?: unknown }
type Frame = Request | Response;

/** Duplex request/receipt transport. Acknowledgement follows completion, not dispatch. */
export class ExtensionPeer {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  constructor(private readonly send: (frame: Frame) => void, private readonly receive: (method: string, payload: unknown) => Promise<unknown>) {}

  call(method: string, payload: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Extension transport closed"));
    if (this.pending.size >= 1024) return Promise.reject(new Error("Extension transport busy"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Extension request timed out; outcome may be unknown"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ v: 1, kind: "request", id, method, payload }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("Extension transport send failed")); }
    });
  }

  accept(value: unknown): void {
    if (this.closed || !value || typeof value !== "object") return;
    const frame = value as Frame;
    if (frame.v !== 1 || typeof frame.id !== "string") return;
    if (frame.kind === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.payload);
      else pending.reject(new Error("Extension request rejected"));
      return;
    }
    if (frame.kind !== "request" || typeof frame.method !== "string") return;
    // Independent requests are not serialized: control replies must pass a waiting Run.
    void this.receive(frame.method, frame.payload).then(
      (payload) => this.reply({ v: 1, kind: "response", id: frame.id, ok: true, payload }),
      () => this.reply({ v: 1, kind: "response", id: frame.id, ok: false }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Extension transport closed; outcome may be unknown"));
    }
    this.pending.clear();
  }

  private reply(frame: Response): void {
    if (!this.closed) { try { this.send(frame); } catch { this.close(); } }
  }
}
