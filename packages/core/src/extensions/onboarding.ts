import { ExtensionApplication, ExtensionRevisionConflict } from "./application.js";
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
  isActive(): boolean;
}

/** Replays durable decisions, not a scheduler or a second operation authority. */
export class ExtensionOnboarding {
  private pending = false;
  private running: Promise<void> | undefined;
  constructor(readonly application: ExtensionApplication, private readonly artifacts: ExtensionArtifacts,
    private readonly candidates: ExtensionCandidates, private readonly ports: ExtensionOnboardingPorts) {}

  async manage(request: ExtensionManagementRequest) {
    if (!this.ports.isActive()) throw new Error("扩展管理等待当前设备就绪");
    switch (request.action) {
      case "prepare": await this.application.prepare(request.id, request.instanceId, request.source); break;
      case "connect": {
        const current = await this.application.operation(request.id);
        if (!current || current.revision !== request.expectedRevision || !["preparing", "blocked"].includes(current.phase)) throw new ExtensionRevisionConflict();
        if (await this.application.get(current.instanceId)) throw new Error("已有试运行实例，不能覆盖；请查询并取消原操作");
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
        const snapshot = await this.application.list();
        const instance = snapshot.instances.find(item => item.id === request.instanceId);
        if (instance) await this.application.setEnabled(instance.id, false, instance.revision);
        else {
          const operations = snapshot.operations?.filter(op => op.instanceId === request.instanceId && extensionOperationActive(op)) ?? [];
          if (!operations.length) throw new Error("没有此连接或接入操作");
          for (const operation of operations) await this.application.cancel(operation.id, operation.revision);
        }
        break;
      }
      case "status": break;
      default: throw new TypeError("Invalid extension management action");
    }
    await this.reconcile();
    return this.application.list();
  }

  reconcile(): Promise<void> {
    this.pending = true;
    if (this.running) return this.running;
    const run = async () => {
      while (this.pending && this.ports.isActive()) {
        this.pending = false;
        for (const previous of (await this.application.list()).operations ?? []) {
          if (!this.ports.isActive()) return;
          let operation = previous;
          let restoringArtifact = false;
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
              const binding = await this.ports.configuration(operation);
              if (binding) {
                try {
                  const instance = await this.application.trial(operation.id, operation.revision, binding);
                  await this.ports.changed(instance);
                } catch (error) {
                  if (error instanceof ExtensionRevisionConflict) await this.ports.discard(operation.instanceId, binding);
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
              if (current && extensionOperationActive(current) && (restoringArtifact || current.phase !== "configuration")) {
                await this.application.block(current.id, current.revision, restoringArtifact ? "本机候选制品缺失或校验失败，需要重新准备；未开放正常使用" : "接入执行受阻，请查询操作并检查候选合同；未开放正常使用").catch(() => undefined);
              } else if (current?.phase === "configuration") {
                await this.application.waiting(current.id, current.revision, "请在目标设备的 /config 消息通道中补全并保存配置；候选尚未开放使用").catch(() => undefined);
              }
            }
          }
          operation = (await this.application.operation(operation.id))!;
          // Verification is type-owned and can advance several checkpoints. Do
          // not wake a model on every network event; only user-action/results.
          if (operation.phase !== "verifying" && operation.notifiedRevision !== operation.revision && this.ports.isActive()) {
            try {
              const continuation = await this.ports.notify(operation);
              await this.application.notified(operation.id, operation.revision, continuation);
            } catch { /* A durable result remains pending until a later access/recovery. */ }
          }
        }
      }
    };
    this.running = run().finally(() => { this.running = undefined; });
    return this.running;
  }
}
