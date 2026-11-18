import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
