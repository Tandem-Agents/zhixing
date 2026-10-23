import {createDurableProjectionOverlay,type AuthorityCommitLog,type ArtifactStore,type DurableProjectionDefinition,type DurableProjectionMutation} from '@zhixing/core/authority';
import type {JsonValue,ArtifactRef} from '@zhixing/core/contracts';
import {CONVERSATION_RUN_STATE_PROJECTION_ID} from './conversation-run-state-index.js';
import {foldConversationBaseBindings,conversationViewAt,preserveBaseDeletions,registerConversationBaseRepair,conversationBaseUnavailableKey,conversationBaseRepairRequired,conversationBaseKey,type ConversationBaseBinding} from './conversation-base-registry.js';
import {isConversationSourceEvidenceError} from './conversation-base-source.js';
import type { DurableProjectionReadContext } from '@zhixing/core/authority';
import type { AdvancementControlEvent, AdvancementSession, AdvancementReviewAttempt } from '@zhixing/core/advancement';
import { loadCommittedBundleBinding, type ConversationFactGroup } from './conversation-assignment.js';
import type { TranscriptRunRecord } from '@zhixing/core/contracts';
import { hasPendingWorksceneTask } from '@zhixing/core/workscene/application';
import { conversationStateKeyHash as hash } from './conversation-state-key.js';
import { partitionedDecisionReducer, decisionSeedAtSource, decisionStartAtSource } from './conversation-decision-partitions.js';

// This directory folds only advancement obligations. Canonical run validation
// remains a required dependency at the same source prefix; the rows locate work
// and never replace the session or accepted run fact.
export const advancementRecoveryPrefix = (id: string) => 'conversation/' + hash(id) + '/advancement-recovery/';
export const advancementPendingPrefix = 'advancement-pending/';
const ordinal = (n: number) => String(n).padStart(16, '0');
interface Root { head?: string; headOrder?: string; active?: string; original: number; cleanup: number; epoch: number; deleted?: boolean }
interface Session { status: AdvancementSession['status']; createdAt: string; originalPending: boolean; direct?: boolean; originalRunId?: string; lower?: number; proxy?: string; evidence: Record<string,string>; rebuild?: string }
export interface AdvancementCleanupWork { sessionId: string; attempt: AdvancementReviewAttempt }
export interface AdvancementRunWork { runId: string; runIndex: number }
const emptyRoot = (): Root => ({ original: 0, cleanup: 0, epoch: 0 });
export async function advancementRecoveryRoot(view: DurableProjectionReadContext, id: string): Promise<Root> {
  return await view.get(advancementRecoveryPrefix(id) + 'root') as unknown as Root | undefined ?? emptyRoot();
}
export async function advancementRecoveryHead(view: DurableProjectionReadContext, id: string): Promise<string | undefined> {
  const root = await advancementRecoveryRoot(view, id);
  return root.active ?? root.head;
}
export async function advancementPendingRun(view: DurableProjectionReadContext, id: string, sessionId: string, before?: number): Promise<AdvancementRunWork | null | undefined> {
  const p = advancementRecoveryPrefix(id), root = await advancementRecoveryRoot(view, id);
  if (root.deleted) return;
  const session = await view.get(p + 'session/' + hash(sessionId)) as unknown as Session | undefined;
  if (!session || session.status !== 'active') return;
  if (session.originalRunId && session.lower === undefined) return null;
  const runs = p + 'runs/' + root.epoch + '/' + hash(sessionId) + '/';
  const page = await view.scan({ gte: runs + ordinal(session.lower ?? 0), lt: before === undefined ? runs + '\uffff' : runs + ordinal(before) }, 1);
  return page.entries[0]?.value as unknown as AdvancementRunWork | undefined;
}
export async function publishAdvancementPending(view: DurableProjectionReadContext, id: string, put: (key: string, value: unknown) => void, drop: (key: string) => void): Promise<void> {
  const p = advancementRecoveryPrefix(id), root = await advancementRecoveryRoot(view, id);
  const active = root.active && !root.deleted ? await view.get(p + 'session/' + hash(root.active)) as unknown as Session | undefined : undefined;
  const work = root.cleanup > 0 || !root.deleted && (root.original > 0 || active &&
    (active.proxy || Object.keys(active.evidence).length || active.rebuild || !!await advancementPendingRun(view, id, root.active!)));
  const key = advancementPendingPrefix + hash(id);
  if (work) put(key, id); else drop(key);
}

export async function foldAdvancementRecovery(input: {
  id: string; view: DurableProjectionReadContext; put(key: string, value: unknown): void; drop(key: string): void;
  event?: AdvancementControlEvent; committed?: { runId: string; record: Omit<TranscriptRunRecord, 'messages'> }; lifecycle?: 'clear' | 'delete';
}): Promise<void> {
  const {id,view,put,drop,event}=input,p=advancementRecoveryPrefix(id);
  if(event?.type==='submission_settled')return;
  if (!event && await view.get(p+'root')===undefined) return;
  const root=await advancementRecoveryRoot(view,id);
  if(input.committed&&(!root.active||root.deleted))return;
  const sessionKey=(sid:string)=>p+'session/'+hash(sid);
  const runKey=(sid:string,index:number)=>p+'runs/'+root.epoch+'/'+hash(sid)+'/'+ordinal(index);
  const original=(s:Session)=>s.originalPending&&(s.status==='active'||s.status==='cancelled'&&s.direct===true);
  if(input.lifecycle){root.epoch++;if(input.lifecycle==='delete')root.deleted=true;}
  if(event){
    const sid=event.sessionId,key=sessionKey(sid),prior=await view.get(key) as unknown as Session|undefined;
    let s:Session=prior?structuredClone(prior):{status:'awaiting-rubric-confirmation',createdAt:event.timestamp,originalPending:false,evidence:{}};
    if(!prior&&event.type!=='session_created')throw new TypeError('Advancement pending state has no creation fact');
    const wasOriginal=prior?original(prior):false;
    switch(event.type){
      case 'session_created':break;
      case 'rubric_confirmed':s.status='active';s.originalPending=true;s.direct=false;break;
      case 'original_task_directed':s.status='cancelled';s.originalPending=true;s.direct=true;break;
      case 'original_task_admission_rejected':s.status='cancelled';s.originalPending=false;break;
      case 'original_task_admitted': {
        s.originalPending=false;s.originalRunId=event.runId;
        const index=await view.get(p+'committed/'+hash(event.runId));if(typeof index==='number')s.lower=index;break;
      }
      case 'run_reviewed': {
        drop(runKey(sid,event.review.runIndex));
        s.rebuild=event.review.decision==='failed'&&event.review.proxyMessageId&&!await view.get(p+'proxy/'+hash([sid,event.review.proxyMessageId]))?event.review.proxyMessageId:undefined;
        break;
      }
      case 'proxy_enqueued':s.proxy=event.proxyMessage.id;put(p+'proxy/'+hash([sid,event.proxyMessage.id]),true);if(s.rebuild===event.proxyMessage.id)delete s.rebuild;break;
      case 'proxy_settled':if(s.proxy===event.proxyMessageId)delete s.proxy;break;
      case 'evidence_requested':s.evidence[event.attempt.reviewId]=event.attempt.requestId;break;
      case 'evidence_settled':for(const [review,request]of Object.entries(s.evidence))if(request===event.requestId)delete s.evidence[review];break;
      case 'session_regenerated':case 'completed':case 'exited':case 'cancelled':
        s.status=event.type==='session_regenerated'?'exited':event.type;s.evidence={};delete s.proxy;delete s.rebuild;break;
    }
    if(!prior&&(!root.headOrder||s.createdAt>=root.headOrder)){root.head=sid;root.headOrder=s.createdAt;}
    const isOriginal=original(s);root.original+=Number(isOriginal)-Number(wasOriginal);
    if(isOriginal)put(p+'original/'+sid,sid);else drop(p+'original/'+sid);
    if(s.status==='active'||s.status==='awaiting-rubric-confirmation')root.active=sid;else if(root.active===sid)delete root.active;
    // Omit undefined DTO fields before publishing JSON index rows.
    put(key,JSON.parse(JSON.stringify(s)));
    if(event.type==='review_attempt_transitioned'||event.type==='review_root_settled'){
      const lineage=event.type==='review_root_settled'?event.lineageId:event.attempt.lineageId;
      const generation=event.type==='review_root_settled'?event.generation:event.attempt.generation;
      const workKey=p+'cleanup/'+hash([sid,lineage,generation]),previous=await view.get(workKey);
      if(event.type==='review_root_settled'){if(previous!==undefined){drop(workKey);root.cleanup--;}}
      else{put(workKey,{sessionId:sid,attempt:event.attempt});if(previous===undefined)root.cleanup++;}
    }
    if(event.type==='session_regenerated'){
      const next:Session={status:'awaiting-rubric-confirmation',createdAt:event.timestamp,originalPending:false,evidence:{}};
      put(sessionKey(event.nextSessionId),next);root.active=event.nextSessionId;
      if(!root.headOrder||next.createdAt>=root.headOrder){root.head=event.nextSessionId;root.headOrder=next.createdAt;}
    }
  }
  const commit=input.committed;
  if(commit&&root.active&&!root.deleted){
    const s=await view.get(sessionKey(root.active)) as unknown as Session|undefined,r=commit.record;
    if(s?.status==='active'){
      put(p+'committed/'+hash(commit.runId),r.runIndex);
      if(s.originalRunId===commit.runId)put(sessionKey(root.active),{...s,lower:r.runIndex});
      if(r.timestamp>=s.createdAt&&!hasPendingWorksceneTask(r as TranscriptRunRecord)&&
        (r.source===undefined||r.source==='interactive'||r.source==='channel'||r.source==='advancement'&&r.advancement?.sessionId===root.active&&!!r.advancement.proxyMessageId))
        put(runKey(root.active,r.runIndex),{runId:commit.runId,runIndex:r.runIndex});
    }
  }
  if(root.original<0||root.cleanup<0)throw new TypeError('Advancement obligation count is invalid');
  put(p+'root',root);await publishAdvancementPending(view,id,put,drop);
}

const registered=new WeakMap<AuthorityCommitLog,ReturnType<AuthorityCommitLog['durableProjection']>>();
const reducers=new WeakMap<AuthorityCommitLog,DurableProjectionDefinition['reduce']>();
/** 本日志是否已登记推进待办目录（分区迁移只处理已登记的决定状态投影）。 */
export function advancementRecoveryRegistered(log:AuthorityCommitLog):boolean{return registered.has(log);}
/** 迁移续算用：已登记的同一待办目录归约。 */
export function advancementRecoveryReducer(log:AuthorityCommitLog):DurableProjectionDefinition['reduce']{
  const reduce=reducers.get(log);if(!reduce)throw new TypeError('Advancement recovery projection is not registered');return reduce;
}
export const ADVANCEMENT_RECOVERY_PROJECTION_ID='advancement-recovery-v1';
export function registerAdvancementRecoveryProjection(log:AuthorityCommitLog,artifacts:ArtifactStore){
  const existing=registered.get(log);if(existing)return existing;
  const definition:DurableProjectionDefinition={projectionId:ADVANCEMENT_RECOVERY_PROJECTION_ID,reducerVersion:2,authenticated:true,
    inputs:{families:['run:','transfer:']},async reduce(envelope,current,source){
      // Canonical business legality is verified by the existing run projection.
      // A pending-only rebuild must not rehydrate unrelated run/assignment state.
      source.readPreparedProjection!(CONVERSATION_RUN_STATE_PROJECTION_ID);
      const changes=new Map<string,JsonValue|undefined>();
      await foldConversationBaseBindings(log,envelope.entries,current,changes,source);
      const view=createDurableProjectionOverlay(current,changes),put=(key:string,value:unknown)=>changes.set(key,value as JsonValue),drop=(key:string)=>changes.set(key,undefined);
      const touched=new Set<string>();
      for(const entry of envelope.entries){
        const body=entry.body as Record<string,unknown>;
        if(entry.stream.startsWith('transfer:')&&body.t==='conversation-transfer-committed-base'&&typeof body.conversationId==='string'){
          const id=body.conversationId;
          try{await publishAdvancementPending(await conversationViewAt(log,view,id,changes),id,put,drop);}
          catch(error){if(source.candidate||!isConversationSourceEvidenceError(error))throw error;put(conversationBaseUnavailableKey(id),true);put(advancementPendingPrefix+hash(id),id);}
          touched.add(id);continue;
        }
        if(!entry.stream.startsWith('run:'))continue;
        if(!['advancement-event','committed','session-lifecycle','session-meta'].includes(String(body.t)))continue;
        if(body.t==='session-meta'&&body.operation!=='delete')continue;
        const id=entry.stream.slice(4);
        if(await view.get(conversationBaseUnavailableKey(id))){if(source.candidate)throw conversationBaseRepairRequired(log,await view.get(conversationBaseKey(id)) as unknown as ConversationBaseBinding);continue;}
        const local=await conversationViewAt(log,view,id,changes);touched.add(id);
        if(body.t==='advancement-event'){
          const stored=body.event;
          const event=stored&&typeof stored==='object'&&'ref'in stored?JSON.parse(Buffer.from(await artifacts.get((stored as {ref:ArtifactRef}).ref)).toString('utf8')):stored;
          await foldAdvancementRecovery({id,view:local,put,drop,event:event as AdvancementControlEvent});
        }else if(body.t==='committed'){
          const root=await advancementRecoveryRoot(local,id);if(!root.active||root.deleted)continue;
          const binding=await loadCommittedBundleBinding(envelope as unknown as ConversationFactGroup,artifacts,candidate=>candidate.assignmentId===body.assignmentId);
          const record='metadata'in binding.closure?binding.closure.metadata:binding.closure.runRecord;
          await foldAdvancementRecovery({id,view:local,put,drop,committed:{runId:body.runId as string,record}});
        }else await foldAdvancementRecovery({id,view:local,put,drop,lifecycle:body.t==='session-meta'?'delete':body.mutation as 'clear'|'delete'});
      }
      for(const id of touched)await preserveBaseDeletions(log,view,id,changes);
      return [...changes].map(([key,value]):DurableProjectionMutation=>value===undefined?{kind:'tombstone',key}:{kind:'put',key,value});
    }};
  // 与 canonical 同一分区迁移：新版本从源头部以空状态就绪，会话在第一次读写前迁移。
  const index=log.durableProjection({...definition,startAtSource:decisionStartAtSource,seedAtSource:decisionSeedAtSource,reduce:partitionedDecisionReducer(log,definition.reduce as DurableProjectionDefinition<unknown>['reduce'])});reducers.set(log,definition.reduce);
  registered.set(log,index);registerConversationBaseRepair(log,ADVANCEMENT_RECOVERY_PROJECTION_ID,()=>index.rebuild());return index;
}
export async function readAdvancementRecovery<T>(log:AuthorityCommitLog,read:(view:DurableProjectionReadContext)=>Promise<T>):Promise<T>{
  return(await log.transactDurableProjection<never,T>(ADVANCEMENT_RECOVERY_PROJECTION_ID,async view=>({kind:'return',value:await read(view)}),{readProjectionIds:[CONVERSATION_RUN_STATE_PROJECTION_ID]})).value;
}
