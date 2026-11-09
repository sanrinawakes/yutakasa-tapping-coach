import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { digest, openExternalSupportLedger } from './external-support-ledger.mjs';
import { normalizeChatworkReceipt, normalizeGmailReceipt } from './external-support-intake.mjs';
import { CHATWORK_DOM_COLLECTOR_SOURCE } from './external-support-chatwork-dom.mjs';
import {
  buildRegressionArtifact, buildProductionArtifact, buildExternalSupportEvidence,
  externalEvidenceDigest,
} from './external-support-evidence.mjs';

const repository = 'sanrinawakes/yutakasa-tapping-coach';
const repositoryUrl = `https://github.com/${repository}`;

// All sources, run metadata, archive digests and provider receipts below are
// synthetic fixtures. This test proves the local protocol and fail-closed gates,
// not the truth of caller-attested originals, CI execution, observations or mail.
test('synthetic intake to sent is idempotent; caller attestations are not live verification', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'external-support-integration-')));
  fs.chmodSync(dir, 0o700);
  let clock = Date.parse('2026-01-02T12:00:00Z');
  const source = { kind: 'gmail', accountId: 'operator@example.invalid', scopeId: 'synthetic-inbox' };
  const config = {
    dbPath: path.join(dir, 'ledger.sqlite'), allowlist: [source], sources: { gmail: source },
    allowedSites: ['https://example.invalid/chat'], repositoryUrl,
  };
  const ledger = openExternalSupportLedger({ ...config, now: () => clock });
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const incoming = {
    sourceVerified: true, accountId: source.accountId,
    message: {
      id: 'aaaaaaaa00000001', thread_id: 'bbbbbbbb00000001', label_ids: ['INBOX'],
      internal_date: String(clock - 60_000),
      payload: {
        mime_type: 'text/plain', headers: [
          { name: 'From', value: 'Synthetic Client <client@example.invalid>' },
          { name: 'Subject', value: '豊かさBOTで質問後に回答がありません' },
        ], body: { content: 'Safariで質問を送信しても回答が返りません。' },
      },
    },
  };
  const event = normalizeGmailReceipt(incoming, config, ledger);
  const queued = ledger.ingest(event);
  assert.equal(queued.state, 'queued');
  let ownership = { caseId: queued.id, revision: queued.revision, owner: 'synthetic-investigation-owner' };
  ledger.claim({ ...ownership, leaseMs: 900_000 });
  ledger.setCondition({ ...ownership, siteUrl: config.allowedSites[0],
    condition: 'Synthetic known technical scenario: send, receive, reload and persist.' });
  const localBinding = ledger.bindWork(ownership);
  const publicBinding = { workId: localBinding.workId };
  assert.deepEqual(ledger.readWorkBinding(publicBinding), localBinding);

  const baseSha = '1'.repeat(40), headSha = '2'.repeat(40), productionSha = '3'.repeat(40);
  const deploymentId = 'dpl_SYNTHETICOnly01';
  const witness = (gitSha, passed, startedAt, finishedAt) => ({
    ...publicBinding, gitSha, status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1,
    tests: 1, clientErrorCount: 0, startedAt, finishedAt,
    result: { conditionObserved: true, expectedOutcome: passed ? 'success' : 'failure',
      unexpectedErrorCount: 0 },
  });
  const now = new Date('2026-01-02T12:31:00Z');
  const beforePath = '.github/workflows/external-support-condition.yml';
  const productionPath = '.github/workflows/external-support-production.yml';
  const beforePayload = buildRegressionArtifact({
    binding: publicBinding, workflowPath: beforePath, runId: 101, prNumber: 99, baseSha, headSha,
    beforeReceipt: witness(baseSha, false, '2026-01-02T12:00:00Z', '2026-01-02T12:00:30Z'),
    headReceipt: witness(headSha, true, '2026-01-02T12:01:00Z', '2026-01-02T12:01:30Z'), now,
  });
  const productionPayload = buildProductionArtifact({
    binding: publicBinding, workflowPath: productionPath, runId: 102, productionSha, deploymentId,
    productionReceipt: {
      ...publicBinding, productionSha, deploymentId, status: 'passed', success: true,
      dbVerified: true, reloadVerified: true, cleanupVerified: true, clientErrorCount: 0,
      startedAt: '2026-01-02T12:04:00Z', finishedAt: '2026-01-02T12:05:00Z',
      result: { conditionObserved: true, unexpectedErrorCount: 0, databaseRowsAfterCleanup: 0 },
    }, now,
  });
  for (const publicPayload of [beforePayload, productionPayload]) {
    const serialized = JSON.stringify(publicPayload);
    for (const privateValue of [localBinding.caseId, localBinding.siteUrl,
      localBinding.conditionDigest, event.body, event.recipient.address]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }
  const githubReceipt = (id, sha, workflowPath, name, payload, created_at, updated_at) => {
    const archiveSha256 = String(id === 101 ? 'a' : 'b').repeat(64);
    return {
      run: { id, status: 'completed', conclusion: 'success', run_attempt: 1,
        repository: { full_name: repository }, path: workflowPath,
        html_url: `${repositoryUrl}/actions/runs/${id}`, head_sha: sha,
        head_branch: 'main', event: 'workflow_dispatch', created_at, updated_at },
      listing: { total_count: 1, artifacts: [{ id: id + 1000, name, expired: false,
        size_in_bytes: 4096, digest: `sha256:${archiveSha256}`,
        workflow_run: { id, head_sha: sha } }] },
      archiveSha256, payloadCanonicalSha256: externalEvidenceDigest(payload), payload,
    };
  };
  const beforeHeadReceipt = githubReceipt(101, baseSha, beforePath, 'external-support-before-head',
    beforePayload, '2026-01-02T12:00:00Z', '2026-01-02T12:02:00Z');
  const productionReceipt = githubReceipt(102, productionSha, productionPath,
    'external-support-production', productionPayload, '2026-01-02T12:04:00Z', '2026-01-02T12:06:00Z');
  const pullRequest = {
    number: 99, html_url: `${repositoryUrl}/pull/99`, state: 'closed', merged: true,
    merged_at: '2026-01-02T12:03:00Z', merge_commit_sha: productionSha,
    head: { sha: headSha, repo: { full_name: repository } },
    base: { sha: baseSha, ref: 'main', repo: { full_name: repository } },
  };
  const evidence = buildExternalSupportEvidence({
    binding: ledger.readWorkBinding(publicBinding), pullRequest, beforeHeadReceipt, productionReceipt,
    observations: ['12:10:00', '12:20:00', '12:30:00'].map(at => ({
      ...localBinding, at: `2026-01-02T${at}Z`, success: true,
      productionSha, deploymentId, clientErrorCount: 0,
    })), verifiedAt: now.toISOString(), now,
  });
  clock = now.getTime();
  ownership = { ...ownership, owner: 'synthetic-release-owner' };
  ledger.claim({ ...ownership, leaseMs: 900_000 });
  ledger.recordEvidence({ ...ownership, evidence });
  assert.equal(ledger.summary({ caseId: queued.id }).state, 'ready_to_reply');

  const body = 'ご不便をおかけしました。修正と確認が完了しました。もう一度ご利用ください。';
  const reserved = ledger.reserveReply({ ...ownership, purpose: 'completion', recipient: event.recipient, body });
  assert.equal(ledger.reserveReply({ ...ownership, purpose: 'completion', recipient: event.recipient, body }).operationId,
    reserved.operationId);
  ledger.markSending({ ...ownership, operationId: reserved.operationId });
  // A real transport must perform exactly one send and directly read its provider
  // result. This fixture performs no network action and attests no actual send.
  const readBackReceipt = {
    operationId: reserved.operationId, messageId: 'cccccccc00000001', sentAt: now.toISOString(),
    recipient: event.recipient, bodyHash: digest(body),
  };
  assert.equal(ledger.recordReceipt({ ...ownership, operationId: reserved.operationId,
    receipt: readBackReceipt }).status, 'sent');
  assert.equal(ledger.summary({ caseId: queued.id }).state, 'sent');
  const repeated = ledger.ingest(normalizeGmailReceipt(incoming, config, ledger));
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.state, 'sent');
  assert.equal(ledger.readCase({ caseId: queued.id }).outbox.length, 1);
  assert.throws(() => ledger.claim({ ...ownership, owner: 'resend-attempt' }),
    error => error.code === 'CASE_NOT_ACTIONABLE');
  const ownReply = structuredClone(incoming);
  ownReply.message.id = readBackReceipt.messageId;
  ownReply.message.label_ids = ['SENT'];
  ownReply.message.payload.headers[0].value = source.accountId;
  ownReply.message.payload.body.content = body;
  assert.equal(normalizeGmailReceipt(ownReply, config, ledger), null);
});

test('a deleted Chatwork tombstone preserves valid intake but blocks scan cursor advancement', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'external-support-chatwork-integration-')));
  fs.chmodSync(dir, 0o700);
  const accountId = '200', roomId = '100000001';
  const validMessageId = '2170000000000000001', deletedMessageId = '2170000000000000002';
  const nowUnix = 1_794_050_000, fromUnix = nowUnix - 1_000;
  const source = { kind: 'chatwork', accountId, scopeId: roomId };
  const config = {
    dbPath: path.join(dir, 'ledger.sqlite'), allowlist: [source], sources: { chatwork: source },
    allowedSites: ['https://example.invalid/chat'], repositoryUrl,
  };
  const ledger = openExternalSupportLedger({ ...config, now: () => nowUnix * 1_000 });
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const html = `<!doctype html><html><body>
    <section id="_messageId${validMessageId}" data-mid="${validMessageId}" data-rid="${roomId}" data-deleted="0">
      <div data-aid="300" data-source="timeline_message_avatar_profile" data-testid="user-icon">Synthetic reporter</div>
      <span data-tm="${nowUnix - 1_200}">synthetic time</span>
      <pre><span>豊かさBOTで質問後に回答がありません。</span></pre>
    </section>
    <section id="_messageId${deletedMessageId}" data-mid="${deletedMessageId}" data-rid="${roomId}" data-deleted="1"></section>
  </body></html>`;
  const dom = new JSDOM(html, { url: `https://www.chatwork.com/#!rid${roomId}` });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  const beforeDOM = dom.serialize();
  const options = {
    verifiedAccountId: accountId, roomId, allowlist: [source], callerAccountVerified: true,
    callerRoomVerified: true, callerHistoryVerified: true, callerTailVerified: true,
    fromUnix, nowUnix,
  };
  const collected = JSON.parse(JSON.stringify(vm.runInNewContext(
    `${CHATWORK_DOM_COLLECTOR_SOURCE}(options)`, { document: dom.window.document, URL, options },
  )));
  assert.equal(dom.serialize(), beforeDOM, 'collector must not mutate the synthetic source DOM');
  assert.deepEqual(collected.receipts.map(receipt => receipt.messageId), [validMessageId]);
  assert.deepEqual(collected.unverifiedMessageIds, [deletedMessageId]);
  assert.deepEqual(collected.deferred,
    [{ messageId: deletedMessageId, reason: 'deleted_message_unavailable' }]);
  assert.equal(collected.sourceLoaded, true);
  assert.equal(collected.paginationComplete, false);

  const queued = ledger.ingest(normalizeChatworkReceipt(collected.receipts[0], config, ledger));
  assert.equal(queued.state, 'queued');
  const cursorBefore = ledger.getScanCursor({ source });
  assert.throws(() => ledger.recordScanComplete({
    source: collected.source, sourceVerified: collected.collectorVerified,
    expectedRevision: cursorBefore.cursorRevision,
    from: new Date(fromUnix * 1_000).toISOString(),
    to: new Date(nowUnix * 1_000).toISOString(),
    sourceLoaded: collected.sourceLoaded, paginationComplete: collected.paginationComplete,
  }), error => error.code === 'INCOMPLETE_SOURCE_SCAN');
  assert.deepEqual(ledger.getScanCursor({ source }), cursorBefore);
});
