import type {
  RuntimeFactory,
  SessionRuntime,
} from "@zhixing/owner-kernel";
import { createOwnerRuntimeAdapter } from "@zhixing/runtime-host/session-adapter";

type AgentRuntime = Parameters<typeof createOwnerRuntimeAdapter>[1];

export interface ExecutorRoleOptions {
  readonly createAgentRuntime: (
    sessionId: string,
    environment?: { readonly workspaceRoot: string | null },
  ) => Promise<AgentRuntime>;
}

/** 执行角色只持运行能力；权威状态、监听器和部署拓扑均由组合根负责。 */
export interface ExecutorRole {
  createSessionRuntime(
    sessionId: string,
    environment?: { readonly workspaceRoot: string | null },
  ): Promise<SessionRuntime>;
}

export function createExecutorRole(options: ExecutorRoleOptions): ExecutorRole {
  return {
    async createSessionRuntime(sessionId, environment) {
      const runtime = await options.createAgentRuntime(sessionId, environment);
      return createOwnerRuntimeAdapter(sessionId, runtime);
    },
  };
}

/** 单机拓扑 adapter：与未来远程 adapter 共用 owner-kernel 的 RuntimeFactory 合同。 */
export function createInProcessRuntimeFactory(
  executor: ExecutorRole,
): RuntimeFactory {
  return {
    create(sessionId, environment) {
      return executor.createSessionRuntime(sessionId, environment);
    },
  };
}
