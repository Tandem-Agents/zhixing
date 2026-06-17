import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getZhixingHome, type WorkflowInstance } from "@zhixing/core";

export interface WorkflowStore {
  create(instance: WorkflowInstance): Promise<WorkflowInstance>;
  get(instanceId: string): Promise<WorkflowInstance | null>;
  listByConversation(conversationId: string): Promise<WorkflowInstance[]>;
  listUnfinished(): Promise<WorkflowInstance[]>;
  update(
    instanceId: string,
    updater: (instance: WorkflowInstance) => WorkflowInstance,
  ): Promise<WorkflowInstance>;
}

export class WorkflowStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStoreError";
  }
}

const UNFINISHED_STATUSES = new Set(["created", "running", "waiting_decision"]);

export class InMemoryWorkflowStore implements WorkflowStore {
  protected readonly instances = new Map<string, WorkflowInstance>();
  private pending: Promise<unknown> = Promise.resolve();

  create(instance: WorkflowInstance): Promise<WorkflowInstance> {
    return this.runExclusive(async () => {
      if (this.instances.has(instance.instanceId)) {
        throw new WorkflowStoreError(
          `Workflow instance already exists: ${instance.instanceId}`,
        );
      }
      const stored = cloneInstance(instance);
      this.instances.set(stored.instanceId, stored);
      await this.persist();
      return cloneInstance(stored);
    });
  }

  get(instanceId: string): Promise<WorkflowInstance | null> {
    return this.runExclusive(async () => {
      const instance = this.instances.get(instanceId);
      return instance ? cloneInstance(instance) : null;
    });
  }

  listByConversation(conversationId: string): Promise<WorkflowInstance[]> {
    return this.runExclusive(async () =>
      [...this.instances.values()]
        .filter((instance) => instance.conversationId === conversationId)
        .map(cloneInstance),
    );
  }

  listUnfinished(): Promise<WorkflowInstance[]> {
    return this.runExclusive(async () =>
      [...this.instances.values()]
        .filter((instance) => UNFINISHED_STATUSES.has(instance.status))
        .map(cloneInstance),
    );
  }

  update(
    instanceId: string,
    updater: (instance: WorkflowInstance) => WorkflowInstance,
  ): Promise<WorkflowInstance> {
    return this.runExclusive(async () => {
      const current = this.instances.get(instanceId);
      if (!current) {
        throw new WorkflowStoreError(`Workflow instance not found: ${instanceId}`);
      }
      const next = cloneInstance(updater(cloneInstance(current)));
      if (next.instanceId !== instanceId) {
        throw new WorkflowStoreError("Workflow instance id cannot be changed");
      }
      this.instances.set(instanceId, next);
      await this.persist();
      return cloneInstance(next);
    });
  }

  protected persist(): Promise<void> {
    return Promise.resolve();
  }

  protected loadInstances(instances: readonly WorkflowInstance[]): void {
    this.instances.clear();
    for (const instance of instances) {
      this.instances.set(instance.instanceId, cloneInstance(instance));
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn, fn);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface JsonWorkflowStoreOptions {
  filePath?: string;
}

interface WorkflowStoreFile {
  readonly version: 1;
  readonly instances: readonly WorkflowInstance[];
}

export class JsonWorkflowStore extends InMemoryWorkflowStore {
  private readonly filePath: string;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(options: JsonWorkflowStoreOptions = {}) {
    super();
    this.filePath =
      options.filePath ?? join(getZhixingHome(), "workflow", "instances.json");
  }

  override async create(instance: WorkflowInstance): Promise<WorkflowInstance> {
    await this.ensureLoaded();
    return super.create(instance);
  }

  override async get(instanceId: string): Promise<WorkflowInstance | null> {
    await this.ensureLoaded();
    return super.get(instanceId);
  }

  override async listByConversation(
    conversationId: string,
  ): Promise<WorkflowInstance[]> {
    await this.ensureLoaded();
    return super.listByConversation(conversationId);
  }

  override async listUnfinished(): Promise<WorkflowInstance[]> {
    await this.ensureLoaded();
    return super.listUnfinished();
  }

  override async update(
    instanceId: string,
    updater: (instance: WorkflowInstance) => WorkflowInstance,
  ): Promise<WorkflowInstance> {
    await this.ensureLoaded();
    return super.update(instanceId, updater);
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: WorkflowStoreFile = {
      version: 1,
      instances: [...this.instances.values()],
    };
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = this.load();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as WorkflowStoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.instances)) {
        throw new WorkflowStoreError("Invalid workflow store file");
      }
      this.loadInstances(parsed.instances);
    } catch (error) {
      if (isNotFound(error)) {
        this.loadInstances([]);
      } else if (error instanceof WorkflowStoreError) {
        throw error;
      } else {
        throw new WorkflowStoreError(
          `Failed to load workflow store: ${errorMessage(error)}`,
        );
      }
    }
    this.loaded = true;
  }
}

function cloneInstance(instance: WorkflowInstance): WorkflowInstance {
  return structuredClone(instance);
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
