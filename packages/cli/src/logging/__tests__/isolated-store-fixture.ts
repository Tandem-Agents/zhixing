import { writeFileSync } from "node:fs";
import { LogFilesProcess } from "../files-process.js";

const originalLock = LogFilesProcess.prototype.tryLock;
const originalUnlock = LogFilesProcess.prototype.unlock;
LogFilesProcess.prototype.tryLock = async function () {
  const locked = await originalLock.call(this);
  if (locked) {
    process.send!({ kind: "locked" });
    // The caller is deliberately suspended before the transaction continues.
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return locked;
};
LogFilesProcess.prototype.unlock = async function () {
  await originalUnlock.call(this);
  writeFileSync(process.argv[4]!, String(Date.now()));
};
await import("../store-worker.js");
