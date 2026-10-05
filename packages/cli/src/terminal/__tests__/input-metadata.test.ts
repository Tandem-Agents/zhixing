import { describe, expect, it } from 'vitest';
import { InputMaterialRegistry } from '../../input-material-registry.js';

const file = { kind: 'file' as const, filePath: '/synthetic/材料.txt', name: '材料.txt', mimeType: 'text/plain', byteSize: 7 };
describe('terminal material reference budget', () => {
  it('rejects new metadata without losing accepted material and releases collected tokens', () => {
    const registry = new InputMaterialRegistry(1024);
    const id = registry.registerLocalFile(file), token = registry.format(id);
    const retained = registry.metadataBytes;
    expect(registry.format(id)).toBe(token); expect(registry.metadataBytes).toBe(retained);
    expect(() => registry.registerLocalFile({ ...file, filePath: '/synthetic/' + '汉'.repeat(400) })).toThrow('工作区不足');
    expect(registry.size).toBe(1); expect(registry.get(id)).toEqual({ ...file, id });
    expect(registry.isKnownToken(id, token)).toBe(true); expect(registry.metadataBytes).toBe(retained);
    registry.cleanup(new Set()); expect(registry.metadataBytes).toBe(0); expect(registry.size).toBe(0);
    const next = registry.registerLocalFile(file); expect(next).toBe(id + 1);
    registry.format(next); registry.clearAll(); expect(registry.metadataBytes).toBe(0);
  });
  it('admits exact remaining token capacity and keeps a prior token when a new format cannot fit', () => {
    const reference = new InputMaterialRegistry();
    const id = reference.registerLocalFile(file), token = reference.format(id, { maxWidth: 20 });
    const registry = new InputMaterialRegistry(reference.metadataBytes);
    registry.registerLocalFile(file); expect(registry.format(id, { maxWidth: 20 })).toBe(token);
    expect(() => registry.format(id)).toThrow('工作区不足');
    expect(registry.isKnownToken(id, token)).toBe(true);
    expect(registry.metadataBytes).toBe(reference.metadataBytes);
  });
});
