import { build, defineConfig } from "tsup";
import { spawnSync } from "node:child_process";
// biome-ignore lint/style/noRestrictedImports: Build-only scratch is removed in finally; Vitest lifecycle helpers cannot run in the builder.
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
// biome-ignore lint/style/noRestrictedImports: Declaration output is OS-temporary build data, not product home or a test fixture.
import { tmpdir } from "node:os";
import path from "node:path";

const entry = [
    "src/logging/index.ts",
    "src/logging/storage.ts",
    "src/logging/application.ts",
    "src/index.ts",
    "src/extensions/contracts.ts",
    "src/extensions/candidate.ts",
    "src/extensions/onboarding.ts",
    "src/extensions/application.ts",
    "src/extensions/runtime.ts",
    "src/extensions/artifacts.ts",
    "src/extensions/protocol.ts",
    "src/mcp-management/application.ts",
    "src/events/index.ts",
    "src/types/index.ts",
    "src/tool-loop/index.ts",
    "src/loop/index.ts",
    "src/resilience/index.ts",
    "src/context/index.ts",
    "src/channels/index.ts",
    "src/channels/extension.ts",
    "src/channels/extension-worker.ts",
    "src/transcript/index.ts",
    "src/conversation/index.ts",
    "src/conversation/application.ts",
    "src/advancement/application.ts",
    "src/workscene/application.ts",
    "src/workscene/types.ts",
    "src/workscene/index.ts",
    "src/rubrics/index.ts",
    "src/skills/catalog-application.ts",
    "src/skills/catalog-management-correctness.ts",
    "src/skills/admission.ts",
    "src/skills/id.ts",
    "src/skills/global-state-adapter.ts",
    "src/product-api/catalog.ts",
    "src/trust-administration/application.ts",
    "src/advancement/index.ts",
    "src/resources/index.ts",
    "src/security/index.ts",
    "src/confirmation/index.ts",
    "src/identity/index.ts",
    "src/typeahead/index.ts",
    "src/interrupt/index.ts",
    "src/scheduler/index.ts",
    "src/scheduler/application.ts",
    "src/orchestration/index.ts",
    "src/contracts/index.ts",
    "src/protocol/index.ts",
    "src/persistence/index.ts",
    "src/paths.ts",
    "src/authority/index.ts",
    "src/delivery/index.ts",
    "src/delivery/application.ts",
    "src/delivery/channel-effect.ts",
    "src/device-administration/application.ts",
    "src/device-administration/correctness.ts",
    "src/backup-recovery/application.ts",
    "src/environment/index.ts",
    "src/environment/workspace-administration.ts",
    "src/environment/workspace-probe-persistence.ts",
    "src/environment/workspace-binding-generation-persistence.ts",
    "src/environment/workspace-binding-catalog-persistence.ts",
    "src/test-support/s7-durable.ts",
    "src/test-support/s7-durable-harness.ts",
];

export default defineConfig({
  entry,
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node24",
  async onSuccess() {
    // Release the TypeScript checker before Rollup builds the declaration graph.
    // Public declarations remain bundled; neither stage needs an enlarged V8 heap.
    const scratch = await mkdtemp(path.join(tmpdir(), "zhixing-core-dts-"));
    try {
      const require = createRequire(import.meta.url);
      const emitted = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"),
        "--emitDeclarationOnly", "--declarationMap", "false", "--outDir", scratch,
      ], { windowsHide: true, stdio: "inherit" });
      if (emitted.error) throw emitted.error;
      if (emitted.status !== 0) throw Error(`TypeScript declaration emission failed (${emitted.signal ?? emitted.status})`);
      await build({ config: false, entry: Object.fromEntries(entry.map(source => {
        const name = source.slice(4, -3);
        return [name, path.join(scratch, `${name}.d.ts`)];
      })), outDir: "dist", format: ["esm"], dts: { only: true }, clean: false });
    } finally {
      if (path.dirname(scratch) !== path.resolve(tmpdir()) || !path.basename(scratch).startsWith("zhixing-core-dts-"))
        throw Error("Unexpected declaration scratch directory");
      await rm(scratch, { recursive: true, force: true });
    }
  },
});
