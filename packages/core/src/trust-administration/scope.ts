import { createHash } from "node:crypto";
import type { ExplicitEnvironmentSelection } from "../contracts/protocol.js";
import { parseConversationId } from "../conversation/scope-id.js";
import type { TrustAdministrationContext } from "./application.js";

/**
 * 一次运行的授权范围输入，全部来自已认证的事实：对话所属的工作场景，以及本次运行
 * 环境要求里的工作区绑定（owner 侧取自它构造的清单或显式环境选择，执行端取自收到的
 * 已验签清单）。不接受本机路径。
 */
export interface ExecutionTrustScopeInput {
  readonly sceneId?: string;
  readonly workspace?: {
    readonly deviceId: string;
    readonly bindingRef: string;
    /** 执行端从清单得到；owner 在选定执行目标前不知道，组合快照时按绑定取全部修订。 */
    readonly workspaceBindingRevision?: number;
  };
}

/**
 * 授权范围的唯一推导：工作场景对话→scene；本次运行带工作区→workspace；否则→main。
 * 范围只决定哪一组批准规则适用；工作区根、受保护路径等执行环境约束不受影响。
 */
export function resolveExecutionTrustScope(
  input: ExecutionTrustScopeInput,
): TrustAdministrationContext {
  if (input.sceneId !== undefined) {
    if (!input.sceneId) throw new TypeError("Scene identity is empty");
    return Object.freeze({ kind: "scene", sceneId: input.sceneId });
  }
  if (input.workspace) {
    const revision = input.workspace.workspaceBindingRevision;
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new TypeError("Workspace binding revision is invalid");
    }
    return Object.freeze({
      kind: "workspace",
      hash: workspaceTrustIdentity(input.workspace.deviceId, input.workspace.bindingRef),
      ...(revision === undefined ? {} : { revision }),
    });
  }
  return Object.freeze({ kind: "main" });
}

/**
 * owner 派发时的运行范围：对话所属的工作场景，或本次显式环境选择的工作区。与 owner
 * 构造清单时的环境推导同源（主对话的工作区只来自显式选择），执行端从收到的清单得出
 * 同一范围。此时尚不知道绑定修订，组合快照按绑定取全部修订，由执行端按清单修订过滤。
 */
export function conversationRunTrustScope(
  conversationId: string,
  explicit: ExplicitEnvironmentSelection | undefined,
): TrustAdministrationContext {
  const { scope } = parseConversationId(conversationId);
  return resolveExecutionTrustScope({
    ...(scope.kind === "workscene" ? { sceneId: scope.sceneId } : {}),
    ...(explicit ? { workspace: explicit.workspace } : {}),
  });
}

/**
 * job 运行的范围输入：job 不属于工作场景，只看清单环境要求里的工作区绑定（有则按工作区
 * 及其修订，没有则 main）。执行端绑定、owner 接纳沉淀与派发冻结快照都经它取得同一输入，
 * 再交 resolveExecutionTrustScope 推导。
 */
export function jobRunTrustScopeInput(
  environment: { readonly workspace?: ExecutionTrustScopeInput["workspace"] | null },
): ExecutionTrustScopeInput {
  return Object.freeze(environment.workspace ? { workspace: environment.workspace } : {});
}

/**
 * 工作区绑定（设备＋bindingRef）的稳定身份（SHA-256 前 16 字符）。只用绑定身份、
 * 不用本机路径：owner 与任何执行端都能从清单得出同一身份。删除后重建得到新的
 * bindingRef，即新范围；改路径另由规则上记的绑定修订区分。
 */
export function workspaceTrustIdentity(deviceId: string, bindingRef: string): string {
  if (!deviceId || !bindingRef) throw new TypeError("Workspace binding identity is empty");
  return createHash("sha256").update(`${deviceId}\u0000${bindingRef}`).digest("hex").slice(0, 16);
}
