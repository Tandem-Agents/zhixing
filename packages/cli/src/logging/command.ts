import path from "node:path";
import { getZhixingHome } from "@zhixing/core/paths";
import { LogApplication } from "@zhixing/core/logging/application";
import type { LogFilter, LogPolicy } from "@zhixing/core/logging";
import { createStdoutWriter } from "../screen/cli-writer.js";
import { createLocalLogStore } from "./runtime.js";

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
  const { store } = createLocalLogStore(home);
  const application = new LogApplication(store, () => ({
    subject: "local-cli",
    revision: "local-storage-owner",
    manageStorage: true,
    scopes: [],
  }));
  try {
    let result: unknown;
    if (command.action === "status") result = await application.status();
    else if (command.action === "search")
      result = await application.search(command.filter, command.cursor);
    else if (command.action === "read")
      result = await application.read(command.address, command.view, command.cursor);
    else {
      const status = await application.status();
      if (!command.patch) result = status.policy;
      else {
        if (!Number.isSafeInteger(command.revision) || command.revision! < 1)
          throw Error("修改日志策略需要 --revision 指定当前版本");
        const patch = JSON.parse(command.patch) as Record<string, unknown>;
        if (
          !patch ||
          Array.isArray(patch) ||
          typeof patch !== "object" ||
          Object.keys(patch).some((key) => !Object.hasOwn(status.policy.effective, key))
        )
          throw Error("日志策略字段无效");
        result = await application.applyPolicy(
          { ...status.policy.effective, ...patch } as LogPolicy,
          command.revision!,
        );
      }
    }
    writer.line(JSON.stringify(result, null, 2));
  } finally {
    await store.close();
  }
}
