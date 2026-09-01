import {
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type WorkspaceSessionType,
} from "@zhixing/providers";
import type { RuntimeWorkspaceConfigurationProjection } from "../runtime/runtime-configuration-projections.js";

/**
 * Anchor 宿主对默认运行形态工作区的只读投影。
 *
 * 工作区优先级、路径归一化和会话类型裁决仍只由 providers 的权威 resolver
 * 负责；这里仅把同一次解析投影成两个现有宿主消费者所需的形态。显式
 * Workscene / Executor assignment 工作区不经过本投影。
 */
export interface HostDefaultWorkspaceProjection {
  readonly postAdoptionReviewWorkingDirectory: string;
  readonly hostInfoWorkspace: string | undefined;
}

export function createHostDefaultWorkspaceProjection(
  configuration: RuntimeWorkspaceConfigurationProjection,
  sessionType: WorkspaceSessionType = resolveWorkspaceSessionType(),
): HostDefaultWorkspaceProjection {
  const resolved = resolveWorkspace(configuration, { sessionType });
  return Object.freeze({
    postAdoptionReviewWorkingDirectory: resolved.path ?? process.cwd(),
    hostInfoWorkspace: resolved.path ?? undefined,
  });
}
