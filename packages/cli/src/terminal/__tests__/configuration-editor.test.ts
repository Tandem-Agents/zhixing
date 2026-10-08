import { describe, expect, it, vi } from 'vitest';
import { TerminalConfigurationEditor } from '../configuration-editor.js';
import type { TerminalView } from '@zhixing/terminal-ui/protocol';
import type { ConfigEditorRuntime } from '../../config-editor/types.js';
import type { ConfigurationEditResult } from '../../runtime/configuration-edit.js';
import { ConfigurationEditPendingError } from '@zhixing/providers/configuration';
import type { McpSetupCandidate } from '@zhixing/core/mcp-management';

function setup(runtime?: ConfigEditorRuntime, apiKey = 'synthetic-original-secret-123456') {
  const views: Omit<TerminalView, 'generation'>[] = [];
  const save = vi.fn(async (_edit: Extract<ConfigurationEditResult, { kind: 'completed' }>) => {});
  const editor = new TerminalConfigurationEditor({
    session: { initialConfig: { llm: { main: { provider: 'deepseek', model: 'deepseek-v4-flash' } } },
      initialCredentials: { providers: { deepseek: { apiKey } } }, writers: { save } },
    title: '合成配置', sections: runtime ? ['mcp'] : ['model'], runtime,
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
  it('preserves the selected thinking option when completing the provider page', async () => {
    const h = setup();
    await h.choose('主模型'); await h.choose('DeepSeek'); await h.choose('使用模型');
    await h.choose('deepseek-v4-pro'); await h.choose('强度 max');
    await h.action('back'); await h.choose('完成'); await h.action('complete');
    expect((await h.result).kind).toBe('completed');
    expect(h.save.mock.calls[0]![0].config.llm?.main).toMatchObject({
      provider: 'deepseek', model: 'deepseek-v4-pro', thinking: { mode: 'effort', effort: 'max' },
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
    await vi.waitFor(() => expect(h.current().message).toContain('synthetic connection rejected'));
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
    expect(h.save.mock.calls[0]![0]).toMatchObject({ credentials: { providers: { deepseek: { apiKey: 'synthetic-replacement-secret' } } } });
    expect(JSON.stringify(h.views)).not.toContain('synthetic-replacement-secret');
  });

  it('cancels asynchronous MCP source work without publishing its late candidate', async () => {
    let complete!: (value: { ok: true; choices: { name: string; summary: string; reason: string }[] }) => void;
    let signal: AbortSignal | undefined;
    const h = setup({ mcpResolve: async (_input, abort) => { signal = abort; return new Promise(resolve => { complete = resolve; }); } });
    await h.choose('其他');
    await h.editor.act({ kind: 'configuration-action', editId: h.editor.editId, action: 'field', value: 'synthetic source' });
    expect(h.current().busy).toBe(true);
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
});
