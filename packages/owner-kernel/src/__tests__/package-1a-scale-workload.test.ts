import type { LogRecordPort } from '@zhixing/core/authority';
import { currentMaintenanceUrgency, runInMaintenanceContext, runDetachedMaintenanceContext } from '@zhixing/core/resources';
import { AuthorityWorkObserver } from '../../../core/src/authority/logging.js';
import { open } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createTempDir } from '@zhixing/test-utils';
import path from 'node:path';
import { describe, expect, it, vi, onTestFinished, afterAll } from 'vitest';
import * as runViews from '../conversation-run-state-view.js';
import { registerConversationReadProjection } from '../conversation-read-index.js';
import { BASE_CONVERSATION, BASE_NOW, BASE_TRANSFER, baseVerifier, createConversationBaseHarness } from './conversation-base-harness.js';

/**
 * Package 1a workload boundary, measured on a real cold storage instance.
 *
 * The previous instance is stopped and a NEW Authority log is opened over the
 * same root; the existing Authority work observation (`options.records` → `work`
 * records: scans, readBytes, preparedFrames, …) is installed before the first
 * read. The cold open, the current/recovery reads, the first send and the
 * save/stop are measured, not just API call counts.
 */

type Work = { operations: number; scans: number; readBytes: number; preparedFrames: number; executionMs: number; physicalReadBytes: number; physicalWriteBytes: number; physicalWrites: number; materializations: number; materializedRuns: number; materializedAssignments: number; segmentEntryProbes: number; otherReadBytes: number; maxSegmentReadRequest: number };
const emptyWork = (): Work => ({ operations: 0, scans: 0, readBytes: 0, preparedFrames: 0, executionMs: 0, physicalReadBytes: 0, physicalWriteBytes: 0, physicalWrites: 0, materializations: 0, materializedRuns: 0, materializedAssignments: 0, segmentEntryProbes: 0, otherReadBytes: 0, maxSegmentReadRequest: 0 });

async function workCapture(root: string) {
  // Instrument actual FileHandle I/O, including projection pages/checkpoints.
  // This is a test-only counter; nested writeFile/write calls count once.
  const probe = await open(path.join(root, 'io-probe'), 'w');
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const paths = new WeakMap<object, string>();
  const io = new Map<string, { read: number; write: number; reads: number; writes: number }>();
  const openFile = fs.open;
  const opened = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await openFile(...args);
    paths.set(handle, path.relative(root, String(args[0])).replaceAll('\\', '/'));
    return handle;
  });
  syncBuiltinESMExports();

  const physical = { physicalReadBytes: 0, physicalWriteBytes: 0, physicalWrites: 0, materializations: 0, materializedRuns: 0, materializedAssignments: 0, segmentEntryProbes: 0, otherReadBytes: 0, maxSegmentReadRequest: 0 };
  const depth = new WeakMap<object, number>();
  const spies = ['read', 'readv', 'readFile', 'write', 'writev', 'writeFile', 'appendFile'].map(method => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(async function(this: object, ...args: any[]) {
      const nested = depth.get(this) ?? 0; depth.set(this, nested + 1);
      try {
        const result = await original.apply(this, args);
        if (!nested) {
          const file = paths.get(this) ?? '<unmapped>';
          const value = io.get(file) ?? { read: 0, write: 0, reads: 0, writes: 0 };
          if (method.startsWith('read')) {
            const bytes = result?.bytesRead ?? Buffer.byteLength(result);
            physical.physicalReadBytes += bytes; value.read += bytes; value.reads++;
            if (file.endsWith('.offsets')) physical.segmentEntryProbes += bytes / 8;
            else if (file.endsWith('.data')) {
              const requested = method === 'read' ? (typeof args[2] === 'number' ? args[2] : args[0]?.length ?? bytes) : bytes;
              physical.maxSegmentReadRequest = Math.max(physical.maxSegmentReadRequest, requested);
            } else physical.otherReadBytes += bytes;

          } else {
            const bytes = result?.bytesWritten ?? Buffer.byteLength(args[0]);
            physical.physicalWrites++; physical.physicalWriteBytes += bytes; value.write += bytes; value.writes++;
          }
          io.set(file, value);
        }
        return result;
      } finally { depth.set(this, nested); }
    });
  });
  const prepare = runViews.prepareConversationRunView;
  const materialized = vi.spyOn(runViews, 'prepareConversationRunView').mockImplementation(async (...args) => {
    const result = await prepare(...args);
    physical.materializations++;
    physical.materializedRuns += result.state.admittedByRun.size;
    physical.materializedAssignments += result.state.assignedById.size;
    return result;
  });
  onTestFinished(() => { spies.forEach(spy => spy.mockRestore()); materialized.mockRestore(); opened.mockRestore(); syncBuiltinESMExports(); });
  const buckets: { operation: string; data: Record<string, number> }[] = [];
  const foreground: typeof buckets = [], background: typeof buckets = [];
  const begin = AuthorityWorkObserver.prototype.begin;
  const observe = vi.spyOn(AuthorityWorkObserver.prototype, 'begin').mockImplementation(function(operation) {
    // A detached retirement pump may finish during the measurement's log
    // settling interval. Attribute at operation entry, before log aggregation
    // merges foreground and background work with the same checkpoint name.
    const target = currentMaintenanceUrgency() === 'background' ? background : foreground;
    const observed = begin.call(this, operation), finish = observed.finish;
    let finished = false;
    observed.finish = (...failure) => {
      finish(...failure);
      if (finished) return;
      finished = true;
      target.push({ operation, data: { ...observed.data, operations: 1 } });
    };
    return observed;
  });
  onTestFinished(() => observe.mockRestore());
  const port: LogRecordPort = { record: entry => {
    const record = entry as { event?: string; data?: Record<string, number> };
    if (record.event !== 'work') return;
    buckets.push({ operation: String(record.data?.operation ?? ''), data: record.data ?? {} });
  } };
  const aggregate = (list: { operation: string; data: Record<string, number> }[]): Work => {
    const result = emptyWork();
    for (const bucket of list) {
      result.operations += bucket.data.operations ?? 0;
      for (const key of Object.keys(result) as (keyof Work)[]) if (key !== 'operations') result[key] += Math.round(bucket.data[key] ?? 0);
    }
    return result;
  };
  return { port, mark: () => ({ bucket: buckets.length, foregroundBucket: foreground.length, backgroundBucket: background.length,
    io: new Map([...io].map(([key, value]) => [key, { ...value }])), ...physical }), since: (from: { bucket: number; foregroundBucket: number; backgroundBucket: number; io: typeof io } & typeof physical) => ({
    offsetIo: [...io].filter(([file]) => file.endsWith('.offsets')).map(([file, value]) => ({ file,
      bytes: value.read - (from.io.get(file)?.read ?? 0), calls: value.reads - (from.io.get(file)?.reads ?? 0) })).filter(item => item.calls),
    workByOperation: Object.fromEntries([...new Set(buckets.slice(from.bucket).map(item => item.operation))].map(name =>
      [name, buckets.slice(from.bucket).filter(item => item.operation === name).reduce((total, item) => total + (item.data.operations ?? 0), 0)])),
    io: [...io].map(([file, value]) => ({ file, read: value.read - (from.io.get(file)?.read ?? 0), write: value.write - (from.io.get(file)?.write ?? 0), reads: value.reads - (from.io.get(file)?.reads ?? 0), writes: value.writes - (from.io.get(file)?.writes ?? 0) })).filter(value => value.read || value.write).sort((a,b) => b.read - a.read).slice(0, 12),
    backgroundWork: aggregate(background.slice(from.backgroundBucket)),
    ...aggregate(foreground.slice(from.foregroundBucket)), physicalReadBytes: physical.physicalReadBytes - from.physicalReadBytes,
    physicalWriteBytes: physical.physicalWriteBytes - from.physicalWriteBytes, physicalWrites: physical.physicalWrites - from.physicalWrites,
    segmentEntryProbes: physical.segmentEntryProbes - from.segmentEntryProbes, otherReadBytes: physical.otherReadBytes - from.otherReadBytes, maxSegmentReadRequest: physical.maxSegmentReadRequest,
    materializations: physical.materializations - from.materializations, materializedRuns: physical.materializedRuns - from.materializedRuns, materializedAssignments: physical.materializedAssignments - from.materializedAssignments,
  }) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 1200));

async function admitContinuation(journal: { admit: (input: never) => Promise<unknown> }, runId: string, position: number, parent: string) {
  await journal.admit({ runId, ingressKey: runId, queuedPosition: position,
    userInput: { parts: [{ type: 'text', text: runId }] }, invocation: { kind: 'agent', source: 'interactive' },
    ingress: { kind: 'first-party', surfacePrincipal: 'rpc:fixture', deviceId: 'fixture-device', ingressId: runId, receivedAt: BASE_NOW,
      turnOrigin: { channel: 'rpc', worksceneContinuation: { kind: 'task', conversationId: BASE_CONVERSATION, runId: parent } } } } as never);
}

/** Ended history: plain ended runs plus ended delegations with real parents. */
async function seedEndedHistory(harness: Awaited<ReturnType<typeof createConversationBaseHarness>>, size: number) {
  for (let index = 0; index < size; index += 1) {
    await harness.admit(harness.sourceJournal, `ended-${index}`, index * 2);
    await admitContinuation(harness.sourceJournal as never, `child-${index}`, index * 2 + 1, `ended-${index}`);
    await harness.sourceJournal.cancelRun({ runId: `child-${index}`, requestId: `cancel-child-${index}` });
    await harness.sourceJournal.cancelRun({ runId: `ended-${index}`, requestId: `cancel-ended-${index}` });
  }
  await harness.admit(harness.sourceJournal, 'current', size * 2);
}

const measurements = new Map<string, Map<number, Record<string, Work>>>();
function remember(mode: string, size: number, phases: Record<string, Work>) {
  const scales = measurements.get(mode) ?? new Map(); scales.set(size, phases); measurements.set(mode, scales);
}
afterAll(() => {
  for (const [mode, scales] of measurements) {
    const small = scales.get(32), large = scales.get(128); if (!small || !large) continue;
    for (const phase of ['coldCurrent', 'recovery', 'firstSend', 'continuation', 'saveStop']) {
      for (const metric of ['operations', 'scans', 'preparedFrames', 'materializations', 'materializedRuns', 'materializedAssignments'] as const)
        expect(large[phase]![metric], `${mode}/${phase}/${metric}`).toBeLessThanOrEqual(small[phase]![metric] * 1.5 + 8);
      // Actual bytes include existing 64 KiB segment read-ahead. A short segment
      // returns fewer bytes at EOF than a full segment for the same bounded
      // lookup. Compare probes and non-segment reads; separately enforce the
      // fixed physical request bound and keep raw bytes in the evidence.
      expect(large[phase]!.segmentEntryProbes, `${mode}/${phase}/segmentEntryProbes`).toBeLessThanOrEqual(small[phase]!.segmentEntryProbes * 1.5 + 32);
      expect(large[phase]!.maxSegmentReadRequest).toBeLessThanOrEqual(64 * 1024);
      for (const metric of ['readBytes', 'otherReadBytes', 'physicalWriteBytes'] as const)
        expect(large[phase]![metric], `${mode}/${phase}/${metric}`).toBeLessThanOrEqual(small[phase]![metric] * 1.5 + 256 * 1024);
    }
  }
});

it('attributes physical observation to the opened synthetic file', async () => {
  const root = await createTempDir('scale-io-observation'), work = await workCapture(root);
  const mark = work.mark(), handle = await open(path.join(root, 'verified-io'), 'w+');
  await handle.writeFile(Buffer.alloc(37)); await handle.read(Buffer.alloc(37), 0, 37, 0); await handle.close();
  const observed = work.since(mark);
  expect(observed.io).toEqual([{ file: 'verified-io', read: 37, write: 37, reads: 1, writes: 1 }]);
});

describe('package 1a cold-storage workload boundary', () => {
  it('keeps explicit foreground work and detached maintenance separately visible', async () => {
    const root = await createTempDir('work-attribution'), work = await workCapture(root), before = work.mark();
    const observer = new AuthorityWorkObserver(work.port, () => 'attribution-test');
    await runInMaintenanceContext('foreground', async () => {
      observer.begin('readProjection').finish();
      await runDetachedMaintenanceContext('background', async () => observer.begin('projection.checkpoint').finish());
    });
    observer.flush();
    const measured = work.since(before);
    expect(measured.operations).toBe(1);
    expect(measured.backgroundWork.operations).toBe(1);
    expect(measured.workByOperation).toEqual({ readProjection: 1, 'projection.checkpoint': 1 });
  });

  it.each([32, 128])('native cold open, first send and save stay bounded with %i ended runs', async size => runInMaintenanceContext('foreground', async () => {
    const harness = await createConversationBaseHarness();
    await seedEndedHistory(harness, size);
    await harness.source.log.stopStorageMaintenance();
    await harness.target.log.stopStorageMaintenance();

    // Brand-new storage instance; observation is installed before any read.
    const work = await workCapture(harness.root);
    const cold = harness.reopen('source', work.port);
    const index = registerConversationReadProjection(cold.log, cold.artifacts, baseVerifier);
    const scan = index.scan.bind(index);
    let continuationScanRows = 0;
    vi.spyOn(index, 'scan').mockImplementation(async (...args: never[]) => {
      const page = await scan(...args);
      continuationScanRows += page.entries.length;
      return page;
    });
    const journal = harness.journal('source', cold);

    let at = work.mark();
    expect(await journal.runState('current')).toBe('queued');
    await settle();
    const coldCurrent = work.since(at);
    expect(coldCurrent.operations).toBeGreaterThan(0);

    at = work.mark();
    await journal.pendingInputs();
    await settle();
    const recovery = work.since(at);

    at = work.mark();
    const writer = harness.journal('source', cold);
    const beforeSend = await cold.log.checkpoint();
    await writer.admit({ runId: 'first-send', ingressKey: 'first-send', queuedPosition: size * 2 + 1,
      userInput: { parts: [{ type: 'text', text: 'first-send' }] }, invocation: { kind: 'agent', source: 'interactive' },
      ingress: { kind: 'first-party', surfacePrincipal: 'rpc:fixture', deviceId: 'fixture-device', ingressId: 'first-send', receivedAt: BASE_NOW } });
    expect(await writer.runState('first-send')).toBe('queued');
    const afterSend = await cold.log.checkpoint();
    expect(afterSend.lsn).toBeGreaterThan(beforeSend.lsn);
    await settle();
    const firstSend = work.since(at);

    continuationScanRows = 0;
    at = work.mark();
    const sources = await journal.worksceneContinuationSources();
    await settle();
    const continuation = { rows: continuationScanRows, ...work.since(at) };

    at = work.mark();
    await cold.log.checkpoint();
    await cold.log.stopStorageMaintenance();
    await settle();
    const saveStop = work.since(at);
    remember('native', size, { coldCurrent, recovery, firstSend, saveStop, continuation });
    console.log(JSON.stringify({ size, mode: 'native', endedHistory: size * 2 + 1, sources: sources.length,
      coldCurrent, recovery, firstSend, saveStop, continuation, beforeSend, afterSend }));

    // 本地会话（无导入基底）冷打开只按索引读取当前事实，不再整体物化执行工作集；恢复与首发仍各准备一次，
    // 说明计量钩子在工作
    expect(coldCurrent.materializations).toBe(0);
    expect(coldCurrent.readBytes).toBeGreaterThan(0);
    expect(recovery.materializations + firstSend.materializations).toBeGreaterThan(0);
    // Current/recovery/first-send/save must not walk the ended history.
    for (const phase of [coldCurrent, recovery, firstSend, saveStop]) {
      expect(phase.scans).toBeLessThanOrEqual(64);
      expect(phase.preparedFrames).toBeLessThanOrEqual(64);
      expect(phase.readBytes).toBeLessThanOrEqual(512 * 1024);
    }
    // The reproduced regression must be rejected: ended delegations never enter
    // the current candidate enumeration, at either scale.
    expect(firstSend.physicalWriteBytes).toBeGreaterThan(0);
    expect(sources).toHaveLength(0);
    expect(continuation.rows).toBeLessThanOrEqual(8);
  }), 900_000);

  it.each([32, 128])('imported cold open, first send and save stay bounded with %i ended runs', async size => runInMaintenanceContext('foreground', async () => {
    const harness = await createConversationBaseHarness();
    await seedEndedHistory(harness, size);
    await harness.transfer();
    await harness.target.log.stopStorageMaintenance();
    await harness.source.log.stopStorageMaintenance();

    const work = await workCapture(harness.root);
    const cold = harness.reopen('target', work.port);
    const owner = harness.journal('target', cold);
    const importer = harness.makeImporter(cold, owner);
    // Rebinding a committed base occurs on ordinary reopen and is included
    // in coldCurrent, even when the immutable seed is already prepared.
    let at = work.mark();
    const publication = await importer.committedBaseSource(BASE_TRANSFER);
    await owner.installImportedBase(publication.source);
    await settle();
    const importRebind = work.since(at);

    const index = registerConversationReadProjection(cold.log, cold.artifacts, baseVerifier);
    const scan = index.scan.bind(index); let continuationScanRows = 0;
    const scanProbe = vi.spyOn(index, 'scan').mockImplementation(async (...args) => { const page = await scan(...args); continuationScanRows += page.entries.length; return page; });
    onTestFinished(() => scanProbe.mockRestore());
    expect(await owner.runState('current')).toBe('queued');
    await settle();
    const coldCurrent = work.since(at);

    at = work.mark();
    await owner.pendingInputs();
    await settle();
    const recovery = work.since(at);

    at = work.mark();
    const beforeSend = await cold.log.checkpoint();
    await harness.admit(owner, 'first-send-target', size * 2 + 1);
    expect(await owner.runState('first-send-target')).toBe('queued');
    const afterSend = await cold.log.checkpoint();
    expect(afterSend.lsn).toBeGreaterThan(beforeSend.lsn);
    await settle();
    const firstSend = work.since(at);

    continuationScanRows = 0; at = work.mark();
    const sources = await owner.worksceneContinuationSources();
    await settle();
    const continuation = { rows: continuationScanRows, ...work.since(at) };
    expect(sources).toHaveLength(0); expect(continuation.rows).toBe(0);

    at = work.mark();
    await cold.log.checkpoint();
    await cold.log.stopStorageMaintenance();
    await settle();
    const saveStop = work.since(at);

    remember('imported', size, { coldCurrent, recovery, firstSend, saveStop, continuation });
    console.log(JSON.stringify({ size, mode: 'imported', endedHistory: size * 2 + 1,
      importRebind, coldCurrent, recovery, firstSend, saveStop, continuation, beforeSend, afterSend }));

    expect(importRebind.operations).toBeGreaterThan(0);
    expect(coldCurrent.materializations).toBeGreaterThan(0);
    expect(firstSend.physicalWriteBytes).toBeGreaterThan(0);
    for (const phase of [coldCurrent, recovery, firstSend, saveStop]) {
      expect(phase.scans).toBeLessThanOrEqual(64);
      expect(phase.preparedFrames).toBeLessThanOrEqual(64);
      expect(phase.readBytes).toBeLessThanOrEqual(512 * 1024);
    }
  }), 900_000);
});
