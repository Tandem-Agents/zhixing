import { describe, expect, it } from 'vitest';
import { terminalEnvironment } from '../environment-presentation.js';

describe('terminal public environment', () => {
  it('projects only current model and resolved directory, without configuration or host internals', () => {
    const current = { primaryModel: { providerId: 'provider', model: 'model' }, workspaceRoot: 'D:/work', secret: 'never-send' };
    expect(terminalEnvironment(current)).toEqual({ provider: 'provider', model: 'model', workspace: 'D:/work' });
    current.primaryModel = { providerId: 'new-provider', model: 'new-model' }; current.workspaceRoot = 'E:/other';
    expect(terminalEnvironment(current)).toEqual({ provider: 'new-provider', model: 'new-model', workspace: 'E:/other' });
  });
  it('preserves an unknown directory and bounds every public field', () => {
    const projected = terminalEnvironment({ primaryModel: { providerId: 'p'.repeat(1000), model: 'm'.repeat(10000) }, workspaceRoot: null });
    expect(projected.workspace).toBeNull(); expect(projected.provider.length).toBe(256); expect(projected.model.length).toBe(512);
    expect(terminalEnvironment({ primaryModel: { providerId: '', model: '' }, workspaceRoot: 'x'.repeat(10000) }).workspace?.length).toBe(4096);
  });
});
