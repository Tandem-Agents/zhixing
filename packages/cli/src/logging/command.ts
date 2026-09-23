import path from "node:path";
import { getZhixingHome } from "@zhixing/core/paths";
import { LOG_APPLY_POLICY, LOG_READ, LOG_SEARCH, LOG_STATUS } from "@zhixing/core/logging/application";
import type { LogFilter } from "@zhixing/core/logging";
import { createStdoutWriter } from "../screen/cli-writer.js";
import { createLogAccess, createLocalLogProductApi, LOCAL_LOG_OWNER } from "./access.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";

export const LOG_FORMAT_DESCRIPTION =
  "zxlog/1：最高 published-*.head 指向已耐久的同代 state-*.json，包含存储身份、策略、水位和保留段；segment-*.jsonl 每行一条已脱敏记录；detail-*.json 为段所属详情；index-*.json 可重建。仅已发布治理版本登记的段属于保留证据。稳定地址为 zxlog://<storeId>/record/<id> 或 /operation/<kind>/<id>。";
export type LoggingCommand =
  | { readonly action: "location" }
  | { readonly action: "status" }
  | {
      readonly action: "search";
      readonly filter: LogFilter;
      readonly cursor?: string;
    }
  | {
      readonly action: "read";
      readonly address: string;
      readonly view: "overview" | "timeline" | "detail";
      readonly cursor?: string;
    }
  | {
      readonly action: "policy";
      readonly patch?: string;
      readonly revision?: number;
    };

/** Offline and live local invocations use exactly the same application and authorization. */
export async function runLoggingCommand(
  command: LoggingCommand,
  home = getZhixingHome(),
): Promise<void> {
  const writer = createStdoutWriter();
  if (command.action === "location") {
    writer.line(path.join(home, "logs", "runtime"));
    writer.line(LOG_FORMAT_DESCRIPTION);
    writer.line("当前覆盖运行入口与宿主启停链；旧后台日志仍使用 zz serve logs。");
    return;
  }
  const capacity = createDeviceCapacityRuntime(path.resolve(home), { createDirectory: false });
  const access = createLogAccess(path.resolve(home), capacity.arbiter);
  const api = createLocalLogProductApi(access);
  const context = () => LOCAL_LOG_OWNER;
  try {
    let result: unknown;
    if (command.action === "status") result = await api.query(LOG_STATUS, { context, request: undefined });
    else if (command.action === "search")
      result = await api.query(LOG_SEARCH, { context, request: { filter: command.filter, cursor: command.cursor } });
    else if (command.action === "read")
      result = await api.query(LOG_READ, { context, request: { address: command.address, view: command.view, cursor: command.cursor } });
    else {
      const status = await api.query(LOG_STATUS, { context, request: undefined });
      if (!command.patch) result = status.policy;
      else {
        if (!Number.isSafeInteger(command.revision) || command.revision! < 1)
          throw Error("修改日志策略需要 --revision 指定当前版本");
        result = (await api.command(LOG_APPLY_POLICY, { context, request: {
          patch: JSON.parse(command.patch), expectedVersion: command.revision!,
        } })).result;
      }
    }
    writer.line(JSON.stringify(result, null, 2));
  } finally {
    await access.close();
  }
}
