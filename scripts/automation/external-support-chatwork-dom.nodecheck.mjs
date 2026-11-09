import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { collectChatworkDOM, CHATWORK_DOM_COLLECTOR_SOURCE } from './external-support-chatwork-dom.mjs';

// Identifiers and prose are synthetic; only the rendered attribute schema and
// download-link shape come from observation, not any customer's private record.
const ACCOUNT = '200', ROOM = '100000001', NOW = 1_794_050_000;
const firstId = '2170000000000000001', secondId = '2170000000000000002';
const options = {
  verifiedAccountId: ACCOUNT, roomId: ROOM,
  allowlist: [{ kind: 'chatwork', accountId: ACCOUNT, scopeId: ROOM }],
  callerAccountVerified: true, callerRoomVerified: true, fromUnix: NOW - 1000, nowUnix: NOW,
  callerHistoryVerified: true, callerTailVerified: true,
};
const golden = `<!doctype html><html><body>
  <section id="_messageId${firstId}" data-rid="${ROOM}" data-mid="${firstId}">
    <div data-aid="300" data-source="timeline_message_avatar_profile" data-testid="user-icon">Reporter</div><time data-tm="${NOW - 1200}">10:34</time>
    <pre><span>合成問い合わせです。
豊かさBOTの合成シナリオで回答を確認してください。
返信元の表示と添付ラベルも本文のまま残す
synthetic-screen.jpeg (30.11 KB)</span></pre>
    <div data-cwopen="[info]" data-cwclose="[/info]">
      <div data-cwopen="[download:1234567890]" data-cwclose="[/download]">
        <a href="/gateway/download_file.php?bin=1&amp;file_id=1234567890&amp;preview=0" target="_downloadFrame" tabindex="-1">synthetic-screen.jpeg (30.11 KB)</a>
        <a data-file-id="1234567890" data-type="chatworkImagePreview" data-mime-type="image/jpeg">preview</a>
      </div>
    </div>
  </section>
  <section id="_messageId${secondId}" data-rid="${ROOM}" data-mid="${secondId}">
    <div data-aid="${ACCOUNT}" data-source="timeline_message_avatar_profile" data-testid="user-icon">Operator</div><time data-tm="${NOW - 300}">12:17</time>
    <pre><span>利用先URLと発生時刻をご確認ください。</span></pre>
  </section>
</body></html>`;

function run(html = golden, override = {}, hideBaseURI = false) {
  const dom = new JSDOM(html, { url: `https://www.chatwork.com/#!rid${ROOM}` });
  // jsdom does not lay out rendered text. The golden fixture has no styling or
  // scripts, so textContent supplies the observed innerText contract in tests.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  if (hideBaseURI) Object.defineProperty(dom.window.document, 'baseURI', { value: undefined });
  const before = dom.serialize();
  const actual = vm.runInNewContext(`${CHATWORK_DOM_COLLECTOR_SOURCE}(options)`, {
    document: dom.window.document, URL, options: { ...options, ...override },
  });
  assert.equal(dom.serialize(), before, 'collector must never mutate the DOM');
  return JSON.parse(JSON.stringify(actual));
}

test('golden observed message attributes produce exact private receipts without UI changes', () => {
  const result = run();
  assert.equal(result.schema, 'yutakasa-chatwork-dom-receipts-v1');
  assert.equal(result.collectorVerified, true);
  assert.equal(result.sourceLoaded, true);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.oldestLoadedUnix, NOW - 1200);
  assert.deepEqual(result.receipts.map(r => r.messageId), [firstId, secondId]);
  assert.equal(result.receipts[0].authorAccountId, '300');
  assert.equal(result.receipts[1].authorAccountId, ACCOUNT);
  assert.equal(result.receipts[0].accountId, ACCOUNT);
  assert.equal(result.receipts[0].sourceVerified, true);
  assert.match(result.receipts[0].body, /返信元の表示と添付ラベルも本文のまま残す/);
  assert.match(result.receipts[0].body, /synthetic-screen\.jpeg \(30\.11 KB\)/);
  assert.deepEqual(result.receipts[0].attachments,
    [{ fileId: '1234567890', filename: 'synthetic-screen.jpeg', mimeType: 'image/jpeg', sizeBytes: null,
      sourceUploadedPreviewVerified: true }]);
  assert.equal(result.receipts[0].replyToMessageId, undefined);
  assert.equal(result.receipts[0].editedAtUnix, undefined);
  assert.equal(result.receipts[0].currentProseVerified, true);
  assert.equal(result.receipts[0].currentProseMessageId, firstId);
  assert.equal(result.receipts[0].currentProse, result.receipts[0].body);
});

test('account and room authority comes only from caller-verified exact allowlist scope', () => {
  for (const patch of [
    { callerAccountVerified: false }, { callerRoomVerified: false },
    { verifiedAccountId: '300' }, { roomId: '999' }, { allowlist: [] },
    { allowlist: [{ kind: 'gmail', accountId: ACCOUNT, scopeId: ROOM }] },
  ]) assert.throws(() => run(golden, patch), /DOM_(?:CALLER_VERIFICATION_REQUIRED|SCOPE_NOT_ALLOWED)/);
  assert.throws(() => run(golden, { verifiedAccountId: Number(ACCOUNT) }), /DOM_VERIFIED_IDENTITY_REQUIRED/);
});

test('missing or inconsistent immutable IDs, room, time and prose reject the batch', () => {
  for (const html of [
    golden.replace(` data-mid="${firstId}"`, ''),
    golden.replace(`data-mid="${firstId}"`, `data-mid="${secondId}"`),
    golden.replace(`data-rid="${ROOM}"`, 'data-rid="999"'),
    golden.replace(` data-tm="${NOW - 1200}"`, ''),
    golden.replace(`data-tm="${NOW - 1200}"`, `data-tm="${NOW + 1}"`),
    golden.replace(`data-tm="${NOW - 1200}"`, 'data-tm="0"'),
    golden.replace('<pre>', '<div>').replace('</pre>', '</div>'),
    golden.replace(`_messageId${secondId}`, `_messageId${firstId}`).replace(`data-mid="${secondId}"`, `data-mid="${firstId}"`),
  ]) assert.throws(() => run(html), /DOM_/);
});

test('unloaded, loading or incomplete history never certifies zero matching messages', () => {
  const empty = run('<html><body><p>room</p></body></html>');
  assert.deepEqual(empty.receipts, []);
  assert.equal(empty.sourceLoaded, false);
  assert.equal(empty.paginationComplete, false);
  assert.equal(empty.oldestLoadedUnix, null);
  const loading = run(golden.replace('</body>', '<p>メッセージを読み込んでいます</p></body>'));
  assert.equal(loading.sourceLoaded, true);
  assert.equal(loading.loading, true);
  assert.equal(loading.paginationComplete, false);
  const partial = run(golden, { fromUnix: NOW - 3600 });
  assert.equal(partial.sourceLoaded, true);
  assert.equal(partial.paginationComplete, false);
  assert.equal(run(golden, { callerHistoryVerified: false }).paginationComplete, false);
  assert.equal(run(golden, { callerTailVerified: false }).paginationComplete, false);
  assert.equal(run(golden, { callerHistoryVerified: undefined, callerTailVerified: undefined }).paginationComplete, false);
});

test('consecutive messages with omitted author are deferred without inheriting or blocking valid receipts', () => {
  const missing = golden.replace(' data-aid="300"', '');
  const result = run(missing);
  assert.equal(result.sourceLoaded, true);
  assert.equal(result.paginationComplete, false);
  assert.equal(result.oldestLoadedUnix, NOW - 1200);
  assert.deepEqual(result.receipts.map(r => r.messageId), [secondId]);
  assert.deepEqual(result.unverifiedMessageIds, [firstId]);
  assert.deepEqual(result.deferred, [{ messageId: firstId, reason: 'author_header_unverified' }]);
});

test('empty deleted message roots are deferred without blocking valid siblings or completing coverage', () => {
  const deletedId = '2170000000000000003';
  const tombstone = `<div id="_messageId${deletedId}" data-mid="${deletedId}" data-rid="${ROOM}" data-deleted="1"></div>`;
  const result = run(golden.replace('</body>', tombstone + '</body>'));
  assert.deepEqual(result.receipts.map(receipt => receipt.messageId), [firstId, secondId]);
  assert.deepEqual(result.deferred, [{ messageId: deletedId, reason: 'deleted_message_unavailable' }]);
  assert.deepEqual(result.unverifiedMessageIds, [deletedId]);
  assert.equal(result.sourceLoaded, true);
  assert.equal(result.oldestLoadedUnix, NOW - 1200);
  assert.equal(result.paginationComplete, false);
  const onlyDeleted = run(`<html><body>${tombstone}</body></html>`);
  assert.deepEqual(onlyDeleted.receipts, []);
  assert.deepEqual(onlyDeleted.deferred, result.deferred);
  assert.equal(onlyDeleted.sourceLoaded, false);
  assert.equal(onlyDeleted.oldestLoadedUnix, null);
  assert.equal(onlyDeleted.paginationComplete, false);
});

test('deleted roots cannot expose stale prose or bypass immutable identity and room guards', () => {
  const deleted = golden.replace(`data-mid="${firstId}"`, `data-mid="${firstId}" data-deleted="1"`);
  const result = run(deleted);
  assert.deepEqual(result.receipts.map(receipt => receipt.messageId), [secondId]);
  assert.deepEqual(result.deferred, [{ messageId: firstId, reason: 'deleted_message_unavailable' }]);
  assert.equal(result.oldestLoadedUnix, NOW - 300, 'deleted timestamps are not coverage evidence');
  assert.equal(result.paginationComplete, false);
  for (const html of [
    deleted.replace(`data-mid="${firstId}"`, `data-mid="${secondId}"`),
    deleted.replace(`data-rid="${ROOM}"`, 'data-rid="999"'),
    deleted.replace(`_messageId${secondId}`, `_messageId${firstId}`).replace(`data-mid="${secondId}"`, `data-mid="${firstId}"`),
  ]) assert.throws(() => run(html), /DOM_(?:MESSAGE_ID_MISMATCH|MESSAGE_ROOM_MISMATCH|DUPLICATE_MESSAGE_ID)/);
  assert.throws(() => run(golden.replace(` data-tm="${NOW - 1200}"`, '')), /DOM_MESSAGE_TIME_REQUIRED/);
});

test('rendered upload tag and exact preview verify MIME; display size never guesses bytes', () => {
  const html = golden.replaceAll('synthetic-screen.jpeg (30.11 KB)', 'long (name).png (2 MiB)');
  assert.deepEqual(run(html).receipts[0].attachments,
    [{ fileId: '1234567890', filename: 'long (name).png', mimeType: 'image/jpeg', sizeBytes: null,
      sourceUploadedPreviewVerified: true }]);
  const noSize = golden.replaceAll('synthetic-screen.jpeg (30.11 KB)', 'file (name).jpeg');
  assert.equal(run(noSize).receipts[0].attachments[0].filename, 'file (name).jpeg');
  const external = golden.replace('/gateway/download_file.php',
    'https://untrusted.example.invalid/gateway/download_file.php');
  assert.throws(() => run(external), /DOM_ATTACHMENT_LINK_INVALID/);
  assert.throws(() => run(golden.replace('file_id=1234567890', 'file_id=bad')), /DOM_ATTACHMENT_ID_REQUIRED/);
  assert.throws(() => run(golden.replace('file_id=1234567890', 'file_id=1234567890&amp;file_id=123')),
    /DOM_ATTACHMENT_ID_REQUIRED/);
});

test('a pasted same-origin download URL is prose, not a verified uploaded attachment', () => {
  const withoutUploadUI = golden.replace(/    <div data-cwopen="\[info\]"[\s\S]*?    <\/div>/,
    '<pre><a href="https://www.chatwork.com/gateway/download_file.php?file_id=1234567890">https://www.chatwork.com/gateway/download_file.php?file_id=1234567890</a></pre>');
  assert.deepEqual(run(withoutUploadUI).receipts[0].attachments, []);
  assert.deepEqual(run(withoutUploadUI.replace('file_id=1234567890', 'file_id=bad')).receipts[0].attachments, []);
  assert.throws(() => run(golden.replace('data-cwopen="[download:1234567890]"',
    'data-cwopen="[download:999]"')), /DOM_ATTACHMENT_ID_REQUIRED/);
  assert.throws(() => run(golden.replace('data-file-id="1234567890"', 'data-file-id="999"')),
    /DOM_ATTACHMENT_PREVIEW_MISMATCH/);
  assert.throws(() => run(golden.replace(' data-mime-type="image/jpeg"', '')),
    /DOM_ATTACHMENT_MIME_REQUIRED/);
});

test('reply ancestry requires matching rendered CW tag and visible source IDs, never reply-aid authorship', () => {
  const replyId = '2170000000000000999';
  const replyUI = `<div data-cwtag="[rp aid=400 to=${ROOM}-${replyId}]" data-aid="400"><div aria-label="返信元を見る" data-rid="${ROOM}" data-mid="${replyId}">返信元の合成表示</div></div>`;
  const withReply = golden.replace('<pre>', `<pre>${replyUI}`);
  const result = run(withReply);
  assert.equal(result.receipts[0].authorAccountId, '300');
  assert.equal(result.receipts[0].replyToMessageId, replyId);
  assert.match(result.receipts[0].body, /返信元の合成表示/);
  assert.equal(result.receipts[0].currentProseVerified, true);
  assert.equal(result.receipts[0].currentProseMessageId, firstId);
  assert.equal(result.receipts[0].currentProse.includes('返信元の合成表示'), false);
  assert.deepEqual(run(withReply.replace(' data-aid="300"', '')).unverifiedMessageIds, [firstId]);
  const mismatch = run(withReply.replace(`data-mid="${replyId}"`, 'data-mid="2170000000000000998"'));
  assert.deepEqual(mismatch.deferred, [{ messageId: firstId, reason: 'reply_metadata_unverified' }]);
  assert.equal(mismatch.paginationComplete, false);
  assert.deepEqual(mismatch.receipts.map(r => r.messageId), [secondId]);
  const onlyProse = run(golden.replace('<pre>', `<pre>[rp aid=400 to=${ROOM}-${replyId}]\n`));
  assert.equal(onlyProse.receipts[0].replyToMessageId, undefined);
  assert.deepEqual(run(golden.replace('data-source="timeline_message_avatar_profile"',
    'data-source="other-profile"')).unverifiedMessageIds, [firstId]);
});

test('current prose is separately ID-bound only across known DOM boundaries, never guessed quote text', () => {
  const unknown = golden.replace('<pre>', '<pre><div data-cwtag="[qt]">別件です。これは引用</div>');
  const result = run(unknown).receipts[0];
  assert.match(result.body, /別件です。これは引用/);
  assert.equal(result.currentProseVerified, undefined);
  const unknownNoAttribute = golden.replace('<pre>', '<pre><div>未知の引用構造</div>');
  assert.equal(run(unknownNoAttribute).receipts[0].currentProseVerified, undefined);
  const lineBreak = run(golden.replace('合成問い合わせです。', '合成<br>問い合わせです。')).receipts[0];
  assert.match(lineBreak.currentProse, /合成\n問い合わせです。/);
  const wrapped = golden.replace('<pre>', '<pre><div data-cwopen="[info]" data-cwclose="[/info]"><div>')
    .replace('</pre>', '</div></div></pre>');
  const wrappedReceipt = run(wrapped).receipts[0];
  assert.equal(wrappedReceipt.currentProseVerified, true);
  assert.equal(wrappedReceipt.currentProseMessageId, firstId);
  assert.equal(wrappedReceipt.currentProse, wrappedReceipt.body);
  const quotedInfo = wrapped.replace('<span>合成問い合わせです。', '<span><div data-cwtag="[qt]">別件です。引用</div>合成問い合わせです。');
  assert.equal(run(quotedInfo).receipts[0].currentProseVerified, undefined);
  for (const unknownSpan of [
    golden.replace('<span>', '<span data-cwtag="[qt]">'),
    golden.replace('<span>', '<span class="unknown-quote">'),
    golden.replace('<span>', '<span><b>未知markup</b>'),
  ]) assert.equal(run(unknownSpan).receipts[0].currentProseVerified, undefined);
});

test('observed generic file preview verifies video identity, URL and MIME without guessing', () => {
  const video = golden.replaceAll('synthetic-screen.jpeg (30.11 KB)', 'video.mov (14.5 MB)')
    .replace('data-file-id="1234567890" data-type="chatworkImagePreview" data-mime-type="image/jpeg"',
      'data-type="chatworkFilePreview" data-url="gateway/download_file.php?bin=1&amp;file_id=1234567890&amp;preview=1" data-mime-type="video/quicktime" data-content-id="video.mov"');
  assert.deepEqual(run(video).receipts[0].attachments,
    [{ fileId: '1234567890', filename: 'video.mov', mimeType: 'video/quicktime', sizeBytes: null,
      sourceUploadedPreviewVerified: true }]);
  assert.deepEqual(run(video, {}, true), run(video));
  for (const invalid of [
    video.replace('data-content-id="video.mov"', 'data-content-id="other.mov"'),
    video.replace('data-url="gateway/', 'data-url="https://untrusted.example.invalid/gateway/'),
    video.replace('data-url="gateway/download_file.php?bin=1&amp;file_id=1234567890',
      'data-url="gateway/download_file.php?bin=1&amp;file_id=999'),
  ]) assert.throws(() => run(invalid), /DOM_ATTACHMENT_PREVIEW_MISMATCH/);
});

test('relative upload and preview URLs work with document.baseURI unavailable like live CUA', () => {
  assert.deepEqual(run(golden, {}, true), run(golden));
  assert.doesNotMatch(CHATWORK_DOM_COLLECTOR_SOURCE, /document\.(?:baseURI|location|URL)|\b(?:window|history)\./);
});

test('upload UI never removes customer symptoms or separate-issue prose from its info ancestor', () => {
  const upload = golden.match(/    <div data-cwopen="\[info\]"[\s\S]*?    <\/div>/)[0];
  const nested = golden.replace(upload, '').replace('<pre>', '<pre>' + upload.replace(
    '<div data-cwopen="[info]" data-cwclose="[/info]">',
    '<div data-cwopen="[info]" data-cwclose="[/info]">別件です。新しい不具合があります。'));
  const message = run(nested).receipts[0];
  assert.equal(message.currentProseVerified, true);
  assert.match(message.currentProse, /別件です。新しい不具合があります。/);
  assert.equal(message.currentProse.includes('synthetic-screen.jpeg'), true,
    'the original prose also contains a filename and must not be semantically removed');
  assert.match(message.body, /synthetic-screen.jpeg/);
  const unknownUploadText = nested.replace('<div data-cwopen="[download:1234567890]" data-cwclose="[/download]">',
    '<div data-cwopen="[download:1234567890]" data-cwclose="[/download]">回答がありません。');
  assert.equal(run(unknownUploadText).receipts[0].currentProseVerified, undefined);
});

test('observed empty preview tag is excluded only when verified upload, image, height and URL agree', () => {
  const preview = '<div data-cwtag="[preview id=1234567890 ht=150]"><img data-file-id="1234567890" height="150" src="gateway/preview_file.php?bin=1&amp;preview=1&amp;file_id=1234567890" alt=""></div>';
  const withPreview = golden.replace('<pre>', '<pre>' + preview);
  const original = run(golden).receipts[0];
  const result = run(withPreview, {}, true).receipts[0];
  assert.equal(result.currentProseVerified, true);
  assert.equal(result.currentProseMessageId, firstId);
  assert.equal(result.currentProse, original.currentProse);
  assert.deepEqual(result.attachments, original.attachments);
  for (const invalid of [
    withPreview.replace('data-cwtag="[preview id=1234567890 ht=150]"',
      'data-cwtag="[preview id=999 ht=150]"'),
    withPreview.replace('img data-file-id="1234567890"', 'img data-file-id="999"'),
    withPreview.replace('height="150"', 'height="151"'),
    withPreview.replace('alt=""', 'alt="回答がありません"'),
    withPreview.replace('src="gateway/preview_file.php', 'src="https://untrusted.example.invalid/gateway/preview_file.php'),
    withPreview.replace('preview=1&amp;file_id=1234567890', 'preview=1&amp;file_id=999'),
    withPreview.replace('<img data-file-id=', '新しい不具合です<img data-file-id='),
  ]) assert.equal(run(invalid).receipts[0].currentProseVerified, undefined);
});

test('serialized collector is self-contained, read-only and does not output private prose', () => {
  assert.equal(typeof collectChatworkDOM, 'function');
  assert.match(CHATWORK_DOM_COLLECTOR_SOURCE, /^\(function collectChatworkDOM/);
  assert.doesNotMatch(CHATWORK_DOM_COLLECTOR_SOURCE,
    /\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|console|process|require|click|dispatchEvent|setAttribute|appendChild|removeChild)\s*[.(]/);
  assert.equal(run().receipts.length, 2);
  assert.doesNotMatch(CHATWORK_DOM_COLLECTOR_SOURCE, /new TextEncoder\(/);
  assert.throws(() => run(golden.replace('合成問い合わせです。', 'あ'.repeat(70_000))),
    /DOM_MESSAGE_BODY_REQUIRED/);
  assert.throws(() => run(golden.replace('合成問い合わせです。', '😀'.repeat(50_000))),
    /DOM_MESSAGE_BODY_REQUIRED/);
  assert.throws(() => run(golden, { fromUnix: NOW + 1 }), /DOM_SCAN_WINDOW_INVALID/);
  assert.throws(() => run(golden, { nowUnix: 0 }), /DOM_SCAN_WINDOW_INVALID/);
});
