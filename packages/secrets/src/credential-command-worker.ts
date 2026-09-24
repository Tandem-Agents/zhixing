import { spawn } from "node:child_process";

// One request and one child. This process never observes product configuration or files.
process.once("message", (request: { command: string; args: string[]; input?: Uint8Array }) => {
  const { command, args, input } = request;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, failure: string | undefined;
  const startedAt = Date.now();
  const clear = (): void => {
    for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
    input?.fill(0);
  };
  const send = (value: object, done = (): void => {}): void => {
    if (!process.connected) { done(); return; }
    process.send!(value, () => { done(); process.disconnect(); });
  };
  try {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const fail = (reason: string): void => { failure ??= reason; child.kill(); };
    const disconnected = (): void => { fail("owner exited"); };
    process.once("disconnect", disconnected);
    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.length;
      if (failure || bytes > 1024 * 1024) { chunk.fill(0); fail("output exceeded limit"); }
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => fail("input failed"));
    child.once("error", () => { failure ??= "could not start"; });
    const timer = setTimeout(() => fail("timed out"), Math.max(1, 10_000 - (Date.now() - startedAt)));
    child.once("close", code => {
      clearTimeout(timer);
      process.off("disconnect", disconnected);
      if (failure) { clear(); send({ error: failure }); }
      else {
        const output = Buffer.concat(stdout), error = Buffer.concat(stderr);
        clear();
        send({ code: code ?? -1, stdout: output, stderr: error }, () => { output.fill(0); error.fill(0); });
      }
    });
    child.stdin.end(input);
  } catch { clear(); send({ error: "could not start" }); }
});
