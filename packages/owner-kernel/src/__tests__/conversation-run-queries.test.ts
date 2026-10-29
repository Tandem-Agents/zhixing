import { expect, it } from 'vitest';
import type { DurableProjectionReadContext } from '@zhixing/core/authority';
import type { JsonValue } from '@zhixing/core/contracts';
import { conversationStateBase as base, conversationStateFieldKey as fieldKey, conversationStateHash as hash,
  encodeConversationState as encode } from '../conversation-run-state-index.js';
import { readIndexedConversationAuthority, readIndexedPendingDispatch, readIndexedRecoveryAssignments, readIndexedPendingProjections } from '../conversation-run-queries.js';
const id='query-conversation';
// Selector fault/page boundaries. Actual authority, migration and CAS paths are
// covered separately by the journal and production-composition tests.
function fixture(){
 const rows=new Map<string,JsonValue>(), reads:string[]=[];
 const view:DurableProjectionReadContext={
  async get(key){reads.push(key);return rows.get(key);},
  async getMany(keys){reads.push(...keys);return keys.map(key=>rows.get(key));},
  async scan(range,limit){
   const selected=[...rows].filter(([key])=>(range.gt===undefined||key>range.gt)&&(range.gte===undefined||key>=range.gte)&&(range.lt===undefined||key<range.lt)).sort(([a],[b])=>a<b?-1:a>b?1:0);
   const entries=selected.slice(0,Math.min(7,limit)).map(([key,value])=>({key,value}));
   return {entries,...(selected.length>entries.length?{continuation:'another-page'}:{})};
  }
 };
 const field=(name:string,key:string,value:unknown)=>rows.set(fieldKey(id,name,key),{key,value:encode(value)});
 const obligation=(kind:string,key:string)=>rows.set(base(id)+'pending-'+kind+'/'+hash(key),key);
 const assignment=(a:string,r:string,state='running')=>{
  field('assignedById',a,{record:{t:'assigned',assignmentId:a,runId:r},capIds:new Set(['capability']),acked:false});
  field('assignmentByRun',r,a);field('stateByRun',r,{state});
 };
 return {rows,reads,view,field,obligation,assignment};
}
it('reads initial authority defaults and leaves legacy root compatibility explicit',async()=>{
 const h=fixture();expect(await readIndexedConversationAuthority(h.view,id)).toEqual({domainRevision:0,commitRevision:0,deleted:false,hasDurableIdentity:false,pendingLifecycleProjections:0});
 expect(h.reads).toHaveLength(1);
 h.rows.set(base(id)+'run-root',encode({domainRevision:4,deleted:false}));
 expect(await readIndexedConversationAuthority(h.view,id)).toBeUndefined();
});
it.each(['missing-state','queued-active','missing-assignment'])('rejects an incomplete active pointer before filtering dispatched: %s',async mode=>{
 const h=fixture();h.rows.set(base(id)+'root',{conversationId:id,version:1,activeRunId:'r'});h.assignment('a','r','dispatched');
 if(mode==='missing-state')h.rows.delete(fieldKey(id,'stateByRun','r'));
 if(mode==='queued-active')h.field('stateByRun','r',{state:'queued'});
 if(mode==='missing-assignment')h.rows.delete(fieldKey(id,'assignedById','a'));
 await expect(readIndexedPendingDispatch(h.view,id)).rejects.toThrow('Active run index has no durable assignment state');
});
it('returns only complete unacknowledged dispatches and detaches the result',async()=>{
 const h=fixture();h.rows.set(base(id)+'root',{conversationId:id,version:1,activeRunId:'r'});h.assignment('a','r','running');
 expect(await readIndexedPendingDispatch(h.view,id)).toBeUndefined();
 h.field('stateByRun','r',{state:'dispatched'});
 const first=(await readIndexedPendingDispatch(h.view,id))!;expect('capIds' in first).toBe(false);(first.record as {runId:string}).runId='changed';
 expect((await readIndexedPendingDispatch(h.view,id))!.record.runId).toBe('r');
 h.field('extra-closedAssignments','a',true);expect(await readIndexedPendingDispatch(h.view,id)).toBeUndefined();
});
it('keeps acknowledgement first when its recovery entry is superseded and closed',async()=>{
 const h=fixture();h.assignment('a','r','committed');h.obligation('recovery','a');h.obligation('ack','a');
 h.field('extra-committedByAssignment','a',{t:'committed',assignmentId:'a',runId:'r'});
 h.field('assignmentByRun','r','new-assignment');h.field('extra-superseded','a',{reason:'old'});h.field('extra-closedAssignments','a',true);
 expect((await readIndexedRecoveryAssignments(h.view,id)).map(x=>[x.assignmentId,x.state])).toEqual([['a','committed']]);
 h.field('bundleAcknowledgements','a',{observed:true});
 await expect(readIndexedRecoveryAssignments(h.view,id)).rejects.toThrow('Bundle acknowledgement outbox');
});
it.each(['run','assignment'])('rejects a mismatched acknowledgement %s instead of silently filtering its obligation',async mismatch=>{
 const h=fixture();h.assignment('a','r','committed');h.obligation('ack','a');
 h.field('extra-committedByAssignment','a',{t:'committed',assignmentId:mismatch==='assignment'?'different':'a',runId:mismatch==='run'?'different':'r'});
 await expect(readIndexedRecoveryAssignments(h.view,id)).rejects.toThrow('Bundle acknowledgement outbox');
});
it('keeps not-started and exact containment evidence in ordinary recovery filtering',async()=>{
 const h=fixture();h.assignment('a','r');h.obligation('recovery','a');
 h.field('extra-rejectedNotStarted','a\0cancel',{proof:true});expect(await readIndexedRecoveryAssignments(h.view,id)).toEqual([]);
 h.rows.delete(fieldKey(id,'extra-rejectedNotStarted','a\0cancel'));
 h.field('resolutionsByRun','r',{openFactDigest:'known-fact'});h.field('extra-containedFacts','known-fact',true);
 expect(await readIndexedRecoveryAssignments(h.view,id)).toEqual([]);
 h.rows.delete(fieldKey(id,'extra-containedFacts','known-fact'));
 expect((await readIndexedRecoveryAssignments(h.view,id)).map(x=>x.assignmentId)).toEqual(['a']);
});
it('returns every current obligation beyond 32 across multiple pages',async()=>{
 const h=fixture();
 for(let n=0;n<35;n++){
  const a='a-'+n,r='r-'+n;h.assignment(a,r);h.obligation('recovery',a);h.obligation('commit',a);
  h.field('extra-committedByAssignment',a,{t:'committed',assignmentId:a,runId:r,commitRevision:n+1});
 }
 expect(new Set((await readIndexedRecoveryAssignments(h.view,id)).map(x=>x.assignmentId)).size).toBe(35);
 expect(new Set((await readIndexedPendingProjections(h.view,id)).map(x=>x.assignmentId)).size).toBe(35);
});
it('rejects dangling recovery and projection directories',async()=>{
 const h=fixture();h.obligation('recovery','missing');h.obligation('commit','missing');
 await expect(readIndexedRecoveryAssignments(h.view,id)).rejects.toThrow('Recovery outbox');
 await expect(readIndexedPendingProjections(h.view,id)).rejects.toThrow('Commit projection outbox');
});