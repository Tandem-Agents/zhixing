import type { WorkScene } from "@zhixing/core";

export interface WorksceneWriteResult {
  readonly scene: WorkScene;
  readonly workdirWarning?: string;
}

/** 运行宿主工具所需的最小工作场景端口；持久化与 owner 装配留在组合根。 */
export interface WorksceneToolDirectory {
  list(): Promise<WorkScene[]>;
  get(id: string): Promise<WorkScene | null>;
  create(options: {
    readonly name: string;
    readonly workdir?: string;
  }): Promise<WorksceneWriteResult>;
  rename(id: string, name: string): Promise<WorkScene | null>;
  setWorkdir(
    id: string,
    workdir: string | null,
  ): Promise<WorksceneWriteResult | null>;
  remove(id: string): Promise<boolean>;
}
