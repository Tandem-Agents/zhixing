/** Stable, product-facing projection of the local host lifecycle. */

export type ManagedHostDesiredMode = "managed" | "on-demand" | "none";

export type ManagedHostProcessState =
  | "running"
  | "running-unhealthy"
  | "stopped"
  | "stale";

export type ManagedHostReadiness =
  | "recovering"
  | "ready"
  | "degraded"
  | "stopping"
  | "failed";

export type ManagedHostActionCode =
  | "login-required"
  | "credentials-locked"
  | "pairing-required"
  | "permission-required"
  | "configuration-invalid";

export type ManagedHostPublicState =
  | "not-needed"
  | "waiting-online"
  | "starting"
  | "ready"
  | "stopping"
  | "needs-attention";

export interface ManagedHostServiceState {
  readonly state: "absent" | "disabled" | "enabled";
  readonly running: boolean;
  readonly matches: boolean;
}

export interface ManagedHostPublicStatus {
  readonly state: ManagedHostPublicState;
  readonly label: string;
  readonly action?: string;
}

export interface ManagedHostProjectionInput {
  readonly desired: ManagedHostDesiredMode;
  readonly service?: ManagedHostServiceState;
  readonly process: ManagedHostProcessState;
  readonly readiness?: ManagedHostReadiness;
  readonly errorCode?: ManagedHostActionCode;
}

const PUBLIC_ACTIONS: Readonly<Record<ManagedHostActionCode, string>> = {
  "login-required": "请重新登录系统",
  "credentials-locked": "请解锁本机凭据",
  "pairing-required": "请重新运行配对设置",
  "permission-required": "请检查本机权限",
  "configuration-invalid": "请重新运行配对设置",
};

export function projectManagedHostStatus(
  input: ManagedHostProjectionInput,
): ManagedHostPublicStatus {
  if (input.readiness === "stopping") {
    return { state: "stopping", label: "正在结束当前工作" };
  }
  if (input.errorCode) {
    return {
      state: "needs-attention",
      label: "需要处理",
      action: PUBLIC_ACTIONS[input.errorCode],
    };
  }
  if (input.service && !input.service.matches) {
    return {
      state: "needs-attention",
      label: "需要处理",
      action: PUBLIC_ACTIONS["configuration-invalid"],
    };
  }
  if (
    input.desired !== "managed" &&
    input.service &&
    (input.service.state === "enabled" || input.service.running)
  ) {
    return input.service.running
      ? { state: "stopping", label: "正在结束当前工作" }
      : {
          state: "needs-attention",
          label: "需要处理",
          action: PUBLIC_ACTIONS["permission-required"],
        };
  }
  if (input.desired === "none") {
    return input.process === "stopped" || input.process === "stale"
      ? { state: "not-needed", label: "不需要后台运行" }
      : { state: "stopping", label: "正在结束当前工作" };
  }
  if (
    input.desired === "on-demand" &&
    (input.process === "stopped" || input.process === "stale")
  ) {
    return { state: "not-needed", label: "不需要后台运行" };
  }
  if (
    input.desired === "managed" &&
    (!input.service || input.service.state !== "enabled")
  ) {
    return {
      state: "needs-attention",
      label: "需要处理",
      action: PUBLIC_ACTIONS["permission-required"],
    };
  }
  if (
    input.desired === "managed" &&
    input.service?.running === true &&
    (input.process === "stopped" || input.process === "stale")
  ) {
    return {
      state: "needs-attention",
      label: "需要处理",
      action: PUBLIC_ACTIONS["configuration-invalid"],
    };
  }
  if (input.process === "stopped" || input.process === "stale") {
    return { state: "waiting-online", label: "等待开机上线" };
  }
  if (input.readiness === "failed") {
    return {
      state: "needs-attention",
      label: "需要处理",
      action: PUBLIC_ACTIONS["configuration-invalid"],
    };
  }
  if (
    input.process === "running-unhealthy" ||
    input.readiness === "recovering" ||
    input.readiness === undefined
  ) {
    return { state: "starting", label: "正在启动" };
  }
  return { state: "ready", label: "可以使用" };
}
