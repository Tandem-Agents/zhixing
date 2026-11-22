import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { TerminalConfigurationEditor } from '../configuration-editor.js';
import type { TerminalView } from '@zhixing-ai/terminal-ui/protocol';
import type { ConfigEditorRuntime } from '../../config-editor/types.js';
import type { ConfigurationEditResult } from '../../runtime/configuration-edit.js';
import { CONFIGURATION_LOG_SOURCE, ConfigurationEditPendingError } from '@zhixing-ai/providers/configuration';
import { recordingFixture } from '../../../../core/src/logging/__tests__/recording.js';
import { RUNTIME_LOG_SOURCE } from '../../logging/runtime.js';
import type { McpSetupCandidate } from '@zhixing-ai/core/mcp-management';
import type { ZhixingConfig, ZhixingCredentials } from '@zhixing-ai/providers';

function setup(runtime?: ConfigEditorRuntime, apiKey = 'synthetic-original-secret-123456', purpose: 'setup' | 'edit' = 'edit',
  session?: { config: ZhixingConfig; credentials: ZhixingCredentials }) {
  const views: Omit<TerminalView, 'generation'>[] = [];
  const save = vi.fn(async (_edit: Extract<ConfigurationEditResult, { kind: 'completed' }>) => {});
  const editor = new TerminalConfigurationEditor({
    session: { initialConfig: session?.config ?? { llm: { main: { provider: 'deepseek', model: 'deepseek-v4-flash' } } },
      initialCredentials: session?.credentials ?? { providers: { deepseek: { apiKey } } }, writers: { save } },
    title: '合成配置', sections: runtime ? ['mcp'] : ['model'], purpose, runtime,
    headerDetails: ['工作目录    fixture-workspace', '配置        fixture.json', '秘密存储    本机安全存储'],
    publish: async view => { views.push(view); },
  });
  const result = editor.run();
  const current = () => views.at(-1)!;
  const action = (value: string) => editor.act({ kind: 'configuration-action', editId: editor.editId, action: value });
  const choose = async (label: string) => {
    const choice = current().choices?.find(item => item.label.includes(label));
    expect(choice, `Missing ${label} in ${JSON.stringify(current())}`).toBeDefined();
    await action(choice!.id);
  };
  return { views, save, editor, result, current, action, choose };
}

describe('single-root Node configuration transaction', () => {
  it.each(['config', 'mcp'] as const)('keeps the initial %s loading header identical to the prepared editor', async kind => {
    // Execute the production entry until its first cancellation checkpoint;
    // no backend or configuration import is needed to render this first frame.
    const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
    const methods = ['#configuration', '#configurationHeaderDetails'].map(name => owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)!.getText(source).replace(/#/gu, '')).join('\n');
    const Fixture = new Function(ts.transpile(`class Fixture { ${methods} } return Fixture;`, { target: ts.ScriptTarget.ES2022 }))();
    const target = new Fixture(), abort = new AbortController(), views: Omit<TerminalView, 'generation'>[] = [];
    const stopped = Error('stop after initial frame'); abort.abort(stopped);
    Object.assign(target, { abort, configPath: 'fixture-config.json', resolvedLocalView: { workspaceRoot: 'fixture-workspace' }, publish: async (view: Omit<TerminalView, 'generation'>) => { views.push(view); } });
    await expect(target.configuration(kind)).rejects.toBe(stopped);
    const loading = views[0]!;
    const editor = new TerminalConfigurationEditor({ session: { initialConfig: {}, initialCredentials: {}, writers: { save: vi.fn() } },
      title: kind === 'config' ? '配置' : 'MCP 管理', sections: kind === 'config' ? ['model', 'messaging'] : ['mcp'], purpose: 'edit',
      headerDetails: target.configurationHeaderDetails(), publish: async view => { views.push(view); } });
    const result = editor.run();
    expect(loading.configurationHome).toBe(true); expect(loading.chromeDetails).toHaveLength(3);
    for (const key of ['title', 'configurationHome', 'chromeDescription', 'chromeDetails'] as const) expect(loading[key]).toEqual(views.at(-1)![key]);
    editor.cancel(); await result;
  });

  it('shows the recovered-save notice on the home page until the first operation', async () => {
    const views: Omit<TerminalView, 'generation'>[] = [];
    const editor = new TerminalConfigurationEditor({ session: { initialConfig: { llm: { main: { provider: 'deepseek', model: 'deepseek-v4-flash' } } },
      initialCredentials: { providers: { deepseek: { apiKey: 'synthetic-key-123456' } } }, writers: { save: vi.fn() }, notice: '上次接纳的配置修改已保存完成。' },
      title: '配置', sections: ['model'], purpose: 'edit', publish: async view => { views.push(view); } });
    const result = editor.run();
    await vi.waitFor(() => expect(views.at(-1)?.message).toContain('上次接纳的配置修改已保存完成。'));
    await editor.act({ kind: 'configuration-action', editId: editor.editId, action: views.at(-1)!.choices![0]!.id });
    expect(views.at(-1)?.message ?? '').not.toContain('上次接纳的配置修改已保存完成。');
    editor.cancel(); await result;
  });

  it('records terminal configuration saves with the configuration source without capture loss', async () => {
    const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
    const methods = ['#configuration', '#configurationHeaderDetails'].map(name => owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)!.getText(source).replace(/#/gu, '')).join('\n')
      .replace("await import('../runtime/configuration-application.js')", 'configurationApplication');
    const logs = recordingFixture();
    const configurationApplication = {
      editRuntimeConfiguration: async (input: { configurationRecords: import('@zhixing-ai/core/logging').LogRecordPort }) => {
        input.configurationRecords.record({ event: 'saved', data: { scope: 'global', selectionVersion: 'v1', selectionDigest: 'synthetic-digest' } });
        return { kind: 'local-applied' };
      },
    };
    const Fixture = new Function('configurationApplication', 'CONFIGURATION_LOG_SOURCE', ts.transpile('class Fixture { ' + methods + ' } return Fixture;', { target: ts.ScriptTarget.ES2022 }))(configurationApplication, CONFIGURATION_LOG_SOURCE);
    const target = new Fixture();
    Object.assign(target, { abort: new AbortController(), configPath: 'fixture-config.json', home: 'fixture-home',
      logging: { bind: logs.bind, records: logs.bind(RUNTIME_LOG_SOURCE, { scope: 'storage' }) }, secretPlatform: {},
      connection: { getStatus: () => ({ kind: 'unavailable' }) }, publish: async () => {}, mainView: {},
    });
    await target.configuration('config');
    await logs.finish();
    expect(logs.recorder.health().captureFailures).toBe(0);
    expect(logs.records()).toContainEqual(expect.objectContaining({ source: CONFIGURATION_LOG_SOURCE.id, event: 'saved' }));
  });

  it.each([['setup', '保存并启动', '退出'], ['edit', '保存并生效', '放弃本次修改']] as const)(
    'names the main actions by purpose (%s)', async (purpose, complete, cancel) => {
      const h = setup(undefined, undefined, purpose);
      await vi.waitFor(() => expect(h.current().choices?.some(item => item.label === '完成')).toBe(true));
      expect(h.current().choices!.find(item => item.label === '完成')?.detail).toBe(complete);
      expect(h.current().choices!.find(item => item.label === '取消')?.detail).toBe(cancel);
      h.editor.cancel(); await h.result;
    });
  it('returns to the row the user entered from instead of the first row', async () => {
    const h = setup();
    await h.choose('主模型'); await h.choose('DeepSeek');
    const modelRow = h.current().choices!.find(item => item.label.includes('使用模型'))!.id;
    expect(modelRow).not.toBe(h.current().choices![0]!.id);
    await h.action(modelRow);
    await h.action('back');
    expect(h.current().initialItemId).toBe(modelRow);
    while (!h.current().configurationHome) await h.action('back');
    expect(h.current().choices!.find(item => item.id === h.current().initialItemId)?.label).toContain('主模型');
    // 恢复只作用于返回后的那一次发布：再次进入服务商页时定位当前服务商，不带旧行（旧行是第一项）
    await h.choose('主模型');
    expect(h.current().choices!.find(item => item.id === h.current().initialItemId)?.label).toBe('● DeepSeek 官方');
    h.editor.cancel(); await h.result;
  });

  describe('selection pages start on the current value', () => {
    const credentials = { providers: { deepseek: { apiKey: 'synthetic-key-123456' } } } as ZhixingCredentials;
    const configured = { llm: {
      main: { provider: 'deepseek', model: 'deepseek-v4-pro', thinking: { mode: 'effort', effort: 'max' } },
      light: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    } } as ZhixingConfig;
    const focused = (h: ReturnType<typeof setup>) => h.current().choices!.find(item => item.id === h.current().initialItemId)?.label;
    const home = async (h: ReturnType<typeof setup>) => { while (!h.current().configurationHome) await h.action('back'); };

    it('marks and focuses the configured provider, model and thinking option; an unconfigured role has none', async () => {
      const h = setup(undefined, undefined, 'edit', { config: configured, credentials });
      await h.choose('主模型');
      expect(focused(h)).toBe('● DeepSeek 官方');
      expect(h.current().chromeDescription).toContain('带 ● 的是当前已选');
      await h.action(h.current().initialItemId!); await h.choose('使用模型');
      expect(focused(h)).toBe('● deepseek-v4-pro');
      await h.action(h.current().initialItemId!);
      expect(h.current().title).toBe('deepseek-v4-pro · 思考控制');
      expect(focused(h)).toBe('● 强度 max');
      await home(h);
      await h.choose('轻量模型');
      expect(focused(h)).toBe('● DeepSeek 官方');
      await h.action(h.current().initialItemId!); await h.choose('使用模型');
      // 当前项排第二，光标跟随当前项而不是第一项
      expect(focused(h)).toBe('● deepseek-v4-flash');
      await home(h);
      await h.choose('强力模型');
      expect(h.current().initialItemId).toBeUndefined();
      expect(h.current().choices!.some(item => item.label.startsWith('● '))).toBe(false);
      h.editor.cancel(); await h.result;
    });

    it('keeps the thinking setting when the user only browses the current model and saves', async () => {
      const h = setup(undefined, undefined, 'edit', { config: configured, credentials });
      await h.choose('主模型'); await h.choose('DeepSeek'); await h.choose('使用模型'); await h.choose('deepseek-v4-pro');
      expect(h.current().title).toBe('deepseek-v4-pro · 思考控制');
      await home(h); await h.action('complete');
      expect((await h.result).kind).toBe('completed');
      expect(h.save.mock.calls[0]![0].config.llm?.main).toMatchObject({
        connectionId: 'deepseek',
        model: 'deepseek-v4-pro',
        params: { thinking: { mode: 'effort', effort: 'max' } },
      });
    });

    it('returns to the row the user entered from rather than the current value', async () => {
      const h = setup(undefined, undefined, 'edit', { config: configured, credentials });
      await h.choose('主模型'); await h.choose('硅基流动'); await h.action('back');
      expect(focused(h)).toBe('硅基流动');
      h.editor.cancel(); await h.result;
    });

    it('opens the page holding a current value past the first page without pinning later paging', async () => {
      const models = Array.from({ length: 30 }, (_, index) => `custom-${String(index + 1).padStart(2, '0')}`);
      const h = setup(undefined, undefined, 'edit', {
        config: { llm: { main: { provider: 'deepseek', model: 'custom-28' } } } as ZhixingConfig,
        credentials: { providers: { deepseek: { apiKey: 'synthetic-key-123456', models } } } as ZhixingCredentials,
      });
      await h.choose('主模型'); await h.choose('DeepSeek'); await h.choose('使用模型');
      expect(focused(h)).toBe('● custom-28');
      expect(h.current().choices![0]!.id).toBe('previous');
      await h.action('previous');
      expect(h.current().initialItemId).toBeUndefined();
      expect(h.current().choices!.some(item => item.label === 'deepseek-v4-pro')).toBe(true);
      await h.action('next');
      expect(h.current().initialItemId).toBeUndefined();
      expect(h.current().choices!.some(item => item.label === '● custom-28')).toBe(true);
      // 从子页返回回到进入行（优先于当前项），再次进入列表重新定位当前项
      await h.choose('添加自定义模型'); await h.action('back');
      expect(focused(h)).toBe('+ 添加自定义模型');
      await h.action('back'); await h.choose('使用模型');
      expect(focused(h)).toBe('● custom-28');
      h.editor.cancel(); await h.result;
    });

    it('shows a hand-configured model outside the catalog as current only under its own provider', async () => {
      const h = setup(undefined, undefined, 'edit', {
        config: { llm: { main: { provider: 'deepseek', model: 'manual-config-model' } } } as ZhixingConfig, credentials,
      });
      await h.choose('主模型'); await h.choose('DeepSeek'); await h.choose('使用模型');
      expect(focused(h)).toBe('● manual-config-model');
      await h.action('back'); await h.action('back'); await h.choose('硅基流动'); await h.choose('使用模型');
      expect(h.current().choices!.some(item => item.label.includes('manual-config-model'))).toBe(false);
      h.editor.cancel(); await h.result;
    });
  });

  it('puts the stable guide of an input page in its header and keeps errors in the body', async () => {
    const h = setup();
    await h.choose('主模型'); await h.choose('DeepSeek'); await h.choose('使用模型'); await h.choose('添加自定义模型');
    expect(h.current()).toMatchObject({ title: '添加自定义模型', chromeDescription: '为 DeepSeek 官方 添加 · 输入服务商提供的完整 model id。' });
    expect(h.current().message ?? '').toBe('');
    h.editor.cancel(); await h.result;
    const m = setup({ mcpResolve: async () => ({ ok: false, error: '无法识别这个来源' }) });
    await m.choose('其他');
    const guide = '输入预设名、包名、网址、启动命令或描述。';
    expect(m.current()).toMatchObject({ title: '接入 MCP', chromeDescription: guide }); expect(m.current().message ?? '').toBe('');
    await m.editor.act({ kind: 'configuration-action', editId: m.editor.editId, action: 'field', value: 'synthetic' });
    await vi.waitFor(() => expect(m.current().message).toContain('无法识别这个来源'));
    expect(m.current().chromeDescription).toBe(guide);
    m.editor.cancel(); await m.result;
  });

  it('preserves the selected thinking option when completing the provider page', async () => {
    const h = setup();
    await h.choose('主模型'); await h.choose('DeepSeek'); await h.choose('使用模型');
    await h.choose('deepseek-v4-pro'); await h.choose('强度 max');
    await h.action('back'); await h.choose('完成'); await h.action('complete');
    expect((await h.result).kind).toBe('completed');
    expect(h.save.mock.calls[0]![0].config.llm?.main).toMatchObject({
      connectionId: 'deepseek', model: 'deepseek-v4-pro', params: { thinking: { mode: 'effort', effort: 'max' } },
    });
  });

  it('shows the actual MCP target and each secret instruction before probing and keeps failures editable', async () => {
    const candidate: McpSetupCandidate = { serverId: 'synthetic', source: 'inferred',
      entry: { type: 'http', url: 'https://synthetic.invalid/mcp' },
      secretFields: [
        { key: 'TOKEN', label: '令牌', hint: '复制专用令牌', example: '示例格式', docUrl: 'https://synthetic.invalid/token' },
        { key: 'ACCOUNT', label: '账号秘密', hint: '填写第二项', example: '' },
      ] };
    const probe = vi.fn(async () => ({ ok: false as const, error: 'synthetic connection rejected' }));
    const h = setup({ mcpResolve: async () => ({ ok: true, candidate }), mcpProbe: { probe } });
    await h.choose('其他');
    await h.editor.act({ kind: 'configuration-action', editId: h.editor.editId, action: 'field', value: 'synthetic' });
    await vi.waitFor(() => expect(h.current().field?.id).toBe('TOKEN'));
    expect(h.current().message).toContain('将连接：https://synthetic.invalid/mcp');
    expect(h.current().message).toContain('复制专用令牌');
    expect(h.current().message).toContain('https://synthetic.invalid/token');
    expect(probe).not.toHaveBeenCalled();
    await h.editor.act({ kind: 'secret-value', editId: h.editor.editId, fieldId: 'TOKEN', value: 'synthetic-token-value' });
    expect(h.current().message).toContain('密钥 2/2');
    expect(probe).not.toHaveBeenCalled();
    await h.editor.act({ kind: 'secret-value', editId: h.editor.editId, fieldId: 'ACCOUNT', value: 'synthetic-account-value' });
    // 未知原因不外露探测原文，给中文说明与回到来源修改的入口
    await vi.waitFor(() => expect(h.current().message).toContain('连接验证没有通过'));
    expect(h.current().message).not.toContain('synthetic connection rejected');
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).toMatchObject({ url: candidate.entry.url,
      credentials: { TOKEN: 'synthetic-token-value', ACCOUNT: 'synthetic-account-value' } });
    expect(JSON.stringify(h.views)).not.toContain('synthetic-token-value');
    expect(JSON.stringify(h.views)).not.toContain('synthetic-account-value');
    h.editor.cancel(); expect((await h.result).kind).toBe('cancelled'); expect(h.save).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Q'])('pages the complete MCP target before probing, including redaction expansion (%s)', async apiKey => {
    const args = [apiKey ? apiKey.repeat(2000) : 'x'.repeat(4095), '🦞final-argument'];
    const target = args.join(' ');
    const candidate: McpSetupCandidate = { serverId: 'synthetic-long', source: 'inferred',
      entry: { type: 'stdio', command: 'synthetic-command', args }, secretFields: [] };
    const probe = vi.fn(async () => ({ ok: true as const, tools: [] }));
    const h = setup({ mcpResolve: async () => ({ ok: true, candidate }), mcpProbe: { probe } }, apiKey);
    await h.choose('其他');
    await h.editor.act({ kind: 'configuration-action', editId: h.editor.editId, action: 'field', value: 'synthetic-long' });
    await vi.waitFor(() => expect(h.current().message).toContain('连接目标'));
    await expect(h.action('select:0')).rejects.toThrow('查看完整');
    const pieces: string[] = [];
    while (true) {
      pieces.push(h.current().message!.split('\n')[1]!);
      expect(h.current().message!.length).toBeLessThanOrEqual(4097);
      expect(probe).not.toHaveBeenCalled();
      if (!h.current().choices?.some(choice => choice.id === 'next')) break;
      await h.action('next');
    }
    const expected = `将在本机运行：synthetic-command ${target}`;
    expect(pieces.join('')).toBe(apiKey ? expected.replaceAll(apiKey, '[已设置]') : expected);
    await h.choose('验证连接');
    await vi.waitFor(() => expect(h.current().choices?.some(choice => choice.label.includes('synthetic-long'))).toBe(true));
    expect(probe).toHaveBeenCalledOnce();
    h.editor.cancel(); expect((await h.result).kind).toBe('cancelled');
  });

  it('never publishes old secret text and saves a replaced field through the original owner', async () => {
    const h = setup();
    await h.choose('主模型'); await h.choose('DeepSeek'); await h.choose('API Key');
    expect(h.current().field).toMatchObject({ secret: true, configured: true });
    expect(h.current().field).not.toHaveProperty('value');
    expect(JSON.stringify(h.views)).not.toContain('123456');
    const staleEdit = h.editor.editId;
    await h.editor.act({ kind: 'secret-value', editId: staleEdit, fieldId: h.current().field!.id, value: 'synthetic-replacement-secret' });
    await expect(h.editor.act({ kind: 'secret-value', editId: staleEdit, fieldId: 'not-current', value: 'late' })).rejects.toThrow('已更新');
    await h.action('complete');
    expect((await h.result).kind).toBe('completed');
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.save.mock.calls[0]![0]).toMatchObject({
      credentials: { version: 2, modelSecrets: { deepseek: { v: 2, kind: 'api-key', value: 'synthetic-replacement-secret' } } },
    });
    expect(JSON.stringify(h.views)).not.toContain('synthetic-replacement-secret');
  });

  it('cancels asynchronous MCP source work without publishing its late candidate', async () => {
    let complete!: (value: { ok: true; choices: { name: string; summary: string; reason: string }[] }) => void;
    let signal: AbortSignal | undefined;
    const h = setup({ mcpResolve: async (_input, abort) => { signal = abort; return new Promise(resolve => { complete = resolve; }); } });
    await h.choose('其他');
    const beforeLoading = h.current();
    await h.editor.act({ kind: 'configuration-action', editId: h.editor.editId, action: 'field', value: 'synthetic source' });
    expect(h.current().busy).toBe(true);
    for (const key of ['title', 'configurationHome', 'chromeDescription', 'chromeDetails'] as const) {
      expect(h.current()[key]).toEqual(beforeLoading[key]);
    }
    await h.action('back');
    expect(signal?.aborted).toBe(true);
    const count = h.views.length;
    complete({ ok: true, choices: [{ name: 'late-package', summary: 'late', reason: 'late' }] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.views).toHaveLength(count);
    expect(JSON.stringify(h.current())).not.toContain('late-package');
    h.editor.cancel(); expect((await h.result).kind).toBe('cancelled'); expect(h.save).not.toHaveBeenCalled();
  });

  it('keeps a failed save editable and does not claim completion', async () => {
    const h = setup(); h.save.mockRejectedValueOnce(Error('synthetic disk failure'));
    await h.action('complete');
    expect(h.current().message).toContain('未完成保存');
    expect(h.current().busy).not.toBe(true);
    await h.action('complete'); expect((await h.result).kind).toBe('completed');
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it('preserves the durable save outcome when the surface closes during submission', async () => {
    const h = setup();
    let saved!: () => void;
    h.save.mockImplementationOnce(() => new Promise(resolve => { saved = resolve; }));
    const operation = h.action('complete');
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    h.editor.dispose();
    let settled = false;
    void h.result.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    const views = h.views.length;
    saved(); await operation;
    expect((await h.result).kind).toBe('completed');
    expect(h.views).toHaveLength(views);
  });

  it.each(['accepted', 'unknown'] as const)('requires owner recovery after an %s save, rather than resubmitting the old snapshot', async acceptance => {
    const h = setup();
    h.save.mockRejectedValueOnce(new ConfigurationEditPendingError(acceptance, Error('synthetic interruption')));
    const result = expect(h.result).rejects.toMatchObject({ acceptance });
    await h.action('complete'); await result;
    await expect(h.action('complete')).rejects.toThrow('已更新');
    expect(h.save).toHaveBeenCalledOnce();
  });

  it('completes first-run connection setup directly via Ctrl+S identically to in-page save + home complete, and preserves existing main on regular add', async () => {
    const discoverModels = vi.fn(async () => ({
      status: 'discovered' as const,
      models: [{ id: 'local-chat-alpha', capabilities: {} }],
      authoritativeNativeFacts: false,
      fromCache: false,
    }));
    const openZeroSetup = () => {
      const views: Omit<TerminalView, 'generation'>[] = [];
      const save = vi.fn(async (_edit: Extract<ConfigurationEditResult, { kind: 'completed' }>) => {});
      const editor = new TerminalConfigurationEditor({
        session: { initialConfig: {}, initialCredentials: {}, writers: { save } },
        title: '初始配置',
        sections: ['model', 'messaging'],
        purpose: 'setup',
        runtime: { discoverModels },
        publish: async view => { views.push(view); },
      });
      const result = editor.run();
      const current = () => views.at(-1)!;
      const action = (value: string) => editor.act({ kind: 'configuration-action', editId: editor.editId, action: value });
      const choose = async (label: string) => {
        const choice = current().choices?.find(item => item.label.includes(label));
        expect(choice, `Missing ${label} in ${JSON.stringify(current())}`).toBeDefined();
        await action(choice!.id);
      };
      return { views, save, editor, result, current, action, choose };
    };

    const prepareNewCustomConnection = async (h: ReturnType<typeof openZeroSetup>) => {
      await h.choose('服务商连接');
      await h.choose('新增服务商连接');
      expect(h.current().configurationControls?.canComplete).toBe(false);
      await h.choose('自定义连接');
      expect(h.current().configurationControls?.canComplete).toBe(true);
      await h.choose('接口端点');
      expect(h.current().configurationControls?.canComplete).toBe(false);
      await h.editor.act({ kind: 'configuration-action', editId: h.editor.editId, action: 'field', value: 'http://127.0.0.1:18080/v1' });
      await vi.waitFor(() => expect(h.current().title).toContain('服务商连接 ·'));
      expect(h.current().choices?.find(c => c.label === '首次默认主模型')?.detail).toContain('local-chat-alpha');
      expect(h.current().configurationControls?.canComplete).toBe(true);
    };

    // Path A: Direct Ctrl+S on connection-config
    const direct = openZeroSetup();
    await prepareNewCustomConnection(direct);
    await direct.action('complete');
    const directRes = await direct.result;
    expect(directRes.kind).toBe('completed');
    expect(direct.save).toHaveBeenCalledOnce();

    // Path B: Click in-page "保存" -> Esc back to home -> click "完成"
    const twoStep = openZeroSetup();
    await prepareNewCustomConnection(twoStep);
    await twoStep.choose('保存');
    while (!twoStep.current().configurationHome) await twoStep.action('back');
    await twoStep.choose('完成');
    const twoStepRes = await twoStep.result;
    expect(twoStepRes.kind).toBe('completed');
    expect(twoStep.save).toHaveBeenCalledOnce();

    expect(direct.save.mock.calls[0]![0]).toEqual(twoStep.save.mock.calls[0]![0]);
    expect(direct.save.mock.calls[0]![0].config.llm).toMatchObject({
      schemaVersion: 2,
      main: { connectionId: 'custom', model: 'local-chat-alpha' },
    });

    // Existing main preserved when pressing Ctrl+S directly on a newly added connection
    const existingSave = vi.fn(async () => {});
    const existingViews: Omit<TerminalView, 'generation'>[] = [];
    const existingEditor = new TerminalConfigurationEditor({
      session: {
        initialConfig: { llm: { main: { provider: 'deepseek', model: 'deepseek-v4-flash' } } },
        initialCredentials: { providers: { deepseek: { apiKey: 'synthetic-existing-key' } } },
        writers: { save: existingSave },
      },
      title: '配置',
      sections: ['model'],
      purpose: 'edit',
      runtime: { discoverModels },
      publish: async view => { existingViews.push(view); },
    });
    const existingRun = existingEditor.run();
    const pick = async (label: string) => {
      const choice = existingViews.at(-1)!.choices?.find(item => item.label.includes(label))!;
      await existingEditor.act({ kind: 'configuration-action', editId: existingEditor.editId, action: choice.id });
    };
    await pick('服务商连接');
    await pick('新增服务商连接');
    await pick('自定义连接');
    await existingEditor.act({ kind: 'configuration-action', editId: existingEditor.editId, action: 'complete' });
    expect((await existingRun).kind).toBe('completed');
    expect(existingSave.mock.calls[0]![0].config.llm).toMatchObject({
      main: { connectionId: 'deepseek', model: 'deepseek-v4-flash' },
      connections: { custom: { endpoint: 'http://127.0.0.1:11434/v1' } },
    });
  });

  it('enforces unconfirmed 401 across both direct Ctrl+S and Esc-to-home completion while allowing draft rollback on uncommitted new connections', async () => {
    const discoverModels = vi.fn(async () => ({
      status: 'auth-rejected' as const,
      models: [],
      authoritativeNativeFacts: false,
      fromCache: false,
      errorMessage: '401 Unauthorized',
    }));

    // 1. Existing connection rotated to a 401 key: neither direct Ctrl+S nor Esc -> home complete can bypass "先存"
    const views: Omit<TerminalView, 'generation'>[] = [];
    const save = vi.fn(async () => {});
    const editor = new TerminalConfigurationEditor({
      session: {
        initialConfig: {
          llm: {
            schemaVersion: 2,
            connections: {
              deepseek: {
                name: 'DeepSeek 官方',
                presetId: 'deepseek',
                adapter: 'openai-compatible',
                endpoint: 'https://api.deepseek.com/v1',
                auth: { mode: 'api-key', secretRef: 'deepseek' },
                network: { proxy: 'inherit' },
              },
            },
            main: { connectionId: 'deepseek', model: 'deepseek-v4-flash' },
          },
        },
        initialCredentials: { version: 2, modelSecrets: { deepseek: { v: 2, kind: 'api-key', value: 'synthetic-old-key' } } },
        writers: { save },
      },
      title: '配置',
      sections: ['model'],
      purpose: 'edit',
      runtime: { discoverModels },
      publish: async view => { views.push(view); },
    });
    const result = editor.run();
    const cur = () => views.at(-1)!;
    const act = (action: string) => editor.act({ kind: 'configuration-action', editId: editor.editId, action });
    const pick = async (label: string) => {
      const choice = cur().choices?.find(item => item.label.includes(label));
      expect(choice).toBeDefined();
      await act(choice!.id);
    };

    await pick('服务商连接');
    await pick('DeepSeek');
    await pick('API Key');
    await editor.act({ kind: 'secret-value', editId: editor.editId, fieldId: cur().field!.id, value: 'synthetic-401-key' });
    await vi.waitFor(() => expect(cur().title).toContain('服务商连接 ·'));

    // Direct Ctrl+S stays on connection-config with 401 message
    await act('complete');
    expect(cur().title).toContain('服务商连接 ·');
    expect(cur().message).toContain('401');
    expect(save).not.toHaveBeenCalled();

    // Esc back to home -> home also blocks completion with the same 401 requirement
    while (!cur().configurationHome) await act('back');
    expect(cur().choices?.find(item => item.label === '服务商连接')?.status).toBe('pending');
    await act('complete');
    expect(cur().configurationHome).toBe(true);
    expect(cur().message).toContain('401');
    expect(save).not.toHaveBeenCalled();

    // Cancel remains available and discards the unconfirmed draft
    editor.cancel();
    expect((await result).kind).toBe('cancelled');
    expect(save).not.toHaveBeenCalled();

    // 2. Uncommitted new connection encountering 401 and cancelled via Esc rolls back cleanly without blocking unrelated edits
    const views2: Omit<TerminalView, 'generation'>[] = [];
    const save2 = vi.fn(async () => {});
    const editor2 = new TerminalConfigurationEditor({
      session: {
        initialConfig: {
          llm: {
            schemaVersion: 2,
            connections: {
              deepseek: {
                name: 'DeepSeek 官方',
                presetId: 'deepseek',
                adapter: 'openai-compatible',
                endpoint: 'https://api.deepseek.com/v1',
                auth: { mode: 'api-key', secretRef: 'deepseek' },
                network: { proxy: 'inherit' },
              },
            },
            main: { connectionId: 'deepseek', model: 'deepseek-v4-flash' },
          },
        },
        initialCredentials: { version: 2, modelSecrets: { deepseek: { v: 2, kind: 'api-key', value: 'synthetic-good-key' } } },
        writers: { save: save2 },
      },
      title: '配置',
      sections: ['model'],
      purpose: 'edit',
      runtime: { discoverModels },
      publish: async view => { views2.push(view); },
    });
    const run2 = editor2.run();
    const cur2 = () => views2.at(-1)!;
    const act2 = (action: string) => editor2.act({ kind: 'configuration-action', editId: editor2.editId, action });
    const pick2 = async (label: string) => {
      const choice = cur2().choices?.find(item => item.label.includes(label))!;
      await act2(choice.id);
    };

    await pick2('轻量模型');
    await pick2('DeepSeek');
    await pick2('完成');
    await act2('back');

    await pick2('服务商连接');
    await pick2('新增服务商连接');
    await pick2('OpenAI');
    await pick2('API Key');
    await editor2.act({ kind: 'secret-value', editId: editor2.editId, fieldId: cur2().field!.id, value: 'synthetic-abandoned-401' });
    await vi.waitFor(() => expect(cur2().title).toContain('OpenAI'));

    // Esc on uncommitted new connection abandons the draft cleanly
    await act2('back');
    expect(cur2().title).toBe('服务商连接');
    expect(JSON.stringify(cur2())).not.toContain('OpenAI');
    await act2('complete');
    expect((await run2).kind).toBe('completed');
    expect(save2).toHaveBeenCalledOnce();
    const savedPayload = save2.mock.calls[0]![0]!;
    expect(savedPayload.config.llm?.connections?.openai).toBeUndefined();
    expect(savedPayload.credentials.modelSecrets?.openai).toBeUndefined();
    expect(savedPayload.config.llm?.light).toBeDefined();
    expect(discoverModels).toHaveBeenCalledTimes(2); // Existing untouched deepseek was NOT forced to re-probe
  });

  it('projects redacted legacy endpoints without contradictory status, blocks Ctrl+S on repair/MCP gates, and distinguishes cancellable loading from durable saving', async () => {
    const legacyPathToken = 'SYNTHETIC_LEGACY_PATH_TOKEN_771';
    const legacyApiKey = 'SYNTHETIC_LEGACY_API_KEY_882';
    const queryLeakToken = 'SYNTHETIC_QUERY_LEAK_993';
    const replacementPathToken = 'SYNTHETIC_REPLACEMENT_PATH_445';
    const views: Omit<TerminalView, 'generation'>[] = [];
    const save = vi.fn(async () => {});
    const editor = new TerminalConfigurationEditor({
      session: {
        initialConfig: { llm: { schemaVersion: 2, connections: {}, main: { connectionId: 'local_ok', model: 'm1' } } },
        initialCredentials: {
          version: 2,
          protectedLegacyProviders: {
            deepseek: {
              apiKey: legacyApiKey,
              baseUrl: `https://gw.corp.example/${legacyPathToken}/v1`,
              protocol: 'openai-compatible',
            },
          },
        },
        writers: { save },
      },
      title: '配置',
      sections: ['model'],
      purpose: 'edit',
      publish: async view => { views.push(view); },
    });
    const run = editor.run();
    const cur = () => views.at(-1)!;
    const act = (action: string) => editor.act({ kind: 'configuration-action', editId: editor.editId, action });
    const pick = async (label: string) => {
      const choice = cur().choices?.find(item => item.label.includes(label))!;
      await act(choice.id);
    };

    await pick('迁移待修复项');
    expect(cur().configurationControls?.canComplete).toBe(false);
    await pick('deepseek');
    expect(cur().title).toContain('迁移修复 · deepseek');
    expect(cur().configurationControls?.canComplete).toBe(false);
    const endpointRow = cur().choices?.find(item => item.label === '旧自定义端点')!;
    expect(endpointRow.status).toBe('ready');
    expect(endpointRow.detail).toBe('https://gw.corp.example（已隐去受保护路径与参数）');
    expect(endpointRow.detail).not.toContain('待填写');

    // Ctrl+S on migration-repair-provider does not auto-migrate or jump to home
    await act('complete');
    expect(cur().title).toContain('迁移修复 · deepseek');
    expect(save).not.toHaveBeenCalled();

    // Open repair-endpoint: remains dedicated secret field with no prefilled value
    await pick('旧自定义端点');
    expect(cur().field).toEqual({ id: 'repair-endpoint:deepseek', label: '迁移修复 · deepseek 端点', secret: true, configured: false });
    expect(cur().configurationControls?.canComplete).toBe(false);

    // Reject secret-bearing query URL without echoing the raw secret
    await editor.act({
      kind: 'secret-value',
      editId: editor.editId,
      fieldId: 'repair-endpoint:deepseek',
      value: `https://gw.corp.example/v1?api_key=${queryLeakToken}`,
    });
    expect(cur().field?.id).toBe('repair-endpoint:deepseek');
    expect(cur().message).toContain('纯净端点');

    // Submit clean URL with sensitive path -> entity row still redacts unconfirmed path!
    await editor.act({
      kind: 'secret-value',
      editId: editor.editId,
      fieldId: 'repair-endpoint:deepseek',
      value: `https://new-gw.corp.example/${replacementPathToken}/v1`,
    });
    expect(cur().title).toContain('迁移修复 · deepseek');
    const updatedRow = cur().choices?.find(item => item.label === '旧自定义端点')!;
    expect(updatedRow.status).toBe('ready');
    expect(updatedRow.detail).toBe('已设新端点 · https://new-gw.corp.example（已隐去受保护路径与参数）');

    const serializedViews = JSON.stringify(views);
    for (const secret of [legacyPathToken, legacyApiKey, queryLeakToken, replacementPathToken]) {
      expect(serializedViews).not.toContain(secret);
    }
    editor.cancel();
    await run;

    // MCP add gate & loading vs durable saving controls
    let finishResolve!: (res: { ok: true; candidate: McpSetupCandidate }) => void;
    let finishSave!: () => void;
    const candidate: McpSetupCandidate = {
      serverId: 'demo-mcp',
      source: 'inferred',
      entry: { type: 'http', url: 'https://mcp.example.com/sse' },
      secretFields: [],
    };
    const mcpViews: Omit<TerminalView, 'generation'>[] = [];
    const mcpSave = vi.fn(() => new Promise<void>(resolve => { finishSave = resolve; }));
    const mcpEditor = new TerminalConfigurationEditor({
      session: { initialConfig: {}, initialCredentials: {}, writers: { save: mcpSave } },
      title: 'MCP 管理',
      sections: ['mcp'],
      purpose: 'edit',
      runtime: {
        mcpResolve: () => new Promise(resolve => { finishResolve = resolve; }),
        mcpProbe: { probe: async () => ({ ok: true as const, tools: [] }) },
      },
      publish: async view => { mcpViews.push(view); },
    });
    const mcpRun = mcpEditor.run();
    const mcpCur = () => mcpViews.at(-1)!;
    const otherId = mcpCur().choices!.find(item => item.label.includes('其他'))!.id;
    await mcpEditor.act({ kind: 'configuration-action', editId: mcpEditor.editId, action: otherId });
    await mcpEditor.act({ kind: 'configuration-action', editId: mcpEditor.editId, action: 'field', value: 'demo' });
    // Cancellable loading state: canComplete=false, canBack=true, canCancel=true
    expect(mcpCur().busy).toBe(true);
    expect(mcpCur().configurationControls).toEqual({ canComplete: false, canBack: true, canCancel: true });

    finishResolve({ ok: true, candidate });
    await vi.waitFor(() => expect(mcpCur().title).toBe('接入 · demo-mcp'));
    expect(mcpCur().configurationControls).toEqual({ canComplete: false, canBack: true, canCancel: true });

    // Pressing Ctrl+S before "验证连接" stays on mcp-add and never calls save!
    await mcpEditor.act({ kind: 'configuration-action', editId: mcpEditor.editId, action: 'complete' });
    expect(mcpCur().title).toBe('接入 · demo-mcp');
    expect(mcpSave).not.toHaveBeenCalled();

    // Verify connection -> returns to home -> Ctrl+S enters durable saving (canComplete=false, canBack=false, canCancel=false)
    const verifyId = mcpCur().choices!.find(item => item.label === '验证连接')!.id;
    await mcpEditor.act({ kind: 'configuration-action', editId: mcpEditor.editId, action: verifyId });
    await vi.waitFor(() => expect(mcpCur().configurationHome).toBe(true));
    expect(mcpCur().configurationControls?.canComplete).toBe(true);

    const savingPromise = mcpEditor.act({ kind: 'configuration-action', editId: mcpEditor.editId, action: 'complete' });
    await vi.waitFor(() => expect(mcpSave).toHaveBeenCalledOnce());
    expect(mcpCur().busy).toBe(true);
    expect(mcpCur().configurationControls).toEqual({ canComplete: false, canBack: false, canCancel: false });
    finishSave();
    await savingPromise;
    expect((await mcpRun).kind).toBe('completed');
  });

  it('commits ancestor provider-config identically from parent and child pages, gates unchosen model/provider pickers, preserves explicit model/params, and returns to parent on missing credentials', async () => {
    const dualReadyConfig: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          local: {
            name: '本机测试',
            adapter: 'openai-compatible',
            endpoint: 'http://127.0.0.1:47982/v1',
            auth: { mode: 'none' },
            network: { proxy: 'direct', allowPrivateOrigin: true },
            customModels: ['model-a'],
          },
          alt: {
            name: '另一条已配置连接',
            presetId: 'deepseek',
            adapter: 'openai-compatible',
            endpoint: 'http://127.0.0.1:47982/v1',
            auth: { mode: 'none' },
            network: { proxy: 'direct', allowPrivateOrigin: true },
          },
          custom_blank: {
            name: '无推荐自定义连接',
            adapter: 'openai-compatible',
            endpoint: 'http://127.0.0.1:47982/v1',
            auth: { mode: 'none' },
            network: { proxy: 'direct', allowPrivateOrigin: true },
            customModels: ['cand-1', 'cand-2'],
          },
          nokey: {
            name: '缺密钥预设连接',
            presetId: 'deepseek',
            adapter: 'openai-compatible',
            endpoint: 'https://api.deepseek.com/v1',
            auth: { mode: 'api-key', secretRef: 'nokey' },
            network: { proxy: 'inherit' },
          },
        },
        main: { connectionId: 'local', model: 'model-a' },
      },
    };
    const openDual = (initialConfig: ZhixingConfig = dualReadyConfig) => {
      const views: Omit<TerminalView, 'generation'>[] = [];
      const save = vi.fn(async (_edit: Extract<ConfigurationEditResult, { kind: 'completed' }>) => {});
      const editor = new TerminalConfigurationEditor({
        session: { initialConfig, initialCredentials: { version: 2 }, writers: { save } },
        title: '配置',
        sections: ['model'],
        purpose: 'edit',
        publish: async view => { views.push(view); },
      });
      const result = editor.run();
      const cur = () => views.at(-1)!;
      const act = (action: string) => editor.act({ kind: 'configuration-action', editId: editor.editId, action });
      const pick = async (label: string) => {
        const choice = cur().choices?.find(item => item.label.includes(label));
        expect(choice, `Missing ${label} in ${JSON.stringify(cur())}`).toBeDefined();
        await act(choice!.id);
      };
      return { views, save, editor, result, cur, act, pick };
    };

    // 1. Parent provider-config direct Ctrl+S vs child model-list direct Ctrl+S (without choosing another model)
    const fromParent = openDual();
    await fromParent.pick('主模型');
    // Browsing provider-list when main is already configured keeps canComplete=true without impersonating unconfirmed choices
    expect(fromParent.cur().configurationControls?.canComplete).toBe(true);
    await fromParent.pick('另一条已配置连接');
    expect(fromParent.cur().configurationControls?.canComplete).toBe(true);
    await fromParent.act('complete');
    expect((await fromParent.result).kind).toBe('completed');

    const fromChild = openDual();
    await fromChild.pick('主模型');
    await fromChild.pick('另一条已配置连接');
    await fromChild.pick('使用模型');
    expect(fromChild.cur().title).toContain('选择模型');
    expect(fromChild.cur().configurationControls?.canComplete).toBe(true);
    await fromChild.act('complete');
    expect((await fromChild.result).kind).toBe('completed');

    expect(fromChild.save.mock.calls[0]![0]).toEqual(fromParent.save.mock.calls[0]![0]);
    expect(fromChild.save.mock.calls[0]![0].config.llm?.main).toEqual({
      connectionId: 'alt',
      model: 'deepseek-v4-pro',
    });
    expect(fromChild.save.mock.calls[0]![0].config.llm?.light).toBeUndefined();

    // 2. Browsing provider-list without confirming keeps original local/model-a; unconfigured light provider-list & custom no-recommendation model-list gate Ctrl+S
    const browseOnly = openDual();
    await browseOnly.pick('轻量模型');
    expect(browseOnly.cur().configurationControls?.canComplete).toBe(false);
    await browseOnly.act('complete');
    expect(browseOnly.cur().title).toContain('轻量模型 · 选择服务商');
    expect(browseOnly.save).not.toHaveBeenCalled();
    await browseOnly.act('back');
    await browseOnly.pick('主模型');
    await browseOnly.pick('无推荐自定义连接');
    await browseOnly.pick('使用模型');
    expect(browseOnly.cur().title).toContain('选择模型');
    expect(browseOnly.cur().configurationControls?.canComplete).toBe(false);
    await browseOnly.act('complete');
    expect(browseOnly.cur().title).toContain('选择模型');
    expect(browseOnly.save).not.toHaveBeenCalled();
    await browseOnly.act('back');
    await browseOnly.act('back');
    // Back on 主模型 · 选择服务商 without having committed another provider: Ctrl+S preserves local/model-a
    await browseOnly.act('complete');
    expect((await browseOnly.result).kind).toBe('completed');
    expect(browseOnly.save.mock.calls[0]![0].config.llm?.main).toEqual({
      connectionId: 'local',
      model: 'model-a',
    });

    // 3. Explicit model + thinking + maxOutputTokens params preserved when completing from model-list or thinking-config
    const withParams = openDual({
      llm: {
        ...dualReadyConfig.llm!,
        main: {
          connectionId: 'alt',
          model: 'deepseek-v4-flash',
          params: { thinking: { mode: 'effort', effort: 'max' }, maxOutputTokens: 4096 },
        },
      },
    });
    await withParams.pick('主模型');
    await withParams.pick('另一条已配置连接');
    await withParams.pick('使用模型');
    expect(withParams.cur().choices?.find(item => item.label.startsWith('● '))?.label).toBe('● deepseek-v4-flash');
    await withParams.act('complete');
    expect((await withParams.result).kind).toBe('completed');
    expect(withParams.save.mock.calls[0]![0].config.llm?.main).toEqual({
      connectionId: 'alt',
      model: 'deepseek-v4-flash',
      params: { thinking: { mode: 'effort', effort: 'max' }, maxOutputTokens: 4096 },
    });

    // 4. Child page Ctrl+S with missing parent credential returns to parent provider-config while keeping chosen model/thinking draft
    const missingCred = openDual();
    await missingCred.pick('主模型');
    await missingCred.pick('缺密钥预设连接');
    await missingCred.pick('使用模型');
    await missingCred.pick('deepseek-v4-pro');
    await missingCred.pick('强度 max');
    expect(missingCred.cur().title).toContain('选择模型');
    await missingCred.act('complete');
    expect(missingCred.save).not.toHaveBeenCalled();
    expect(missingCred.cur().title).toContain('主模型 · 缺密钥预设连接');
    expect(missingCred.cur().message).toContain('API Key');
    expect(missingCred.cur().choices?.find(item => item.label === '使用模型')?.detail).toBe('deepseek-v4-pro');
    missingCred.editor.cancel();
    await missingCred.result;
  });

  it('pops directly back to connection-list when confirming connection deletion while preserving cancel and active-role guards', async () => {
    const initialConfig: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          local: {
            name: '本机主连接',
            adapter: 'openai-compatible',
            endpoint: 'http://127.0.0.1:47982/v1',
            auth: { mode: 'none' },
            network: { proxy: 'direct', allowPrivateOrigin: true },
            customModels: ['model-a'],
          },
          spare: {
            name: '待移除连接',
            presetId: 'deepseek',
            adapter: 'openai-compatible',
            endpoint: 'http://127.0.0.1:47982/v1',
            auth: { mode: 'none' },
            network: { proxy: 'direct', allowPrivateOrigin: true },
          },
        },
        main: { connectionId: 'local', model: 'model-a' },
      },
    };
    const views: Omit<TerminalView, 'generation'>[] = [];
    const save = vi.fn(async (_edit: Extract<ConfigurationEditResult, { kind: 'completed' }>) => {});
    const editor = new TerminalConfigurationEditor({
      session: { initialConfig, initialCredentials: { version: 2 }, writers: { save } },
      title: '配置',
      sections: ['model'],
      purpose: 'edit',
      publish: async view => { views.push(view); },
    });
    const result = editor.run();
    const cur = () => views.at(-1)!;
    const act = (action: string) => editor.act({ kind: 'configuration-action', editId: editor.editId, action });
    const pick = async (label: string) => {
      const choice = cur().choices?.find(item => item.label.includes(label));
      expect(choice, `Missing ${label} in ${JSON.stringify(cur())}`).toBeDefined();
      await act(choice!.id);
    };

    await pick('服务商连接');
    expect(cur().title).toBe('服务商连接');

    // Cancel on spare connection-delete returns 1 level to connection-config
    await pick('待移除连接');
    expect(cur().title).toBe('服务商连接 · 待移除连接');
    await pick('删除');
    expect(cur().title).toBe('删除连接 · 待移除连接');
    await act('back');
    expect(cur().title).toBe('服务商连接 · 待移除连接');

    // Confirming deletion atomically pops both connection-delete and invalidated connection-config
    await pick('删除');
    await pick('删连接');
    expect(cur().title).toBe('服务商连接');
    expect(views.some(v => (v.message ?? '').includes('连接不存在'))).toBe(false);
    expect(cur().choices?.some(item => item.label.includes('待移除连接'))).toBe(false);
    expect(cur().choices?.some(item => item.id === cur().initialItemId)).toBe(true);

    // Guard: sole remaining active main connection cannot be deleted without a replacement; stays on connection-delete
    await pick('本机主连接');
    expect(cur().title).toBe('服务商连接 · 本机主连接');
    await pick('删除');
    expect(cur().title).toBe('删除连接 · 本机主连接');
    await pick('删连接');
    expect(cur().title).toBe('删除连接 · 本机主连接');
    await act('back');
    expect(cur().title).toBe('服务商连接 · 本机主连接');
    await act('back');
    expect(cur().title).toBe('服务商连接');

    // Subsequent Esc goes to configuration home rather than reopening an orphaned detail page
    await act('back');
    expect(cur().configurationHome).toBe(true);
    await act('complete');
    expect((await result).kind).toBe('completed');
    expect(save.mock.calls[0]![0].config.llm?.connections?.spare).toBeUndefined();
    expect(save.mock.calls[0]![0].config.llm?.main).toEqual({ connectionId: 'local', model: 'model-a' });
  });
});
