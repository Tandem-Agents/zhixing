import { fork } from "node:child_process";
import type { ExtensionManifest, ExtensionProcess, ExtensionTypeBinding } from "./contracts.js";
import { ExtensionPeer } from "./protocol.js";

export async function startExtensionProcess(options: {
  readonly entry: string;
  readonly manifest: ExtensionManifest;
  readonly generation: string;
  readonly projection: unknown;
  readonly binding: ExtensionTypeBinding;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly onFault: () => void;
}): Promise<ExtensionProcess> {
  options.binding.validate(options.manifest, options.projection);
  options.signal.throwIfAborted();
  // Inherit operating-system essentials, not provider keys or host configuration.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = fork(options.entry, [], Object.assign({
    execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", env,
  } as import("node:child_process").ForkOptions, { windowsHide: true }));
  let closing = false;
  let retiring = false;
  let stopping: Promise<void> | undefined;
  const accepted = new Set<Promise<unknown>>();
  let exited = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let healthPending = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  const peer = new ExtensionPeer((frame) => {
    if (!child.connected) throw new Error("Extension disconnected");
    child.send(frame, (error) => { if (error) fault(); });
  }, async (method, payload) => {
    if (closing || (!retiring && !options.isCurrent())) throw new Error("Expired extension generation");
    return options.binding.receive({ method, payload });
  });
  const terminate = () => {
    if (closing) return;
    closing = true;
    if (heartbeat) clearInterval(heartbeat);
    options.binding.close();
    // Deliver graceful shutdown without waiting behind a pending business request.
    void peer.call("control.stop", null, 1_000).catch(() => undefined).finally(() => {
      peer.close();
      if (!exited) child.kill();
    });
    killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 1_500);
    killTimer.unref();
  };
  const fault = () => { if (!closing) { options.onFault(); terminate(); } };
  child.on("message", (frame) => peer.accept(frame));
  child.on("error", fault);
  child.once("close", () => {
    exited = true;
    if (heartbeat) clearInterval(heartbeat);
    if (killTimer) clearTimeout(killTimer);
    options.signal.removeEventListener("abort", terminate);
    options.binding.close();
    peer.close();
    resolveExit();
    if (!closing) { closing = true; options.onFault(); }
  });
  options.signal.addEventListener("abort", terminate, { once: true });
  if (options.signal.aborted) terminate();
  const call = (method: string, payload: unknown): Promise<unknown> => {
    if (closing || (!retiring && !options.isCurrent())) return Promise.reject(new Error("Extension is not available"));
    const request = peer.call(method, payload);
    accepted.add(request);
    void request.finally(() => accepted.delete(request)).catch(() => undefined);
    return request;
  };
  try {
    options.binding.bindTransport?.(call);
    const hello = await peer.call("control.start", {
      protocol: options.manifest.protocol, type: options.manifest.type, contract: options.manifest.contract,
      generation: options.generation, projection: options.projection,
    }, 60_000);
    if (!hello || typeof hello !== "object" || (hello as { protocol?: unknown }).protocol !== 1) {
      throw new Error("Extension handshake mismatch");
    }
    if (closing || !options.isCurrent()) throw new Error("Extension activation superseded");
    heartbeat = setInterval(() => {
      if (healthPending || closing) return;
      healthPending = true;
      void peer.call("control.health", null, 5_000).then(
        (health) => { if (health !== "ready") fault(); }, fault,
      ).finally(() => { healthPending = false; });
    }, 30_000);
    heartbeat.unref();
    return { generation: options.generation,
      call: (method, payload) => {
        if (closing || retiring || !options.isCurrent()) return Promise.reject(new Error("Extension is not available"));
        return call(method, payload);
      },
      stop: () => {
        if (stopping) return stopping;
        retiring = true;
        options.binding.quiesce?.();
        // Already-issued effects retain their original receipt/unknown result.
        // Peer requests have a finite deadline; do not wait for business Runs.
        stopping = (async () => { await Promise.allSettled([...accepted]); terminate(); await exit; })();
        return stopping;
      },
    };
  } catch (error) { terminate(); await exit; throw error; }
}
