import { randomUUID } from "node:crypto";
import { LogApplication } from "@zhixing/core/logging/application";
import { createLocalLogStore } from "../runtime.js";

// No timer, IPC or other application handle may keep this process alive for close().
const { store, capacity } = createLocalLogStore(process.argv[2]!);
await store.initialize();
await store.append([
  {
    record: {
      schema: 1,
      id: randomUUID(),
      process: randomUUID(),
      seq: 1,
      occurredAt: Date.now(),
      source: "runtime",
      sourceVersion: 1,
      event: "stopped",
      level: "info",
      tier: "critical",
      refs: [],
      access: { scope: "storage" },
      message: "关闭验证",
      data: {},
      result: "success",
    },
  },
]);
const application = new LogApplication(store, () => ({
  subject: "fixture-owner",
  revision: "1",
  manageStorage: true,
  scopes: [],
}));
await application.search();
await store.close();
capacity.close();
process.stdout.write("closed\n");
