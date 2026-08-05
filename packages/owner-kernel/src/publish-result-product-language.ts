import type {
  AuthorityError,
  GlobalStagedMutation,
} from "@zhixing/core/contracts";

interface ProductErrorCopy {
  readonly reason: string;
  readonly actions: readonly [string, string];
}

const ERROR_COPY = {
  unauthorized: { reason: "当前账号没有保存这项修改的权限", actions: ["检查权限后重试", "放弃这项修改"] },
  "capability-expired": { reason: "本次操作授权已过期", actions: ["重新进入后重试", "放弃这项修改"] },
  "epoch-stale": { reason: "相关内容已更新，本次修改基于旧状态", actions: ["查看最新内容后重试", "放弃这项修改"] },
  "revision-conflict": { reason: "相关内容已被其他修改更新", actions: ["查看最新内容后重试", "放弃这项修改"] },
  "fence-rejected": { reason: "本次修改已失效", actions: ["重新进入后重试", "放弃这项修改"] },
  busy: { reason: "相关内容正在更新", actions: ["稍后重试", "放弃这项修改"] },
  "not-found": { reason: "要修改的内容已不存在", actions: ["查看当前内容", "放弃这项修改"] },
  invalid: { reason: "这项修改的内容不符合要求", actions: ["检查内容后重试", "放弃这项修改"] },
  "lease-exhausted": { reason: "本次操作的可用资源已用完", actions: ["缩小操作后重试", "放弃这项修改"] },
  "missing-base": { reason: "缺少完成这项修改所需的基础内容", actions: ["补齐内容后重试", "放弃这项修改"] },
  "typed-stale": { reason: "相关内容的类型或版本已经变化", actions: ["查看最新内容后重试", "放弃这项修改"] },
  "capability-gap": { reason: "当前设备无法完成这项修改", actions: ["选择可用设备后重试", "放弃这项修改"] },
  "unavailable-offline": { reason: "完成这项修改所需的设备当前离线", actions: ["设备恢复在线后重试", "放弃这项修改"] },
  "idempotency-conflict": { reason: "这次请求与已经处理的修改不一致", actions: ["刷新当前状态后重试", "放弃这项修改"] },
} satisfies Record<AuthorityError["code"], ProductErrorCopy>;

const MUTATION_LABEL = {
  "memory-append": "保存记忆",
  "memory-delete": "删除记忆",
  "schedule-create": "创建定时任务",
  "schedule-update": "更新定时任务",
  "schedule-set-state": "更新定时任务状态",
  "schedule-delete": "删除定时任务",
  "skill-usage": "更新技能使用记录",
  "skill-create": "创建技能",
  "skill-update": "更新技能",
  "skill-admit": "接入技能",
  "workscene-create": "创建场景",
  "workscene-rename": "重命名场景",
  "workscene-set-workdir": "更新场景工作目录",
  "workscene-delete": "删除场景",
  "delivery-enqueue": "发送消息",
} satisfies Record<GlobalStagedMutation["kind"], string>;

export interface PublishConflictProductCopy extends ProductErrorCopy {
  readonly mutationLabel: string;
}

export function publishConflictProductCopy(
  mutationKind: GlobalStagedMutation["kind"],
  errorCode: AuthorityError["code"],
): PublishConflictProductCopy {
  return { mutationLabel: MUTATION_LABEL[mutationKind], ...ERROR_COPY[errorCode] };
}

export function productizePublishAuthorityError(
  error: AuthorityError,
): AuthorityError {
  const copy = ERROR_COPY[error.code];
  return {
    code: error.code,
    message: `${copy.reason}。${copy.actions.join("，")}。`,
    retryable: error.retryable,
  };
}
