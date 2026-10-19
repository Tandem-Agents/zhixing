import { ExtensionApplication, ExtensionRevisionConflict } from "./application.js";
import { createHash } from "node:crypto";
import { ExtensionArtifacts } from "./artifacts.js";
import { ExtensionCandidates, validateExtensionCandidate } from "./candidate.js";
import { extensionOperationActive, type ExtensionBinding, type ExtensionInstance, type ExtensionManagementRequest, type ExtensionManifest, type ExtensionOperation } from "./contracts.js";

/** Finite type contribution. Management knows nothing about channels or platform fields. */
export interface ExtensionOnboardingPorts {
  validate(manifest: ExtensionManifest): void;
  configuration(operation: ExtensionOperation): Promise<ExtensionBinding | undefined>;
  discard(id: string, binding: ExtensionBinding): Promise<void>;
  changed(instance: ExtensionInstance): Promise<void>;
  notify(operation: ExtensionOperation): Promise<unknown>;
  preparationClosed?(operation: ExtensionOperation): Promise<boolean>;
  repairSource?(instance: ExtensionInstance): Promise<ExtensionOperation["source"] | undefined>;
  replacement?(operation: ExtensionOperation, binding: ExtensionBinding): Promise<void>;
  isActive(): boolean;
}

/** Replays durable decisions, not a scheduler or a second operation authority. */
export class ExtensionOnboarding {
  private pending = false;
  private restartRequested = false;
  private running: Promise<void> | undefined;
  private after: string | undefined;
  private continuation: ReturnType<typeof setImmediate> | undefined;
  private closed = false;
  private readonly requested = new Set<string>();
  constructor(readonly application: ExtensionApplication, private readonly artifacts: ExtensionArtifacts,
    private readonly candidates: ExtensionCandidates, private readonly ports: ExtensionOnboardingPorts) {}

  async manage(request: ExtensionManagementRequest) {
    if (this.closed || !this.ports.isActive()) throw new Error("扩展管理等待当前设备就绪");
    switch (request.action) {
      case "prepare": await this.application.prepare(request.id, request.instanceId, request.source); break;
      case "update": case "repair": await this.application.prepare(request.id, request.instanceId, request.source, request.action); break;
      case "candidate": {
        const operation = await this.application.operation(request.id);
        const manifest = operation?.previous?.binding.manifest ?? operation?.candidate;
        if (!manifest) throw new Error("此操作尚无可导出的候选源码");
        return { ...await this.application.list(), candidate: await this.candidates.read(manifest.digest) };
      }
      case "connect": {
        const current = await this.application.operation(request.id);
        const instance = current && await this.application.get(current.instanceId);
        const correctingTrial = current && !current.previous && instance?.enabled && !instance.admission?.ready && instance.admission?.operationId === current.id;
        if (!current || current.revision !== request.expectedRevision ||
            (!["preparing", "blocked"].includes(current.phase) && !(correctingTrial && current.phase === "verifying"))) throw new ExtensionRevisionConflict();
        if (!current.previous && instance && !correctingTrial) throw new Error("该试运行已失效，请查询当前操作与启用状态");
        if (current.switched) throw new Error("原候选尚未回退，不能覆盖");
        const candidate = validateExtensionCandidate(request.candidate);
        this.ports.validate(candidate.manifest);
        // The accepted operation already exists before storing/installing anything.
        await this.candidates.save(candidate);
        await this.artifacts.import(candidate.manifest, Buffer.from(candidate.code));
        await this.application.candidate(current.id, current.revision, candidate.manifest);
        break;
      }
      case "cancel": await this.application.cancel(request.id, request.expectedRevision); break;
      case "disable": {
        const instance = await this.application.get(request.instanceId);
        if (instance) await this.ports.changed(await this.application.setEnabled(instance.id, false, instance.revision));
        else {
          const operations = await this.application.activeOperations(request.instanceId);
          if (!operations.length) throw new Error("没有此连接或接入操作");
          for (const operation of operations) { await this.application.cancel(operation.id, operation.revision); this.requested.add(operation.id); }
        }
        break;
      }
      case "status": break;
      default: throw new TypeError("Invalid extension management action");
    }
    await this.reconcile("id" in request ? request.id : undefined);
    return this.application.list();
  }

  reconcile(operationId?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (operationId) this.requested.add(operationId);
    this.pending = true;
    this.restartRequested = true;
    const running = this.runPage();
    return operationId ? running.then(() => {
      if (!this.closed && this.ports.isActive() && this.requested.has(operationId)) return this.reconcile(operationId);
    }) : running;
  }

  /** Recovery is owned here, but unrelated pending effects are not a ready barrier. */
  requestReconcile(): void {
    if (this.closed) return;
    this.pending = true;
    this.restartRequested = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.pending || this.closed || !this.ports.isActive() || this.continuation || this.running) return;
    this.continuation = setImmediate(() => {
      this.continuation = undefined;
      void this.runPage().catch(() => undefined);
    });
    this.continuation.unref();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.continuation) clearImmediate(this.continuation);
    this.continuation = undefined; this.requested.clear();
    await this.running;
  }

  private runPage(): Promise<void> {
    if (this.running) return this.running;
    const run = async () => {
      if (this.pending && !this.closed && this.ports.isActive()) {
        this.pending = false;
        if (this.after === undefined) this.restartRequested = false;
        const snapshot = await this.application.current();
        for (const instance of snapshot.instances) {
          if (!instance.enabled || instance.phase !== "blocked" || !instance.recoveryExhausted || (instance.admission && !instance.admission.ready) ||
              snapshot.operations?.some(op => op.instanceId === instance.id && extensionOperationActive(op))) continue;
          const source = [...snapshot.operations ?? []].reverse().find(op => op.instanceId === instance.id)?.source ?? await this.ports.repairSource?.(instance);
          if (source) await this.application.prepare(`repair-${createHash("sha256").update(`${instance.id}:${instance.generation}`).digest("hex")}`, instance.id,
            { ...source, request: "连接有限恢复已耗尽。定位并修复原有能力，不更换账号、扩权、增功能或清除历史。" }, "repair");
        }
        const selected = [...this.requested].slice(0, 32);
        for (const id of selected) {
          if (this.closed || !this.ports.isActive()) return;
          const operation = await this.application.operation(id);
          if (operation) await this.reconcileOperation(operation);
          this.requested.delete(id);
        }
        const page = await this.application.workPage(this.after, 32);
        for (const previous of page.operations) {
          if (this.closed || !this.ports.isActive()) return;
          if (!selected.includes(previous.id)) await this.reconcileOperation(previous);
        }
        this.after = page.after;
        this.pending ||= page.after !== undefined || this.requested.size > 0 || this.restartRequested;
      }
    };
    let completed = false;
    this.running = run().then(() => { completed = true; }).finally(() => {
      this.running = undefined;
      if (completed) this.schedule();
    });
    return this.running;
  }

  private async reconcileOperation(previous: ExtensionOperation): Promise<void> {
    if (this.closed || !this.ports.isActive()) return;
    const current = await this.application.operation(previous.id);
    if (!current) return;
    let operation = current;
    let restoringArtifact = false;
    let configuringExisting = false;
    try {
      if (operation.phase === "preparing" && operation.notifiedRevision === operation.revision &&
          await this.ports.preparationClosed?.(operation)) {
        await this.application.block(operation.id, operation.revision, "准备运行已结束，尚未提交有效候选；未安装或启用连接");
      }
      if (operation.phase === "configuration") {
        restoringArtifact = true;
        const saved = await this.candidates.read(operation.candidate!.digest);
        await this.artifacts.import(saved.manifest, Buffer.from(saved.code));
        restoringArtifact = false;
        const configuredInstance = await this.application.get(operation.instanceId);
        configuringExisting = Boolean(configuredInstance);
        const binding = await this.ports.configuration(operation);
        if (binding) {
          try {
            if (operation.previous) await this.ports.replacement?.(operation, binding);
            const instance = await this.application.trial(operation.id, operation.revision, binding);
            await this.ports.changed(instance);
          } catch (error) {
            // Existing instances borrow a committed immutable projection,
            // including failed first trials. Only initial preparation owns
            // an uncommitted projection that can be discarded on conflict.
            if (error instanceof ExtensionRevisionConflict && !configuredInstance && !operation.previous &&
                !(await this.application.get(operation.instanceId))) await this.ports.discard(operation.instanceId, binding);
            throw error;
          }
        }
      }
      const instance = await this.application.get(operation.instanceId);
      // Only reconcile a durable start/stop decision. A status query must
      // not reset the runtime's finite retry budget after a fault.
      if (instance && (!instance.enabled || instance.phase === "stopped")) await this.ports.changed(instance);
    } catch (error) {
      if (!(error instanceof ExtensionRevisionConflict)) {
        const current = await this.application.operation(operation.id);
        if (current && extensionOperationActive(current) && (restoringArtifact || configuringExisting || current.phase !== "configuration" || current.previous)) {
          await this.application.block(current.id, current.revision, restoringArtifact ? "本机候选制品缺失或校验失败，需要重新准备；未开放正常使用" : "接入执行受阻，请查询操作并检查候选合同；未开放正常使用").catch(() => undefined);
        } else if (current?.phase === "configuration") {
          await this.application.waiting(current.id, current.revision, "请在目标设备的 /config 消息通道中补全并保存配置；候选尚未开放使用").catch(() => undefined);
        }
      }
    }
    const settled = await this.application.get(operation.instanceId);
    if (settled && settled.phase === "stopped") await this.ports.changed(settled);
    const refreshed = await this.application.operation(operation.id);
    if (!refreshed) return;
    operation = refreshed;
    // Verification is type-owned and can advance several checkpoints. Do
    // not wake a model on every network event; only user-action/results.
    if ((operation.phase !== "verifying" || !operation.verification) && operation.notifiedRevision !== operation.revision && !this.closed && this.ports.isActive()) {
      try {
        const continuation = await this.ports.notify(operation);
        if (!this.closed && this.ports.isActive()) await this.application.notified(operation.id, operation.revision, continuation);
      } catch { /* A durable result remains pending until a later access/recovery. */ }
    }
  }
}
