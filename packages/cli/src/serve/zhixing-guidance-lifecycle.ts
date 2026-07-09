import path from "node:path";

import {
  buildGuidanceMessagePair,
  loadLayeredGuidance as defaultLoadLayeredGuidance,
  type GuidanceResolvedRoots,
  type GuidanceWarningInput,
  type ReadGuidanceFile,
} from "@zhixing/core";
import type { AgentRuntimeLifecycle } from "@zhixing/orchestrator/runtime";

export interface ZhixingGuidanceScene {
  readonly workdir?: string;
}

export interface ZhixingGuidanceLifecycleDeps {
  readonly getZhixingHome: () => string;
  readonly getWorkscene: (sceneId: string) => Promise<ZhixingGuidanceScene | null>;
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

      const homeDir = deps.getZhixingHome();
      let workdir: string | undefined;
      if (ctx.mode === "work" && ctx.sceneId) {
        workdir = await resolveWorkdir(ctx.sceneId, deps, (event) =>
          ctx.reportLifecycleWarning(event),
        );
      }
      const roots: GuidanceResolvedRoots = workdir
        ? { homeDir, workdir }
        : { homeDir };

      try {
        const payload = await loadLayeredGuidance({
          roots,
          readGuidanceFile: deps.readGuidanceFile,
          reportWarning: (event) => ctx.reportLifecycleWarning(event),
        });
        ctx.contributeMessagePrefix(
          payload ? buildGuidanceMessagePair(payload) : null,
        );
      } catch (error) {
        ctx.contributeMessagePrefix(null);
        ctx.reportLifecycleWarning({
          message: `约定加载失败，已跳过本窗约定：${errorMessage(error)}`,
        });
      }
    },
  };
}

async function resolveWorkdir(
  sceneId: string,
  deps: ZhixingGuidanceLifecycleDeps,
  reportWarning: (event: GuidanceWarningInput) => void,
): Promise<string | undefined> {
  let scene: ZhixingGuidanceScene | null;
  try {
    scene = await deps.getWorkscene(sceneId);
  } catch (error) {
    reportWarning({
      message: `工作场景约定查询失败，已降级为仅全局约定：${errorMessage(error)}`,
    });
    return undefined;
  }

  const workdir = scene?.workdir;
  if (!workdir) return undefined;
  if (path.isAbsolute(workdir)) return workdir;

  reportWarning({
    message: `工作场景约定目录不是绝对路径，已跳过场景层：${workdir}`,
  });
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
