import { createServer, type Socket } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const { endpoint, protocol, root, pid } = workerData as { endpoint: string; protocol: number; root: string; pid: number };
const response = JSON.stringify({ protocol, root, pid }) + "\n";
const sockets = new Set<Socket>();
const server = createServer(socket => {
  if (sockets.size >= 8) { socket.destroy(); return; }
  sockets.add(socket); socket.setTimeout(500, () => socket.destroy());
  socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
  socket.end(response);
});
server.on("error", (error: NodeJS.ErrnoException) => {
  // Keep the bounded worker independent of the product module graph.
  const code = ["EACCES", "EPERM", "EADDRINUSE", "EADDRNOTAVAIL", "EINVAL", "ENOTSUP", "EMFILE", "ENFILE"].includes(error.code ?? "") ? error.code : undefined;
  parentPort?.postMessage({ kind: "unavailable", code }); parentPort?.close();
});
server.listen(endpoint, () => { parentPort?.postMessage("ready"); });
