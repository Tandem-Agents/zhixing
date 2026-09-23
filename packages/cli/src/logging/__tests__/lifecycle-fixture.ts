import { beginRuntimeLogging } from "../runtime.js";
import { runServer, createServerContext, DEFAULT_SERVER_CONFIG } from "@zhixing/server";

const home = process.argv[2]!;
const logging = beginRuntimeLogging(home, "lifecycle-fixture");
const context = createServerContext({
  config: { ...DEFAULT_SERVER_CONFIG, host: "127.0.0.1", port: 0 },
  version: "logging-test",
  token: "isolated-fixture-token",
});
const runner = await runServer({
  context,
  skipProcessLock: true,
  exitOnSignal: false,
  logger: { info() {}, warn() {}, error() {} },
});
process.send?.({ phase: "started" });
process.once("message", () => process.emit("SIGTERM"));
await runner.waitForShutdown();
await logging.finish("success", "signal-drained");
process.send?.({ phase: "finished" });
process.disconnect?.();
