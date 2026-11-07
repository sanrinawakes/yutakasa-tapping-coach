import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openExternalSupportLedger, digest } from './external-support-ledger.mjs';
import { LOGIN_FAQ, isLoginFAQEvent, isPureThanksEvent } from './external-support-nocode.mjs';

const CLI = fileURLToPath(new URL('./external-support-ledger.mjs', import.meta.url));
const BASE = Date.parse('2026-11-07T12:00:00Z');
const SITE = 'https://yutakasa-tapping-coach.vercel.app/chat';
const REPO = 'https://github.com/sanrinawakes/yutakasa-tapping-coach';
const SOURCE = {kind:'gmail',accountId:'operator@example.com',scopeId:'approved-product-inbox'};
const CHATWORK_SOURCE = {kind:'chatwork',accountId:'synthetic-operator',scopeId:'synthetic-chatwork-room'};
const event = (extra={}) => {const e={source:SOURCE,sourceVerified:true,verifiedThreadId:'thread-1',immutableMessageId:'message-1',messageRevision:'1',sourceUpdatedAt:'2026-11-07T11:59:00Z',body:'private customer body',sender:{address:'customer@example.com'},attachments:[{id:'image-1',name:'private.jpg',mediaType:'image/jpeg'}],...extra};return {...e,recipient:extra.recipient??{kind:'gmail',address:'customer@example.com',threadId:e.verifiedThreadId}};};
function fixture(t, initial=event(), startTime=BASE){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'external-support-test-'));fs.chmodSync(dir,0o700);
  const config={dbPath:path.join(dir,'ledger.sqlite'),allowlist:[SOURCE,CHATWORK_SOURCE],allowedSites:[SITE,LOGIN_FAQ.siteUrl],repositoryUrl:REPO};
  let time=startTime;const ledger=openExternalSupportLedger({...config,now:()=>time});
  t.after(()=>{ledger.close();fs.rmSync(dir,{recursive:true,force:true});});
  const found=ledger.ingest(initial);let own={caseId:found.id,revision:1,owner:'owner-A'};
  ledger.claim({...own,leaseMs:900_000});
  return {dir,config,ledger,own,setTime:v=>{time=v;},getTime:()=>time};
}
function proof(f){
  const c=f.ledger.setCondition({...f.own,siteUrl:SITE,condition:'Safari and Chrome: question gets no assistant answer'});
  const {workId}=f.ledger.bindWork(f.own);
  const sha='a'.repeat(40);return {workId,caseId:f.own.caseId,revision:f.own.revision,siteUrl:SITE,conditionDigest:c.conditionDigest,productionSha:sha,deploymentId:'dpl_verified',prUrl:`${REPO}/pull/140`,prMergeSha:sha,ciRunUrl:`${REPO}/actions/runs/12345`,ciStatus:'success',ciSha:sha,dbVerified:true,reloadVerified:true,cleanupVerified:true,clientErrorCount:0,verifiedAt:new Date(BASE+1_200_000).toISOString(),observations:[0,600_000,1_200_000].map(offset=>({at:new Date(BASE+offset).toISOString(),success:true,workId,caseId:f.own.caseId,revision:f.own.revision,siteUrl:SITE,conditionDigest:c.conditionDigest,productionSha:sha,deploymentId:'dpl_verified',clientErrorCount:0}))};
}
function afterWindow(f){f.setTime(BASE+1_200_000);f.own.owner+='-next';f.ledger.claim({...f.own,leaseMs:900_000});}
const expectCode=(fn,code)=>assert.throws(fn,e=>e.code===code);
const completion=(f,extra={})=>f.ledger.reserveReply({...f.own,purpose:'completion',recipient:event().recipient,body:'The issue is fixed. Please resend your question.',...extra});

test('source allowlist is exact and immutable message plus revision dedupes',t=>{
  const f=fixture(t);const l=f.ledger;
  assert.equal(l.ingest(event()).duplicate,true);
  expectCode(()=>l.ingest(event({sourceVerified:false})),'UNVERIFIED_OR_FOREIGN_SOURCE');
  for(const source of [{...SOURCE,accountId:'other'},{...SOURCE,scopeId:'other'},{...SOURCE,kind:'chatwork'}])expectCode(()=>l.ingest(event({source})),'UNVERIFIED_OR_FOREIGN_SOURCE');
  expectCode(()=>l.ingest(event({body:'changed without a source revision'})),'MESSAGE_REVISION_CONFLICT');
  assert.equal(l.summary().total,1);
});

test('same text from another genuine thread never merges; thread reparenting is forbidden',t=>{
  const f=fixture(t);const second=f.ledger.ingest(event({verifiedThreadId:'thread-2',immutableMessageId:'message-2'}));
  assert.notEqual(second.id,f.own.caseId);
  expectCode(()=>f.ledger.ingest(event({verifiedThreadId:'thread-2',messageRevision:'2',sourceUpdatedAt:'2026-11-07T12:00:00Z'})),'MESSAGE_THREAD_MISMATCH');
});

test('CAS claims require current revision and a live exclusive owner',t=>{
  const f=fixture(t);
  expectCode(()=>f.ledger.claim({...f.own,owner:'owner-B'}),'LEASE_BUSY');
  expectCode(()=>f.ledger.transition({...f.own,owner:'owner-B',state:'investigating'}),'LEASE_REQUIRED');
  expectCode(()=>f.ledger.transition({...f.own,revision:2,state:'investigating'}),'STALE_REVISION');
  f.setTime(BASE+900_001);expectCode(()=>f.ledger.transition({...f.own,state:'investigating'}),'LEASE_REQUIRED');
  expectCode(()=>f.ledger.claim(f.own),'OWNER_REUSE_FORBIDDEN');
  assert.equal(f.ledger.claim({...f.own,owner:'owner-B'}).leaseOwner,'owner-B');
  expectCode(()=>f.ledger.transition({...f.own,state:'investigating'}),'LEASE_REQUIRED');
});

test('releaseClaim clears only the current private lease and preserves state, proof and unknown sends',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);f.ledger.markSending({...f.own,operationId:op.operationId});f.ledger.markUnknown({...f.own,operationId:op.operationId});
  const before=f.ledger.readCase({caseId:f.own.caseId});const released=f.ledger.releaseClaim(f.own);assert.equal(released.released,true);
  const saved=f.ledger.readCase({caseId:f.own.caseId});assert.equal(saved.leaseOwner,null);assert.equal(saved.leaseUntil,null);for(const key of ['state','revision','context','condition','evidence','outbox','resolutions','closures'])assert.deepEqual(saved[key],before[key]);
  const next={...f.own,owner:'release-next-owner'};f.ledger.claim(next);expectCode(()=>f.ledger.releaseClaim(f.own),'LEASE_OWNER_MISMATCH');expectCode(()=>completion({...f,own:next}),'UNCERTAIN_SEND_REQUIRES_RECONCILIATION');
});

test('releaseClaim fences wrong owner, stale revision and expired ownership taken by another worker',t=>{
  const f=fixture(t);expectCode(()=>f.ledger.releaseClaim({...f.own,owner:'foreign-owner'}),'LEASE_OWNER_MISMATCH');expectCode(()=>f.ledger.releaseClaim({...f.own,revision:99}),'STALE_REVISION');
  f.setTime(BASE+900_001);const next={...f.own,owner:'expired-lease-successor'};f.ledger.claim(next);expectCode(()=>f.ledger.releaseClaim(f.own),'LEASE_OWNER_MISMATCH');assert.equal(f.ledger.readCase({caseId:f.own.caseId}).leaseOwner,next.owner);
  assert.equal(f.ledger.releaseClaim(next).released,true);expectCode(()=>f.ledger.releaseClaim(next),'LEASE_OWNER_MISMATCH');
});

test('releaseClaim CLI returns anonymous handoff status without exposing owner or private context',t=>{
  const f=fixture(t);f.ledger.transition({...f.own,state:'observing'});const cfg=path.join(f.dir,'release-config.json');fs.writeFileSync(cfg,JSON.stringify(f.config),{mode:0o600});
  const r=runCli(cfg,f.config,{command:'releaseClaim',args:f.own});assert.equal(r.status,0,r.stdout);const value=JSON.parse(r.stdout);assert.equal(value.released,true);assert.equal(value.state,'observing');assert.equal(value.id,f.own.caseId);assert.ok(!r.stdout.includes(f.own.owner));assert.ok(!r.stdout.includes('customer@example.com'));assert.ok(!r.stdout.includes('private customer body'));
});

test('image attachments are inert evidence and do not force permanent manual handling',t=>{
  const f=fixture(t);assert.equal(f.ledger.readCase({caseId:f.own.caseId}).context.trust,'untrusted_customer_content');
  assert.equal(f.ledger.transition({...f.own,state:'investigating'}).state,'investigating');
});

test('decision/billing requests cannot auto execute or become completion ready',t=>{
  const f=fixture(t);const d=f.ledger.ingest(event({verifiedThreadId:'billing',immutableMessageId:'billing-1',decisionRequired:true}));
  assert.equal(d.state,'decision_required');expectCode(()=>f.ledger.claim({caseId:d.id,revision:1,owner:'worker'}),'CASE_NOT_ACTIONABLE');
  const b=f.ledger.ingest(event({verifiedThreadId:'refund',immutableMessageId:'refund-1',prohibitedActions:['refund']}));assert.equal(b.state,'decision_required');
  expectCode(()=>f.ledger.transition({...f.own,state:'sent'}),'GATED_STATE');
  expectCode(()=>f.ledger.transition({...f.own,state:'ready_to_reply'}),'GATED_STATE');
  expectCode(()=>f.ledger.reserveReply({...f.own,purpose:'progress',recipient:event().recipient,body:'We are investigating.'}),'PROGRESS_REPLY_FORBIDDEN');
});

test('one clarification reservation per exact revision, stable operation ID',t=>{
  const f=fixture(t);const args={...f.own,purpose:'clarification',recipient:event().recipient,body:'Please share the URL and failure time.',missingFields:['siteUrl','failureTime']};
  expectCode(()=>f.ledger.reserveReply({...args,missingFields:[]}),'MISSING_FIELDS_REQUIRED');
  const a=f.ledger.reserveReply(args);assert.equal(f.ledger.reserveReply(args).operationId,a.operationId);
  expectCode(()=>f.ledger.reserveReply({...args,body:'A second request'}),'REPLY_ALREADY_RESERVED_OR_SENT');
  f.ledger.markSending({...f.own,operationId:a.operationId});f.ledger.recordReceipt({...f.own,operationId:a.operationId,receipt:{operationId:a.operationId,messageId:'provider-clarification',sentAt:new Date(BASE).toISOString(),recipient:args.recipient,bodyHash:digest(args.body)}});
  assert.equal(f.ledger.summary({caseId:f.own.caseId}).state,'awaiting_info');
  f.own.owner+='-next';f.ledger.claim(f.own);expectCode(()=>f.ledger.reserveReply({...args,owner:f.own.owner}),'REPLY_ALREADY_RESERVED_OR_SENT');
});

test('completion requires exact case/site/customer-condition and release/functional evidence',t=>{
  const f=fixture(t);expectCode(()=>completion(f),'COMPLETION_NOT_READY');const p=proof(f);afterWindow(f);
  const invalid=[['caseId','case_foreign','EVIDENCE_BINDING_MISMATCH'],['revision',2,'EVIDENCE_BINDING_MISMATCH'],['siteUrl','https://other.example/chat','EVIDENCE_BINDING_MISMATCH'],['conditionDigest','b'.repeat(64),'EVIDENCE_BINDING_MISMATCH'],['ciStatus','failure','CI_PROOF_REQUIRED'],['ciSha','b'.repeat(40),'CI_PROOF_REQUIRED'],['prMergeSha','b'.repeat(40),'CI_PROOF_REQUIRED'],['prUrl','https://github.com/foreign/repo/pull/140','PR_PROOF_REQUIRED'],['ciRunUrl','https://github.com/foreign/repo/actions/runs/12345','CI_PROOF_REQUIRED'],['dbVerified',false,'FUNCTIONAL_PROOF_REQUIRED'],['reloadVerified',false,'FUNCTIONAL_PROOF_REQUIRED'],['cleanupVerified',false,'FUNCTIONAL_PROOF_REQUIRED'],['clientErrorCount',1,'FUNCTIONAL_PROOF_REQUIRED']];
  for(const [key,value,code] of invalid)expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:{...p,[key]:value}}),code);
  assert.equal(f.ledger.recordEvidence({...f.own,evidence:p}).state,'ready_to_reply');
  expectCode(()=>completion(f,{recipient:{address:'wrong@example.com'}}),'RECIPIENT_MISMATCH');
  assert.equal(completion(f).status,'reserved');
});

test('three success observations require 10 minute spacing across at least 20 minutes',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);
  expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:{...p,observations:p.observations.slice(0,2)}}),'OBSERVATIONS_REQUIRED');
  const failed=structuredClone(p);failed.observations[1].success=false;expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:failed}),'OBSERVATION_BINDING_MISMATCH');
  const quick=structuredClone(p);quick.observations[1].at=new Date(BASE+599_999).toISOString();expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:quick}),'OBSERVATION_INTERVAL_INVALID');
  const future=structuredClone(p);future.observations[2].at=new Date(BASE+1_200_001).toISOString();expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:future}),'OBSERVATION_INTERVAL_INVALID');
  const foreign=structuredClone(p);foreign.observations[2].deploymentId='dpl_foreign';expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:foreign}),'OBSERVATION_BINDING_MISMATCH');
});

test('new incoming revision invalidates release proof, condition and reply reservation',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);
  const next=f.ledger.ingest(event({immutableMessageId:'message-new',sourceUpdatedAt:'2026-11-07T12:19:00Z',body:'It still fails on a different URL'}));
  assert.equal(next.revision,2);assert.equal(next.state,'queued');const saved=f.ledger.readCase({caseId:next.id});assert.equal(saved.evidence,null);assert.equal(saved.condition,null);assert.equal(saved.outbox[0].status,'superseded');
  expectCode(()=>f.ledger.markSending({...f.own,operationId:op.operationId}),'STALE_REVISION');
  const own={...f.own,revision:2,owner:'owner-new-message'};f.ledger.claim(own);expectCode(()=>f.ledger.recordEvidence({...own,evidence:p}),'CONDITION_REQUIRED');
});

test('changing site/condition invalidates reserved completion even on same message revision',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);
  f.ledger.setCondition({...f.own,siteUrl:SITE,condition:'new browser or unregistered member condition'});
  expectCode(()=>f.ledger.markSending({...f.own,operationId:op.operationId}),'SEND_NOT_RESUMABLE');
  expectCode(()=>completion(f),'COMPLETION_NOT_READY');
  expectCode(()=>f.ledger.setCondition({...f.own,siteUrl:'https://foreign.example',condition:'x'}),'SITE_NOT_ALLOWED');
});

test('sending and unknown never auto resend, including lease crash recovery',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);
  f.ledger.markSending({...f.own,operationId:op.operationId});
  expectCode(()=>f.ledger.markSending({...f.own,operationId:op.operationId}),'SEND_NOT_RESUMABLE');
  f.ledger.markUnknown({...f.own,operationId:op.operationId});
  expectCode(()=>completion(f),'UNCERTAIN_SEND_REQUIRES_RECONCILIATION');
  const data=f.ledger.readCase({caseId:f.own.caseId});assert.equal(data.outbox[0].id,op.operationId);assert.equal(data.outbox[0].status,'unknown');
});

test('only exact receipt closes a send; completed case cannot be resent',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);f.ledger.markSending({...f.own,operationId:op.operationId});
  const receipt={operationId:op.operationId,messageId:'provider-sent-id',sentAt:new Date(f.getTime()).toISOString(),recipient:event().recipient,bodyHash:digest('The issue is fixed. Please resend your question.')};
  for(const extra of [{bodyHash:'wrong'},{operationId:'op_other'},{recipient:{address:'wrong@example.com'}}])expectCode(()=>f.ledger.recordReceipt({...f.own,operationId:op.operationId,receipt:{...receipt,...extra}}),'RECEIPT_BINDING_MISMATCH');
  assert.equal(f.ledger.recordReceipt({...f.own,operationId:op.operationId,receipt}).status,'sent');
  assert.equal(f.ledger.summary({caseId:f.own.caseId}).state,'sent');expectCode(()=>f.ledger.claim(f.own),'CASE_NOT_ACTIONABLE');
});

test('new customer input during an uncertain send remains recoverable without resend',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);f.ledger.markSending({...f.own,operationId:op.operationId});
  const n=f.ledger.ingest(event({immutableMessageId:'new',sourceUpdatedAt:'2026-11-07T12:19:00Z'}));assert.equal(n.state,'decision_required');const own={...f.own,revision:2,owner:'owner-reconcile'};
  f.ledger.claim({...own,purpose:'reconcile_receipt'});expectCode(()=>completion({...f,own}),'CASE_NOT_ACTIONABLE');
  const receipt={operationId:op.operationId,messageId:'old-send-id',sentAt:new Date(f.getTime()).toISOString(),recipient:event().recipient,bodyHash:digest('The issue is fixed. Please resend your question.')};
  assert.equal(f.ledger.recordReceipt({...own,operationId:op.operationId,receipt}).status,'sent');assert.equal(f.ledger.summary({caseId:n.id}).state,'decision_required');
});

test('private database/context/config modes and symlink protections are enforced',t=>{
  const f=fixture(t);assert.equal(fs.statSync(f.config.dbPath).mode&0o777,0o600);const output=path.join(f.dir,'context.json');f.ledger.exportContext({caseId:f.own.caseId,outputPath:output});assert.equal(fs.statSync(output).mode&0o777,0o600);assert.match(fs.readFileSync(output,'utf8'),/private customer body/);
  const link=path.join(f.dir,'link.sqlite');fs.symlinkSync(f.config.dbPath,link);expectCode(()=>openExternalSupportLedger({...f.config,dbPath:link}),'SYMLINK_FORBIDDEN');
  const exportLink=path.join(f.dir,'context-link.json');fs.symlinkSync(output,exportLink);expectCode(()=>f.ledger.exportContext({caseId:f.own.caseId,outputPath:exportLink}),'SYMLINK_FORBIDDEN');
  const publicDir=path.join(f.dir,'public');fs.mkdirSync(publicDir,{mode:0o755});expectCode(()=>openExternalSupportLedger({...f.config,dbPath:path.join(publicDir,'db.sqlite')}),'PRIVATE_MODE_REQUIRED');
  const unsafe=path.join(f.dir,'unsafe.sqlite');fs.writeFileSync(unsafe,'',{mode:0o644});expectCode(()=>openExternalSupportLedger({...f.config,dbPath:unsafe}),'PRIVATE_MODE_REQUIRED');
});

function runCli(configPath,config,input){return spawnSync(process.execPath,[CLI,'--db',config.dbPath,'--config',configPath],{input:JSON.stringify(input),encoding:'utf8'});}
test('CLI exposes anonymous IDs/states only and cannot print private context',t=>{
  const f=fixture(t);const configPath=path.join(f.dir,'config.json');fs.writeFileSync(configPath,JSON.stringify(f.config),{mode:0o600});
  const r=runCli(configPath,f.config,{command:'summary',args:{caseId:f.own.caseId}});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).id,f.own.caseId);assert.ok(!r.stdout.includes('customer@example.com'));assert.ok(!r.stdout.includes('private'));
  const forbidden=runCli(configPath,f.config,{command:'readCase',args:{caseId:f.own.caseId}});assert.equal(forbidden.status,1);assert.deepEqual(JSON.parse(forbidden.stdout),{error:'CLI_COMMAND_FORBIDDEN'});
  const changed=runCli(configPath,{...f.config,dbPath:path.join(f.dir,'foreign.sqlite')},{command:'summary'});assert.deepEqual(JSON.parse(changed.stdout),{error:'CONFIG_DATABASE_MISMATCH'});
});

test('two separate CLI workers race with exactly one successful CAS claim',async t=>{
  const f=fixture(t);const configPath=path.join(f.dir,'config.json');fs.writeFileSync(configPath,JSON.stringify(f.config),{mode:0o600});
  const id=f.ledger.ingest(event({immutableMessageId:'race',verifiedThreadId:'race'})).id;
  const run=owner=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[CLI,'--db',f.config.dbPath,'--config',configPath],{stdio:['pipe','pipe','pipe']});let out='';p.stdout.on('data',x=>out+=x);p.on('error',reject);p.on('close',code=>resolve({code,value:JSON.parse(out)}));p.stdin.end(JSON.stringify({command:'claim',args:{caseId:id,revision:1,owner}}));});
  const result=await Promise.all([run('process-A'),run('process-B')]);assert.equal(result.filter(x=>x.code===0).length,1);assert.equal(result.find(x=>x.code!==0).value.error,'LEASE_BUSY');
});

test('all private source revisions survive clarification answers and exports',t=>{
  const f=fixture(t);f.ledger.ingest(event({immutableMessageId:'answer',sourceUpdatedAt:'2026-11-07T12:00:00Z',body:'URL is example; original text must remain',attachments:[]}));
  const saved=f.ledger.readCase({caseId:f.own.caseId});assert.equal(saved.history.length,2);assert.equal(saved.history[0].body,'private customer body');assert.equal(saved.history[0].attachments[0].name,'private.jpg');assert.equal(saved.context.body,'URL is example; original text must remain');
});

test('recipient changes and decision gates remain sticky across further messages',t=>{
  const f=fixture(t);const x=f.ledger.ingest(event({immutableMessageId:'recipient-change',sourceUpdatedAt:'2026-11-07T12:00:00Z',recipient:{...event().recipient,address:'intruder@example.com'}}));assert.equal(x.state,'decision_required');
  const saved=f.ledger.readCase({caseId:x.id});assert.deepEqual(saved.context.recipient,event().recipient);assert.equal(saved.history.at(-1).recipient.address,'intruder@example.com');
  const n=f.ledger.ingest(event({immutableMessageId:'please-proceed',sourceUpdatedAt:'2026-11-07T12:00:00Z',decisionRequired:false}));assert.equal(n.state,'decision_required');
  expectCode(()=>f.ledger.claim({caseId:n.id,revision:n.revision,owner:'worker'}),'CASE_NOT_ACTIONABLE');
});

test('recipient source/thread structure and invalid calendar dates are rejected',t=>{
  const f=fixture(t);for(const recipient of [null,{kind:'gmail',address:'x',threadId:'foreign'},{kind:'chatwork',roomId:CHATWORK_SOURCE.scopeId,replyToMessageId:'1'}]){
    assert.throws(()=>f.ledger.ingest({...event({immutableMessageId:'bad'}),recipient}));
  }
  expectCode(()=>f.ledger.ingest(event({immutableMessageId:'badtime',sourceUpdatedAt:'2026-02-30T12:00:00Z'})),'INVALID_TIME');
});

test('unsent superseded completion can reserve a new stable operation after new proof',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const first=completion(f);
  f.ledger.recordEvidence({...f.own,evidence:{...p,ciRunUrl:`${REPO}/actions/runs/12346`}});const next=completion(f);assert.notEqual(next.operationId,first.operationId);assert.equal(completion(f).operationId,next.operationId);expectCode(()=>f.ledger.markSending({...f.own,operationId:first.operationId}),'SEND_NOT_RESUMABLE');
});

test('receipt after condition changed records actual send but cannot close the case',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);f.ledger.markSending({...f.own,operationId:op.operationId});
  f.ledger.setCondition({...f.own,siteUrl:SITE,condition:'Another specific failure condition'});
  f.ledger.recordReceipt({...f.own,operationId:op.operationId,receipt:{operationId:op.operationId,messageId:'old-binding-sent',sentAt:new Date(f.getTime()).toISOString(),recipient:event().recipient,bodyHash:digest('The issue is fixed. Please resend your question.')}});
  assert.equal(f.ledger.summary({caseId:f.own.caseId}).state,'decision_required');
});

test('historical clarification adoption is exact, single-use and never completion',t=>{
  const f=fixture(t);const body='Please share URL and failure time.';const args={...f.own,purpose:'clarification',source:SOURCE,sourceVerified:true,readBackVerified:true,verifiedThreadId:'thread-1',operationId:'previous-verified-operation',recipient:event().recipient,body,receipt:{operationId:'previous-verified-operation',messageId:'historical-clarify-id',sentAt:'2026-11-07T11:59:30Z',recipient:event().recipient,bodyHash:digest(body)}};
  expectCode(()=>f.ledger.adoptVerifiedReceipt({...args,purpose:'completion'}),'HISTORICAL_COMPLETION_FORBIDDEN');
  expectCode(()=>f.ledger.adoptVerifiedReceipt({...args,readBackVerified:false}),'ADOPTION_SOURCE_MISMATCH');
  expectCode(()=>f.ledger.adoptVerifiedReceipt({...args,source:{...SOURCE,accountId:'foreign'}}),'ADOPTION_SOURCE_MISMATCH');
  expectCode(()=>f.ledger.adoptVerifiedReceipt({...args,receipt:{...args.receipt,sentAt:'2026-11-07T11:58:00Z'}}),'ADOPTION_PREDATES_SOURCE');
  assert.equal(f.ledger.adoptVerifiedReceipt(args).status,'sent');assert.equal(f.ledger.adoptVerifiedReceipt(args).duplicate,true);
  expectCode(()=>f.ledger.reserveReply({...f.own,purpose:'clarification',body,recipient:args.recipient,missingFields:['siteUrl']}),'REPLY_ALREADY_RESERVED_OR_SENT');
  assert.equal(f.ledger.summary({caseId:f.own.caseId}).state,'awaiting_info');
  const other=f.ledger.ingest(event({verifiedThreadId:'other',immutableMessageId:'other'}));const own={caseId:other.id,revision:1,owner:'owner-B'};f.ledger.claim(own);
  expectCode(()=>f.ledger.adoptVerifiedReceipt({...args,...own,verifiedThreadId:'other',operationId:'another-op',recipient:{...event().recipient,threadId:'other'},receipt:{...args.receipt,operationId:'another-op',recipient:{...event().recipient,threadId:'other'}}}),'RECEIPT_MESSAGE_ALREADY_USED');
});

test('reply ancestry resolves only verified received IDs or actually sent receipt IDs',t=>{
  const f=fixture(t);assert.equal(f.ledger.resolveVerifiedThread({source:SOURCE,replyToMessageId:'message-1'}).verifiedThreadId,'thread-1');
  expectCode(()=>f.ledger.resolveVerifiedThread({source:SOURCE,replyToMessageId:'same body text'}),'VERIFIED_THREAD_NOT_FOUND');
  const args={...f.own,purpose:'clarification',recipient:event().recipient,body:'URL?',missingFields:['siteUrl']};const op=f.ledger.reserveReply(args);
  expectCode(()=>f.ledger.resolveVerifiedThread({source:SOURCE,replyToMessageId:op.operationId}),'VERIFIED_THREAD_NOT_FOUND');
  f.ledger.markSending({...f.own,operationId:op.operationId});f.ledger.recordReceipt({...f.own,operationId:op.operationId,receipt:{operationId:op.operationId,messageId:'sent-reply-id',sentAt:new Date(BASE).toISOString(),recipient:args.recipient,bodyHash:digest(args.body)}});
  assert.equal(f.ledger.resolveVerifiedThread({source:SOURCE,replyToMessageId:'sent-reply-id'}).caseId,f.own.caseId);
  expectCode(()=>f.ledger.resolveVerifiedThread({source:{...SOURCE,scopeId:'foreign'},replyToMessageId:'sent-reply-id'}),'UNVERIFIED_OR_FOREIGN_SOURCE');
});

test('identical evidence retry preserves stable reserved operation',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=completion(f);f.ledger.recordEvidence({...f.own,evidence:structuredClone(p)});assert.equal(completion(f).operationId,op.operationId);
});

test('clarification receipt does not erase a newly set decision-required state',t=>{
  const f=fixture(t);const args={...f.own,purpose:'clarification',recipient:event().recipient,body:'URL?',missingFields:['siteUrl']};const op=f.ledger.reserveReply(args);f.ledger.markSending({...f.own,operationId:op.operationId});f.ledger.transition({...f.own,state:'decision_required'});
  f.ledger.recordReceipt({...f.own,operationId:op.operationId,receipt:{operationId:op.operationId,messageId:'clarified-before-decision',sentAt:new Date(BASE).toISOString(),recipient:args.recipient,bodyHash:digest(args.body)}});assert.equal(f.ledger.summary({caseId:f.own.caseId}).state,'decision_required');
});

test('lookupEvent is scope bound; SQLite sidecar symlinks and unsafe configs are refused',t=>{
  const f=fixture(t);assert.equal(f.ledger.lookupEvent({source:SOURCE,immutableMessageId:'message-1',messageRevision:'1'}).body,'private customer body');assert.equal(f.ledger.lookupEvent({source:SOURCE,immutableMessageId:'other',messageRevision:'1'}),null);expectCode(()=>f.ledger.lookupEvent({source:{...SOURCE,scopeId:'foreign'},immutableMessageId:'message-1',messageRevision:'1'}),'UNVERIFIED_OR_FOREIGN_SOURCE');
  const target=path.join(f.dir,'sidecar.sqlite');fs.writeFileSync(target,'',{mode:0o600});fs.symlinkSync(f.config.dbPath,target+'-journal');expectCode(()=>openExternalSupportLedger({...f.config,dbPath:target}),'SYMLINK_FORBIDDEN');
  const cfg=path.join(f.dir,'unsafe-config.json');fs.writeFileSync(cfg,JSON.stringify(f.config),{mode:0o644});const r=runCli(cfg,f.config,{command:'summary'});assert.deepEqual(JSON.parse(r.stdout),{error:'PRIVATE_MODE_REQUIRED'});
  const r2=runCli(cfg,f.config,{command:'lookupEvent',args:{source:SOURCE,immutableMessageId:'message-1',messageRevision:'1'}});assert.equal(r2.status,1);
});

test('unverified source edits bind to the latest immutable revision and invalidate completion without inventing source time',t=>{
  const original=event({source:CHATWORK_SOURCE,sender:{accountId:'synthetic-client'},recipient:{kind:'chatwork',roomId:CHATWORK_SOURCE.scopeId,replyToMessageId:'thread-1'}});
  const f=fixture(t,original);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const reserved=completion(f,{recipient:original.recipient});
  const change={...original,messageRevision:'synthetic-unverified-edit-2',body:'豊かさBOTの発生条件を訂正します。',decisionRequired:true,sourceRevision:{kind:'observed_change_time_unverified',previousMessageRevision:'1'}};
  for(const patch of [
    {decisionRequired:false},{immutableMessageId:'not-observed-before'},
    {sourceRevision:{kind:'observed_change_time_unverified',previousMessageRevision:'not-the-latest'}},
    {sourceRevision:{...change.sourceRevision,forceReady:true}},
    {sourceRevision:{kind:'invented-provider-time',previousMessageRevision:'1'}},
  ])expectCode(()=>f.ledger.ingest({...change,...patch}),'UNVERIFIED_REVISION_BINDING_REQUIRED');
  const changed=f.ledger.ingest(change);assert.equal(changed.state,'decision_required');assert.equal(changed.revision,2);const saved=f.ledger.readCase({caseId:changed.id});
  assert.equal(saved.context.sourceUpdatedAt,original.sourceUpdatedAt);assert.equal(saved.condition,null);assert.equal(saved.evidence,null);assert.equal(saved.outbox[0].id,reserved.operationId);assert.equal(saved.outbox[0].status,'superseded');
  assert.equal(f.ledger.lookupLatestEvent({source:CHATWORK_SOURCE,immutableMessageId:original.immutableMessageId}).body,change.body);
  expectCode(()=>f.ledger.markSending({...f.own,operationId:reserved.operationId}),'STALE_REVISION');
  expectCode(()=>f.ledger.lookupLatestEvent({source:{...CHATWORK_SOURCE,scopeId:'foreign'},immutableMessageId:original.immutableMessageId}),'UNVERIFIED_OR_FOREIGN_SOURCE');
  const cfg=path.join(f.dir,'latest-event-config.json');fs.writeFileSync(cfg,JSON.stringify(f.config),{mode:0o600});const output=runCli(cfg,f.config,{command:'lookupLatestEvent',args:{source:CHATWORK_SOURCE,immutableMessageId:original.immutableMessageId}});assert.deepEqual(JSON.parse(output.stdout),{error:'CLI_COMMAND_FORBIDDEN'});
});

test('scan cursor records a bounded initial window and advances only through overlap',t=>{
  const f=fixture(t);assert.deepEqual(f.ledger.getScanCursor({source:SOURCE}),{checkedUntilMs:0,cursorRevision:0,checkedAtMs:null,coverageFromMs:null});
  const args={source:SOURCE,sourceVerified:true,expectedRevision:0,from:BASE-900_000,to:BASE,paginationComplete:true,sourceLoaded:true};const first=f.ledger.recordScanComplete(args);assert.equal(first.checkedUntilMs,BASE);assert.equal(first.coverageFromMs,BASE-900_000);assert.equal(first.cursorRevision,1);
  f.setTime(BASE+600_000);const next=f.ledger.recordScanComplete({...args,expectedRevision:1,from:new Date(BASE-300_000).toISOString(),to:new Date(BASE+600_000).toISOString()});assert.equal(next.checkedUntilMs,BASE+600_000);assert.equal(next.cursorRevision,2);
  expectCode(()=>f.ledger.recordScanComplete({...args,expectedRevision:1}),'STALE_SCAN_CURSOR');
});

test('failed, unread or paginated scans cannot turn zero matches into a healthy cursor',t=>{
  const f=fixture(t);const args={source:SOURCE,sourceVerified:true,expectedRevision:0,from:0,to:BASE,paginationComplete:true,sourceLoaded:true};
  for(const changed of [{sourceLoaded:false},{paginationComplete:false},{nextPageToken:'remaining-page'},{scanError:'unavailable'},{failed:true}])expectCode(()=>f.ledger.recordScanComplete({...args,...changed}),'INCOMPLETE_SOURCE_SCAN');
  assert.equal(f.ledger.getScanCursor({source:SOURCE}).cursorRevision,0);
  expectCode(()=>f.ledger.recordScanComplete({...args,sourceVerified:false}),'UNVERIFIED_OR_FOREIGN_SOURCE');
  expectCode(()=>f.ledger.recordScanComplete({...args,source:{...SOURCE,scopeId:'foreign'}}),'UNVERIFIED_OR_FOREIGN_SOURCE');
  expectCode(()=>f.ledger.getScanCursor({source:{...SOURCE,accountId:'foreign'}}),'UNVERIFIED_OR_FOREIGN_SOURCE');
});

test('scan cursor CAS refuses gaps, rollback, future or invalid windows and exposes no identity',t=>{
  const f=fixture(t);const args={source:SOURCE,sourceVerified:true,expectedRevision:0,from:0,to:BASE,paginationComplete:true,sourceLoaded:true};f.ledger.recordScanComplete(args);f.setTime(BASE+600_000);
  expectCode(()=>f.ledger.recordScanComplete({...args,expectedRevision:1,from:BASE+1,to:BASE+600_000}),'SCAN_GAP_OR_ROLLBACK');
  expectCode(()=>f.ledger.recordScanComplete({...args,expectedRevision:1,to:BASE-1}),'SCAN_GAP_OR_ROLLBACK');
  expectCode(()=>f.ledger.recordScanComplete({...args,expectedRevision:1,to:BASE+600_001}),'INVALID_SCAN_WINDOW');
  expectCode(()=>f.ledger.recordScanComplete({...args,expectedRevision:1,from:BASE+1,to:BASE}),'INVALID_SCAN_WINDOW');
  const cfg=path.join(f.dir,'cursor-config.json');fs.writeFileSync(cfg,JSON.stringify(f.config),{mode:0o600});const result=runCli(cfg,f.config,{command:'getScanCursor',args:{source:SOURCE}});assert.equal(result.status,0);const value=JSON.parse(result.stdout);assert.equal(value.cursorRevision,1);assert.ok(!result.stdout.includes('operator'));assert.ok(!result.stdout.includes('gmail'));assert.equal(value.checkedUntilMs,BASE);
});

test('known source thread lookup is exact, private and never text-merged',t=>{
  const f=fixture(t);assert.deepEqual(f.ledger.findVerifiedThread({source:SOURCE,verifiedThreadId:'thread-1'}),{caseId:f.own.caseId,verifiedThreadId:'thread-1'});assert.equal(f.ledger.findVerifiedThread({source:SOURCE,verifiedThreadId:'thread-unknown'}),null);assert.equal(f.ledger.findVerifiedThread({source:SOURCE,verifiedThreadId:'private customer body'}),null);
  expectCode(()=>f.ledger.findVerifiedThread({source:{...SOURCE,accountId:'foreign'},verifiedThreadId:'thread-1'}),'UNVERIFIED_OR_FOREIGN_SOURCE');
  const cfg=path.join(f.dir,'private-lookup-config.json');fs.writeFileSync(cfg,JSON.stringify(f.config),{mode:0o600});const result=runCli(cfg,f.config,{command:'findVerifiedThread',args:{source:SOURCE,verifiedThreadId:'thread-1'}});assert.equal(result.status,1);assert.deepEqual(JSON.parse(result.stdout),{error:'CLI_COMMAND_FORBIDDEN'});
});

test('random public work ID is stable for a private condition and rejects stale bindings',t=>{
  const f=fixture(t);expectCode(()=>f.ledger.bindWork(f.own),'CONDITION_REQUIRED');
  const p=proof(f);const binding=f.ledger.readWorkBinding({workId:p.workId});
  assert.match(binding.workId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(f.ledger.bindWork(f.own),binding);assert.equal(binding.caseId,f.own.caseId);assert.equal(binding.revision,1);assert.equal(binding.conditionDigest,p.conditionDigest);
  expectCode(()=>f.ledger.readWorkBinding({workId:'not-a-uuid'}),'INVALID_WORK_ID');
  expectCode(()=>f.ledger.readWorkBinding({workId:'11111111-1111-4111-8111-111111111111'}),'WORK_BINDING_NOT_FOUND');
  f.ledger.setCondition({...f.own,siteUrl:SITE,condition:'changed exact condition'});expectCode(()=>f.ledger.readWorkBinding({workId:p.workId}),'STALE_WORK_BINDING');
  const changed=f.ledger.bindWork(f.own);assert.notEqual(changed.workId,p.workId);
  f.ledger.setCondition({...f.own,siteUrl:SITE,condition:'Safari and Chrome: question gets no assistant answer'});expectCode(()=>f.ledger.readWorkBinding({workId:p.workId}),'STALE_WORK_BINDING');
  const returned=f.ledger.bindWork(f.own);assert.notEqual(returned.workId,p.workId);assert.equal(returned.conditionDigest,p.conditionDigest);expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:p}),'WORK_BINDING_MISMATCH');
  f.ledger.setCondition({...f.own,siteUrl:SITE,condition:'Safari and Chrome: question gets no assistant answer'});assert.equal(f.ledger.bindWork(f.own).workId,returned.workId);
  f.ledger.ingest(event({immutableMessageId:'new-source-work',sourceUpdatedAt:'2026-11-07T12:00:00Z'}));expectCode(()=>f.ledger.readWorkBinding({workId:returned.workId}),'STALE_WORK_BINDING');
});

test('completion evidence requires the exact locally bound work ID and keeps mapping off CLI',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);
  expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:{...p,workId:undefined}}),'WORK_BINDING_REQUIRED');
  expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:{...p,workId:'11111111-1111-4111-8111-111111111111'}}),'WORK_BINDING_MISMATCH');
  expectCode(()=>f.ledger.recordEvidence({...f.own,evidence:{...p,observations:p.observations.map((o,i)=>i===2?{...o,workId:'11111111-1111-4111-8111-111111111111'}:o)}}),'OBSERVATION_BINDING_MISMATCH');
  const cfg=path.join(f.dir,'work-config.json');fs.writeFileSync(cfg,JSON.stringify(f.config),{mode:0o600});
  const newCase=JSON.parse(runCli(cfg,f.config,{command:'ingest',args:event({verifiedThreadId:'cli-work-thread',immutableMessageId:'cli-work-source',sourceUpdatedAt:'2026-01-01T00:00:00Z'})}).stdout);const cliOwn={caseId:newCase.id,revision:1,owner:'cli-work-owner'};
  assert.equal(runCli(cfg,f.config,{command:'claim',args:cliOwn}).status,0);
  const conditionOutput=runCli(cfg,f.config,{command:'setCondition',args:{...cliOwn,siteUrl:SITE,condition:'specific private test condition'}});assert.equal(conditionOutput.status,0);assert.equal(conditionOutput.stdout.includes('conditionDigest'),false);assert.equal(conditionOutput.stdout.includes(SITE),false);
  const result=runCli(cfg,f.config,{command:'bindWork',args:cliOwn});assert.equal(result.status,0,result.stdout);assert.deepEqual(Object.keys(JSON.parse(result.stdout)),['workId']);assert.equal(result.stdout.includes(SITE),false);assert.equal(result.stdout.includes(p.conditionDigest),false);
  const read=runCli(cfg,f.config,{command:'readWorkBinding',args:{workId:p.workId}});assert.equal(read.status,1);assert.deepEqual(JSON.parse(read.stdout),{error:'CLI_COMMAND_FORBIDDEN'});
});

const faqEvent = (extra={}) => event({body:'豊かさBOTのログインURLを教えてください。',attachments:[],...extra});
function guidanceProof(f){
  const condition=f.ledger.setCondition({...f.own,siteUrl:LOGIN_FAQ.siteUrl,condition:LOGIN_FAQ.condition});
  const sourceHistoryDigest=f.ledger.readCase({caseId:f.own.caseId}).sourceHistoryDigest;
  const exact={caseId:f.own.caseId,revision:f.own.revision,siteUrl:LOGIN_FAQ.siteUrl,conditionDigest:condition.conditionDigest,sourceHistoryDigest,productionSha:'a'.repeat(40),deploymentId:'dpl_synthetic123'};
  const at=new Date(f.getTime()).toISOString();
  return {...exact,kind:LOGIN_FAQ.id,verifiedAt:at,currentProduction:{productionSha:exact.productionSha,deploymentId:exact.deploymentId,observedAt:at,readBackVerified:true},flow:{...exact,flowId:LOGIN_FAQ.flowId,dedicatedSyntheticUserVerified:true,syntheticUserId:'synthetic-test-user',loginVerified:true,botAnswerVerified:true,dbVerified:true,reloadVerified:true,cleanupVerified:true,clientErrorCount:0,observedAt:at}};
}
function sendFinal(f,purpose,body){
  const op=f.ledger.reserveReply({...f.own,purpose,body,recipient:event().recipient});
  f.ledger.markSending({...f.own,operationId:op.operationId});
  f.ledger.recordReceipt({...f.own,operationId:op.operationId,receipt:{operationId:op.operationId,messageId:`synthetic-receipt-${purpose}`,sentAt:new Date(f.getTime()).toISOString(),recipient:event().recipient,bodyHash:digest(body)}});
  return op;
}
function newAck(f, extra={}){
  f.setTime(f.getTime()+1000);const message=event({immutableMessageId:'ack-1',body:'ありがとうございます。',attachments:[],sourceUpdatedAt:new Date(f.getTime()).toISOString(),...extra});
  const next=f.ledger.ingest(message);f.own={caseId:next.id,revision:next.revision,owner:`ack-owner-${next.revision}`};f.ledger.claim(f.own);
  return message;
}
const ackArgs=(f,op,messages)=>({...f.own,referenceOperationId:op.operationId,sourceHistoryDigest:f.ledger.readCase({caseId:f.own.caseId}).sourceHistoryDigest,callerReviewedOriginals:true,callerApprovedAckClose:true,acknowledgedMessages:messages.map(m=>({immutableMessageId:m.immutableMessageId,messageRevision:m.messageRevision}))});

test('no-code vocabulary is whole-body only and cannot turn failures, quotes or attachments into FAQ/thanks',()=>{
  assert.equal(isLoginFAQEvent(faqEvent()),true);
  assert.equal(isLoginFAQEvent(faqEvent({body:'豊かさbotのログインurlはどこですか？'})),true);
  for(const body of ['ログインできません。豊かさBOTのログインURLを教えてください。','豊かさBOTが緑のアイコンのままです。','Enterで送信されます。','> 豊かさBOTのログインURLを教えてください。','豊かさBOTのログインURLを教えてください。返金して。'])assert.equal(isLoginFAQEvent(faqEvent({body})),false);
  assert.equal(isLoginFAQEvent(faqEvent({attachments:[{id:'image'}]})),false);
  assert.equal(isLoginFAQEvent(faqEvent({subject:'豊かさBOTが停止しました'})),false);
  for(const body of ['ありがとうございます。まだ回答がありません。','ありがとうございます。別件です。','> ありがとうございます。','ありがとうございます。\nSent from my iPhone'])assert.equal(isPureThanksEvent(event({body,attachments:[]})),false);
  assert.equal(isPureThanksEvent(event({body:'ありがとうございました！',attachments:[]})),true);
});

test('fixed FAQ has its own final route, exact functional proof, stable send and private receipt snapshot',t=>{
  const f=fixture(t,faqEvent());const e=guidanceProof(f);assert.equal(f.ledger.recordGuidanceEvidence({...f.own,evidence:e}).state,'ready_to_reply');
  const args={...f.own,purpose:'guidance_final',recipient:event().recipient,body:LOGIN_FAQ.body};
  expectCode(()=>f.ledger.reserveReply({...args,body:'The bot is fixed.'}),'GUIDANCE_TEMPLATE_MISMATCH');
  expectCode(()=>completion(f),'WORK_BINDING_REQUIRED');
  const first=f.ledger.reserveReply(args);assert.equal(f.ledger.reserveReply(args).operationId,first.operationId);
  const op=sendFinal(f,'guidance_final',LOGIN_FAQ.body);assert.equal(op.operationId,first.operationId);
  const saved=f.ledger.readCase({caseId:f.own.caseId});assert.equal(saved.state,'sent');assert.equal(saved.resolutions.length,1);assert.equal(saved.resolutions[0].purpose,'guidance_final');
  expectCode(()=>f.ledger.claim({...f.own,owner:'resend'}),'CASE_NOT_ACTIONABLE');
});

test('pure FAQ cannot enter technical bindWork and still retains its dedicated guidance route',t=>{
  const f=fixture(t,faqEvent());const evidence=guidanceProof(f);
  expectCode(()=>f.ledger.bindWork(f.own),'FAQ_REQUIRES_GUIDANCE_ROUTE');
  assert.equal(f.ledger.recordGuidanceEvidence({...f.own,evidence}).state,'ready_to_reply');
});

test('generic smoke, wrong release/binding, incomplete synthetic flow or stale production cannot close FAQ',t=>{
  const f=fixture(t,faqEvent());const e=guidanceProof(f);
  for(const [patch,code] of [
    [{kind:'generic-smoke'},'GUIDANCE_EVIDENCE_BINDING_MISMATCH'],[{revision:2},'GUIDANCE_EVIDENCE_BINDING_MISMATCH'],[{sourceHistoryDigest:'b'.repeat(64)},'GUIDANCE_EVIDENCE_BINDING_MISMATCH'],
    [{productionSha:'not-a-sha'},'GUIDANCE_RELEASE_PROOF_REQUIRED'],[{deploymentId:'unknown'},'GUIDANCE_RELEASE_PROOF_REQUIRED'],
    [{flow:{...e.flow,loginVerified:false}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],[{flow:{...e.flow,botAnswerVerified:false}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],
    [{flow:{...e.flow,dbVerified:false}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],[{flow:{...e.flow,reloadVerified:false}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],
    [{flow:{...e.flow,cleanupVerified:false}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],[{flow:{...e.flow,clientErrorCount:1}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],
    [{flow:{...e.flow,dedicatedSyntheticUserVerified:false}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],[{flow:{...e.flow,sourceHistoryDigest:'b'.repeat(64)}},'GUIDANCE_FUNCTIONAL_PROOF_REQUIRED'],
    [{currentProduction:{...e.currentProduction,deploymentId:'dpl_another123'}},'GUIDANCE_CURRENT_PRODUCTION_REQUIRED'],
  ])expectCode(()=>f.ledger.recordGuidanceEvidence({...f.own,evidence:{...e,...patch}}),code);
  f.ledger.recordGuidanceEvidence({...f.own,evidence:e});const op=f.ledger.reserveReply({...f.own,purpose:'guidance_final',recipient:event().recipient,body:LOGIN_FAQ.body});
  f.setTime(BASE+300_001);expectCode(()=>f.ledger.markSending({...f.own,operationId:op.operationId}),'GUIDANCE_CURRENT_PRODUCTION_REQUIRED');
});

test('old or edited bug history and prior technical work can never be downgraded into URL guidance',t=>{
  const f=fixture(t,event({body:'豊かさBOTが緑のアイコンで止まります。',attachments:[]}));
  const changed=f.ledger.ingest(faqEvent({messageRevision:'2',sourceUpdatedAt:new Date(BASE).toISOString()}));f.own={caseId:changed.id,revision:changed.revision,owner:'faq-after-bug'};f.ledger.claim(f.own);
  const e=guidanceProof(f);expectCode(()=>f.ledger.recordGuidanceEvidence({...f.own,evidence:e}),'GUIDANCE_HISTORY_NOT_PURE_FAQ');
  const pure=fixture(t,faqEvent());pure.ledger.setCondition({...pure.own,siteUrl:SITE,condition:'Owner is investigating a real failure'});const second=guidanceProof(pure);expectCode(()=>pure.ledger.recordGuidanceEvidence({...pure.own,evidence:second}),'GUIDANCE_TECHNICAL_CASE_FORBIDDEN');
  const decision=fixture(t,faqEvent());decision.ledger.transition({...decision.own,state:'decision_required'});expectCode(()=>guidanceProof(decision),'CASE_NOT_ACTIONABLE');
  const restored=fixture(t,faqEvent());const old=guidanceProof(restored);restored.ledger.setCondition({...restored.own,siteUrl:SITE,condition:'Different technical condition'});guidanceProof(restored);expectCode(()=>restored.ledger.recordGuidanceEvidence({...restored.own,evidence:old}),'GUIDANCE_TECHNICAL_CASE_FORBIDDEN');
});

test('new FAQ revision invalidates no-code evidence and reserved reply without permitting stale send',t=>{
  const f=fixture(t,faqEvent());const e=guidanceProof(f);f.ledger.recordGuidanceEvidence({...f.own,evidence:e});const op=f.ledger.reserveReply({...f.own,purpose:'guidance_final',recipient:event().recipient,body:LOGIN_FAQ.body});
  const n=f.ledger.ingest(faqEvent({immutableMessageId:'faq-new',sourceUpdatedAt:new Date(BASE).toISOString()}));f.own={caseId:n.id,revision:n.revision,owner:'new-faq-owner'};f.ledger.claim(f.own);
  f.ledger.setCondition({...f.own,siteUrl:LOGIN_FAQ.siteUrl,condition:LOGIN_FAQ.condition});expectCode(()=>f.ledger.recordGuidanceEvidence({...f.own,evidence:e}),'GUIDANCE_EVIDENCE_BINDING_MISMATCH');expectCode(()=>f.ledger.markSending({...f.own,operationId:op.operationId}),'OPERATION_BINDING_MISMATCH');
});

test('pure thanks after actual technical completion closes with no new send, is idempotent, and new question reopens',t=>{
  const f=fixture(t);const p=proof(f);afterWindow(f);f.ledger.recordEvidence({...f.own,evidence:p});const op=sendFinal(f,'completion','The issue is fixed. Please resend your question.');
  const message=newAck(f);const args=ackArgs(f,op,[message]);const before=f.ledger.readCase({caseId:f.own.caseId}).outbox.length;
  const closed=f.ledger.ack_close(args);assert.equal(closed.state,'closed');assert.equal(closed.closeReason,'ack_only');assert.equal(f.ledger.ack_close(args).duplicate,true);
  const saved=f.ledger.readCase({caseId:f.own.caseId});assert.equal(saved.outbox.length,before);assert.equal(saved.closures[0].reason,'ack_only');expectCode(()=>f.ledger.claim({...f.own,owner:'closed-worker'}),'CASE_NOT_ACTIONABLE');
  f.setTime(f.getTime()+1000);const next=f.ledger.ingest(event({immutableMessageId:'new-question',sourceUpdatedAt:new Date(f.getTime()).toISOString(),body:'別件です。新しい不具合があります。',attachments:[]}));assert.equal(next.state,'queued');expectCode(()=>f.ledger.ack_close({...args,revision:next.revision}),'ACK_HISTORY_MISMATCH');
});

test('FAQ final also supports exact pure-thanks close and repeated thanks need only new uncovered IDs',t=>{
  const f=fixture(t,faqEvent());f.ledger.recordGuidanceEvidence({...f.own,evidence:guidanceProof(f)});const op=sendFinal(f,'guidance_final',LOGIN_FAQ.body);
  const first=newAck(f);f.ledger.ack_close(ackArgs(f,op,[first]));const second=newAck(f,{immutableMessageId:'ack-2'});assert.equal(f.ledger.ack_close(ackArgs(f,op,[second])).state,'closed');assert.equal(f.ledger.readCase({caseId:f.own.caseId}).closures.length,2);
});

test('ack close requires exact actual final receipt, caller review, entire source revision coverage and no new issue',t=>{
  const f=fixture(t,faqEvent());f.ledger.recordGuidanceEvidence({...f.own,evidence:guidanceProof(f)});const op=sendFinal(f,'guidance_final',LOGIN_FAQ.body);const one=newAck(f);
  let args=ackArgs(f,op,[one]);expectCode(()=>f.ledger.ack_close({...args,callerReviewedOriginals:false}),'ACK_CALLER_REVIEW_REQUIRED');expectCode(()=>f.ledger.ack_close({...args,referenceOperationId:'foreign-op'}),'ACK_FINAL_RECEIPT_REQUIRED');expectCode(()=>f.ledger.ack_close({...args,sourceHistoryDigest:'b'.repeat(64)}),'ACK_HISTORY_MISMATCH');
  const two=newAck(f,{immutableMessageId:'ack-2'});args=ackArgs(f,op,[one]);expectCode(()=>f.ledger.ack_close(args),'ACK_MESSAGE_COVERAGE_REQUIRED');
  expectCode(()=>f.ledger.ack_close({...ackArgs(f,op,[one,two]),acknowledgedMessages:[...args.acknowledgedMessages,...args.acknowledgedMessages]}),'ACK_MESSAGE_COVERAGE_REQUIRED');
  const bad=newAck(f,{immutableMessageId:'new-failure',body:'ありがとうございます。まだ回答が出ません。'});expectCode(()=>f.ledger.ack_close(ackArgs(f,op,[one,two,bad])),'ACK_NOT_PURE_THANKS');
});

test('no final send, unknown send, new attachment, quoted prose or changed subject cannot become ack-only',t=>{
  const none=fixture(t,event({body:'ありがとうございます。',attachments:[]}));expectCode(()=>none.ledger.ack_close(ackArgs(none,{operationId:'none'},[event()])),'ACK_FINAL_RECEIPT_REQUIRED');
  for(const extra of [{body:'> ありがとうございます。'},{attachments:[{id:'new-image'}]},{subject:'新しい不具合について'}]){
    const f=fixture(t,faqEvent());f.ledger.recordGuidanceEvidence({...f.own,evidence:guidanceProof(f)});const op=sendFinal(f,'guidance_final',LOGIN_FAQ.body);const message=newAck(f,extra);expectCode(()=>f.ledger.ack_close(ackArgs(f,op,[message])),'ACK_NOT_PURE_THANKS');
  }
  const f=fixture(t,faqEvent());f.ledger.recordGuidanceEvidence({...f.own,evidence:guidanceProof(f)});const op=sendFinal(f,'guidance_final',LOGIN_FAQ.body);const message=newAck(f);const clarify=f.ledger.reserveReply({...f.own,purpose:'clarification',recipient:event().recipient,body:'Synthetic clarification',missingFields:['synthetic-field']});f.ledger.markSending({...f.own,operationId:clarify.operationId});f.ledger.markUnknown({...f.own,operationId:clarify.operationId});expectCode(()=>f.ledger.ack_close(ackArgs(f,op,[message])),'ACK_UNFINISHED_SEND');
});

test('ack close rejects another author, edited new questions, and a clarification receipt as final proof',t=>{
  const other=fixture(t,faqEvent());other.ledger.recordGuidanceEvidence({...other.own,evidence:guidanceProof(other)});const sent=sendFinal(other,'guidance_final',LOGIN_FAQ.body);const foreign=newAck(other,{sender:{address:'another@example.invalid'}});expectCode(()=>other.ledger.ack_close(ackArgs(other,sent,[foreign])),'ACK_AUTHOR_MISMATCH');
  const edited=fixture(t,faqEvent());edited.ledger.recordGuidanceEvidence({...edited.own,evidence:guidanceProof(edited)});const prior=sendFinal(edited,'guidance_final',LOGIN_FAQ.body);const original=newAck(edited);const changed=newAck(edited,{immutableMessageId:original.immutableMessageId,messageRevision:'2',body:'別件です。BOTが止まりました。'});expectCode(()=>edited.ledger.ack_close(ackArgs(edited,prior,[original,changed])),'ACK_NOT_PURE_THANKS');
  const clarification=fixture(t);const body='Please share the exact URL.';const op=clarification.ledger.reserveReply({...clarification.own,purpose:'clarification',recipient:event().recipient,body,missingFields:['siteUrl']});clarification.ledger.markSending({...clarification.own,operationId:op.operationId});clarification.ledger.recordReceipt({...clarification.own,operationId:op.operationId,receipt:{operationId:op.operationId,messageId:'synthetic-clarification-receipt',sentAt:new Date(BASE).toISOString(),recipient:event().recipient,bodyHash:digest(body)}});const thanks=newAck(clarification);expectCode(()=>clarification.ledger.ack_close(ackArgs(clarification,op,[thanks])),'ACK_FINAL_RECEIPT_REQUIRED');
});

test('CLI no-code and ack-close outputs remain anonymous and never print private hashes, body or recipient',t=>{
  const realNow=Date.now();const f=fixture(t,faqEvent({sourceUpdatedAt:new Date(realNow-1000).toISOString()}),realNow);const e=guidanceProof(f);const cfg=path.join(f.dir,'no-code-config.json');fs.writeFileSync(cfg,JSON.stringify(f.config),{mode:0o600});
  // An invalid proof returns only its stable error code, not private source or
  // receipt data. This fixture shares the CLI's real clock and live lease.
  const result=runCli(cfg,f.config,{command:'recordGuidanceEvidence',args:{...f.own,evidence:{...e,sourceHistoryDigest:'private-source-digest'}}});
  assert.equal(result.status,1);for(const secret of ['private-source-digest','sourceHistoryDigest','customer@example.com',LOGIN_FAQ.body])assert.equal(result.stdout.includes(secret),false);assert.deepEqual(JSON.parse(result.stdout),{error:'GUIDANCE_EVIDENCE_BINDING_MISMATCH'});
});
