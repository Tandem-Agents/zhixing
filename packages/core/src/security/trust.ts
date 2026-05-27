/**
 * 信任上下文 —— 表达"当前会话处于哪种用户授予的信任范围"。
 *
 * 与操作影响（OperationClass）正交：影响描述操作本身有多大破坏力，信任描述
 * 用户在当前上下文授予了多少放宽空间。二者共同决定一次操作的处置，单独都不定结果。
 *
 * - global：无任何信任锚，最保守。
 * - workspace：用户指定了工作目录，目标落在该目录内的操作获得空间信任（路径锚）。
 * - scene：用户主动进入一个工作场景，整个会话获得场景信任，不依赖具体路径（会话锚）。
 */
export type TrustLevel = "global" | "workspace" | "scene";

export type TrustContext =
  | { kind: "global" }
  | { kind: "workspace"; dir: string }
  | { kind: "scene"; sceneId: string; intent?: string };

/**
 * 取信任上下文的空间锚目录 —— 仅 workspace 持有工作目录；scene 是会话锚、global
 * 无锚，二者均返回 null。供需要"工作区目录"的判断（路径归属、审计显示）统一复用。
 */
export function workspaceDirOf(trust: TrustContext): string | null {
  return trust.kind === "workspace" ? trust.dir : null;
}
