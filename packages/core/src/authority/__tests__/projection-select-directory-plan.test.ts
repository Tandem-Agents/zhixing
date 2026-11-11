import { expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { FileDurableProjectionIndex } from "../index.js";
import { DefaultDeviceCapacityArbiter, DefaultStorageMaintenanceGovernor, createDefaultDeviceCapacityPolicy } from "../../resources/index.js";

/**
 * 写者正常打开先走只读快路径；快路径不成立（这里是全新目录、清单缺失）时才进入目录选择。目录选择只读
 * （至多一次 stat 与一次清单读），按正常打开的只读计划准入，不借写入型初始化（projection-scrub）的大预算；
 * 写入型的初始化步骤仍按 scrub 计划。
 */
it("admits directory selection under the read-only open plan when the fast open path does not apply", async () => {
  const root = await createTempDir("projection-select-directory");
  const arbiter = new DefaultDeviceCapacityArbiter({ policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
  const real = new DefaultStorageMaintenanceGovernor({ capacity: arbiter });
  const kinds: unknown[] = [];
  // 只记下准入请求的计划种类，其余照真实治理器转发
  const governor = new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === "acquire" && typeof value === "function") {
        return (request: { kind?: unknown }, ...rest: unknown[]) => {
          kinds.push(request.kind);
          return (value as (...args: unknown[]) => unknown).call(target, request, ...rest);
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: "select-directory", reducerVersion: 1, storageMaintenance: governor });
  try {
    await index.initialize({ source: { logId: "select-directory", lsn: 0, frameEndOffset: 64, prefixDigest: `sha256:${"0".repeat(64)}` } });
    // 快路径的只读打开 → 目录选择（只读打开计划）→ 写入型初始化（scrub 计划）
    expect(kinds).toEqual(["projection-open", "projection-open", "projection-scrub"]);
  } finally { await index.stopStorageMaintenance(); }
});
