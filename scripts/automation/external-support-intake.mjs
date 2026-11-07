import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, openExternalSupportLedger, readPrivateJson } from './external-support-ledger.mjs';

// Connected tools, not this module, authenticate to the mailbox/browser. Only
// their read-back receipts enter here. Customer prose never supplies scope,
// identity, command, destination or permission fields.
export class IntakeError extends Error {
  constructor(code) { super(code); this.name = 'IntakeError'; this.code = code; }
}
const fail = code => { throw new IntakeError(code); };
const requireValue = (value, code) => { if (!value) fail(code); };
const MAX_BODY = 200_000;
const BOT_TOPIC = /豊かさ\s*(?:BOT|bot|ボット)|yutakasa-tapping-coach|lchatai|LChatAI/iu;
const COURSE = /豊かさ(?:タッピング|コーチング)/u;
const CHAT = /チャット|\bAI\b|ボット|\bBOT\b/iu;
const SUPPORT = /不具合|エラー|使え|使うことができ|回答|返事|返信|止ま|停止|ログイン|入れ|送信|入力|変換|修正|消え|error|fail|stuck|not work/iu;
const QUESTION = /使い方|方法|教え|質問|相談|どうすれば|どのよう|？|\?/iu;
const ACK_ONLY = /^(?:承知しました|わかりました|確認しました|解決しました|ありがとうございます|ご返信ありがとうございます|助かりました)[。！!\s]*$/u;
const OWNER_DECISION = /返金|解約|退会|補償|チャージバック|refund|chargeback|cancel.{0,30}(?:subscription|contract|account)|stop.{0,30}(?:payment|billing|charging)|(?:課金|支払い|決済).{0,15}(?:止め|ストップ|停止して)|(?:カード|クレジット).{0,12}(?:購入して|支払って)|(?:権限|アクセス).{0,12}(?:追加して|付与して)|(?:個人情報|アカウント).{0,12}削除|(?:APIキー|認証情報).{0,15}(?:発行|変更|共有)|(?:セキュリティ|認証).{0,12}無効/iu;
export function redactCredentials(value) {
  return String(value).replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/((?:password|api[_ -]?key|access[_ -]?token|認証コード|ログインコード|ワンタイムコード|パスワード)\s*[:=：]\s*)[^\s<>]+/giu, '$1[REDACTED]')
    .replace(/([?&](?:token|code|otp|password|key|auth|session|signature|sig)=)[^&#\s<>]+/giu, '$1[REDACTED]');
}
export function isSupportCandidate({subject = '', body = '', knownThread = false}) {
  if (knownThread) return true;
  const text = `${subject}\n${body}`;
  return BOT_TOPIC.test(text) || (COURSE.test(text) && CHAT.test(text) && (SUPPORT.test(text) || OWNER_DECISION.test(text)));
}
const currentCue = body => !ACK_ONLY.test(body.trim()) && (SUPPORT.test(body) || QUESTION.test(body) || OWNER_DECISION.test(body));
const replySubject = subject => /^(?:re|返信)\s*[:：]/iu.test(subject.trim());
export function currentMailProse(body, subject='') {
  // In an ordinary reply, an old quoted report does not turn today's unrelated
  // acknowledgement into a new incident. Explicit forwards keep their report.
  if (/^(?:fw|fwd|転送)\s*[:：]/iu.test(subject.trim())) return body;
  return body.split(/(?:^|\n)(?:\s*>|\s*On .{0,300}wrote:|\s*\d{4}[年/.-].{0,250}(?:メール:|メール：|wrote:|>:)\s*$|\s*-{2,}\s*Original Message)/imu)[0];
}
function scoped(config, kind) {
  const source = config.sources?.[kind];
  requireValue(source && source.kind === kind && source.accountId && source.scopeId, 'SOURCE_CONFIG_REQUIRED');
  requireValue(config.allowlist?.some(a => a.kind === source.kind && a.accountId === source.accountId && a.scopeId === source.scopeId), 'SOURCE_NOT_ALLOWED');
  return {kind: source.kind, accountId: source.accountId, scopeId: source.scopeId};
}
const known = (ledger, source, id) => {
  if(!ledger)return null;
  try{return ledger.resolveVerifiedThread({source,replyToMessageId:id});}
  catch(error){if(error.code==='VERIFIED_THREAD_NOT_FOUND')return null;throw error;}
};
function unchangedTime(ledger, source, messageId, revision, supplied) {
  const old = ledger?.lookupEvent({source, immutableMessageId:messageId, messageRevision:revision});
  return old?.sourceUpdatedAt ?? supplied;
}
function cleanBody(body) {
  requireValue(typeof body === 'string' && body.trim().length > 0 && Buffer.byteLength(body) <= MAX_BODY, 'BODY_INVALID_OR_TOO_LARGE');
  return redactCredentials(body.trim());
}
function oneAddress(raw) {
  requireValue(typeof raw === 'string' && !/[\r\n]/.test(raw), 'UNVERIFIED_RECIPIENT');
  const address = raw.match(/<([^<>]+)>/)?.[1] ?? raw.trim();
  requireValue(/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(address), 'UNVERIFIED_RECIPIENT');
  requireValue(!/[,;]/.test(raw.replace(/"[^"]*"/g, '').replace(/<[^<>]+>/g, '')), 'MULTIPLE_RECIPIENTS_REQUIRE_REVIEW');
  return address.toLowerCase();
}
function ignoredGmailSenders(config) {
  const values=config.sources?.gmail?.ignoredSenderAddresses??[];
  requireValue(Array.isArray(values)&&values.length<=100,'IGNORED_SENDERS_INVALID');
  return new Set(values.map(value=>{const address=oneAddress(value);requireValue(value.trim().toLowerCase()===address,'IGNORED_SENDERS_INVALID');return address;}));
}
function header(message, name) {
  const values = (message.payload?.headers ?? []).filter(h => h.name.toLowerCase() === name.toLowerCase()).map(h => h.value);
  requireValue(values.length <= 1, 'AMBIGUOUS_HEADER');
  return values[0];
}
function plainHtml(html) {
  return html.replace(/<div\b[^>]*class=["'][^"']*gmail_quote[^"']*["'][\s\S]*$/iu, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/<\/?(?:p|div|br|li|tr|blockquote)\b[^>]*>/giu, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function mime(message) {
  const bodyParts=[];const attachments=[];let count=0;let requiresRaw=false;
  const walk=(part,depth=0,ancestorAttachment=false)=>{
    requireValue(part&&typeof part==='object'&&!Array.isArray(part)&&depth<=12&&++count<=150,'MIME_LIMIT');
    const mediaType=typeof part.mime_type==='string'?part.mime_type.toLowerCase():'';
    const disposition=typeof part.content_disposition==='string'?part.content_disposition.toLowerCase():null;
    requireValue(disposition===null||['inline','attachment'].includes(disposition),'MIME_DISPOSITION_INVALID');
    const ownAttachment=disposition==='attachment'||Boolean(part.filename)||mediaType==='message/rfc822';
    const blocked=ancestorAttachment||ownAttachment;
    if(ownAttachment&&!ancestorAttachment){attachments.push({filename:String(part.filename??'attached-message').slice(0,255),mimeType:mediaType||null,sizeBytes:Number.isSafeInteger(part.body?.size)?part.body.size:null,attachmentId:part.body?.attachment_id??null,sourceMessageId:message.id});}
    if(!blocked&&['text/plain','text/html'].includes(mediaType)){
      if(typeof part.body?.content==='string')bodyParts.push({mediaType,content:part.body.content});
      else requiresRaw=true;
    }
    const children=part.parts??[];requireValue(Array.isArray(children),'MIME_LIMIT');
    for(const child of children)walk(child,depth+1,blocked);
  };
  walk(message.payload);
  requireValue(attachments.length<=25,'ATTACHMENT_LIMIT');
  const texts=bodyParts.filter(part=>part.mediaType==='text/plain');const html=bodyParts.filter(part=>part.mediaType==='text/html');
  const body=texts.length?texts.map(part=>part.content).join('\n'):html.map(part=>plainHtml(part.content)).join('\n');
  if(!body.trim())requiresRaw=true;
  return {body,attachments,requiresRaw};
}
function currentChatworkProse(text) {
  const withoutQuotes=text.replace(/\[qt\][\s\S]*?\[\/qt\]/giu,'').replace(/^\[rp\s+aid=\d+\s+to=\d+(?:-\d+)?\][^\n]*\n?/iu,'');
  const lines=withoutQuotes.split(/\r?\n/u);
  while(lines.length){
    const line=lines[0].trim();
    if(!line||/^返信元\s*[:：]?$/u.test(line)||/^\[To:\d+\].{0,100}$/iu.test(line)||/^.{1,100}(?:さん|様)$/u.test(line)||/^(?:ありがとうございます|ご対応ありがとうございます|ご返信ありがとうございます)[。！!]?$/u.test(line)){lines.shift();continue;}
    break;
  }
  return lines.join('\n').trim();
}
export function normalizeGmailReceipt(receipt, config, ledger) {
  requireValue(receipt?.sourceVerified===true && receipt.accountId===config.sources?.gmail?.accountId,'UNVERIFIED_CONNECTOR_ACCOUNT');
  const message=receipt.message?.structuredContent??receipt.message; const source=scoped(config,'gmail');
  requireValue(/^[a-f0-9]{8,}$/i.test(message?.id??'') && /^[a-f0-9]{8,}$/i.test(message?.thread_id??''),'GMAIL_IDS_REQUIRED');
  requireValue(Array.isArray(message.label_ids),'GMAIL_LABELS_REQUIRED');
  const from=oneAddress(header(message,'From'));
  // Do not feed our own replies, provider receipts, broadcasts or automatic
  // vacations back into the repair queue. Known thread IDs alone do not bypass
  // this send-loop guard.
  if(from===source.accountId.toLowerCase() || message.label_ids.includes('SENT') || ignoredGmailSenders(config).has(from))return null;
  const autoSubmitted=header(message,'Auto-Submitted');
  if(header(message,'List-Unsubscribe') || (autoSubmitted && autoSubmitted.trim().toLowerCase()!=='no'))return null;
  const extracted=mime(message);const attachments=extracted.attachments;
  for(const legacy of ['decodedBodyMessageId','decodedBodyText','decodedSubject','strictDecodeVerified','knownThreadVerified'])requireValue(!Object.hasOwn(receipt,legacy),'UNBOUND_RECEIPT_ASSERTION');
  const decoderPresent=Object.hasOwn(receipt,'decoder');const decoder=receipt.decoder;
  if(decoderPresent){requireValue(decoder&&typeof decoder==='object'&&!Array.isArray(decoder)&&Object.keys(decoder).sort().join(',')==='body,messageId,strictDecodeVerified,subject'&&decoder.strictDecodeVerified===true&&decoder.messageId===message.id&&typeof decoder.body==='string'&&typeof decoder.subject==='string','BODY_DECODE_REQUIRED');}
  const rawBody=decoderPresent?decoder.body:extracted.body;
  const subject=decoderPresent?decoder.subject:(header(message,'Subject')??'');
  requireValue(typeof rawBody==='string' && typeof subject==='string','BODY_DECODE_REQUIRED');
  if(!decoderPresent&&(extracted.requiresRaw||/\ufffd|\x1b\$|\x1b\(/u.test(rawBody)))fail('BODY_DECODE_REQUIRED');
  if(!decoderPresent&&/=\?[^?]+\?[BQ]\?/iu.test(subject))fail('HEADER_DECODE_REQUIRED');
  const history=known(ledger,source,message.id);const threadKnown=ledger?.findVerifiedThread?.({source,verifiedThreadId:message.thread_id});
  const knownThread=Boolean(history||threadKnown);const current=currentMailProse(rawBody,subject);
  let candidate=isSupportCandidate({subject,body:current,knownThread});
  if(!knownThread&&replySubject(subject)&&!/^(?:fw|fwd|転送)\s*[:：]/iu.test(subject.trim()))candidate=candidate&&currentCue(current);
  if(!candidate)return null;
  const body=cleanBody(rawBody);const date=Number(message.internal_date);
  requireValue(Number.isSafeInteger(date)&&date>0,'GMAIL_DATE_REQUIRED');
  const replyAddress=oneAddress(header(message,'Reply-To')??header(message,'From'));
  const recipient={kind:'gmail',address:replyAddress,threadId:message.thread_id};
  const revision=digest({subject,body,attachments,from,recipient});
  return {source,sourceVerified:true,verifiedThreadId:message.thread_id,immutableMessageId:message.id,messageRevision:revision,
    sourceUpdatedAt:unchangedTime(ledger,source,message.id,revision,new Date(date).toISOString()),body,subject:redactCredentials(subject),
    sender:{address:from},recipient,attachments,decisionRequired:OWNER_DECISION.test(`${subject}\n${current}`)||replyAddress!==from||/^(?:no-?reply|mailer-daemon|postmaster)@/iu.test(from),
    replyContext:{messageId:message.id,threadId:message.thread_id},trust:'untrusted_customer_content'};
}
export function normalizeChatworkReceipt(receipt, config, ledger) {
  const source=scoped(config,'chatwork');
  requireValue(receipt?.sourceVerified===true && receipt.accountId===source.accountId && String(receipt.roomId)===source.scopeId,'UNVERIFIED_CONNECTOR_ACCOUNT');
  requireValue(/^\d{10,}$/.test(receipt.messageId??'') && /^\d+$/.test(receipt.authorAccountId??''),'CHATWORK_IDS_REQUIRED');
  if(receipt.authorAccountId===source.accountId || receipt.deleted===true)return null;
  requireValue(Array.isArray(receipt.attachments??[]),'INVALID_ATTACHMENTS');
  const attachments=(receipt.attachments??[]).map(a=>{requireValue(a&&/^\d+$/.test(a.fileId??'')&&typeof a.filename==='string'&&a.filename.trim().length>0,'ATTACHMENT_SOURCE_REQUIRED');return {fileId:a.fileId,filename:a.filename.trim().slice(0,255),sourceMessageId:receipt.messageId};}).sort((a,b)=>a.fileId.localeCompare(b.fileId)||a.filename.localeCompare(b.filename));
  requireValue(attachments.length<=25,'ATTACHMENT_LIMIT');
  requireValue(receipt.body===undefined||receipt.body===null||typeof receipt.body==='string','BODY_INVALID_OR_TOO_LARGE');
  const attachmentOnly=typeof receipt.body!=='string'||receipt.body.trim().length===0;
  const text=attachmentOnly?(attachments.length?'[添付のみの報告]':cleanBody(receipt.body)):cleanBody(receipt.body);
  const existing=known(ledger,source,receipt.messageId);
  // An explicit new issue in a staff reply is not the old customer's report.
  for(const legacy of ['separateIssueVerified','separateIssueMessageId'])requireValue(!Object.hasOwn(receipt,legacy),'UNBOUND_SEPARATE_ISSUE_ASSERTION');
  const currentFields=['currentProse','currentProseVerified','currentProseMessageId'];const hasCurrentFields=currentFields.some(key=>Object.hasOwn(receipt,key));
  if(hasCurrentFields)requireValue(currentFields.every(key=>Object.hasOwn(receipt,key))&&receipt.currentProseVerified===true&&receipt.currentProseMessageId===receipt.messageId&&typeof receipt.currentProse==='string'&&receipt.currentProse.trim().length>0&&Buffer.byteLength(receipt.currentProse)<=MAX_BODY,'UNBOUND_CURRENT_PROSE_ASSERTION');
  // Only the trusted, message-ID-bound collector may assert which DOM text is
  // the current reply. Semantic prefix removal stays here so the collector
  // does not have to interpret customer prose. The preserved body remains the
  // exact rendered receipt text.
  const current=currentChatworkProse(hasCurrentFields?receipt.currentProse:text);
  const isSeparate=hasCurrentFields&&/^(?:別件(?:です|ですが|で)|別の件|新しい(?:不具合|質問|報告)|another issue(?:\b|\s*[:：]))/iu.test(current.slice(0,500));
  const ancestry=!isSeparate&&receipt.replyToMessageId?known(ledger,source,receipt.replyToMessageId):null;
  const relation=existing??ancestry;
  if(!attachmentOnly&&!isSupportCandidate({body:current,knownThread:!!relation}))return null;
  const threadId=relation?.verifiedThreadId??receipt.messageId;
  const prior=relation?ledger?.readCase({caseId:relation.caseId}):null;
  const recipient=prior?.context?.recipient??{kind:'chatwork',roomId:source.scopeId,replyToMessageId:threadId};
  const sender={accountId:receipt.authorAccountId};
  const date=Number(receipt.editedAtUnix??receipt.createdAtUnix);
  requireValue(Number.isSafeInteger(date)&&date>0,'CHATWORK_DATE_REQUIRED');
  const attachmentIdentity=value=>(value??[]).map(({fileId,filename,sourceMessageId})=>({fileId,filename,sourceMessageId})).sort((a,b)=>String(a.fileId).localeCompare(String(b.fileId))||String(a.filename).localeCompare(String(b.filename)));
  // Compare only the latest observed version of this immutable source message.
  // Searching all history would mistake a real A -> B -> A edit for old A.
  if(existing)requireValue(typeof ledger?.lookupLatestEvent==='function','LATEST_SOURCE_REVISION_REQUIRED');
  const priorEvent=ledger?.lookupLatestEvent?.({source,immutableMessageId:receipt.messageId});
  const unchanged=priorEvent&&priorEvent.body===text&&priorEvent.sender?.accountId===sender.accountId&&digest(priorEvent.recipient)===digest(recipient)&&digest(attachmentIdentity(priorEvent.attachments))===digest(attachmentIdentity(attachments));
  if(unchanged)return structuredClone(priorEvent);
  const sourceUpdatedAt=new Date(date*1000).toISOString();
  const priorProviderTimes=(prior?.history??[]).filter(event=>event.immutableMessageId===receipt.messageId).map(event=>Date.parse(event.sourceUpdatedAt));
  const sourceHighWater=priorEvent?Math.max(Date.parse(priorEvent.sourceUpdatedAt),...priorProviderTimes):-Infinity;
  const providerEditNewer=receipt.editedAtUnix!==undefined&&receipt.editedAtUnix!==null&&priorEvent&&date*1000>sourceHighWater;
  // A DOM body change without a newer provider edit timestamp is real evidence
  // of a difference, not evidence of when it was edited. Preserve the source
  // timestamp and fail closed; never relabel polling time as provider edit time.
  const sourceRevision=priorEvent&&!providerEditNewer?{kind:'observed_change_time_unverified',previousMessageRevision:priorEvent.messageRevision}:null;
  const revision=digest({body:text,attachments:attachmentIdentity(attachments),sender,recipient,
    ...(priorEvent?{previousMessageRevision:priorEvent.messageRevision,sourceUpdatedAt}:{}),
    ...(sourceRevision?{sourceRevision}:{})});
  return {source,sourceVerified:true,verifiedThreadId:threadId,immutableMessageId:receipt.messageId,messageRevision:revision,
    sourceUpdatedAt,body:text,sender,recipient,attachments,
    ...(sourceRevision?{sourceRevision}:{}),decisionRequired:OWNER_DECISION.test(text)||Boolean(sourceRevision),
    replyContext:{messageId:receipt.messageId,roomId:source.scopeId,accountId:receipt.authorAccountId},trust:'untrusted_customer_content'};
}
export function scanPlan(config, ledger, now=Date.now()) {
  requireValue(Number.isFinite(now),'NOW_REQUIRED');const gmail=scoped(config,'gmail');const chatwork=scoped(config,'chatwork');
  const gm=ledger.getScanCursor({source:gmail});const cw=ledger.getScanCursor({source:chatwork});
  const start=cursor=>Math.max(0,(cursor.cursorRevision===0?now-7*86400000:cursor.checkedUntilMs)-15*60000);
  const pending=ledger.summary();const knownThreadIds=[];
  for(const row of pending.cases??[]){const context=ledger.readCase({caseId:row.id}).context;if(context?.source?.kind===gmail.kind&&context.source.accountId===gmail.accountId&&context.source.scopeId===gmail.scopeId&&typeof context.verifiedThreadId==='string')knownThreadIds.push(context.verifiedThreadId);}
  const ignored=[...ignoredGmailSenders(config)].map(address=>`-from:${address}`).join(' ');
  return {gmail:{source:gmail,from:new Date(start(gm)).toISOString(),to:new Date(now).toISOString(),expectedRevision:gm.cursorRevision,
    query:`in:anywhere after:${Math.floor(start(gm)/1000)} {"豊かさBOT" "豊かさボット" "豊かさタッピング" "豊かさコーチング" "yutakasa-tapping-coach" "lchatai"} -from:notifications@github.com${ignored?` ${ignored}`:''}`,
    knownThreadIds:[...new Set(knownThreadIds)].sort()},
    chatwork:{source:chatwork,roomId:chatwork.scopeId,from:new Date(start(cw)).toISOString(),to:new Date(now).toISOString(),expectedRevision:cw.cursorRevision},
    pending};
}

function exportPlan(outputPath, value, dbPath) {
  requireValue(typeof outputPath==='string' && path.isAbsolute(outputPath) && path.normalize(outputPath)===outputPath && path.dirname(outputPath)===path.dirname(dbPath),'PRIVATE_PLAN_PATH_REQUIRED');
  const fd=fs.openSync(outputPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);const s=fs.fstatSync(fd);requireValue(s.isFile()&&s.nlink===1&&(s.mode&0o777)===0o600&&(process.getuid===undefined||s.uid===process.getuid()),'PRIVATE_PLAN_MODE_REQUIRED');}
  finally{fs.closeSync(fd);}
}

// Read private receipts from disk/stdin; never interpolate customer prose into
// shell command text. The CLI emits no bodies, addresses, names or filenames.
async function cli() {
  const args=process.argv.slice(2);requireValue(args.length===2&&args[0]==='--config','CONFIG_REQUIRED');
  const config=readPrivateJson(args[1]);let input='';for await(const c of process.stdin){input+=c;requireValue(Buffer.byteLength(input)<=2_000_000,'INPUT_TOO_LARGE');}
  const request=JSON.parse(input);const ledger=openExternalSupportLedger(config);
  try {
    if(request.command==='plan'){const plan=scanPlan(config,ledger);exportPlan(request.outputPath,plan,config.dbPath);process.stdout.write(JSON.stringify({exported:true,pendingCount:plan.pending.total})+'\n');return;}
    requireValue(['ingest_gmail','ingest_chatwork'].includes(request.command),'COMMAND_FORBIDDEN');
    const receipts=request.receipts;requireValue(Array.isArray(receipts)&&receipts.length<=100,'RECEIPT_BATCH_LIMIT');
    const normalize=request.command==='ingest_gmail'?normalizeGmailReceipt:normalizeChatworkReceipt;
    const results=receipts.map(r=>{const event=normalize(r,config,ledger);if(!event)return {ignored:true};const result=ledger.ingest(event);return {id:result.id,revision:result.revision,state:result.state,duplicate:result.duplicate};});
    process.stdout.write(JSON.stringify({results})+'\n');
  } finally {ledger.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))cli().catch(error=>{process.stdout.write(JSON.stringify({error:error.code??'INTAKE_ERROR'})+'\n');process.exitCode=1;});
