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
  /** 单写队列：所有 save 排到这条链上串行执行，避免并发写互相覆盖丢更新。 */
  private writeChain: Promise<void> = Promise.resolve();

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

    // 写入串行化：把「序列化当前 Map 快照 + 原子写 + rename」排到单写队列尾，
    // 任意时刻只有一个写在进行；后到的写等前一个完成、读到最新快照——根治多任务
    // 并发 save 的 last-rename-wins 丢更新（快照在串行执行时才读、而非排队时）。
    const doWrite = async (): Promise<void> => {
      const data: StoreFile = {
        version: 1,
        tasks: this.allTasks(),
      };
      await mkdir(dirname(this.filePath), { recursive: true });
      // 原子写入：先写 tmp 再 rename
      const tmpPath = this.filePath + ".tmp";
      await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await rename(tmpPath, this.filePath);
    };
    // 前一个写无论成败都接着跑下一个，避免一次失败卡死整条写链
    this.writeChain = this.writeChain.then(doWrite, doWrite);
    return this.writeChain;
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
