import { bindServer } from "../../server.js";
import { DEFAULT_SERVER_CONFIG } from "../../types.js";

const port = Number(process.argv[2]);
const root = process.argv[3] ?? "unknown";
if (!Number.isSafeInteger(port) || port <= 0) {
  throw new Error("A fixed non-zero owner port is required");
}

try {
  const bound = await bindServer({
    config: { ...DEFAULT_SERVER_CONFIG, host: "127.0.0.1", port },
  });
  process.send?.({ root, outcome: "bound", port: bound.port });
  process.on("message", (message) => {
    if (message === "crash") process.exit(73);
    if (message !== "close") return;
    void bound.close().then(() => process.exit(0));
  });
} catch (error) {
  process.send?.({
    root,
    outcome: "rejected",
    code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
  });
  process.exit(0);
}
