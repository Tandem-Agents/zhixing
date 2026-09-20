import { randomUUID } from "node:crypto";
import type { AuthorityCommitLog } from "../authority/interfaces.js";
import type { LogicalRecord } from "../contracts/index.js";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
} from "../product-api/catalog.js";
import {
  validateExtensionBinding,
  type ExtensionBinding,
  type ExtensionInstance,
  type ExtensionSnapshot,
  type ExtensionOperation,
  type ExtensionManagementRequest,
  type ExtensionManifest,
  extensionOperationActive,
  validateExtensionManifest,
} from "./contracts.js";

export const EXTENSION_AUTHORITY_STREAM = "extensions";
export class ExtensionRevisionConflict extends Error {
  constructor() { super("Extension revision conflict"); }
}
interface InstanceRecord { readonly kind: "extension-instance"; readonly instance: ExtensionInstance }
interface OperationRecord { readonly kind: "extension-operation"; readonly operation: ExtensionOperation }
type RecordBody = InstanceRecord | OperationRecord;
interface State { instances: ReadonlyMap<string, ExtensionInstance>; operations: ReadonlyMap<string, ExtensionOperation> }
const empty = (): State => ({ instances: new Map(), operations: new Map() });
function withoutReason(instance: ExtensionInstance): Omit<ExtensionInstance, "reason"> {
  const { reason: _reason, ...rest } = instance;
  return rest;
}

function reduce(state: State, record: LogicalRecord<RecordBody>): State {
  if (record.stream !== EXTENSION_AUTHORITY_STREAM) return state;
  if (record.body.kind === "extension-instance") return { ...state, instances: new Map(state.instances).set(record.body.instance.id, record.body.instance) };
  if (record.body.kind === "extension-operation") return { ...state, operations: new Map(state.operations).set(record.body.operation.id, record.body.operation) };
  throw new Error("Invalid extension authority record");
}

export const extensionList = defineProductApiQuery<"extensions.list", void, ExtensionSnapshot>("extensions.list");
export const extensionSetEnabled = defineProductApiCommand<
  "extensions.set-enabled", { id: string; enabled: boolean; expectedRevision: number }, ExtensionInstance, never
>("extensions.set-enabled", []);
export const extensionRefresh = defineProductApiCommand<
  "extensions.refresh", { id: string; expectedRevision: number }, ExtensionInstance, never
>("extensions.refresh", []);
export const extensionApplyConfiguration = defineProductApiCommand<
  "extensions.apply-configuration", { ids: readonly string[] }, ExtensionSnapshot, never
>("extensions.apply-configuration", []);
export const extensionManage = defineProductApiCommand<"extensions.manage", ExtensionManagementRequest, ExtensionSnapshot, never>("extensions.manage", []);
export const extensionLocalSetup = defineProductApiQuery<"extensions.local-setup", void, Readonly<Record<string, string>>>("extensions.local-setup");
export function extensionPublicSnapshot(snapshot: ExtensionSnapshot): ExtensionSnapshot {
  return { ...snapshot, ...(snapshot.operations ? { operations: snapshot.operations.map(({ verification: _verification, continuation: _continuation, source: { returnAddress: _address, ...source }, ...operation }) => ({ ...operation, source })) } : {}) };
}
export const EXTENSION_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [extensionList, extensionSetEnabled, extensionRefresh, extensionApplyConfiguration, extensionManage, extensionLocalSetup], factEvents: [],
});

/** All durable decisions are short Authority transactions, never transport waits. */
export class ExtensionApplication {
  constructor(private readonly ports: {
    readonly log: () => AuthorityCommitLog;
    readonly assertOwner: () => void;
    readonly commitDecision?: <T>(operation: () => Promise<T>) => Promise<T>;
  }) {}

  async list(): Promise<ExtensionSnapshot> {
    const state = await this.ports.log().rebuildProjection<State, RecordBody>(empty(), reduce, {
      stream: EXTENSION_AUTHORITY_STREAM,
    });
    return { instances: [...state.instances.values()].map((entry) => structuredClone({ ...entry, intentRevision: entry.intentRevision ?? 1 })),
      ...(state.operations.size ? { operations: structuredClone([...state.operations.values()]) } : {}) };
  }

  async get(id: string): Promise<ExtensionInstance | undefined> {
    return (await this.list()).instances.find((instance) => instance.id === id);
  }

  async operation(id: string): Promise<ExtensionOperation | undefined> {
    return (await this.list()).operations?.find((entry) => entry.id === id);
  }

  async prepare(id: string, instanceId: string, source: ExtensionOperation["source"], purpose?: "update" | "repair"): Promise<ExtensionOperation> {
    if (![id, instanceId].every((value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) ||
        !source || typeof source.conversationId !== "string" || !source.conversationId || source.conversationId.length > 256 ||
        typeof source.request !== "string" || !source.request.trim() || source.request.length > 16000) throw new TypeError("Invalid extension request");
    return this.decide((state) => {
      const previous = state.operations.get(id);
      if (previous) {
        if (previous.instanceId !== instanceId || previous.source.conversationId !== source.conversationId || previous.source.request !== source.request || previous.purpose !== purpose) throw new Error("Extension request identity conflict");
        return { value: previous, records: [] };
      }
      const instance = state.instances.get(instanceId);
      const active = [...state.operations.values()].find(op => op.instanceId === instanceId && extensionOperationActive(op));
      if (purpose === "repair" && active?.purpose === "repair" && active.phase !== "blocked") return { value: active, records: [] };
      // A new explicit request may replace a finished diagnosis; automatic fault
      // observation still coalesces against blocked operations and stable ids.
      const superseded = purpose && active?.previous && active.phase === "blocked" && !active.switched ? active : undefined;
      if ((active && !superseded) || (!purpose && instance) || (purpose && (!instance?.enabled || (instance.admission && !instance.admission.ready)))) throw new Error("该连接不可创建此操作，请查询现有状态");
      const operation: ExtensionOperation = { id, instanceId, source: structuredClone(source), revision: 1, phase: "preparing",
        ...(purpose && instance ? { purpose, previous: { binding: instance.binding, intentRevision: instance.intentRevision,
          ...(instance.admission ? { admission: instance.admission } : {}) } } : {}) };
      const records: RecordBody[] = superseded ? [{ kind: "extension-operation", operation: { ...superseded, revision: superseded.revision + 1, phase: "cancelled" } }] : [];
      return { value: operation, records: [...records, { kind: "extension-operation", operation }] };
    });
  }

  async candidate(id: string, revision: number, manifest: ExtensionManifest): Promise<ExtensionOperation> {
    const candidate = validateExtensionManifest(manifest);
    return this.changeOperation(id, revision, (current) => {
      if (current.phase !== "preparing" && current.phase !== "blocked") throw new Error("Candidate is no longer accepted");
      const { reason: _reason, verification: _verification, ...rest } = current;
      return { ...rest, candidate, phase: "configuration" };
    });
  }

  /** Trial and rollback input commit together, before retiring the old generation. */
  async trial(id: string, revision: number, binding: ExtensionBinding): Promise<ExtensionInstance> {
    const checked = validateExtensionBinding(binding);
    return this.decide((state) => {
      const operation = state.operations.get(id);
      if (!operation || operation.revision !== revision || operation.phase !== "configuration" || operation.candidate?.digest !== checked.manifest.digest) throw new ExtensionRevisionConflict();
      const current = state.instances.get(operation.instanceId);
      if (operation.previous) {
        if (!current?.enabled || current.intentRevision !== operation.previous.intentRevision ||
            current.binding.projectionRevision !== operation.previous.binding.projectionRevision ||
            current.binding.manifest.digest !== operation.previous.binding.manifest.digest) throw new ExtensionRevisionConflict();
      } else if (current) throw new Error("Extension instance already exists");
      const instance: ExtensionInstance = { id: operation.instanceId, revision: (current?.revision ?? 0) + 1, enabled: true, intentRevision: current?.intentRevision ?? 1,
        binding: checked, generation: null, phase: "stopped", admission: { operationId: id, ready: false } };
      this.exclusive(state, instance);
      const { reason: _reason, ...accepted } = operation;
      return { value: instance, records: [{ kind: "extension-instance", instance },
        { kind: "extension-operation", operation: { ...accepted, revision: revision + 1, phase: "verifying", ...(operation.previous ? { switched: true } : {}) } }] };
    });
  }

  async checkpoint(id: string, revision: number, verification: unknown): Promise<ExtensionOperation> {
    return this.changeOperation(id, revision, (current) => {
      if (current.phase !== "verifying") throw new ExtensionRevisionConflict();
      return { ...current, verification: structuredClone(verification) };
    });
  }

  async complete(id: string, revision: number, generation: string, verification?: unknown): Promise<void> {
    await this.decide((state) => {
      const operation = state.operations.get(id);
      const instance = operation && state.instances.get(operation.instanceId);
      if (!operation || operation.revision !== revision || operation.phase !== "verifying" || !instance?.enabled ||
          instance.generation !== generation || instance.admission?.operationId !== id) throw new ExtensionRevisionConflict();
      return { value: undefined, records: [{ kind: "extension-operation", operation: { ...operation, revision: revision + 1, phase: "ready", ...(verification === undefined ? {} : { verification }) } },
        { kind: "extension-instance", instance: { ...instance, admission: { operationId: id, ready: true } } }] };
    });
  }

  async block(id: string, revision: number, reason: string): Promise<void> {
    await this.finishUnsuccessful(id, revision, "blocked", reason.slice(0, 1000));
  }

  async waiting(id: string, revision: number, reason: string): Promise<void> {
    const current = await this.operation(id);
    if (current?.reason === reason) return;
    await this.changeOperation(id, revision, (operation) => ({ ...operation, reason }));
  }

  async cancel(id: string, revision: number): Promise<void> {
    await this.finishUnsuccessful(id, revision, "cancelled");
  }

  private async finishUnsuccessful(id: string, revision: number, phase: "blocked" | "cancelled", reason?: string): Promise<void> {
    await this.decide((state) => {
      const operation = state.operations.get(id);
      if (!operation || operation.revision !== revision) throw new ExtensionRevisionConflict();
      if (!extensionOperationActive(operation)) return { value: undefined, records: [] };
      const instance = state.instances.get(operation.instanceId);
      const records: RecordBody[] = [{ kind: "extension-operation", operation: { ...operation, revision: revision + 1, phase, switched: false, ...(reason ? { reason } : {}) } }];
      if (operation.previous && operation.switched && instance?.enabled && instance.admission?.operationId === id && instance.intentRevision === operation.previous.intentRevision) {
        records.push({ kind: "extension-instance", instance: this.rollback(instance, operation) });
      } else if (!operation.previous && phase === "cancelled" && instance?.admission?.operationId === id && !instance.admission.ready) records.push({ kind: "extension-instance", instance: {
        ...instance, enabled: false, revision: instance.revision + 1, intentRevision: instance.intentRevision + 1, generation: null, phase: "stopped" } });
      return { value: undefined, records };
    });
  }

  private rollback(instance: ExtensionInstance, operation: ExtensionOperation): ExtensionInstance {
    const { admission: _admission, recoveryExhausted: _exhausted, reason: _reason, ...rest } = instance;
    return { ...rest, binding: operation.previous!.binding, ...(operation.previous!.admission ? { admission: operation.previous!.admission } : {}),
      revision: instance.revision + 1, generation: null, phase: "stopped" };
  }

  async notified(id: string, revision: number, continuation?: unknown): Promise<void> {
    await this.decide((state) => {
      const operation = state.operations.get(id);
      if (!operation || operation.revision !== revision) return { value: undefined, records: [] };
      return { value: undefined, records: [{ kind: "extension-operation", operation: { ...operation, notifiedRevision: revision,
        ...(continuation === undefined ? {} : { continuation }) } }] };
    });
  }

  private async changeOperation(id: string, revision: number, change: (current: ExtensionOperation) => ExtensionOperation): Promise<ExtensionOperation> {
    return this.decide((state) => {
      const current = state.operations.get(id);
      if (!current || current.revision !== revision || !extensionOperationActive(current)) throw new ExtensionRevisionConflict();
      const operation = { ...change(current), revision: revision + 1 };
      return { value: operation, records: [{ kind: "extension-operation", operation }] };
    });
  }

  async adopt(id: string, binding: ExtensionBinding, enabled = true): Promise<ExtensionInstance> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new TypeError("Invalid extension instance id");
    const checked = validateExtensionBinding(binding);
    return this.change(id, (current) => current ?? {
      id, revision: 1, enabled, intentRevision: 1, binding: checked, generation: null, phase: "stopped",
    });
  }

  async setEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<ExtensionInstance> {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
    return this.change(id, (current) => {
      this.expect(current, expectedRevision);
      return { ...withoutReason(current!), revision: current!.revision + 1, enabled,
        intentRevision: (current!.intentRevision ?? 1) + 1,
        generation: null, phase: "stopped" };
    });
  }

  /** Only the trusted Configuration binding can submit a complete new projection. */
  async refresh(id: string, binding: ExtensionBinding, expectedRevision: number, enabled?: boolean): Promise<ExtensionInstance> {
    const checked = validateExtensionBinding(binding);
    return this.change(id, (current) => {
      this.expect(current, expectedRevision);
      if (current!.binding.manifest.digest !== checked.manifest.digest) {
        throw new Error("Version replacement requires the replacement workflow");
      }
      const { configurationIssue: _issue, ...previous } = withoutReason(current!);
      return { ...previous, binding: checked, enabled: enabled ?? current!.enabled, revision: current!.revision + 1,
        intentRevision: (current!.intentRevision ?? 1) + (enabled === undefined ? 0 : 1),
        generation: null, phase: "stopped" };
    }, true);
  }

  async begin(id: string, expectedRevision: number): Promise<ExtensionInstance> {
    return this.change(id, (current) => {
      this.expect(current, expectedRevision);
      if (!current!.enabled) throw new Error("Extension is disabled");
      return { ...withoutReason(current!), revision: current!.revision + 1, generation: randomUUID(),
        phase: "starting" };
    });
  }

  async noteConfiguration(id: string, expectedRevision: number, issue?: string): Promise<void> {
    await this.change(id, (current) => {
      if (!current) throw new Error("Unknown extension instance");
      if (current.revision !== expectedRevision) return current;
      if (current.configurationIssue === issue) return current;
      const { configurationIssue: _previous, ...rest } = current;
      return { ...rest, ...(issue ? { configurationIssue: issue } : {}) };
    });
  }

  async observe(id: string, generation: string, phase: "running" | "blocked", reason?: string, recoveryExhausted = false): Promise<boolean> {
    return this.decide((state) => {
      const current = state.instances.get(id);
      if (!current) throw new Error("Unknown extension instance");
      if (!current.enabled || current.generation !== generation) return { value: false, records: [] };
      const records: RecordBody[] = [{ kind: "extension-instance", instance: { ...withoutReason(current), phase, recoveryExhausted, ...(reason ? { reason } : {}) } }];
      const operation = current.admission && !current.admission.ready ? state.operations.get(current.admission.operationId) : undefined;
      if (phase === "blocked" && recoveryExhausted && operation?.phase === "verifying") {
        if (operation.previous && operation.switched) records[0] = { kind: "extension-instance", instance: this.rollback(current, operation) };
        records.push({ kind: "extension-operation", operation: {
          ...operation, revision: operation.revision + 1, phase: "blocked", switched: false, reason: operation.previous ? "候选启动或恢复失败，已恢复原版本绑定；可用性以当前连接状态为准" : "连接启动或恢复失败，尚未通过收发验证；请检查本机连接状态与配置" } });
      }
      return { value: true, records };
    });
  }

  contribution(effects: {
    changed(instance: ExtensionInstance): Promise<void>;
    refresh(id: string, expectedRevision: number): Promise<ExtensionInstance>;
    applyConfiguration(ids: readonly string[]): Promise<ExtensionSnapshot>;
    manage?(request: ExtensionManagementRequest): Promise<ExtensionSnapshot>;
    localSetup?(): Promise<Readonly<Record<string, string>>>;
  }) {
    return defineProductApiContribution({
      operations: [
        bindProductApiOperation(extensionManage, async (request) => {
          if (!effects.manage) throw new Error("扩展接入暂不可用");
          return { result: extensionPublicSnapshot(await effects.manage(request)), facts: [] };
        }),
        bindProductApiOperation(extensionLocalSetup, async () => ({ result: await effects.localSetup?.() ?? {}, facts: [] })),
        bindProductApiOperation(extensionList, async () => ({ result: extensionPublicSnapshot(await this.list()), facts: [] })),
        bindProductApiOperation(extensionSetEnabled, async ({ id, enabled, expectedRevision }) => {
          const result = await this.setEnabled(id, enabled, expectedRevision);
          await effects.changed(result);
          return { result, facts: [] };
        }),
        bindProductApiOperation(extensionRefresh, async ({ id, expectedRevision }) => ({
          result: await effects.refresh(id, expectedRevision), facts: [],
        })),
        bindProductApiOperation(extensionApplyConfiguration, async ({ ids }) => ({ result: extensionPublicSnapshot(await effects.applyConfiguration(ids)), facts: [] })),
      ], factEvents: [],
    });
  }

  private expect(current: ExtensionInstance | undefined, revision: number): void {
    if (!current) throw new Error("Unknown extension instance");
    if (!Number.isSafeInteger(revision) || current.revision !== revision) throw new ExtensionRevisionConflict();
  }

  private async change(id: string, decide: (current: ExtensionInstance | undefined) => ExtensionInstance, configurationRefresh = false): Promise<ExtensionInstance> {
    return this.ports.commitDecision ? this.ports.commitDecision(() => this.commit(id, decide, configurationRefresh)) : this.commit(id, decide, configurationRefresh);
  }

  private async commit(id: string, decide: (current: ExtensionInstance | undefined) => ExtensionInstance, configurationRefresh: boolean): Promise<ExtensionInstance> {
    const result = await this.ports.log().transactProjection<State, RecordBody, ExtensionInstance>(
      empty(), reduce, (state) => {
        this.ports.assertOwner();
        const current = state.instances.get(id);
        let instance = decide(current);
        if (instance === current) return { kind: "return", value: structuredClone(instance) };
        this.exclusive(state, instance);
        const operations = new Map<string, ExtensionOperation>();
        for (const operation of state.operations.values()) {
          if (operation.instanceId !== id || !operation.previous || !extensionOperationActive(operation)) continue;
          if (configurationRefresh && current?.enabled && instance.enabled && current.binding.configurationRevision === instance.binding.configurationRevision) {
            // A user-approved secret rotation for the same account resumes the
            // operation and rollback with the same complete local publication.
            operations.set(operation.id, { ...operation, revision: operation.revision + 1, previous: { ...operation.previous,
              binding: { ...instance.binding, manifest: operation.previous.binding.manifest }, intentRevision: instance.intentRevision } });
            continue;
          }
          if (!instance.enabled || instance.intentRevision !== operation.previous.intentRevision ||
              (current && current.binding.projectionRevision !== instance.binding.projectionRevision)) {
            // Stop/configuration intent revokes the candidate. Never leave it as
            // the version that a later explicit enable would accidentally start.
            if (operation.switched && !instance.enabled) instance = { ...this.rollback(instance, operation), enabled: false };
            else if (operation.switched) throw new Error("换版验证期间请先取消操作，再修改配置");
            operations.set(operation.id, { ...operation, revision: operation.revision + 1, phase: "cancelled", switched: false });
          }
        }
        const admission = instance.admission;
        const admittedBy = admission ? state.operations.get(admission.operationId) : undefined;
        if (admission && admittedBy && current) {
          // Type-owned configuration identity is part of admission, unlike a
          // transient process generation or a secret rotation for the same account.
          const identityChanged = current.binding.configurationRevision !== instance.binding.configurationRevision;
          const explicitlyRestarted = instance.enabled && !current.enabled && admittedBy.phase === "cancelled";
          if (identityChanged || explicitlyRestarted) {
            instance = { ...instance, admission: { ...admission, ready: false } };
            const { verification: _proof, reason: _reason, continuation: _continuation, ...previous } = admittedBy;
            operations.set(admittedBy.id, { ...previous, revision: previous.revision + 1, phase: instance.enabled ? "verifying" : "cancelled" });
          } else if (instance.enabled && !admission.ready && instance.phase === "starting" && admittedBy.phase === "blocked") {
            const { reason: _reason, ...previous } = admittedBy;
            operations.set(previous.id, { ...previous, revision: previous.revision + 1, phase: "verifying" });
          }
        }
        if (!instance.enabled) for (const previous of state.operations.values()) {
          const operation = operations.get(previous.id) ?? previous;
          if (operation.instanceId === id && extensionOperationActive(operation)) operations.set(operation.id, { ...operation, revision: operation.revision + 1, phase: "cancelled" });
        }
        const records: RecordBody[] = [{ kind: "extension-instance", instance }, ...[...operations.values()].map(operation => ({ kind: "extension-operation" as const, operation }))];
        return { kind: "append", entries: records.map((body) => ({ stream: EXTENSION_AUTHORITY_STREAM, body })), value: structuredClone(instance) };
      }, { stream: EXTENSION_AUTHORITY_STREAM },
    );
    return result.value;
  }

  private exclusive(state: State, instance: ExtensionInstance): void {
    if (instance.enabled && instance.binding.exclusiveKey && [...state.instances.values()].some((other) =>
      other.id !== instance.id && other.enabled && other.binding.exclusiveKey === instance.binding.exclusiveKey)) throw new Error("Exclusive extension resource is already claimed");
  }

  private async decide<T>(decide: (state: State) => { value: T; records: RecordBody[] }): Promise<T> {
    const execute = async () => (await this.ports.log().transactProjection<State, RecordBody, T>(empty(), reduce, (state) => {
      this.ports.assertOwner();
      const result = decide(state);
      return result.records.length ? { kind: "append", entries: result.records.map((body) => ({ stream: EXTENSION_AUTHORITY_STREAM, body })), value: structuredClone(result.value) }
        : { kind: "return", value: structuredClone(result.value) };
    }, { stream: EXTENSION_AUTHORITY_STREAM })).value;
    return this.ports.commitDecision ? this.ports.commitDecision(execute) : execute();
  }
}
