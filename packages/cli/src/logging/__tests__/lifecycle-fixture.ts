import { beginRuntimeLogging } from "../runtime.js";
import { runServer, createServerContext, DEFAULT_SERVER_CONFIG } from "@zhixing/server";
import assert from 'node:assert/strict';
import { LogFilesProcess } from '../files-process.js';
import { writerEndpoint, writerRootKey } from '../writer-admission.js';

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
if (process.platform === 'win32') {
  const files = new LogFilesProcess(home);
  try {
    await files.open(false);
    assert.deepEqual(JSON.parse(await files.readLocalProcessDeclaration(writerEndpoint(process.pid), process.pid)),
      { protocol: 2, root: writerRootKey(home), pid: process.pid });
    process.send?.({ phase: 'declaration-retained' });
  } finally { await files.close(); }
}
process.send?.({ phase: "finished" });
process.disconnect?.();
