import path from "node:path";

import {
  buildGuidanceMessagePair,
  loadLayeredGuidance as defaultLoadLayeredGuidance,
  type GuidanceResolvedRoots,
  type GuidanceWarningInput,
  type ReadGuidanceFile,
} from "@zhixing/core";
import type { AgentRuntimeLifecycle } from "@zhixing/orchestrator/runtime";

export interface ZhixingGuidanceLifecycleDeps {
  readonly getZhixingHome: () => string;
  /**
   * Resolves the runtime-local workspace root. Raw paths never cross the
   * workscene registry or its wire DTO.
   */
  readonly resolveWorksceneRoot: (sceneId: string) => Promise<string | null>;
  readonly readGuidanceFile: ReadGuidanceFile;
  readonly loadLayeredGuidance?: typeof defaultLoadLayeredGuidance;
}

export function createZhixingGuidanceLifecycle(
  deps: ZhixingGuidanceLifecycleDeps,
): AgentRuntimeLifecycle {
  const loadLayeredGuidance =
    deps.loadLayeredGuidance ?? defaultLoadLayeredGuidance;

  return {
    id: "zhixing-guidance",
    async onWindowOpen(ctx) {
      ctx.contributeMessagePrefix(null);
      if (ctx.runtimeKind === "ephemeral") return;

      let warningFailure: unknown;
      let warningDrain = Promise.resolve();
      const reportWarning = (event: GuidanceWarningInput): void => {
        warningDrain = warningDrain
          .then(() => ctx.reportLifecycleWarning(event))
          .catch((error: unknown) => {
            warningFailure ??= error;
          });
      };
      const homeDir = deps.getZhixingHome();
      let workdir: string | undefined;
      if (ctx.mode === "work" && ctx.sceneId) {
        workdir = await resolveWorkdir(ctx.sceneId, deps, reportWarning);
      }
      const roots: GuidanceResolvedRoots = workdir
        ? { homeDir, workdir }
        : { homeDir };

      try {
        const payload = await loadLayeredGuidance({
          roots,
          readGuidanceFile: deps.readGuidanceFile,
          reportWarning,
        });
        ctx.contributeMessagePrefix(
          payload ? buildGuidanceMessagePair(payload) : null,
        );
      } catch (error) {
        ctx.contributeMessagePrefix(null);
        reportWarning({
          message: `约定加载失败，已跳过本窗约定：${errorMessage(error)}`,
        });
      }
      await warningDrain;
      if (warningFailure !== undefined) throw warningFailure;
    },
  };
}

async function resolveWorkdir(
  sceneId: string,
  deps: ZhixingGuidanceLifecycleDeps,
  reportWarning: (event: GuidanceWarningInput) => void,
): Promise<string | undefined> {
  let workdir: string | null;
  try {
    workdir = await deps.resolveWorksceneRoot(sceneId);
  } catch (error) {
    reportWarning({
      message: `工作场景约定查询失败，已降级为仅全局约定：${errorMessage(error)}`,
    });
    return undefined;
  }

  if (!workdir) return undefined;
  if (!path.isAbsolute(workdir)) {
    reportWarning({
      message: `工作场景约定查询失败，已降级为仅全局约定：工作区根目录不是绝对路径`,
    });
    return undefined;
  }
  return workdir;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
