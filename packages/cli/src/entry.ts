import { observeLogPhase } from "@zhixing/core/logging";
import { getZhixingHome } from "@zhixing/core/paths";
import { beginEntryLogging } from "./logging/bootstrap.js";
import { cliLoggingMode, managedHomeArgument, normalizeCliArgs } from "./logging/entry-mode.js";
import { beginWriterDeclaration, closeWriterDeclaration } from "./logging/writer-admission.js";
import { createStartupProgressPresenter } from "./screen/startup-progress.js";
import { recordFirstSurfaceOutput } from "./logging/runtime-source.js";

// Product-controlled entry: capture precedes Commander, platform and business imports.
const args = normalizeCliArgs(process.argv.slice(2));
const mode = cliLoggingMode(args);
const early = mode === "recorder" || mode === "host" ? beginEntryLogging(args[0] ?? "repl") : undefined;
const home = managedHomeArgument(args) ?? getZhixingHome();
const progress = args.length === 0 && process.stdout.isTTY
  ? createStartupProgressPresenter({ stdout: process.stdout,
    onFirstOutput: () => recordFirstSurfaceOutput(early?.records) }) : undefined;
progress?.begin(performance.now() - process.uptime() * 1000);
try {
  if (early || mode === "policy") await observeLogPhase(early?.records, "declare-writer", () => beginWriterDeclaration(home,
    (reason, failure) => early?.records.record({ event: "writerDeclarationUnavailable", data: { reason, failure } })));
  const { runCli } = await observeLogPhase(early?.records, "load-cli", () => import("./index.js"));
  await runCli(progress);
} catch (error) {
  progress?.disable();
  try { if (early) {
    const { beginRuntimeLogging, recordRuntimeFailure } = await import("./logging/runtime.js");
    const logging = beginRuntimeLogging(home, args[0] ?? "repl");
    recordRuntimeFailure(logging.records, error, "entry-load-failed");
    await logging.finish("failure", "entry-load-failed");
  } } catch { /* If logging itself cannot load, its memory has no durability guarantee. */ }
  process.stderr.write("知行入口加载失败；可用 zz logs 查看已保留的记录。\n");
  process.exitCode = 1;
} finally { progress?.disable(); await closeWriterDeclaration(); }
