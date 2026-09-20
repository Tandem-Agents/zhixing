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
} from "./contracts.js";

export const EXTENSION_AUTHORITY_STREAM = "extensions";
export class ExtensionRevisionConflict extends Error {
  constructor() { super("Extension revision conflict"); }
}
interface InstanceRecord { readonly kind: "extension-instance"; readonly instance: ExtensionInstance }
type State = ReadonlyMap<string, ExtensionInstance>;
function withoutReason(instance: ExtensionInstance): Omit<ExtensionInstance, "reason"> {
  const { reason: _reason, ...rest } = instance;
  return rest;
}

function reduce(state: State, record: LogicalRecord<InstanceRecord>): State {
  if (record.stream !== EXTENSION_AUTHORITY_STREAM) return state;
  if (record.body.kind !== "extension-instance") throw new Error("Invalid extension authority record");
  return new Map(state).set(record.body.instance.id, record.body.instance);
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
export const EXTENSION_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [extensionList, extensionSetEnabled, extensionRefresh, extensionApplyConfiguration], factEvents: [],
});

/** All durable decisions are short Authority transactions, never transport waits. */
export class ExtensionApplication {
  constructor(private readonly ports: {
    readonly log: () => AuthorityCommitLog;
    readonly assertOwner: () => void;
    readonly commitDecision?: <T>(operation: () => Promise<T>) => Promise<T>;
  }) {}

  async list(): Promise<ExtensionSnapshot> {
    const state = await this.ports.log().rebuildProjection<State, InstanceRecord>(new Map(), reduce, {
      stream: EXTENSION_AUTHORITY_STREAM,
    });
    return { instances: [...state.values()].map((entry) => structuredClone({ ...entry, intentRevision: entry.intentRevision ?? 1 })) };
  }

  async get(id: string): Promise<ExtensionInstance | undefined> {
    return (await this.list()).instances.find((instance) => instance.id === id);
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
    });
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

  async observe(id: string, generation: string, phase: "running" | "blocked", reason?: string): Promise<boolean> {
    let accepted = false;
    await this.change(id, (current) => {
      if (!current) throw new Error("Unknown extension instance");
      if (!current.enabled || current.generation !== generation) return current;
      accepted = true;
      return { ...withoutReason(current), phase, ...(reason ? { reason } : {}) };
    });
    return accepted;
  }

  contribution(effects: {
    changed(instance: ExtensionInstance): Promise<void>;
    refresh(id: string, expectedRevision: number): Promise<ExtensionInstance>;
    applyConfiguration(ids: readonly string[]): Promise<ExtensionSnapshot>;
  }) {
    return defineProductApiContribution({
      operations: [
        bindProductApiOperation(extensionList, async () => ({ result: await this.list(), facts: [] })),
        bindProductApiOperation(extensionSetEnabled, async ({ id, enabled, expectedRevision }) => {
          const result = await this.setEnabled(id, enabled, expectedRevision);
          await effects.changed(result);
          return { result, facts: [] };
        }),
        bindProductApiOperation(extensionRefresh, async ({ id, expectedRevision }) => ({
          result: await effects.refresh(id, expectedRevision), facts: [],
        })),
        bindProductApiOperation(extensionApplyConfiguration, async ({ ids }) => ({ result: await effects.applyConfiguration(ids), facts: [] })),
      ], factEvents: [],
    });
  }

  private expect(current: ExtensionInstance | undefined, revision: number): void {
    if (!current) throw new Error("Unknown extension instance");
    if (!Number.isSafeInteger(revision) || current.revision !== revision) throw new ExtensionRevisionConflict();
  }

  private async change(id: string, decide: (current: ExtensionInstance | undefined) => ExtensionInstance): Promise<ExtensionInstance> {
    return this.ports.commitDecision ? this.ports.commitDecision(() => this.commit(id, decide)) : this.commit(id, decide);
  }

  private async commit(id: string, decide: (current: ExtensionInstance | undefined) => ExtensionInstance): Promise<ExtensionInstance> {
    const result = await this.ports.log().transactProjection<State, InstanceRecord, ExtensionInstance>(
      new Map(), reduce, (state) => {
        this.ports.assertOwner();
        const current = state.get(id);
        const instance = decide(current);
        if (instance === current) return { kind: "return", value: structuredClone(instance) };
        if (instance.enabled && instance.binding.exclusiveKey && [...state.values()].some((other) =>
          other.id !== id && other.enabled && other.binding.exclusiveKey === instance.binding.exclusiveKey)) {
          throw new Error("Exclusive extension resource is already claimed");
        }
        return { kind: "append", entries: [{ stream: EXTENSION_AUTHORITY_STREAM,
          body: { kind: "extension-instance", instance } }], value: structuredClone(instance) };
      }, { stream: EXTENSION_AUTHORITY_STREAM },
    );
    return result.value;
  }
}
