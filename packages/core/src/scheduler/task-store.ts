/**
 * JSON 文件持久化的 TaskStore 实现
 *
 * 存储位置：~/.zhixing/scheduler.json
 * 格式：{ version: 1, tasks: ScheduledTask[] }
 *
 * 设计要点：
 * - 读写分离：load() 从磁盘加载到内存，save() 从内存写回磁盘
 * - 内存缓存：getTask() 等查询走内存，不触发 IO
 * - 原子写入：先写 .tmp 再 rename，防止写入中断导致文件损坏
 * - 无依赖：仅使用 node:fs 和 node:path
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getZhixingHome } from "../paths.js";
import type { TaskStore, ScheduledTask } from "./types.js";

interface StoreFile {
  version: 1;
  tasks: ScheduledTask[];
}

/**
 * 默认任务存储路径——惰性求值，每次调用走 getZhixingHome 让 ZHIXING_HOME
 * 环境变量在测试 / 部署期能切换 home 目录而不需要重启进程。
 */
export function getSchedulerStorePath(): string {
  return join(getZhixingHome(), "scheduler.json");
}

export class JsonTaskStore implements TaskStore {
  private tasks: Map<string, ScheduledTask> = new Map();
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getSchedulerStorePath();
  }

  async load(): Promise<ScheduledTask[]> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data: StoreFile = JSON.parse(raw);
      this.tasks.clear();
      for (const task of data.tasks) {
        this.tasks.set(task.id, task);
      }
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        // 首次启动，文件不存在，使用空列表
        this.tasks.clear();
      } else {
        throw err;
      }
    }
    return this.allTasks();
  }

  async save(tasks?: ScheduledTask[]): Promise<void> {
    if (tasks) {
      this.tasks.clear();
      for (const task of tasks) {
        this.tasks.set(task.id, task);
      }
    }

    const data: StoreFile = {
      version: 1,
      tasks: this.allTasks(),
    };

    // 确保目录存在
    await mkdir(dirname(this.filePath), { recursive: true });

    // 原子写入：先写 tmp 再 rename
    const tmpPath = this.filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }

  async addTask(task: ScheduledTask): Promise<void> {
    this.tasks.set(task.id, task);
    await this.save();
  }

  async updateTask(id: string, patch: Partial<ScheduledTask>): Promise<void> {
    const existing = this.tasks.get(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.tasks.set(id, updated);
    await this.save();
  }

  async removeTask(id: string): Promise<void> {
    if (!this.tasks.delete(id)) {
      throw new Error(`Task not found: ${id}`);
    }
    await this.save();
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  private allTasks(): ScheduledTask[] {
    return [...this.tasks.values()];
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
