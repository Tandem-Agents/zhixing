import { normalizeCliArgs } from './logging/entry-mode.js';
import { resolveProgramEntry } from './cli-entry.js';

// Capture the earliest JS boundary before loading the interactive graph. The
// admitted bootstrap recorder consumes this finite observation; no extra file.
const entryAt = performance.now();

// Select one surface before creating any terminal owner. Redirected streams,
// metadata and background services never acquire the interactive screen.
const args = normalizeCliArgs(process.argv.slice(2));
if (process.env.ZHIXING_TERMINAL_ROLE === 'application' && process.env.ZHIXING_TERMINAL_PRELOAD === '1' &&
  (process.env.ZHIXING_TERMINAL_PIPE || process.env.ZHIXING_TERMINAL_FD === '3')) {
  // S 拥有的受管只读预加载：先接管父通道并装载模块图，与 S 的资产核对和存储准入并行。放行（耐久意向、
  // 身份绑定与完整准入之后）到达前不读写 home、不记日志、不连接业务；放行后才发布写者声明并开始应用。
  const prepareAt = performance.now(), prepareCpu = process.cpuUsage();
  let stage: 'writer-declaration' | 'module-load' = 'module-load', stageAt = prepareAt;
  let preload: ReturnType<typeof import('./terminal/application-preload.js')['awaitTerminalPreloadRelease']> | undefined;
  let started: { application: typeof import('./terminal/application.js'); release: import('./terminal/application-preload.js').TerminalPreloadRelease;
    loadedAt: number; releasedAt: number; declaredAt: number } | undefined;
  try {
    preload = (await import('./terminal/application-preload.js')).awaitTerminalPreloadRelease(process.env.ZHIXING_TERMINAL_INSTANCE ?? '');
    const application = await import('./terminal/application.js');
    const loadedAt = performance.now();
    const release = await preload.release;
    const releasedAt = stageAt = performance.now();
    stage = 'writer-declaration';
    const home = process.env.ZHIXING_TERMINAL_HOME;
    if (home) {
      const path = await import('node:path');
      await (await import('./terminal/writer-declaration.js')).beginTerminalWriterDeclaration(home,
        path.join(path.dirname(resolveProgramEntry()), 'terminal', `${process.platform}-${process.arch}`, 'foreground.node'));
    }
    started = { application, release, loadedAt, releasedAt, declaredAt: performance.now() };
  } catch (error) {
    process.exitCode = 71;
    try { await (await import('./terminal/application-bootstrap.js')).reportApplicationBootstrapFailure(error, stage, performance.now() - stageAt, preload?.transport); }
    catch { /* S still observes the actual nonzero process exit. */ }
    preload?.transport.close();
  }
  if (started && preload) {
    const cpu = process.cpuUsage(prepareCpu);
    await started.application.runTerminalApplication({ entryMs: entryAt, writerDeclarationMs: started.declaredAt - started.releasedAt,
      moduleLoadMs: started.loadedAt - prepareAt, preloadWaitMs: started.releasedAt - started.loadedAt,
      processCpuUserMs: cpu.user / 1000, processCpuSystemMs: cpu.system / 1000 }, { transport: preload.transport, release: started.release });
  }
} else if (process.env.ZHIXING_TERMINAL_ROLE === 'application' &&
  (process.env.ZHIXING_TERMINAL_PIPE || process.env.ZHIXING_TERMINAL_FD === '3')) {
  const prepareAt = performance.now(), prepareCpu = process.cpuUsage();
  // Publish the existing process compatibility proof before the heavy graph
  // loads. Other live entry loggers must not mistake N for a legacy writer.
  let stage: 'writer-declaration' | 'module-load' = 'writer-declaration', stageAt = prepareAt, loadAt = prepareAt;
  let application: typeof import('./terminal/application.js') | undefined;
  try {
    const home = process.env.ZHIXING_TERMINAL_HOME;
    if (home) {
      const path = await import('node:path');
      await (await import('./terminal/writer-declaration.js')).beginTerminalWriterDeclaration(home,
        path.join(path.dirname(resolveProgramEntry()), 'terminal', `${process.platform}-${process.arch}`, 'foreground.node'));
    }
    stage = 'module-load'; stageAt = loadAt = performance.now();
    application = await import('./terminal/application.js');
  } catch (error) {
    process.exitCode = 71;
    // The application has not taken the endpoint. Its supervisor can retain
    // a safe first cause even when the application's heavy import fails.
    try { await (await import('./terminal/application-bootstrap.js')).reportApplicationBootstrapFailure(error, stage, performance.now() - stageAt); }
    catch { /* S still observes the actual nonzero process exit. */ }
  }
  if (application) {
    const loadedAt = performance.now(), cpu = process.cpuUsage(prepareCpu);
    await application.runTerminalApplication({ entryMs: entryAt, writerDeclarationMs: loadAt - prepareAt,
      moduleLoadMs: loadedAt - loadAt, processCpuUserMs: cpu.user / 1000, processCpuSystemMs: cpu.system / 1000 });
  }
} else if (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== 'dumb') {
  const interactive = args.length === 0 || (await import('./index.js')).usesInteractiveTerminal(args);
  if (interactive) {
    const prepareAt = performance.now(), prepareCpu = process.cpuUsage();
    // S forwards finite, short-lived display frames. Like N, keep a modest
    // growth margin instead of retaining a server-sized spare heap. This does
    // not cap usable memory or force GC, and never changes the Host runtime.
    (await import('node:v8')).setFlagsFromString('--heap-growing-percent=20');
    const loadAt = performance.now();
    const { launchTerminal } = await import('./terminal/launch.js');
    const loadedAt = performance.now(), cpu = process.cpuUsage(prepareCpu);
    process.exit(await launchTerminal(args, { entryMs: entryAt, prepareMs: loadAt - prepareAt,
      loadMs: loadedAt - loadAt, processCpuUserMs: cpu.user / 1000, processCpuSystemMs: cpu.system / 1000 }));
  } else await import('./command-entry.js');
} else {
  await import('./command-entry.js');
}
