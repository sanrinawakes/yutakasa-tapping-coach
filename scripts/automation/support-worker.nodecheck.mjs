import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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

function entry(overrides = {}) {
  return {
    ticket: {
      id: TICKET_ID,
      category: "technical",
      subject: "送信できない",
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

function fakeApi(statuses = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const chosen = statuses[`${body.action}:${calls.length}`] ?? statuses[body.action] ?? 200;
    const payload = body.action === "log"
      ? { success: true }
      : {
          ticket: {
            id: body.ticketId,
            automation_status: body.action === "claim"
              ? "investigating"
              : body.action === "decision_required"
                ? "blocked_decision"
                : "failed",
            automation_lock_token: body.action === "claim" ? body.lockToken : null,
            decision_required: body.action === "decision_required",
          },
        };
    return new Response(JSON.stringify(payload), { status: chosen });
  };
  return { calls, fetchImpl };
}

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
});

test("technical ticket claims, heartbeats, records a durable marker, and terminates failed", async () => {
  const api = fakeApi();
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: api.fetchImpl });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "log", "log", "failed"]);
  assert.equal(api.calls[1].eventType, "automation_heartbeat");
  assert.deepEqual(api.calls[2].metadata, { latestUserMessageId: MESSAGE_ID });
  assert.equal(new Set(api.calls.map((call) => call.lockToken)).size, 1);
  assert.equal(result.technicalHandoffs, 1);
  assert.equal(result.uncertain, 0);
  assert.equal(JSON.stringify(result).includes("private customer text"), false);
  assert.equal(JSON.stringify(api.calls).includes("private customer text"), false);
  assert.equal(api.calls.some((call) => call.action === "reply"), false);
});

test("decision ticket is locked, heartbeat checked, then blocked without customer reply", async () => {
  const api = fakeApi();
  const item = entry({ ticket: { category: "billing" } });
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [item], fetchImpl: api.fetchImpl });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "log", "decision_required"]);
  assert.equal(result.decisionsRequired, 1);
  assert.equal(api.calls.some((call) => call.action === "reply"), false);
});

test("prior escalation of the same user message is skipped; new message is processed", async () => {
  const prior = entry({ work_logs: [{ event_type: "remote_support_escalated", metadata: { latestUserMessageId: MESSAGE_ID } }] });
  const api = fakeApi();
  const first = await processSupportTickets({ automationToken: TOKEN, tickets: [prior], fetchImpl: api.fetchImpl });
  assert.equal(first.skippedPriorEscalation, 1);
  assert.equal(api.calls.length, 0);
  prior.messages.push({ id: NEW_MESSAGE_ID, sender_type: "user", body: "まだ直りません", created_at: "2026-09-16T01:20:00Z" });
  const second = await processSupportTickets({ automationToken: TOKEN, tickets: [prior], fetchImpl: api.fetchImpl });
  assert.equal(second.technicalHandoffs, 1);
  assert.equal(api.calls[2].metadata.latestUserMessageId, NEW_MESSAGE_ID);
});

test("claim conflict and lost heartbeat never perform terminal mutation", async () => {
  const claimConflict = fakeApi({ claim: 409 });
  const one = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: claimConflict.fetchImpl });
  assert.equal(one.claimConflicts, 1);
  assert.deepEqual(claimConflict.calls.map((call) => call.action), ["claim"]);

  const lostHeartbeat = fakeApi({ log: 409 });
  const two = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: lostHeartbeat.fetchImpl });
  assert.equal(two.lostLocks, 1);
  assert.deepEqual(lostHeartbeat.calls.map((call) => call.action), ["claim", "log"]);
});

test("uncertain log response attempts a safe terminal release and reports uncertainty", async () => {
  const api = fakeApi({ log: 500 });
  const result = await processSupportTickets({ automationToken: TOKEN, tickets: [entry()], fetchImpl: api.fetchImpl });
  assert.deepEqual(api.calls.map((call) => call.action), ["claim", "log", "failed"]);
  assert.equal(result.uncertain, 1);
  assert.equal(result.technicalHandoffs, 0);
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
  assert.deepEqual(calls, ["claim", "failed"]);
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
  assert.deepEqual(calls, ["claim", "failed"]);
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
  assert.deepEqual(calls, ["claim", "failed"]);
  assert.equal(result.uncertain, 1);
});
