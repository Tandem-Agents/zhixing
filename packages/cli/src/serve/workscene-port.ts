import type { WorksceneDto } from "@zhixing/core/contracts";

/** Anchor 产品工具所需的最小工作场景端口；持久化与 owner 装配留在组合根。 */
export interface WorksceneToolDirectory {
  get(id: string): Promise<WorksceneDto | null>;
  workspaceCatalog(): Promise<
    readonly {
      deviceId: string;
      deviceName: string;
      bindingRef: string;
      workspaceBindingRevision: number;
      workspaceName: string;
    }[]
  >;
  selectWorkspace(input: {
    deviceName: string;
    workspaceName: string;
  }): Promise<{ deviceId: string; bindingRef: string } | null>;
}
