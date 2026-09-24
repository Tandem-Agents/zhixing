import { ExtensionRevisionConflict, type ExtensionApplication } from "./application.js";
import type { ExtensionArtifacts } from "./artifacts.js";
import type { ExtensionInstance, ExtensionProcess, ExtensionTypeBinding } from "./contracts.js";
import { startExtensionProcess } from "./process.js";
export { EXTENSION_LOG_SOURCE } from "./logging.js";

interface Slot {
  readonly generation: string;
  readonly controller: AbortController;
  readonly stopped: Promise<void>;
  finished: boolean;
  retired: boolean;
  process?: ExtensionProcess;
  timer?: ReturnType<typeof setTimeout>;
}

/** Runtime evidence only. Desired state and generations always come from the application. */
export class ManagedExtensions {
  private readonly slots = new Map<string, Slot>();
  private readonly decisions = new Map<string, symbol>();
  private allowed = false;
  private paused = false;
  private closed = false;
  constructor(private readonly ports: {
    readonly recordsFor?: (instance: ExtensionInstance, generation: string) => import("../logging/contracts.js").LogRecordPort | undefined;
    readonly application: ExtensionApplication;
    readonly artifacts: ExtensionArtifacts;
    readonly projection: (instance: ExtensionInstance) => Promise<unknown>;
    readonly binding: (instance: ExtensionInstance, generation: string) => ExtensionTypeBinding;
    readonly isOwner: () => boolean;
    readonly onState?: () => void;
  }) {}

  async resume(): Promise<void> {
    if (this.closed) throw new Error("Extension runtime closed");
    this.allowed = true;
    this.paused = false;
    if (!this.ports.isOwner()) return;
    const { instances } = await this.ports.application.list();
    await Promise.all(instances.map((instance) => this.reconcile(instance)));
  }

  async suspend(): Promise<void> {
    this.allowed = false;
    this.decisions.clear();
    const slots = [...this.slots.values()];
    // Host drain has already settled accepted work. Final suspension must not
    // start a second wait for an unresponsive external implementation.
    for (const slot of slots) { this.retire(slot); slot.controller.abort(); }
    await Promise.all(slots.map((slot) => slot.stopped));
    for (const [id, slot] of this.slots) if (slots.includes(slot)) this.slots.delete(id);
    this.ports.onState?.();
  }

  /** Stop new activation/recovery without cutting off accepted effects. */
  pause(): void {
    this.paused = true;
    this.decisions.clear();
    for (const slot of this.slots.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      if (!slot.process) this.retire(slot);
    }
  }

  private retire(slot: Slot): void {
    if (slot.retired) return;
    slot.retired = true;
    const process = slot.process;
    slot.process = undefined;
    if (slot.timer) clearTimeout(slot.timer);
    if (process) void process.stop().finally(() => slot.controller.abort());
    else slot.controller.abort();
  }

  async close(): Promise<void> { this.closed = true; await this.suspend(); }

  current(id: string): ExtensionProcess | undefined {
    const slot = this.slots.get(id);
    return this.allowed && this.ports.isOwner() && !slot?.retired ? slot?.process : undefined;
  }

  state(id: string): "running" | "starting" | "stopping" | "stopped" {
    const slot = this.slots.get(id);
    if (!slot || slot.finished) return "stopped";
    if (slot.retired) return "stopping";
    return slot.process ? "running" : "starting";
  }

  async reconcile(instance: ExtensionInstance, attempts = 0): Promise<void> {
    const decision = Symbol();
    this.decisions.set(instance.id, decision);
    const valid = () => this.decisions.get(instance.id) === decision && this.allowed && !this.paused && !this.closed && this.ports.isOwner();
    // Callers can finish out of order; reconcile the latest committed intent.
    const latest = await this.ports.application.get(instance.id);
    if (this.decisions.get(instance.id) !== decision || !latest) return;
    instance = latest;
    const previous = this.slots.get(instance.id);
    if (previous && !previous.retired && !previous.finished && instance.enabled && previous.generation === instance.generation) return;
    if (previous) {
      this.retire(previous);
      await previous.stopped;
      if (this.slots.get(instance.id) === previous) this.slots.delete(instance.id);
    }
    if (!instance.enabled || !valid()) return;
    // Beginning a generation is a CAS, not a lock held across process startup.
    let starting: ExtensionInstance;
    try { starting = await this.ports.application.begin(instance.id, instance.revision); }
    catch (error) {
      if (!(error instanceof ExtensionRevisionConflict)) throw error;
      // A superseded caller may have committed without acquiring a slot.
      // Only the latest decision reconciles again; stop/ownership still wins.
      if (valid()) await this.reconcile(instance, attempts);
      return;
    }
    if (!valid()) return;
    const controller = new AbortController();
    let stopped!: () => void;
    const slot: Slot = { generation: starting.generation!, controller, finished: false, retired: false,
      stopped: new Promise<void>((resolve) => { stopped = resolve; }) };
    this.slots.set(instance.id, slot);
    const launch = async (): Promise<void> => {
      let records: import("../logging/contracts.js").LogRecordPort | undefined;
      // Observation setup must not acquire the business slot's settlement obligation.
      try { records = this.ports.recordsFor?.(starting, slot.generation); } catch { /* optional observer */ }
      records?.record({ event: "starting", data: { attempt: attempts } });
      let process: ExtensionProcess | undefined;
      try {
        const projection = await this.ports.projection(starting);
        const entry = await this.ports.artifacts.resolve(starting.binding.manifest);
        controller.signal.throwIfAborted();
        process = await startExtensionProcess({ entry, manifest: starting.binding.manifest,
          records,
          generation: slot.generation, projection, signal: controller.signal,
          binding: this.ports.binding(starting, slot.generation),
          isCurrent: () => this.slots.get(instance.id) === slot && !slot.retired && this.allowed && this.ports.isOwner(),
          onFault: () => { slot.process = undefined; this.ports.onState?.(); controller.abort(); },
        });
        if (controller.signal.aborted || !await this.ports.application.observe(instance.id, slot.generation, "running") || controller.signal.aborted) {
          await process.stop(); return;
        }
        slot.process = process;
        this.ports.onState?.();
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } catch (error) {
        records?.record(() => ({ event: "failed", result: controller.signal.aborted ? "cancelled" : "failure", data: { error: error instanceof Error ? error.message : "扩展启动未完成" } }));
        if (!controller.signal.aborted) {
          await this.ports.application.observe(instance.id, slot.generation, "blocked", "启动失败：请检查本机制品、配置及连接状态").catch(() => undefined);
        }
      } finally {
        if (process) await process.stop();
        slot.process = undefined;
        slot.finished = true;
        this.ports.onState?.();
        if (this.slots.get(instance.id) === slot && !slot.retired && this.allowed && !this.paused && !this.closed && this.ports.isOwner()) {
          await this.ports.application.observe(instance.id, slot.generation, "blocked", "连接中断", attempts >= 3).catch(() => undefined);
          if (attempts < 3 && this.slots.get(instance.id) === slot && !slot.retired && this.allowed && !this.paused && !this.closed && this.ports.isOwner()) {
            records?.record({ event: "retry", data: { attempt: attempts + 1 } });
            slot.timer = setTimeout(() => {
              if (this.slots.get(instance.id) !== slot) return;
              this.slots.delete(instance.id);
              void this.ports.application.get(instance.id).then((current) => {
                if (current?.enabled && current.generation === slot.generation) return this.reconcile(current, attempts + 1);
              }).catch(() => undefined);
            }, 1_000 * 2 ** attempts);
            slot.timer.unref();
          }
        }
        this.ports.onState?.();
        stopped();
      }
    };
    // Startup remains interruptible and does not occupy the command endpoint.
    void launch();
  }
}
