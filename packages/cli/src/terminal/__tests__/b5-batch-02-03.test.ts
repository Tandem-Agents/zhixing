import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalView } from '../../../../terminal-ui/src/protocol.js';
import { independentCommandTitle, runIndependentCommand } from '../independent-command.js';
import { TerminalRecovery } from '../recovery.js';

const source = ts.createSourceFile(
  'application.ts',
  readFileSync(new URL('../application.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const owner = source.statements.find(
  (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication',
)!;
function extractMethod(name: string): string {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === name);
  if (!node) throw new Error(`Missing production method ${name}`);
  return node.getText(source).replace(/#/gu, '');
}

const HeaderHost = new Function(
  ts.transpile(
    `class HeaderHost {
      configPath = '/isolated/.zhixing/config.jsonc';
      resolvedLocalView = undefined;
      ${extractMethod('#configurationHeaderDetails')}
    }
    return HeaderHost;`,
    { target: ts.ScriptTarget.ES2022 },
  ),
)() as new () => {
  configPath: string;
  resolvedLocalView?: {
    workspaceRoot: string | null;
    workspaceLabel?: string;
    hostInfo: { workspace?: string } | null;
  };
  configurationHeaderDetails(purpose: 'setup' | 'edit', config?: { workspace?: { root?: string } }): readonly string[];
};

describe('B5-02 configurationHeaderDetails workspace provenance', () => {
  it('uses session.initialConfig workspace in setup without ever falling back to process.cwd()', () => {
    const host = new HeaderHost();
    host.resolvedLocalView = {
      workspaceRoot: '/workscene/override',
      workspaceLabel: '场景工作区',
      hostInfo: { workspace: '/workscene/override' },
    };

    expect(
      host.configurationHeaderDetails('setup', { workspace: { root: 'D:\\ZhixingWorkspace' } }),
    ).toEqual([
      '工作目录    D:\\ZhixingWorkspace',
      '配置        /isolated/.zhixing/config.jsonc',
      '秘密存储    本机安全存储',
    ]);

    expect(host.configurationHeaderDetails('setup', {})).toEqual([
      '工作目录    未绑定工作目录',
      '配置        /isolated/.zhixing/config.jsonc',
      '秘密存储    本机安全存储',
    ]);
    expect(host.configurationHeaderDetails('setup', {})[0]).not.toContain(process.cwd());
  });

  it('preserves runtime projection priority in edit mode, falls back to config when offline, and shows 正在读取… before config load completes', () => {
    const host = new HeaderHost();

    // Offline / pre-read loading frame: no runtime view and no loaded config yet
    expect(host.configurationHeaderDetails('edit')[0]).toBe('工作目录    正在读取…');
    expect(host.configurationHeaderDetails('edit')[0]).not.toContain(process.cwd());

    // Offline editor open: no runtime view, config loaded
    expect(host.configurationHeaderDetails('edit', { workspace: { root: 'E:\\ConfiguredWorkspace' } })[0]).toBe(
      '工作目录    E:\\ConfiguredWorkspace',
    );
    expect(host.configurationHeaderDetails('edit', {})[0]).toBe('工作目录    未绑定工作目录');

    // Connected in main conversation or workscene: runtime projection wins over global config
    host.resolvedLocalView = {
      workspaceRoot: 'E:\\SceneWorkspace',
      workspaceLabel: '场景目录',
      hostInfo: { workspace: 'D:\\ZhixingWorkspace' },
    };
    expect(host.configurationHeaderDetails('edit', { workspace: { root: 'D:\\ZhixingWorkspace' } })[0]).toBe(
      '工作目录    E:\\SceneWorkspace',
    );
    expect(host.configurationHeaderDetails('edit')[0]).toBe('工作目录    E:\\SceneWorkspace');

    // Connected host with explicitly unbound workspace
    host.resolvedLocalView = {
      workspaceRoot: null,
      hostInfo: {},
    };
    expect(host.configurationHeaderDetails('edit')[0]).toBe('工作目录    未绑定工作目录');
  });
});

describe('B5-03 standalone command title and sub-page busy restoration', () => {
  it('derives controlled command titles from known subcommands and never echoes operands or secrets', () => {
    expect(independentCommandTitle(['pair'])).toBe('知行 · zz pair');
    expect(independentCommandTitle(['pair', 'SECRET_INVITATION_TOKEN'])).toBe('知行 · zz pair');
    expect(independentCommandTitle(['--log', 'pair', '--relay-only', 'SECRET'])).toBe('知行 · zz pair');
    expect(independentCommandTitle(['device', 'remove', 'my-laptop', '--permanent'])).toBe('知行 · zz device remove');
    expect(independentCommandTitle(['device', 'continue', 'my-laptop', '--mode', 'transfer'])).toBe('知行 · zz device continue');
    expect(independentCommandTitle(['duty', 'migrate'])).toBe('知行 · zz duty migrate');
    expect(independentCommandTitle(['backup', 'setup', '--directory', '/secret/path'])).toBe('知行 · zz backup setup');
    expect(independentCommandTitle(['backup', 'verify'])).toBe('知行 · zz backup verify');
    expect(independentCommandTitle(['backup', 'recover'])).toBe('知行 · zz backup recover');
    expect(independentCommandTitle(['backup', 'root', 'rotate'])).toBe('知行 · zz backup root rotate');
    expect(independentCommandTitle(['backup', 'root', 'invalidate'])).toBe('知行 · zz backup root invalidate');
    expect(independentCommandTitle(['backup', 'root', 'approve-reset'])).toBe('知行 · zz backup root approve-reset');
    expect(independentCommandTitle(['backup', 'root', 'reset', '--approval', 'SECRET_CODE'])).toBe('知行 · zz backup root reset');
    expect(independentCommandTitle(['unknown', 'SECRET_ARG'])).toBe('知行 · 命令');
  });

  it('restores the command executing view after selection sub-pages without overwriting active recovery display', async () => {
    const published: Omit<TerminalView, 'generation'>[] = [];
    const signal = new AbortController().signal;
    const recovery = new TerminalRecovery({
      signal,
      publish: async view => {
        published.push(view);
      },
      send: async () => {},
    });

    const resumeExecuting = vi.fn(async () => {
      if (!signal.aborted && !recovery.active) {
        published.push({ kind: 'command', title: '知行 · zz backup root approve-reset', message: '正在执行命令…', busy: true });
      }
    });

    // Verify recovery retainResult protection: when recovery.show(..., retainResult=true) is active,
    // resumeExecuting does not overwrite the recovery display or prevent finishDisplay.
    await recovery.show('APPROVAL-CODE-123', '请保存重置确认码', true);
    expect(recovery.active).toBe(true);
    await resumeExecuting();
    expect(published.at(-1)?.kind).toBe('recovery');
    const finishPromise = recovery.finishDisplay();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(published.at(-1)).toMatchObject({ kind: 'recovery', title: '确认码已生成' });
    await recovery.act({ kind: 'recovery-cancel', requestId: published.at(-1)!.requestId! });
    await finishPromise;
    expect(recovery.active).toBe(false);

    // Verify runIndependentCommand with invalid invitation returns cleanly via command-output without conversation views
    const messages: unknown[] = [];
    const exitCode = await runIndependentCommand(['pair', 'abcd'], {
      home: '/nonexistent-isolated-home',
      signal,
      logging: { records: undefined, bind: () => undefined as never, finish: async () => {} } as never,
      secretStore: {} as never,
      management: {} as never,
      recovery,
      ensureManagement: async () => {},
      completeConfiguration: async () => 'ready',
      choose: async () => undefined,
      send: async message => {
        messages.push(message);
      },
      resumeExecuting,
    });
    expect(exitCode).toBe(1);
    expect(published.some(view => view.kind === 'conversation')).toBe(false);
    expect(messages).toEqual([
      {
        type: 'command-output',
        stream: 'stderr',
        text: expect.stringContaining('配对邀请内容无效或不完整'),
      },
    ]);
  }, 30_000);
});
