import { afterEach, expect, it, vi } from "vitest";
import { StorageMaintenanceAdmissionError, isHoldingMaintenanceExclusion, runHoldingMaintenanceExclusion } from "@zhixing/core/resources";
import { retryControlAdmission } from "../conversation-admission-retry.js";
afterEach(()=>vi.useRealTimers());
const pressure=()=>new StorageMaintenanceAdmissionError({kind:"backpressured",blockedBy:"probe-unavailable",retryAfterMs:10});
it("recovers only outside exclusion then retries the same caller", async()=>{
  const failure=pressure(); let calls=0;
  const recover=vi.fn(async()=>{expect(isHoldingMaintenanceExclusion()).toBe(false)});
  expect(await retryControlAdmission(async()=>{if(++calls===1)throw failure; return 7},recover)).toBe(7);
  expect(calls).toBe(2); expect(recover).toHaveBeenCalledOnce();
});
it("bounds persistent pressure and honors cancellation without another attempt", async()=>{
  vi.useFakeTimers();
  const failure=pressure(); const operation=vi.fn(async()=>{throw failure});
  const pending=retryControlAdmission(operation,async()=>{});
  const rejected=expect(pending).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(5010); await rejected;
  const abort=new AbortController();
  const cancel=retryControlAdmission(operation,async()=>{},abort.signal);
  const cancelled=expect(cancel).rejects.toThrow("cancelled");
  abort.abort(); await vi.advanceTimersByTimeAsync(1); await cancelled;
});
it("does not wait on permanent failures or while holding exclusion", async()=>{
  const failure=pressure(); const recover=vi.fn(async()=>{});
  await expect(runHoldingMaintenanceExclusion(()=>retryControlAdmission(async()=>{throw failure},recover))).rejects.toBe(failure);
  const gap=new StorageMaintenanceAdmissionError({kind:"capacity-gap",blockedBy:"memoryReservationBytes"} as never);
  await expect(retryControlAdmission(async()=>{throw gap},recover)).rejects.toBe(gap);
  expect(recover).not.toHaveBeenCalled();
});

it("recovers a cold external control envelope after lookup pressure using real storage", async()=>{
  const {createTempDir}=await import("@zhixing/test-utils");
  const {FileArtifactStore,FileAuthorityCommitLog}=await import("@zhixing/core/authority");
  const {ControlAdmissionJournal,createInitialControlEnvelope}=await import("@zhixing/owner-kernel/control-admission");
  const {join}=await import("node:path");
  const root=await createTempDir("cold-control-admission");
  const artifacts=new FileArtifactStore(join(root,"artifacts"));
  const log=new FileAuthorityCommitLog(join(root,"authority"),artifacts);
  const source={principal:{surfacePrincipal:"rpc:owner",deviceId:"device-1",connectionId:"connection-1"},
    ingress:{kind:"first-party" as const,surfacePrincipal:"rpc:owner",deviceId:"device-1",ingressId:"large-input",receivedAt:new Date().toISOString()}};
  const envelope=createInitialControlEnvelope({requestId:"large-input",source,at:source.ingress.receivedAt,
    body:{t:"input",conversationId:"conversation-large",ingress:{ingressId:"large-input",source:"first-party"},input:{parts:[{type:"text",text:"x".repeat(40*1024)}]},invocation:{kind:"agent",source:"interactive"},ownerEpoch:1}});
  const first=new ControlAdmissionJournal(log,artifacts);
  await expect(first.apply({source,envelope,prepare:()=>{throw Error("after receipt")}})).rejects.toThrow("after receipt");
  const cold=new ControlAdmissionJournal(log,artifacts);
  const get=artifacts.get.bind(artifacts); let pressured=false;
  const snapshots=vi.spyOn(log,"readSnapshot");
  const spy=vi.spyOn(artifacts,"get").mockImplementation(async(...args)=>{
    if(!pressured&&isHoldingMaintenanceExclusion()){pressured=true;throw pressure()}
    return get(...args);
  });
  try {
    const result=await retryControlAdmission(()=>cold.lookup({source,envelope}),async()=>{
      expect(isHoldingMaintenanceExclusion()).toBe(false);
      await cold.prepareRecovery();
    });
    expect(result.kind).toBe("received-pending"); expect(pressured).toBe(true);
    expect(snapshots).not.toHaveBeenCalled();
    expect((await log.readStream("control")).filter(record=>(record.body as {t:string}).t==="received")).toHaveLength(1);
  } finally {spy.mockRestore();snapshots.mockRestore();await log.stopStorageMaintenance()}
},20000);

it.each(["cancel","deadline"] as const)("does not start a new attempt after recovery crosses %s",async(mode)=>{
  vi.useFakeTimers();
  const signal=new AbortController(); const failure=pressure();
  const operation=vi.fn(async()=>{if(operation.mock.calls.length===1)throw failure;return 1});
  const pending=retryControlAdmission(operation,async()=>{
    if(mode==="cancel")signal.abort(); else await new Promise(resolve=>setTimeout(resolve,5100));
  },signal.signal);
  const rejected=mode==="cancel"?expect(pending).rejects.toThrow("cancelled"):expect(pending).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(5200);await rejected;
  expect(operation).toHaveBeenCalledOnce();
});
