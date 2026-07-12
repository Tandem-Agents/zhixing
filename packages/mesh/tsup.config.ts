import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/blind-relay.ts",
    "src/index.ts",
    "src/canonical.ts",
    "src/device-identity.ts",
    "src/errors.ts",
    "src/handshake.ts",
    "src/outbound-tunnel.ts",
    "src/replay-window.ts",
    "src/service-registry.ts",
    "src/transport.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
