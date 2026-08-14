/**
 * 知行 CLI 入口
 *
 * 运行模式：
 * - 交互模式：zhixing → REPL 多轮对话
 * - 运行控制：zhixing status / zhixing stop → 查看或停止知行
 * - 宿主启动：zhixing serve → 核心宿主（由交互入口按需拉起，保留给内部与诊断）
 */

import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStdoutWriter } from "./screen/cli-writer.js";
import type { StartupCheckResult } from "./startup.js";
import { MAX_LOG_LINES, normalizeLogLineCount } from "./serve/log-line-count.js";
import { ZHIXING_CLI_VERSION } from "./version.js";
import { findUnknownCommandPath } from "./command-gate.js";

async function renderActionError(error: unknown): Promise<void> {
  if (
    error instanceof Error &&
    "deliveryConfirmed" in error &&
    (error as Error & { readonly deliveryConfirmed?: unknown })
      .deliveryConfirmed === true
  ) {
    return;
  }
  const writer = createStdoutWriter();
  try {
    const { renderError } = await import("./render.js");
    renderError(error, writer);
  } catch {
    const message = error instanceof Error ? error.message : String(error);
    writer.line(`\n${chalk.red("✗")} ${message}`);
  }
}

async function pruneRuntimeLogs(): Promise<void> {
  const { pruneAllLogs } = await import("./output/llm-chunk-dump.js");
  pruneAllLogs();
}

/**
 * 处理 ensureBootstrap 非 ready 状态：报错退出或 cancel 退出。
 * ready / completed 状态下返回，让 caller 继续主流程。
 */
function handleStartupResult(result: StartupCheckResult): void {
  if (result.kind === "ready") return;

  if (result.kind === "schema-error") {
    console.error(chalk.red(`[配置错误] ${result.message}`));
    console.error(chalk.dim(`请修复或删除文件后重试：${result.filePath}`));
    process.exit(2);
  }
  if (result.kind === "secret-store-error") {
    console.error(chalk.red(`[秘密存储不可用] ${result.message}`));
    console.error(chalk.dim(`设备本地目录：${result.filePath}`));
    process.exit(2);
  }
  if (result.kind === "semantic-error") {
    console.error(
      chalk.red(`[配置错误] ${result.filePath} 含 ${result.issues.length} 处废弃字段：`),
    );
    console.error("");
    for (const [index, issue] of result.issues.entries()) {
      console.error(chalk.yellow(`${index + 1}. 字段：${issue.field}`));
      console.error(chalk.dim(`   原因：${issue.reason}`));
      console.error(chalk.dim(`   修复：${issue.fix}`));
      console.error("");
    }
    console.error(chalk.dim("修复后重新运行 `zhixing` 验证。"));
    process.exit(2);
  }
  if (result.kind === "non-tty") {
    console.error(chalk.red("缺少必要配置，且当前环境非交互终端。"));
    console.error(chalk.dim("请在 TTY 终端中运行 `zhixing` 完成配置。缺失项："));
    for (const label of result.missingLabels) {
      console.error(chalk.dim(`  - ${label}`));
    }
    process.exit(2);
  }
  if (result.kind === "cancelled") {
    console.log(chalk.dim("已取消配置。"));
    process.exit(0);
  }
}

export const program = new Command();

export interface CliCommandDescriptor {
  readonly path: string;
  readonly hidden: boolean;
  readonly hasAction: boolean;
}

/** Serializes the real Commander tree; coverage checks never maintain a parallel command list. */
export function captureCliCommandDescriptor(
  root: Command = program,
): readonly CliCommandDescriptor[] {
  const entries: CliCommandDescriptor[] = [];
  const visit = (command: Command, parents: readonly string[]): void => {
    const name = command.name();
    const path = [...parents, name].join(" ");
    entries.push({
      path,
      hidden: (command as Command & { readonly _hidden?: boolean })._hidden === true,
      hasAction:
        typeof (command as Command & { readonly _actionHandler?: unknown })
          ._actionHandler === "function",
    });
    for (const child of command.commands) visit(child, [...parents, name]);
  };
  visit(root, []);
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

function rejectUnknownCommandPath(argv: string[], command: Command): void {
  const unknownCommand = findUnknownCommandPath(argv, command);
  if (!unknownCommand) return;

  console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
  console.error(chalk.dim("Run `zz --help` to see available commands."));
  process.exit(1);
}

async function handleStopAction(): Promise<void> {
  try {
    await pruneRuntimeLogs();
    const { runStopCommand } = await import("./serve/stop.js");
    const result = await runStopCommand();
    const exitCode =
      result.status === "error" || result.status === "refused" ? 1 : 0;
    process.exit(exitCode);
  } catch (err) {
    await renderActionError(err);
    process.exit(1);
  }
}

async function handleStatusAction(): Promise<void> {
  try {
    await pruneRuntimeLogs();
    const { runStatusCommand } = await import("./serve/status.js");
    const report = await runStatusCommand();
    const {
      printProgramUpdateProjection,
      readCurrentAuthorityProgramUpdateProjection,
    } = await import("./update/runtime.js");
    printProgramUpdateProjection(await readCurrentAuthorityProgramUpdateProjection());
    // exit code: 0 running, 1 running-unhealthy, 2 stopped, 3 stale
    const exitCode =
      report.status === "running"
        ? 0
        : report.status === "running-unhealthy"
          ? 1
          : report.status === "stopped"
            ? 2
            : 3;
    process.exit(exitCode);
  } catch (err) {
    await renderActionError(err);
    process.exit(1);
  }
}

function parseLogLineCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`必须是 1 到 ${MAX_LOG_LINES} 的整数`);
  }
  try {
    return normalizeLogLineCount(Number(value));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InvalidArgumentError(message);
  }
}

function parseRevision(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError("revision 必须是非负整数");
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new InvalidArgumentError("revision 超出安全整数范围");
  }
  return revision;
}

program
  .name("zhixing")
  .description("知行 — 智能体引擎")
  .version(ZHIXING_CLI_VERSION)
  .addOption(
    new Option(
      "--log",
      "启用诊断 dump 到 ~/.zhixing/logs/（LLM raw chunk + keypress 路径） —— 排查渲染 / 上下文 / 流式 / 按键输入问题用",
    ).hideHelp(),
  )
  .action(async (options: {
    log?: boolean;
  }) => {
    try {
      const [
        { setDiagnosticLogger },
        { configureLlmChunkDump, pruneAllLogs },
        { configureKeypressDump },
        { runStartupCheck },
        { startRepl },
      ] = await Promise.all([
        import("@zhixing/core"),
        import("./output/llm-chunk-dump.js"),
        import("./security/keypress-dump.js"),
        import("./startup.js"),
        import("./repl.js"),
      ]);

      pruneAllLogs();
      // cli 交互模式（REPL）静默 core 诊断 log（[llm] 请求 / 工具调用等），
      // 避免污染对话 UI；serve 及其子命令各自独立 action 不受影响，
      // 保持默认 console.log 输出供运维与调试观察
      setDiagnosticLogger(() => {});
      // 诊断 dump 启用配置 —— 必须在 startRepl 触发 dump 预热之前调用，
      // 否则 singleton cached 为 NOOP 后续无法激活。--log 是唯一开关（无 ENV 兜底）：
      //   - llm-chunk-dump：LLM stream 完整事件流（含 codepoint hex）
      //   - keypress-dump：SelectOperationRegion keypress 路径每节点（confirmation
      //     panel 字符输入异常调查用）
      // 两个 dump 写到不同文件，互不干扰；--log 单一开关统一启用，避免多 flag
      // 心智负担与 PowerShell env var 持久化陷阱。
      const dumpEnabled = options.log === true;
      configureLlmChunkDump(dumpEnabled);
      configureKeypressDump(dumpEnabled);
      // 启动期检查——先确保必要字段就绪
      const startupResult = await runStartupCheck({
        mode: "repl",
      });
      handleStartupResult(startupResult);

      await startRepl();
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

// ─── zhixing status / stop（用户运行控制入口） ───
program
  .command("status")
  .description("查看知行运行状态")
  .action(handleStatusAction);

program
  .command("stop")
  .description("停止知行")
  .action(handleStopAction);

program
  .command("update")
  .description("立即检查更新或恢复上一个可用版本")
  .option("--restore-previous", "恢复上一个可用版本")
  .action(async (options: { restorePrevious?: boolean }) => {
    try {
      const { printProgramUpdateProjection, runUpdateCommand } = await import("./update/runtime.js");
      printProgramUpdateProjection(await runUpdateCommand(options));
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("离线检查运行与更新状态并给出一个下一步")
  .action(async () => {
    try {
      const { inspectProgramHealth, printProgramDoctorReport } = await import("./update/doctor.js");
      const { tryReadCurrentAuthorityProgramUpdateStatus } = await import("./runtime/rpc-program-update-facade.js");
      printProgramDoctorReport(await inspectProgramHealth({
        currentAuthorityStatus: tryReadCurrentAuthorityProgramUpdateStatus,
      }));
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

const appCmd = program.command("app").description("管理知行应用");

appCmd
  .command("remove")
  .description("移除知行应用（保留全部数据）")
  .action(async () => {
    try {
      const { removeApplication } = await import("./update/app-remove.js");
      await removeApplication();
      console.log("正在移除知行应用；设备身份、配置和全部工作都会保留");
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

program
  .command("pair")
  .description("配对另一台知行设备")
  .argument("[invitation]", "另一台设备显示的高熵配对邀请")
  .option("--listen <host:port>", "出码设备的临时监听地址")
  .option("--advertise <host:port>", "邀请中公布的直连地址")
  .option("--relay <host:port>", "盲中继会合地址")
  .option("--relay-only", "仅通过盲中继会合")
  .option(
    "--executor-auto-start <choice>",
    "加入设备开机后是否自动上线：yes 或 no",
    parseYesNo,
  )
  .action(async (invitation: string | undefined, options: {
    listen?: string;
    advertise?: string;
    relay?: string;
    relayOnly?: boolean;
    executorAutoStart?: boolean;
  }) => {
    try {
      const { runPairCommand } = await import("./serve/mesh-pair-command.js");
      await runPairCommand({
        ...(invitation ? { invitation } : {}),
        ...(options.listen ? { listen: options.listen } : {}),
        ...(options.advertise ? { advertise: options.advertise } : {}),
        ...(options.relay ? { relay: options.relay } : {}),
        ...(options.relayOnly ? { relayOnly: true } : {}),
        ...(options.executorAutoStart !== undefined
          ? { executorAutoStart: options.executorAutoStart }
          : {}),
      });
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

function parseYesNo(value: string): boolean {
  if (value === "yes") return true;
  if (value === "no") return false;
  throw new Error("必须填写 yes 或 no");
}

function parseDeviceRemovalMode(value: string): "transfer" | "destroy" | "lost" | "cancel" {
  if (value === "transfer" || value === "destroy" || value === "lost" || value === "cancel") {
    return value;
  }
  throw new Error("设备移除方式必须是 transfer、destroy、lost 或 cancel");
}

const deviceCmd = program
  .command("device")
  .description("管理已配对设备");

deviceCmd
  .command("list")
  .description("列出可以移除的已配对设备")
  .action(async () => {
    try {
      const { listRemovableDevices } = await import("./runtime/device-removal-command.js");
      await listRemovableDevices();
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

deviceCmd
  .command("remove")
  .description("永久移除设备及其本机数据")
  .argument("[device-name]", "设备名称；交互终端可省略后按序号选择")
  .requiredOption("--permanent", "确认这是永久设备移除，不是应用移除")
  .option("--current", "永久移除当前值班设备")
  .option("--duty-device <name>", "当前值班设备移除前的接班设备名称")
  .option("--recovery-backup", "当前值班设备移除前使用已验证的恢复备份")
  .option("--mode <mode>", "处理方式：transfer、destroy 或 lost", parseDeviceRemovalMode)
  .option("--confirm", "确认设备名、未转移工作和不可逆后果")
  .action(async (deviceName: string | undefined, options: {
    permanent: boolean;
    current?: boolean;
    dutyDevice?: string;
    recoveryBackup?: boolean;
    mode?: "transfer" | "destroy" | "lost" | "cancel";
    confirm?: boolean;
  }) => {
    try {
      if (options.current) {
        if (deviceName || options.mode) {
          throw new TypeError("--current 不能与设备名称或 --mode 同时使用");
        }
        const { uninstallCurrentDevice } = await import("./runtime/anchor-uninstall-command.js");
        await uninstallCurrentDevice({
          ...(options.dutyDevice ? { targetName: options.dutyDevice } : {}),
          ...(options.recoveryBackup ? { recoveryBackup: true } : {}),
          ...(options.confirm ? { confirmed: true } : {}),
        });
        process.exit(0);
      }
      if (options.dutyDevice || options.recoveryBackup) {
        throw new TypeError("--duty-device 和 --recovery-backup 只可与 --current 同时使用");
      }
      if (options.mode === "cancel") throw new TypeError("新移除操作不能以 cancel 开始");
      const { removeDevice } = await import("./runtime/device-removal-command.js");
      await removeDevice({
        permanent: options.permanent,
        ...(deviceName ? { targetName: deviceName } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.confirm ? { confirmed: true } : {}),
      });
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

deviceCmd
  .command("continue")
  .description("继续、取消或按失控设备收束已登记的移除操作")
  .argument("<device-name>", "设备名称")
  .requiredOption("--mode <mode>", "处理方式：transfer、destroy、lost 或 cancel", parseDeviceRemovalMode)
  .option("--confirm", "确认永久删除本地权威，或确认按失控设备撤销")
  .action(async (targetName: string, options: {
    mode: "transfer" | "destroy" | "lost" | "cancel";
    confirm?: boolean;
  }) => {
    try {
      const { continueDeviceRemoval } = await import("./runtime/device-removal-command.js");
      await continueDeviceRemoval({
        targetName,
        mode: options.mode,
        ...(options.confirm ? { confirmed: true } : {}),
      });
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

deviceCmd
  .command("status")
  .description("查看已登记的设备移除进度")
  .argument("<device-name>", "设备名称")
  .action(async (targetName: string) => {
    try {
      const { showDeviceRemovalStatus } = await import("./runtime/device-removal-command.js");
      await showDeviceRemovalStatus(targetName);
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

const dutyCmd = program
  .command("duty")
  .description("迁移当前值班设备");

dutyCmd
  .command("targets")
  .description("列出可以接班的已配对设备")
  .action(async () => {
    try {
      const { listDutyMigrationTargets } = await import("./runtime/duty-migration-command.js");
      await listDutyMigrationTargets();
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

dutyCmd
  .command("migrate")
  .description("把值班职责迁移到指定设备")
  .argument("[device-name]", "目标设备名称；交互终端可省略后按序号选择")
  .option("--prepare-only", "只准备迁移，保留取消机会")
  .action(async (deviceName: string | undefined, options: { prepareOnly?: boolean }) => {
    try {
      const { prepareDutyMigration } = await import("./runtime/duty-migration-command.js");
      await prepareDutyMigration(deviceName, options.prepareOnly !== true);
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

dutyCmd
  .command("continue")
  .description("继续已准备的值班设备迁移")
  .argument("<transfer-id>", "迁移编号")
  .action(async (transferId: string) => {
    try {
      const { continueDutyMigration } = await import("./runtime/duty-migration-command.js");
      await continueDutyMigration(transferId);
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

dutyCmd
  .command("cancel")
  .description("取消尚未切换的值班设备迁移")
  .argument("<transfer-id>", "迁移编号")
  .action(async (transferId: string) => {
    try {
      const { cancelDutyMigration } = await import("./runtime/duty-migration-command.js");
      await cancelDutyMigration(transferId);
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

const backupCmd = program
  .command("backup")
  .description("管理恢复备份");

backupCmd
  .command("setup")
  .description("选择独立目录或配对设备并创建恢复备份")
  .option("--directory <path>", "使用物理独立目录")
  .option("--device <device-name>", "使用列表中名称唯一的已配对设备")
  .action(async (options: { directory?: string; device?: string }) => {
    try {
      const { runBackupSetupCommand } = await import("./serve/backup-command.js");
      await runBackupSetupCommand({
        ...(options.directory ? { directory: options.directory } : {}),
        ...(options.device ? { pairedDeviceName: options.device } : {}),
      });
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

backupCmd
  .command("verify")
  .description("从实际目标回读并验证恢复备份")
  .action(async () => {
    try {
      const { runBackupVerifyCommand } = await import("./serve/backup-command.js");
      await runBackupVerifyCommand();
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

backupCmd
  .command("status")
  .description("查看恢复备份状态和下一步操作")
  .action(async () => {
    try {
      const { runBackupStatusCommand } = await import("./serve/backup-command.js");
      await runBackupStatusCommand();
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

backupCmd
  .command("recover")
  .description("值班设备丢失后，从完整恢复备份接管值班")
  .option("--directory <path>", "从指定备份目录恢复")
  .option("--device <device-name>", "从列表中唯一命名的已配对备份设备恢复")
  .option("--backup <number>", "多个备份存在时选择显示的序号")
  .action(async (options: { directory?: string; device?: string; backup?: string }) => {
    try {
      const { runDisasterRecoveryCommand } = await import(
        "./serve/disaster-recovery-command.js"
      );
      const backupNumber = options.backup === undefined
        ? undefined
        : Number(options.backup);
      await runDisasterRecoveryCommand({
        ...(options.directory ? { directory: options.directory } : {}),
        ...(options.device ? { pairedDeviceName: options.device } : {}),
        ...(backupNumber !== undefined ? { backupNumber } : {}),
      });
      process.exit(0);
    } catch (err) {
      const { disasterRecoveryPublicError } = await import(
        "./serve/disaster-recovery-command.js"
      );
      await renderActionError(disasterRecoveryPublicError(err));
      process.exit(1);
    }
  });

backupCmd
  .command("recover-finish")
  .description("确认旧值班设备已隔离并完成恢复")
  .option("--confirm-old-device-isolated", "确认旧设备已隔离或擦除")
  .action(async (options: { confirmOldDeviceIsolated?: boolean }) => {
    try {
      const { runDisasterRecoveryFinishCommand } = await import(
        "./serve/disaster-recovery-command.js"
      );
      await runDisasterRecoveryFinishCommand({
        userConfirmedOldDeviceIsolated: options.confirmOldDeviceIsolated === true,
      });
      process.exit(0);
    } catch (err) {
      const { disasterRecoveryPublicError } = await import(
        "./serve/disaster-recovery-command.js"
      );
      await renderActionError(disasterRecoveryPublicError(err));
      process.exit(1);
    }
  });

const recoveryRootCmd = backupCmd
  .command("root")
  .description("轮换、停用或重置恢复码");

recoveryRootCmd
  .command("rotate")
  .description("验证当前恢复码并生成、回读和启用新的恢复码")
  .option("--confirm-save-new-code", "确认现在保存并回读新的恢复码")
  .action(async (options: { confirmSaveNewCode?: boolean }) => {
    try {
      const { runRecoveryRootRotateCommand } = await import("./serve/backup-command.js");
      await runRecoveryRootRotateCommand({
        userConfirmed: options.confirmSaveNewCode === true,
      });
      process.exit(0);
    } catch (err) {
      const { recoveryRootPublicError } = await import("./serve/backup-command.js");
      await renderActionError(recoveryRootPublicError(err));
      process.exit(1);
    }
  });

recoveryRootCmd
  .command("invalidate")
  .description("恢复码泄露且暂不能换新时，立即停用当前恢复码")
  .option("--confirm-disable", "确认立即停用当前恢复码")
  .action(async (options: { confirmDisable?: boolean }) => {
    try {
      const { runRecoveryRootInvalidateCommand } = await import("./serve/backup-command.js");
      await runRecoveryRootInvalidateCommand({ userConfirmed: options.confirmDisable === true });
      process.exit(0);
    } catch (err) {
      const { recoveryRootPublicError } = await import("./serve/backup-command.js");
      await renderActionError(recoveryRootPublicError(err));
      process.exit(1);
    }
  });

recoveryRootCmd
  .command("approve-reset")
  .description("在另一台已加入设备上确认恢复码丢失")
  .option("--confirm-reset", "确认协助当前主设备重置恢复码")
  .action(async (options: { confirmReset?: boolean }) => {
    try {
      const { runRecoveryRootApproveResetCommand } = await import("./serve/backup-command.js");
      await runRecoveryRootApproveResetCommand({ userConfirmed: options.confirmReset === true });
      process.exit(0);
    } catch (err) {
      const { recoveryRootPublicError } = await import("./serve/backup-command.js");
      await renderActionError(recoveryRootPublicError(err));
      process.exit(1);
    }
  });

recoveryRootCmd
  .command("reset")
  .description("由当前主设备使用另一台设备的确认码建立新的恢复码")
  .requiredOption("--approval <code>", "另一台已加入设备生成的重置确认码")
  .option("--confirm-save-new-code", "确认旧恢复码已丢失并准备保存新恢复码")
  .action(async (options: { approval: string; confirmSaveNewCode?: boolean }) => {
    try {
      const { runRecoveryRootResetCommand } = await import("./serve/backup-command.js");
      await runRecoveryRootResetCommand({
        approval: options.approval,
        userConfirmed: options.confirmSaveNewCode === true,
      });
      process.exit(0);
    } catch (err) {
      const { recoveryRootPublicError } = await import("./serve/backup-command.js");
      await renderActionError(recoveryRootPublicError(err));
      process.exit(1);
    }
  });

const workspaceCmd = program
  .command("workspace")
  .description("管理本机已授权工作区");

workspaceCmd
  .command("status")
  .description("查看本机工作区目录状态")
  .action(async () => {
    const { runWorkspaceCommand } = await import(
      "./runtime/workspace-command.js"
    );
    await runWorkspaceCommand((workspace) => workspace.status());
  });

workspaceCmd
  .command("list")
  .description("列出本机已授权工作区")
  .action(async () => {
    const { runWorkspaceCommand } = await import(
      "./runtime/workspace-command.js"
    );
    await runWorkspaceCommand((workspace) => workspace.list());
  });

workspaceCmd
  .command("create")
  .description("授权一个本机工作区")
  .argument("<name>", "工作区名称")
  .argument("<path>", "本机目录路径")
  .action(async (name: string, targetPath: string) => {
    const { runWorkspaceCommand } = await import(
      "./runtime/workspace-command.js"
    );
    await runWorkspaceCommand((workspace) =>
      workspace.create(name, targetPath),
    );
  });

workspaceCmd
  .command("create-scene")
  .description("授权本机目录并创建绑定该目录的工作场景")
  .argument("<name>", "工作场景与工作区名称")
  .argument("<path>", "本机目录路径")
  .action(async (name: string, targetPath: string) => {
    const { runWorkspaceSceneCreateCommand } = await import(
      "./runtime/workspace-command.js"
    );
    await runWorkspaceSceneCreateCommand(name, targetPath);
  });

workspaceCmd
  .command("rename")
  .description("修改本机工作区名称")
  .argument("<current-name>", "当前工作区名称")
  .argument("<name>", "新名称")
  .requiredOption("--revision <n>", "当前记录 revision", parseRevision)
  .action(
    async (
      currentName: string,
      name: string,
      options: { revision: number },
    ) => {
      const { runWorkspaceCommand } = await import(
        "./runtime/workspace-command.js"
      );
      await runWorkspaceCommand((workspace) =>
        workspace.rename(currentName, name, options.revision),
      );
    },
  );

workspaceCmd
  .command("repath")
  .description("修改本机工作区目录")
  .argument("<name>", "工作区名称")
  .argument("<path>", "新目录路径")
  .requiredOption("--revision <n>", "当前记录 revision", parseRevision)
  .action(
    async (
      name: string,
      targetPath: string,
      options: { revision: number },
    ) => {
      const { runWorkspaceCommand } = await import(
        "./runtime/workspace-command.js"
      );
      await runWorkspaceCommand((workspace) =>
        workspace.repath(name, targetPath, options.revision),
      );
    },
  );

workspaceCmd
  .command("remove")
  .description("移除本机工作区授权")
  .argument("<name>", "工作区名称")
  .requiredOption("--revision <n>", "当前记录 revision", parseRevision)
  .action(async (name: string, options: { revision: number }) => {
    const { runWorkspaceCommand } = await import(
      "./runtime/workspace-command.js"
    );
    await runWorkspaceCommand(async (workspace) => {
      await workspace.remove(name, options.revision);
      return { removed: name };
    });
  });

workspaceCmd
  .command("reset")
  .description("灾难恢复本机工作区目录")
  .requiredOption("--generation <id>", "当前目录世代")
  .option("--confirm <preview>", "提交上一次预览返回的确认凭据")
  .action(async (options: { generation: string; confirm?: string }) => {
    const { runWorkspaceCommand } = await import("./runtime/workspace-command.js");
    const {
      decodeLocalWorkspaceResetPreview,
      encodeLocalWorkspaceResetPreview,
    } = await import("./runtime/local-workspace-management-host.js");
    if (!options.confirm) {
      await runWorkspaceCommand(async (workspace) => {
        const preview = await workspace.previewReset(options.generation);
        return {
          impact: preview.impact,
          expiresAt: preview.expiresAt,
          confirmation: encodeLocalWorkspaceResetPreview(preview),
        };
      });
      return;
    }
    const preview = decodeLocalWorkspaceResetPreview(options.confirm);
    if (preview.expectedCatalogGeneration !== options.generation) {
      throw new InvalidArgumentError("恢复确认凭据不属于当前目录世代");
    }
    await runWorkspaceCommand((workspace) =>
      workspace.confirmReset(preview, preview.impact),
    );
  });

// ─── zhixing serve（常驻服务模式） ───
const serveCmd = program
  .command("serve", { hidden: true })
  .description("启动常驻服务（HTTP + WebSocket + 调度器）")
  .option("--managed", "由系统托管的非交互启动")
  .addOption(new Option("--managed-home <path>").hideHelp())
  .addOption(new Option("--managed-secret-backend <backend>").hideHelp())
  .action(async (options: {
    managed?: boolean;
    managedHome?: string;
    managedSecretBackend?: string;
  }) => {
    try {
      const { applyManagedServiceLaunchContext } = await import("./serve/managed-service.js");
      applyManagedServiceLaunchContext({
        ...(options.managed ? { managed: true } : {}),
        ...(options.managedHome ? { home: options.managedHome } : {}),
        ...(options.managedSecretBackend
          ? { backend: options.managedSecretBackend }
          : {}),
      });
      await pruneRuntimeLogs();
      const {
        runServeCommand,
      } = await import("./serve/topology-command.js");
      await runServeCommand({ ...(options.managed ? { managed: true } : {}) });
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

// zhixing serve logs —— 查看日志（默认尾部 50 行；--tail 持续跟踪）
serveCmd
  .command("logs")
  .description("查看后台宿主日志")
  .option("--tail", "持续跟踪（类 tail -f）")
  .option("--lines <n>", "显示行数（默认 50）", parseLogLineCount)
  .action(async (options: { tail?: boolean; lines?: number }) => {
    try {
      await pruneRuntimeLogs();
      const { runLogsCommand } = await import("./serve/logs.js");
      await runLogsCommand({ tail: options.tail, lines: options.lines });
      process.exit(0);
    } catch (err) {
      await renderActionError(err);
      process.exit(1);
    }
  });

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // pnpm run 会将 `--` 原样传递给脚本，导致 Commander 将后续选项误认为位置参数。
  // 移除 argv 中首个独立的 `--`，使 `-p` 等选项正常解析。
  const argv = [...process.argv];
  const dashIdx = argv.indexOf("--", 2);
  if (dashIdx !== -1) {
    argv.splice(dashIdx, 1);
  }

  rejectUnknownCommandPath(argv, program);

  program.parseAsync(argv).catch(async (err: unknown) => {
    await renderActionError(err);
    process.exit(1);
  });
}
