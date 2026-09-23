import type { LogRpcClient } from "@zhixing/rpc";
import type { CliWriter } from "../screen/index.js";

/** Existing /config surface, applying the same versioned policy action without a second config file. */
export async function configureLogs(
  args: string,
  logs: Pick<LogRpcClient, "status" | "applyPolicy">,
  writer: Pick<CliWriter, "line">,
): Promise<void> {
  const values = args.trim().split(/\s+/u).filter(Boolean);
  if (values.length !== 0 && values.length !== 3)
    throw Error(
      "用法：/config logs；修改：/config logs <容量MiB> <关键记录天数> <当前版本>",
    );
  let status;
  if (!values.length) status = await logs.status();
  else {
    const [mib, days, version] = values.map(Number);
    if (
      [mib, days, version].some(
        (value) => !Number.isSafeInteger(value) || value! <= 0,
      )
    )
      throw Error("容量、天数和版本必须是正整数");
    // Read the baseline so dependent TTLs stay consistent; CAS prevents replacing another editor's intent.
    const current = await logs.status();
    const baseline = current.policy.desired ?? current.policy.effective;
    const criticalTtlMs = days! * 86_400_000;
    status = await logs.applyPolicy({
      expectedVersion: version!,
      patch: {
        maxBytes: mib! * 1024 * 1024,
        criticalTtlMs,
        detailTtlMs: Math.min(baseline.detailTtlMs, criticalTtlMs),
        attachmentTtlMs: Math.min(baseline.attachmentTtlMs, criticalTtlMs),
      },
    });
  }
  const { policy } = status;
  writer.line(
    `日志策略版本 ${policy.version}：已生效容量 ${policy.effective.maxBytes / 1024 / 1024} MiB，关键记录保留 ${policy.effective.criticalTtlMs / 86_400_000} 天。`,
  );
  if (policy.desired)
    writer.line(
      `待生效容量 ${policy.desired.maxBytes / 1024 / 1024} MiB；${policy.blocked ?? "后台治理完成后生效"}。`,
    );
  writer.line(
    `修改：/config logs <容量MiB> <关键记录天数> ${policy.version}；详细限额可用 zz logs policy。`,
  );
}
