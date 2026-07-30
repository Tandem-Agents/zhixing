import type { WorksceneDto } from "@zhixing/core/contracts";

export interface WorksceneWriteResult {
  readonly scene: WorksceneDto;
  readonly workspaceWarning?: string;
}

/** 运行宿主工具所需的最小工作场景端口；持久化与 owner 装配留在组合根。 */
export interface WorksceneToolDirectory {
  list(): Promise<WorksceneDto[]>;
  get(id: string): Promise<WorksceneDto | null>;
  create(options: {
    readonly name: string;
    readonly workspace?: { deviceId: string; bindingRef: string };
    readonly requestId: string;
  }): Promise<WorksceneWriteResult>;
  rename(id: string, name: string, requestId: string): Promise<WorksceneDto | null>;
  setWorkdir(
    id: string,
    workspace: { deviceId: string; bindingRef: string } | null,
    requestId: string,
  ): Promise<WorksceneWriteResult | null>;
  remove(id: string, requestId: string): Promise<boolean>;
  workspaceCatalog(): Promise<
    readonly {
      deviceId: string;
      deviceName: string;
      bindingRef: string;
      workspaceName: string;
    }[]
  >;
  selectWorkspace(input: {
    deviceName: string;
    workspaceName: string;
  }): Promise<{ deviceId: string; bindingRef: string } | null>;
}
