import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/connection.ts",
    "src/skill-catalog-client.ts",
    "src/session-wire.ts",
    "src/session-turn-stream.ts",
    "src/session-broadcast.ts",
    "src/session-events.ts",
    "src/confirmation-bridge.ts",
    "src/event-bridge.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node24",
});
