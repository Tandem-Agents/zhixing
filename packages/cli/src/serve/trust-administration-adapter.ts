import {
  TrustAdministrationApplicationService,
  type TrustAdministrationApplication,
  type TrustAdministrationRepository,
  type TrustAdministrationScopeDescriber,
} from "@zhixing-ai/core/trust-administration";

/** 本机工作区登记：绑定身份摘要 → 显示名与当前绑定修订。 */
export type WorkspaceTrustDirectory = () => Promise<
  ReadonlyMap<string, { readonly name: string; readonly revision: number }>
>;

/**
 * Host composition of the one Trust Administration application.
 *
 * 非场景会话列出主模式上下文：与主对话执行侧记录批准、owner 派发规则快照用的同一上下文
 * （确认页写“仅主模式生效”）。场景会话由应用按会话 id 解析为 scene。其他范围的
 * 工作区分组按本机登记命名；规则的绑定修订与登记不同，或登记里找不到，标为不再生效。
 */
export function createTrustAdministrationApplication(deps: {
  readonly repository: TrustAdministrationRepository;
  readonly workspaces?: WorkspaceTrustDirectory;
}): TrustAdministrationApplication {
  return new TrustAdministrationApplicationService({
    repository: deps.repository,
    defaultContext: () => ({ kind: "main" }),
    ...(deps.workspaces ? { describeScope: describeWithDirectory(deps.workspaces) } : {}),
  });
}

function describeWithDirectory(workspaces: WorkspaceTrustDirectory): TrustAdministrationScopeDescriber {
  return async (context, rules) => {
    switch (context.kind) {
      case "main":
        return { label: "主模式", effective: true };
      case "scene":
        return { label: `工作场景 ${context.sceneId}`, effective: true };
      case "workspace": {
        const registered = (await workspaces()).get(context.hash);
        if (!registered) {
          return {
            label: `工作区 ${context.hash.slice(0, 8)}`,
            effective: false,
            note: "该工作区已移除、重建或不在本机登记，这些规则不再生效，可撤销",
          };
        }
        const current = rules.some((rule) =>
          rule.contextId?.kind === "workspace" &&
          (rule.contextId.revision === undefined || rule.contextId.revision === registered.revision));
        return current
          ? { label: `工作区「${registered.name}」`, effective: true }
          : {
              label: `工作区「${registered.name}」`,
              effective: false,
              note: "目录已变更，这些规则不再生效，可撤销",
            };
      }
    }
  };
}
