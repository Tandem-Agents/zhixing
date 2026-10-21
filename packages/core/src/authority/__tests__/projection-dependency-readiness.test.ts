import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AuthorityCacheIntegrity, FileDurableProjectionIndex } from '../index.js';
import { createTempDir } from '@zhixing/test-utils';
import { FileArtifactStore } from '../artifact-store.js';
import { FileAuthorityCommitLog } from '../commit-log.js';

it.each([true, false])('prepares an unopened validation dependency and preserves rejection (valid=%s)', async valid => {
  const root = await createTempDir('projection-dependency-readiness');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const original = new FileAuthorityCommitLog(path.join(root, 'log'), artifacts);
  await original.append([{ stream: 'control', body: { validated: valid } }]);
  await original.stopStorageMaintenance();
  const log = new FileAuthorityCommitLog(path.join(root, 'log'), artifacts);
  try {
    log.durableProjection({ projectionId: 'a-dependent', reducerVersion: 1, inputs: { streams: ['control'] },
      async reduce(_envelope, _current, source) {
        expect(await source.readPreparedProjection!('z-validation').get('verified')).toBe(true);
        return [{ kind: 'put', key: 'result', value: 'verified-source' }];
      } });
    log.durableProjection({ projectionId: 'z-validation', reducerVersion: 1, inputs: { streams: ['control'] },
      reduce(envelope) {
        if (envelope.entries.some(entry => (entry.body as { validated?: boolean }).validated !== true)) throw Error('invalid proof');
        return [{ kind: 'put', key: 'verified', value: true }];
      } });
    const result = log.transactDurableProjection('a-dependent', async view => ({ kind: 'return', value: await view.get('result') }),
      { readProjectionIds: ['z-validation'] });
    if (valid) expect((await result).value).toBe('verified-source');
    else await expect(result).rejects.toThrow('invalid proof');
  } finally { await log.stopStorageMaintenance(); }
}, 30000);

it('reuses authenticated absence only within a recovery page and invalidates it on each committed delta', async () => {
  const root=await createTempDir('recovery-page-read'),artifacts=new FileArtifactStore(path.join(root,'artifacts'));
  const integrity=new AuthorityCacheIntegrity(Buffer.alloc(32,77));
  const writer=new FileAuthorityCommitLog(path.join(root,'log'),artifacts,{integrity});
  for(let n=1;n<=130;n++)await writer.append([{stream:'control',body:{n}}]);
  await writer.stopStorageMaintenance();
  const log=new FileAuthorityCommitLog(path.join(root,'log'),artifacts,{integrity});
  const reads=vi.spyOn(FileDurableProjectionIndex.prototype,'getMany');
  try {
    const index=log.durableProjection({projectionId:'page-counter',reducerVersion:1,authenticated:true,inputs:{streams:['control']},
      async reduce(envelope,current){
        const n=(envelope.entries[0]!.body as {n:number}).n;
        expect(await current.get('count')??0).toBe(n-1);
        expect(await current.get('always-absent')).toBeUndefined();
        expect(await current.get('flag')).toBe(n>31&&n<=65?true:undefined);
        return [{kind:'put' as const,key:'count',value:n},
          ...(n===31?[{kind:'put' as const,key:'flag',value:true}]:n===65?[{kind:'tombstone' as const,key:'flag'}]:[])];
      }});
    expect(await index.get('count')).toBe(130);
    const absentReads=reads.mock.calls.filter(([keys])=>keys.includes('always-absent')).length;
    expect(absentReads).toBeGreaterThanOrEqual(3);
    expect(absentReads).toBeLessThanOrEqual(5);
  } finally {reads.mockRestore();await log.stopStorageMaintenance();}
},30000);