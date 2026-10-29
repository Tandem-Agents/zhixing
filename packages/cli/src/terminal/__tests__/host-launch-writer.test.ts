import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyWindowsWriterGate } from './host-launch-writer-fixture.js';
const artifact=process.env.ZHIXING_FOREGROUND_NATIVE_TEST_ARTIFACT??fileURLToPath(new URL('../../../../terminal-ui/dist/win32-x64/foreground.node',import.meta.url));
const delayedRoot=fileURLToPath(new URL('../../../../terminal-ui/build/writer-deadline-tests/',import.meta.url));
const hasDelayedArtifacts=['after-resumed','before-resumed'].every(point=>existsSync(path.join(delayedRoot,point,'identity.json')));
const hash=(bytes: string|Buffer)=>createHash('sha256').update(bytes).digest('hex');

describe.skipIf(process.platform!=='win32')('production Windows filesystem gate',()=>{
  it('binds the suspended target, preserves private arguments, and fences cancellation, expiry and revocation',async()=>{
    await verifyWindowsWriterGate(artifact,['permit','cancel','expired','malformed','revoked','filesystem','powershell']);
  },30000);
  // Build with terminal-ui/scripts/build-writer-deadline-tests.mjs and the pinned
  // native compiler. No diagnostic pause or runtime switch enters production.
  it.skipIf(!hasDelayedArtifacts).each(['after-resumed','before-resumed'] as const)('keeps creation responsibility closed across %s descheduling',async point=>{
    const root=path.join(delayedRoot,point),identity=JSON.parse(await readFile(path.join(root,'identity.json'),'utf8'));
    expect(identity.point).toBe(point);
    expect(identity.sourceSha256).toBe(hash(await readFile(new URL('../../../../terminal-ui/native/exec-gate-win32.c',import.meta.url))));
    expect(identity.addonSha256).toBe(hash(await readFile(artifact)));
    expect(identity.gateSha256).toBe(hash(await readFile(path.join(root,'exec-gate.exe'))));
    await verifyWindowsWriterGate(path.join(root,'foreground.node'),['permit'],point==='before-resumed');
  },15000);
});