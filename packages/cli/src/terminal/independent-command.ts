import type { createPlatformSecretStore } from '@zhixing-ai/secrets';
import type { TerminalMessage, TerminalView } from '@zhixing-ai/terminal-ui/protocol';
import type { RuntimeLogging } from '../logging/runtime.js';
import type { RpcManagementFacade } from '../runtime/rpc-management-facade.js';
import type { TerminalSelectionResponse } from './selection.js';
import type { TerminalRecovery } from './recovery.js';
import type { ManagedCommandPorts } from './managed-command.js';
import { terminalManagedServiceCommand } from './managed-service-command.js';

export interface IndependentCommandPorts {
  readonly home: string;
  readonly signal: AbortSignal;
  readonly logging: RuntimeLogging;
  readonly secretStore: ReturnType<typeof createPlatformSecretStore>;
  readonly management: RpcManagementFacade;
  readonly recovery: TerminalRecovery;
  ensureManagement(): Promise<void>;
  completeConfiguration(): Promise<'ready' | 'cancelled'>;
  choose(view: Omit<TerminalView, 'generation'>): Promise<TerminalSelectionResponse | undefined>;
  send(message: TerminalMessage): Promise<void>;
  resumeExecuting?(): Promise<void>;
}

type CommandTitleTree = Readonly<Record<string, string | CommandTitleNode>>;
interface CommandTitleNode { readonly [subcommand: string]: string | CommandTitleNode }

/** 受控的独立终端命令标题映射：仅匹配固定子命令词，绝不拼接任何位置参数、选项值或用户输入。 */
const INDEPENDENT_COMMAND_TITLES: CommandTitleTree = {
  pair: '知行 · zz pair',
  device: {
    remove: '知行 · zz device remove',
    continue: '知行 · zz device continue',
  },
  duty: {
    migrate: '知行 · zz duty migrate',
  },
  backup: {
    setup: '知行 · zz backup setup',
    verify: '知行 · zz backup verify',
    recover: '知行 · zz backup recover',
    root: {
      rotate: '知行 · zz backup root rotate',
      invalidate: '知行 · zz backup root invalidate',
      'approve-reset': '知行 · zz backup root approve-reset',
      reset: '知行 · zz backup root reset',
    },
  },
};

export function independentCommandTitle(args: readonly string[]): string {
  let node: string | CommandTitleNode | undefined = INDEPENDENT_COMMAND_TITLES;
  for (const token of args) {
    if (token === '--log') continue;
    if (!node || typeof node === 'string' || !Object.hasOwn(node, token)) break;
    node = node[token];
    if (typeof node === 'string') return node;
  }
  return '知行 · 命令';
}

/** N supplies interaction and ownership; Commander still invokes each original action. */
export async function runIndependentCommand(args: readonly string[], ports: IndependentCommandPorts): Promise<number> {
  const output: { stream: 'stdout' | 'stderr'; text: string }[] = [];
  let bytes = 0;
  const write = (stream: 'stdout' | 'stderr', text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 1024 * 1024) throw Error('命令结果超过终端容量。');
    output.push({ stream, text });
  };
  const writeLine = (line: string) => write('stdout', line + '\n');
  const resumeExecuting = async () => {
    if (!ports.signal.aborted && !ports.recovery.active) await ports.resumeExecuting?.();
  };
  const chooseRaw = async (view: Omit<TerminalView, 'generation'>) => {
    ports.signal.throwIfAborted();
    const answer = await ports.choose(view); ports.signal.throwIfAborted(); return answer?.cancelCause ? undefined : answer;
  };
  const choose = async (view: Omit<TerminalView, 'generation'>) => {
    const answer = await chooseRaw(view);
    if (answer) await resumeExecuting();
    return answer;
  };
  const confirm = async (message: string) => (await choose({ kind: 'selection', title: '确认操作', message,
    choices: [{ id: 'cancel', label: '取消' }, { id: 'confirm', label: '确认', danger: true }] }))?.itemId === 'confirm';
  const selectIndex = async (items: readonly { displayName: string }[], title: string) => {
    let page = 0;
    for (;;) {
      const start = page * 24;
      const answer = await chooseRaw({ kind: 'selection', title, message: '请选择目标设备。', choices: [
        ...items.slice(start, start + 24).map((item, i) => ({ id: String(start + i), label: item.displayName })),
        ...(page ? [{ id: 'previous', label: '上一页', paging: 'previous' as const }] : []), ...(start + 24 < items.length ? [{ id: 'next', label: '下一页', paging: 'next' as const }] : []),
        { id: 'cancel', label: '取消', dismiss: true },
      ] });
      if (!answer || answer.itemId === 'cancel') throw Error('操作已取消。');
      if (answer.itemId === 'previous') { page--; continue; }
      if (answer.itemId === 'next') { page++; continue; }
      const index = Number(answer.itemId);
      if (Number.isSafeInteger(index) && index >= start && index < Math.min(items.length, start + 24)) {
        await resumeExecuting();
        return index;
      }
    }
  };
  const readRecoveryPackage = async () => {
    const value = await ports.recovery.read();
    await resumeExecuting();
    return value;
  };
  const common = { zhixingHome: ports.home, logging: ports.logging, secretStore: ports.secretStore, writeLine };
  const duty = { management: ports.management, signal: ports.signal, writeLine,
    io: { interactive: true, selectIndex: (items: readonly { displayName: string }[]) => selectIndex(items, '选择接班设备') } };
  const managed: ManagedCommandPorts = {
    logging: ports.logging, write,
    prepare: async management => { ports.signal.throwIfAborted(); if (management) await ports.ensureManagement(); ports.signal.throwIfAborted(); },
    duty, device: { management: ports.management, signal: ports.signal, writeLine },
    deviceIO: { interactive: true, confirm, selectIndex: items => selectIndex(items, '选择要移除的设备'),
      chooseMode: async conversations => {
        const answer = await choose({ kind: 'selection', title: '处理设备上的对话', message: `该设备有 ${conversations.length} 个对话。请选择处理方式。`,
          choices: [{ id: 'transfer', label: '转移后移除' }, { id: 'destroy', label: '永久删除', danger: true }, { id: 'cancel', label: '取消' }] });
        return answer?.itemId === 'transfer' ? 'transfer' : answer?.itemId === 'destroy' ? 'destroy' : 'cancel';
      } },
    uninstall: { management: ports.management, signal: ports.signal, writeLine },
    uninstallIO: { interactive: true, confirm,
      readRecoveryPackage: async () => {
        const { decodeRecoveryPackage, requireCurrentRecoveryPackage, encodeRecoveryPackage } = await import('@zhixing-ai/mesh/recovery-package');
        return encodeRecoveryPackage(requireCurrentRecoveryPackage(decodeRecoveryPackage(await readRecoveryPackage())).root);
      },
      choosePath: async preflight => {
        const targets = preflight.migrationTargets.filter(item => item.ready);
        const answer = await chooseRaw({ kind: 'selection', title: '选择卸载前的安全路径', choices: [
          ...(targets.length ? [{ id: 'migration', label: '先转移值班职责' }] : []),
          ...(preflight.recoveryBackupReady ? [{ id: 'recovery-backup', label: '使用已验证的恢复备份' }] : []),
          { id: 'cancel', label: '取消' },
        ] });
        if (answer?.itemId === 'recovery-backup') {
          await resumeExecuting();
          return { path: 'recovery-backup' };
        }
        if (answer?.itemId !== 'migration') throw Error('操作已取消。');
        return { path: 'migration', targetName: targets[await selectIndex(targets, '选择接班设备')]!.displayName };
      } },
    backup: { ...common, readRecoveryPackage,
      showRecoveryPackage: value => ports.recovery.show(value), showResetApproval: value => ports.recovery.show(value, '请保存重置确认码', true) },
    recovery: { ...common, signal: ports.signal, readRecoveryPackage },
    pair: { ...common, signal: ports.signal, composition: 'production', completeDeviceConfiguration: async () => {
        const outcome = await ports.completeConfiguration();
        if (outcome === 'ready') await resumeExecuting();
        return outcome;
      },
      promptExecutorAutoStart: async () => {
        const answer = await choose({ kind: 'selection', title: '设备自动上线', message: '是否在开机后自动上线？',
          choices: [{ id: 'yes', label: '开机自动上线' }, { id: 'no', label: '手动启动' }] });
        if (!answer) throw Error('操作已取消。'); return answer.itemId === 'yes';
      },
      selectDutyDevice: async input => {
        const answer = await choose({ kind: 'selection', title: '选择值班设备', choices: [
          { id: 'current', label: input.currentDeviceName }, { id: 'paired', label: input.pairedDeviceName },
        ] });
        if (!answer) throw Error('操作已取消。'); return answer.itemId === 'paired' ? 'paired' : 'current';
      },
      migrateDutyTo: async name => { await ports.ensureManagement(); const { prepareDutyMigration } = await import('../runtime/duty-migration-command.js'); await prepareDutyMigration(name, true, duty); },
      reconcileManagedService: async trigger => {
        const { reconcileCurrentManagedService } = await import('../serve/managed-service-runtime.js');
        await reconcileCurrentManagedService(trigger, ports.signal, ports.home, ports.secretStore, terminalManagedServiceCommand);
      },
      showPairingInvitation: async ({ invitation }) => {
        const { default: QRCode } = await import('qrcode');
        const code = QRCode.create(invitation, { errorCorrectionLevel: 'L' }), size = code.modules.size;
        const pixel = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && code.modules.get(y, x);
        const lines: string[] = [];
        for (let y = -2; y < size + 2; y += 2) {
          let line = '';
          for (let x = -2; x < size + 2; x++) line += pixel(x, y) ? pixel(x, y + 1) ? '█' : '▀' : pixel(x, y + 1) ? '▄' : ' ';
          lines.push(line);
        }
        await ports.recovery.show(lines.join('\n') + '\n\n' + invitation, '配对邀请 · 扫码或复制邀请');
      },
      confirmRecoveryPackage: async value => { if (value) await ports.recovery.show(value); else ports.recovery.close(); return readRecoveryPackage(); },
    },
  };
  let code = 1;
  try { const { runManagedCli } = await import('../index.js'); code = await runManagedCli(args, managed); }
  finally {
    for (const item of output) {
      for (let start = 0; start < item.text.length;) {
        let end = Math.min(item.text.length, start + 8192);
        if (end < item.text.length && /[\udc00-\udfff]/u.test(item.text[end]!)) end--;
        await ports.send({ type: 'command-output', stream: item.stream, text: item.text.slice(start, end) }); start = end;
      }
    }
  }
  // Domain outcome is fixed. Only the final confirmation-code result retains
  // a private reading/copying page; dismiss performs no domain action.
  try { await ports.recovery.finishDisplay(); } finally { ports.recovery.close(); }
  return code;
}
