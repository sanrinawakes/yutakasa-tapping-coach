import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MonitorLedgerError } from "./monitor-ledger.mjs";

import {
  SupportWorkerError,
  planTicket,
  processSupportTicketContextFile,
  processSupportTickets,
  readTicketContextFile,
  validateTicketContext,
} from "./support-worker.mjs";

const TOKEN = "remote-support-automation-secret-32-characters";
const TICKET_ID = "2e4710db-9274-4e4c-96c4-59dc97e21c8d";
const MESSAGE_ID = "a61fb99e-874b-4111-a95a-4f4cb268e48c";
const NEW_MESSAGE_ID = "f41fb99e-874b-4111-a95a-4f4cb268e48c";
const RECEIPT_ID = "b61fb99e-874b-4111-a95a-4f4cb268e48c";
const INITIAL_SUPPORT_ACK = "お問い合わせを受け付けました。内容を確認して対応します。調査内容によっては2〜3日かかる場合があります。対応後、この画面でご連絡します。";

function entry(overrides = {}) {
  return {
    ticket: {
      id: TICKET_ID,
      category: "technical",
      subject: "送信できない",
      has_attachments: false,
      status: "open",
      decision_required: false,
      automation_status: "queued",
      ...overrides.ticket,
    },
    messages: [
      {
        id: MESSAGE_ID,
        sender_type: "user",
        body: "保存しても画面に出ません。private customer text",
        created_at: "2026-09-16T01:00:00Z",
      },
      ...(overrides.messages ?? []),
    ],
    work_logs: overrides.work_logs ?? [],
  };
}

function context(tickets = [entry()]) {
  return {
    schemaVersion: 1,
    trust: "untrusted_customer_input",
    obtainedAt: "2026-09-16T01:05:00Z",
    tickets,
  };
}

function fakeApi(statuses = {}, claimedEntry = entry()) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    if (init.method === "GET") {
      assert.equal(new URL(String(_url)).searchParams.has("lockToken"), false);
      assert.equal(init.headers["x-automation-lock-token"], calls.find((call) => call.action === "claim")?.lockToken);
      calls.push({ action: "get" });
      return new Response(JSON.stringify({
        ticket: {
          ...claimedEntry.ticket,
          status: "in_progress",
          automation_status: "investigating",
          automation_lock_token: calls.find((call) => call.action === "claim")?.lockToken,
          updated_at: "2026-09-16T01:05:00.000Z",
        },
        messages: claimedEntry.messages,
        work_logs: claimedEntry.work_logs,
      }), { status: statuses.get ?? 200 });
    }
    const body = JSON.parse(init.body);
    calls.push(body);
    const chosen = statuses[`${body.action}:${calls.length}`] ?? statuses[body.action] ?? 200;
    const payload = body.action === "log"
      ? { success: true }
      : body.action === "handoff" ? { workId: body.workId }
      : body.action === "clarify" ? { messageId: MESSAGE_ID, created: true }
      : {
          ticket: {
            id: body.ticketId,
            automation_status: body.action === "claim"
              ? "investigating"
              : body.action === "decision_required"
                ? "blocked_decision"
                : body.action === "manual_review"
                  ? "manual_review"
                : "failed",
            automation_lock_token: body.action === "claim" ? body.lockToken : null,
            decision_required: body.action === "decision_required",
          },
        };
    return new Response(JSON.stringify(payload), { status: chosen });
  };
  return { calls, fetchImpl };
}

test("a new user message after the queue snapshot prevents the stale terminal decision", async () => {
  const fresh = entry({ messages: [{
    id: NEW_MESSAGE_ID,
    sender_type: "user",
    body: "追加で相談します。",
    created_at: "2026-09-16T01:04:00Z",
  }] });
  const api = fakeApi({}, fresh);
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: api.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.staleContexts, 1);
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "failed"]);
  assert.equal(api.calls[2].latestUserMessageId, NEW_MESSAGE_ID);
  assert.equal(api.calls.some((call) => call.action === "decision_required" || call.eventType === "remote_support_escalated"), false);
});

test("a changed claim snapshot or lost detail lock cannot reach progress or terminal actions", async () => {
  const changed = entry({ ticket: { category: "billing" } });
  const staleApi = fakeApi({}, changed);
  const stale = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: staleApi.fetchImpl });
  assert.equal(stale.staleContexts, 1);
  assert.deepEqual(staleApi.calls.map((call) => call.action), ["claim", "get", "failed"]);
  assert.equal(staleApi.calls.some((call) => call.action === "decision_required"), false);

  const conflictApi = fakeApi({ get: 409 });
  const conflict = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: conflictApi.fetchImpl });
  assert.equal(conflict.lostLocks, 1);
  assert.deepEqual(conflictApi.calls.map((call) => call.action), ["claim", "get"]);
});

test("a claimed-detail fetch that ignores abort leaves the ticket for stale-lock recovery", async () => {
  const api = fakeApi();
  const fetchImpl = (url, init) => init.method === "GET"
    ? new Promise(() => {})
    : api.fetchImpl(url, init);
  const started = Date.now();
  const result = await processSupportTickets({
    automationToken: TOKEN, tickets: [entry()], fetchImpl,
    timeoutMs: 1000, maxRuntimeMs: 10_000,
  });
  assert.ok(Date.now() - started < 2500);
  assert.equal(result.uncertain, 1);
  assert.deepEqual(api.calls.map((call) => call.action), ["claim"]);
});

test("lost distributed lease stops before any ticket mutation", async () => {
  const api = fakeApi();
  await assert.rejects(
    () => processSupportTickets({
      automationToken: TOKEN,
      tickets: [entry()],
      fetchImpl: api.fetchImpl,
      beforeMutation: async () => { throw new MonitorLedgerError("monitor_lease_lost"); },
    }),
    (error) => error instanceof MonitorLedgerError && error.code === "monitor_lease_lost",
  );
  assert.deepEqual(api.calls, []);
});

test("lease loss after claim prevents heartbeat, terminal update, and release", async () => {
  const api = fakeApi();
  let checks = 0;
  await assert.rejects(
    () => processSupportTickets({
      automationToken: TOKEN,
      tickets: [entry()],
      fetchImpl: api.fetchImpl,
      beforeMutation: async () => {
        checks += 1;
        if (checks > 1) throw new MonitorLedgerError("monitor_lease_lost");
      },
    }),
    (error) => error instanceof MonitorLedgerError && error.code === "monitor_lease_lost",
  );
  assert.deepEqual(api.calls.map((call) => call.action), ["claim"]);
});

test("private context schema and file permissions fail closed", () => {
  assert.equal(validateTicketContext(context()).length, 1);
  assert.throws(
    () => validateTicketContext(context([{ ...entry(), messages: [] }, entry()])),
    { code: "support_context_ticket_invalid" },
  );
  assert.throws(
    () => validateTicketContext(context([entry({ ticket: { decision_required: true } })])),
    { code: "support_context_ticket_invalid" },
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "support-worker-test."));
  try {
    const file = path.join(directory, "ticket-context.json");
    fs.writeFileSync(file, JSON.stringify(context()), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    assert.equal(readTicketContextFile(file).length, 1);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readTicketContextFile(file), { code: "support_context_file_security_invalid" });
    fs.chmodSync(file, 0o600);
    const link = path.join(directory, "link.json");
    fs.symlinkSync(file, link);
    assert.throws(() => readTicketContextFile(link), { code: "support_context_file_security_invalid" });
    fs.unlinkSync(link);
    fs.unlinkSync(file);
  } finally {
    fs.rmdirSync(directory);
  }
});

test("decision classification uses the customer's full history without exposing it", () => {
  const item = entry({ messages: [{
    id: NEW_MESSAGE_ID,
    sender_type: "user",
    body: "返金を希望します。",
    created_at: "2026-09-16T01:10:00Z",
  }] });
  assert.deepEqual(planTicket(item), {
    kind: "decision_required",
    latestUserMessageId: NEW_MESSAGE_ID,
  });
  assert.equal(planTicket(entry({ ticket: { category: "billing" } })).kind, "decision_required");
  assert.equal(planTicket(entry({
    ticket: { category: "billing" },
    work_logs: [{ event_type: "remote_support_escalated", metadata: { latestUserMessageId: MESSAGE_ID } }],
  })).kind, "decision_required");
  assert.equal(planTicket(entry()).kind, "technical_handoff");
  const tied = entry({ messages: [{
    id: NEW_MESSAGE_ID,
    sender_type: "user",
    body: "同時刻の追記です。",
    created_at: "2026-09-16T01:00:00Z",
  }] });
  tied.messages.reverse();
  assert.equal(planTicket(tied).latestUserMessageId, NEW_MESSAGE_ID);
  assert.equal(planTicket(entry({ messages: [{
    id: NEW_MESSAGE_ID, sender_type: "user", body: "I need a refund for this payment.",
    created_at: "2026-09-16T01:10:00Z",
  }] })).kind, "decision_required");
  assert.equal(planTicket(entry({ messages: [{
    id: NEW_MESSAGE_ID, sender_type: "user", body: "Please delete my personal data.",
    created_at: "2026-09-16T01:10:00Z",
  }] })).kind, "decision_required");
});

test("only an attachment-free, first generic technical report qualifies for a fixed clarification",()=>{
  const generic=entry({ticket:{subject:"使えない",has_attachments:false}});
  generic.messages=[{id:MESSAGE_ID,sender_type:"user",body:"使えない",
    created_at:"2026-09-16T01:00:00Z"},
  {id:RECEIPT_ID,sender_type:"system",body:INITIAL_SUPPORT_ACK,
    created_at:"2026-09-16T01:00:01Z"}];
  assert.equal(planTicket(generic,{clarificationEnabled:true}).kind,"clarification_needed");
  assert.equal(planTicket(generic).kind,"technical_handoff");
  assert.equal(planTicket({...generic,messages:[generic.messages[0]]},
    {clarificationEnabled:true}).kind,"technical_handoff");
  assert.equal(planTicket({...generic,messages:[generic.messages[0],
    {...generic.messages[1],body:"別のシステム案内"}]},
    {clarificationEnabled:true}).kind,"technical_handoff");
  assert.equal(planTicket(entry({ticket:{subject:"返金したい",has_attachments:false},
    messages:[{id:MESSAGE_ID,sender_type:"user",body:"使えない",
      created_at:"2026-09-16T01:00:00Z"}]}),{clarificationEnabled:true}).kind,"decision_required");
  assert.equal(planTicket({...generic,ticket:{...generic.ticket,has_attachments:true}},
    {clarificationEnabled:true}).kind,"manual_review");
  assert.equal(planTicket({...generic,
    work_logs:[{event_type:"automation_clarification_sent",metadata:{}}]},
    {clarificationEnabled:true}).kind,"technical_handoff");
  assert.equal(planTicket({...generic,
    messages:[...generic.messages,{id:NEW_MESSAGE_ID,sender_type:"user",body:"動かない",
      created_at:"2026-09-16T01:10:00Z"}]},
    {clarificationEnabled:true}).kind,"technical_handoff");
});

test("technical tickets with attachments go to manual review before repair handoff", async () => {
  const attached = entry({ ticket: { has_attachments: true } });
  assert.equal(planTicket(attached).kind, "manual_review");
  const api = fakeApi({}, attached);
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [attached],
    fetchImpl: api.fetchImpl, repairBridgeEnabled: true });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "manual_review"]);
  assert.equal(result.manualReviews, 1);
  assert.equal(result.technicalHandoffs, 0);
  assert.equal(result.uncertain, 0);
  assert.equal(result.ok, true);
  assert.throws(() => validateTicketContext(context([{ ...attached,
    ticket: { ...attached.ticket, automation_status: "manual_review" } }])),
  { code: "support_context_ticket_invalid" });
  assert.equal(api.calls.some((call) => call.action === "handoff" ||
    call.eventType === "remote_support_escalated" || call.action === "reply"), false);
});

test("missing attachment evidence cannot enter the repair bridge", async () => {
  const unknown = entry({ ticket: { has_attachments: undefined } });
  assert.equal(planTicket(unknown).kind, "manual_review");
  const api = fakeApi({}, unknown);
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [unknown],
    fetchImpl: api.fetchImpl, repairBridgeEnabled: true });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "manual_review"]);
  assert.equal(result.manualReviews, 1);
  assert.equal(result.technicalHandoffs, 0);
});

test("queue attachment arrays and claimed detail flag produce the same repair decision", async () => {
  const queued = entry({ ticket: { has_attachments: undefined } });
  queued.messages[0].attachments = [];
  const claimed = entry();
  assert.equal(planTicket(queued).kind, "technical_handoff");
  const api = fakeApi({}, claimed);
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [queued],
    fetchImpl: api.fetchImpl, repairBridgeEnabled: true });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "handoff"]);
  assert.equal(result.technicalHandoffs, 1);
  assert.equal(result.staleContexts, 0);

  const attachedQueue = entry({ ticket: { has_attachments: undefined } });
  attachedQueue.messages[0].attachments = [{ id: RECEIPT_ID }];
  const attachedDetail = entry({ ticket: { has_attachments: true } });
  assert.equal(planTicket(attachedQueue).kind, "manual_review");
  const inconsistent = entry({ ticket: { has_attachments: false } });
  inconsistent.messages[0].attachments = [{ id: RECEIPT_ID }];
  assert.equal(planTicket(inconsistent).kind, "manual_review");
  const attachedApi = fakeApi({}, attachedDetail);
  const attachedResult = await processSupportTickets({ automationToken: TOKEN,
    tickets: [attachedQueue], fetchImpl: attachedApi.fetchImpl, repairBridgeEnabled: true });
  assert.deepEqual(attachedApi.calls.map((call) => call.action), ["claim", "get", "log", "manual_review"]);
  assert.equal(attachedResult.manualReviews, 1);
  assert.equal(attachedResult.staleContexts, 0);
});

test("fixed clarification uses claimed version and finishes once without a model or free-form body",async()=>{
  const generic=entry({ticket:{subject:"使えない",has_attachments:false}});
  generic.messages=[{id:MESSAGE_ID,sender_type:"user",body:"使えない",
    created_at:"2026-09-16T01:00:00Z"},
  {id:RECEIPT_ID,sender_type:"system",body:INITIAL_SUPPORT_ACK,
    created_at:"2026-09-16T01:00:01Z"}];
  const api=fakeApi({},generic);
  const result=await processSupportTickets({automationToken:TOKEN,tickets:[generic],
    fetchImpl:api.fetchImpl,clarificationEnabled:true});
  assert.deepEqual(api.calls.map((call)=>call.action),["claim","get","log","clarify"]);
  assert.equal(api.calls[3].ticketVersion,"2026-09-16T01:05:00.000Z");
  assert.equal(api.calls[3].latestUserMessageId,MESSAGE_ID);
  assert.equal(Object.hasOwn(api.calls[3],"body"),false);
  assert.equal(result.clarificationsSent,1);
  assert.equal(result.ok,true);
});

test("technical ticket claims, heartbeats, and atomically queues a private repair job", async () => {
  const api = fakeApi();
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()],
    fetchImpl: api.fetchImpl, repairBridgeEnabled: true });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "handoff"]);
  assert.equal(api.calls[2].eventType, "automation_heartbeat");
  assert.equal(api.calls[3].latestUserMessageId, MESSAGE_ID);
  assert.equal(api.calls[3].ticketVersion, "2026-09-16T01:05:00.000Z");
  assert.match(api.calls[3].workId, /^[a-f0-9-]{36}$/u);
  assert.equal(new Set(api.calls.filter((call) => call.lockToken).map((call) => call.lockToken)).size, 1);
  assert.equal(result.technicalHandoffs, 1);
  assert.equal(result.uncertain, 0);
  assert.equal(JSON.stringify(result).includes("private customer text"), false);
  assert.equal(JSON.stringify(api.calls).includes("private customer text"), false);
  assert.equal(api.calls.some((call) => call.action === "reply"), false);
});

test("bridge OFF uses the existing manual escalation without the new RPC", async () => {
  const api = fakeApi({ handoff: 500 });
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()],
    fetchImpl: api.fetchImpl });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim","get","log","log","failed"]);
  assert.equal(result.technicalHandoffs,1);
  assert.equal(api.calls.some((call)=>call.action==="handoff"),false);
});

test("decision ticket is locked, heartbeat checked, then blocked without customer reply", async () => {
  const item = entry({ ticket: { category: "billing" } });
  const api = fakeApi({}, item);
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [item], fetchImpl: api.fetchImpl });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "decision_required"]);
  assert.equal(result.decisionsRequired, 1);
  assert.equal(api.calls.some((call) => call.action === "reply"), false);
});

test("old escalation log cannot suppress an atomic handoff after an uncertain failure", async () => {
  const prior = entry({ work_logs: [{ event_type: "remote_support_escalated", metadata: { latestUserMessageId: MESSAGE_ID } }] });
  const api = fakeApi({}, prior);
  const first = await processSupportTickets({ automationToken: TOKEN, tickets: [prior],
    fetchImpl: api.fetchImpl, repairBridgeEnabled: true });
  assert.equal(first.technicalHandoffs, 1);
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "handoff"]);
  prior.messages.push({ id: NEW_MESSAGE_ID, sender_type: "user", body: "まだ直りません", created_at: "2026-09-16T01:20:00Z" });
  const secondApi = fakeApi({}, prior);
  const second = await processSupportTickets({ automationToken: TOKEN, tickets: [prior],
    fetchImpl: secondApi.fetchImpl, repairBridgeEnabled: true });
  assert.equal(second.technicalHandoffs, 1);
  assert.equal(secondApi.calls[3].latestUserMessageId, NEW_MESSAGE_ID);
  const offApi=fakeApi({},prior);
  const off=await processSupportTickets({automationToken:TOKEN,tickets:[prior],fetchImpl:offApi.fetchImpl});
  assert.equal(off.skippedPriorEscalation,0);
});

test("claim conflict and lost heartbeat never perform terminal mutation", async () => {
  const claimConflict = fakeApi({ claim: 409 });
  const one = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: claimConflict.fetchImpl });
  assert.equal(one.claimConflicts, 1);
  assert.deepEqual(claimConflict.calls.map((call) => call.action), ["claim"]);

  const lostHeartbeat = fakeApi({ log: 409 });
  const two = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: lostHeartbeat.fetchImpl });
  assert.equal(two.lostLocks, 1);
  assert.deepEqual(lostHeartbeat.calls.map((call) => call.action), ["claim", "get", "log"]);
});

test("uncertain log response attempts a safe terminal release and reports uncertainty", async () => {
  const api = fakeApi({ log: 500 });
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()],
    fetchImpl: api.fetchImpl, repairBridgeEnabled: true });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "failed"]);
  assert.equal(result.uncertain, 1);
  assert.equal(result.technicalHandoffs, 0);
});

test("ambiguous handoff response remains nonhealthy when a guarded release conflicts", async () => {
  const api = fakeApi({ "handoff:4": 500, "failed:5": 409 });
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()],
    fetchImpl: api.fetchImpl, repairBridgeEnabled: true });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "get", "log", "handoff", "failed"]);
  assert.equal(result.uncertain, 1);
  assert.equal(result.lostLocks, 1);
  assert.equal(result.ok, false);
});

test("context file runner processes only current private data", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "support-worker-test."));
  try {
    const file = path.join(directory, "ticket-context.json");
    fs.writeFileSync(file, JSON.stringify(context()), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const api = fakeApi();
    const result = await processSupportTicketContextFile({
      contextPath: file,
      automationToken: TOKEN,
      fetchImpl: api.fetchImpl,
      repairBridgeEnabled: true,
    });
    assert.equal(result.technicalHandoffs, 1);
    fs.unlinkSync(file);
  } finally {
    fs.rmdirSync(directory);
  }
});

test("invalid token never reaches the API", async () => {
  const api = fakeApi();
  await assert.rejects(
    processSupportTickets({ automationToken: "short", tickets: [entry()], fetchImpl: api.fetchImpl }),
    SupportWorkerError,
  );
  assert.equal(api.calls.length, 0);
});

test("a fetch that ignores AbortSignal cannot hold the worker indefinitely", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.action);
    if (body.action === "claim") return new Promise(() => {});
    return new Response(JSON.stringify({
      ticket: { id: TICKET_ID, automation_status: "failed", automation_lock_token: null },
    }), { status: 200 });
  };
  const started = Date.now();
  const result = await processSupportTickets({
    automationToken: TOKEN,
    tickets: [entry()],
    fetchImpl,
    timeoutMs: 1000,
    maxRuntimeMs: 10_000,
  });
  assert.ok(Date.now() - started < 2500);
  assert.deepEqual(calls, ["claim"]);
  assert.equal(result.uncertain, 1);
  assert.equal(result.ok, false);
});

test("an oversized response with a stalled cancel fails within the deadline", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.action);
    if (body.action === "claim") {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel() { return new Promise(() => {}); },
      });
      return new Response(stream, { status: 200 });
    }
    return new Response(JSON.stringify({
      ticket: { id: TICKET_ID, automation_status: "failed", automation_lock_token: null },
    }), { status: 200 });
  };
  const started = Date.now();
  const result = await processSupportTickets({
    automationToken: TOKEN,
    tickets: [entry()],
    fetchImpl,
    timeoutMs: 1000,
    maxRuntimeMs: 10_000,
  });
  assert.ok(Date.now() - started < 2500);
  assert.deepEqual(calls, ["claim"]);
  assert.equal(result.uncertain, 1);
});

test("a response stream that never finishes shares the hard request deadline", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.action);
    if (body.action === "claim") {
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }
    return new Response(JSON.stringify({
      ticket: { id: TICKET_ID, automation_status: "failed", automation_lock_token: null },
    }), { status: 200 });
  };
  const started = Date.now();
  const result = await processSupportTickets({
    automationToken: TOKEN,
    tickets: [entry()],
    fetchImpl,
    timeoutMs: 1000,
    maxRuntimeMs: 10_000,
  });
  assert.ok(Date.now() - started < 2500);
  assert.deepEqual(calls, ["claim"]);
  assert.equal(result.uncertain, 1);
});
