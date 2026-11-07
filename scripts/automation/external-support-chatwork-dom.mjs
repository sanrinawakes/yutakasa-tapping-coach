/**
 * Read-only, closure-free DOM collector for the observed Chatwork message UI.
 * The caller must separately verify the signed-in account and selected room in
 * the existing visible UI. Customer prose must never supply these arguments.
 * callerHistoryVerified attests a continuously loaded normal-room timeline, not
 * a search/jump result or the oldest timestamp alone. callerTailVerified attests
 * its current tail. Without both, no complete scan can be recorded.
 * Return values are private receipts: save them in a mode-0600 private file, not
 * stdout, a public artifact, a log, an Issue or a PR. No transport runs here.
 */
export function collectChatworkDOM(options) {
  const reject = code => { throw new Error(code); };
  const requireValue = (value, code) => { if (!value) reject(code); };
  requireValue(options && typeof options === 'object' && !Array.isArray(options), 'DOM_OPTIONS_REQUIRED');
  const { verifiedAccountId, roomId, allowlist, callerAccountVerified, callerRoomVerified,
    callerHistoryVerified, callerTailVerified, fromUnix, nowUnix } = options;
  requireValue(typeof verifiedAccountId === 'string' && /^\d+$/.test(verifiedAccountId) &&
    typeof roomId === 'string' && /^\d+$/.test(roomId), 'DOM_VERIFIED_IDENTITY_REQUIRED');
  requireValue(callerAccountVerified === true && callerRoomVerified === true,
    'DOM_CALLER_VERIFICATION_REQUIRED');
  requireValue(Array.isArray(allowlist) && allowlist.some(scope => scope?.kind === 'chatwork' &&
    scope.accountId === verifiedAccountId && scope.scopeId === roomId), 'DOM_SCOPE_NOT_ALLOWED');
  requireValue(Number.isSafeInteger(nowUnix) && nowUnix > 0 && Number.isSafeInteger(fromUnix) &&
    fromUnix >= 0 && fromUnix <= nowUnix, 'DOM_SCAN_WINDOW_INVALID');
  requireValue(typeof document !== 'undefined' && document.body &&
    typeof document.querySelectorAll === 'function', 'DOM_DOCUMENT_REQUIRED');

  const roots = [...document.querySelectorAll('[id^="_messageId"]')];
  requireValue(roots.length <= 500, 'DOM_MESSAGE_LIMIT');
  const visibleText = document.body.innerText;
  requireValue(typeof visibleText === 'string', 'DOM_VISIBLE_TEXT_REQUIRED');
  const loading = visibleText.includes('メッセージを読み込んでいます');
  const seen = new Set();
  const unverifiedMessageIds = [];
  const deferred = [];
  const defer = (messageId, reason) => { unverifiedMessageIds.push(messageId); deferred.push({ messageId, reason }); return null; };
  const loadedTimes = [];
  // CUA's read-only DOM sandbox does not expose TextEncoder. Count UTF-8 bytes
  // without browser APIs or hidden state (unpaired surrogates encode as 3 bytes).
  const utf8Bytes = value => { let count = 0; for (const character of value) {
    const point = character.codePointAt(0); count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  } return count; };
  let totalBytes = 0;
  const receipts = roots.map(root => {
    const id = root.getAttribute('id')?.match(/^_messageId(\d{10,})$/)?.[1];
    requireValue(id && root.getAttribute('data-mid') === id, 'DOM_MESSAGE_ID_MISMATCH');
    requireValue(root.getAttribute('data-rid') === roomId, 'DOM_MESSAGE_ROOM_MISMATCH');
    requireValue(!seen.has(id), 'DOM_DUPLICATE_MESSAGE_ID');
    seen.add(id);
    const rawTime = root.querySelector('[data-tm]')?.getAttribute('data-tm');
    requireValue(typeof rawTime === 'string' && /^\d+$/.test(rawTime), 'DOM_MESSAGE_TIME_REQUIRED');
    const createdAtUnix = Number(rawTime);
    requireValue(Number.isSafeInteger(createdAtUnix) && createdAtUnix > 0 &&
      createdAtUnix <= nowUnix, 'DOM_MESSAGE_TIME_INVALID');
    loadedTimes.push(createdAtUnix);
    const headers = [...root.querySelectorAll('[data-aid][data-source="timeline_message_avatar_profile"][data-testid="user-icon"]')]
      .filter(element => !element.closest('pre'));
    const authorAccountId = headers[0]?.getAttribute('data-aid');
    if (typeof authorAccountId !== 'string' || !/^\d+$/.test(authorAccountId)) {
      // Consecutive posts may omit the author header in the real UI. Do not
      // inherit an author from another root or drop other valid messages.
      return defer(id, 'author_header_unverified');
    }
    if (headers.some(header => header.getAttribute('data-aid') !== authorAccountId)) {
      return defer(id, 'author_header_unverified');
    }
    const prose = root.querySelector('pre');
    const body = prose?.innerText;
    requireValue(typeof body === 'string' && body.trim().length > 0 &&
      utf8Bytes(body) <= 200_000 && !body.includes('\0'), 'DOM_MESSAGE_BODY_REQUIRED');
    totalBytes += utf8Bytes(body);
    requireValue(totalBytes <= 1_000_000, 'DOM_RECEIPT_BATCH_LIMIT');
    let replyToMessageId;
    const replyTag = prose.firstElementChild;
    const rawReplyTag = replyTag?.getAttribute('data-cwtag');
    if (typeof rawReplyTag === 'string' && rawReplyTag.startsWith('[rp')) {
      const reply = rawReplyTag.match(/^\[rp aid=(\d+) to=(\d+)-(\d{10,})\]$/);
      const replySource = replyTag.querySelector('div[aria-label="返信元を見る"][data-rid][data-mid]');
      if (!reply || replyTag.tagName !== 'DIV' || reply[2] !== roomId ||
          replySource?.getAttribute('data-rid') !== roomId ||
          replySource?.getAttribute('data-mid') !== reply[3]) {
        return defer(id, 'reply_metadata_unverified');
      }
      replyToMessageId = reply[3];
    }
    const attachments = new Map();
    const verifiedAttachmentUI = new Set();
    for (const anchor of root.querySelectorAll('a[href*="file_id="]')) {
      const wrapper = anchor.parentElement;
      const info = wrapper?.parentElement;
      const wrapperId = wrapper?.getAttribute('data-cwopen')?.match(/^\[download:(\d+)\]$/)?.[1];
      if (!wrapperId || wrapper?.tagName !== 'DIV' ||
          wrapper.getAttribute('data-cwclose') !== '[/download]' ||
          info?.tagName !== 'DIV' || info.getAttribute('data-cwopen') !== '[info]' ||
          info.getAttribute('data-cwclose') !== '[/info]' ||
          anchor.getAttribute('target') !== '_downloadFrame') continue;
      let url;
      try { url = new URL(anchor.getAttribute('href'), 'https://www.chatwork.com/'); }
      catch { reject('DOM_ATTACHMENT_LINK_INVALID'); }
      // A pasted URL is only prose. Accept only the observed rendered CW upload
      // tags and matching preview identity, never a CSS hash or URL alone.
      requireValue(url.origin === 'https://www.chatwork.com' &&
        url.pathname === '/gateway/download_file.php', 'DOM_ATTACHMENT_LINK_INVALID');
      const fileIds = url.searchParams.getAll('file_id');
      requireValue(fileIds.length === 1 && /^\d+$/.test(fileIds[0]) && fileIds[0] === wrapperId,
        'DOM_ATTACHMENT_ID_REQUIRED');
      const label = anchor.innerText;
      requireValue(typeof label === 'string', 'DOM_ATTACHMENT_LABEL_REQUIRED');
      const filename = label.trim().replace(/\s+\(\s*\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*\)$/iu, '').trim();
      requireValue(filename.length > 0 && filename.length <= 255 && !filename.includes('\0'),
        'DOM_ATTACHMENT_LABEL_REQUIRED');
      const previews = [...wrapper.querySelectorAll('a[data-type="chatworkImagePreview"],a[data-type="chatworkFilePreview"]')];
      requireValue(previews.length === 1, 'DOM_ATTACHMENT_PREVIEW_MISMATCH');
      const preview = previews[0];
      if (preview.getAttribute('data-type') === 'chatworkImagePreview') {
        requireValue(preview.getAttribute('data-file-id') === fileIds[0], 'DOM_ATTACHMENT_PREVIEW_MISMATCH');
      } else {
        let previewURL;
        try { previewURL = new URL(preview.getAttribute('data-url'), 'https://www.chatwork.com/'); }
        catch { reject('DOM_ATTACHMENT_PREVIEW_MISMATCH'); }
        const previewIds = previewURL.searchParams.getAll('file_id');
        requireValue(previewURL.origin === 'https://www.chatwork.com' &&
          previewURL.pathname === '/gateway/download_file.php' && previewIds.length === 1 &&
          previewIds[0] === fileIds[0] && preview.getAttribute('data-content-id') === filename,
        'DOM_ATTACHMENT_PREVIEW_MISMATCH');
      }
      const mimeType = preview.getAttribute('data-mime-type');
      requireValue(typeof mimeType === 'string' && mimeType.length <= 100 &&
        /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mimeType), 'DOM_ATTACHMENT_MIME_REQUIRED');
      const prior = attachments.get(fileIds[0]);
      requireValue(!prior || prior.filename === filename, 'DOM_ATTACHMENT_LABEL_CONFLICT');
      totalBytes += utf8Bytes(filename);
      requireValue(totalBytes <= 1_000_000, 'DOM_RECEIPT_BATCH_LIMIT');
      attachments.set(fileIds[0], { fileId: fileIds[0], filename, mimeType, sizeBytes: null,
        sourceUploadedPreviewVerified: true });
      // The info ancestor may also contain the customer's actual symptom.
      // Exclude only this proven download/preview UI, never the whole info box.
      const onlyKnownUploadUI = [...wrapper.childNodes].every(node =>
        (node.nodeType === 3 && !node.textContent.trim()) || node === anchor || node === preview);
      if (onlyKnownUploadUI) verifiedAttachmentUI.add(wrapper);
    }
    requireValue(attachments.size <= 25, 'DOM_ATTACHMENT_LIMIT');
    // The observed empty image-preview UI can precede the download tag. Remove
    // it only when the already verified upload, literal tag and IMG all agree.
    for (const previewUI of root.querySelectorAll('div[data-cwtag]')) {
      const tag = previewUI.getAttribute('data-cwtag')?.match(/^\[preview id=(\d+) ht=(\d+)\]$/);
      if (!tag || !attachments.has(tag[1])) continue;
      const images = [...previewUI.querySelectorAll('img')];
      const image = images[0];
      if (images.length !== 1 || image?.getAttribute('data-file-id') !== tag[1] ||
          image.getAttribute('height') !== tag[2] || image.getAttribute('alt') !== '' ||
          ![...previewUI.childNodes].every(node =>
            (node.nodeType === 3 && !node.textContent.trim()) || node === image)) continue;
      let previewURL;
      try { previewURL = new URL(image.getAttribute('src'), 'https://www.chatwork.com/'); }
      catch { continue; }
      const previewIds = previewURL.searchParams.getAll('file_id');
      if (previewURL.origin === 'https://www.chatwork.com' &&
          previewURL.pathname === '/gateway/preview_file.php' && previewIds.length === 1 &&
          previewIds[0] === tag[1]) verifiedAttachmentUI.add(previewUI);
    }
    // This auxiliary field has a DOM boundary, not a semantic interpretation.
    // Remove only validated rendered reply/upload UI. The observed [info] tag is
    // a semantic wrapper and keeps its text. Unknown quotation/format is not
    // attested, and raw pre.innerText remains untouched in `body`.
    const currentNodes = [...prose.childNodes].filter(node =>
      !(replyToMessageId && node === replyTag) && !verifiedAttachmentUI.has(node));
    const readCurrentNode = (node, inInfo = false) => {
      if (verifiedAttachmentUI.has(node)) return '';
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return null;
      if (node.tagName === 'BR') return '\n';
      const knownInfo = node.tagName === 'DIV' && node.getAttribute('data-cwopen') === '[info]' &&
        node.getAttribute('data-cwclose') === '[/info]' && node.getAttribute('data-cwtag') == null;
      const infoContent = inInfo && node.tagName === 'DIV' && node.getAttribute('data-cwtag') == null &&
        node.getAttribute('data-cwopen') == null && node.getAttribute('data-cwclose') == null;
      // Live Chatwork wraps ordinary customer prose in attribute-free SPANs.
      // outerHTML is an observed read-only DOM property; the exact opening tag
      // rejects attributed/quoted spans without a new sandbox API dependency.
      const plainSpan = node.tagName === 'SPAN' && typeof node.outerHTML === 'string' &&
        node.outerHTML.startsWith('<span>');
      if (!knownInfo && !infoContent && !plainSpan) return null;
      const pieces = [...node.childNodes].map(child => readCurrentNode(child, knownInfo || infoContent));
      return pieces.some(piece => piece === null) ? null : pieces.join('');
    };
    const currentPieces = currentNodes.map(node => readCurrentNode(node));
    const currentProse = currentPieces.some(piece => piece === null) ? null : currentPieces.join('');
    const currentFields = typeof currentProse === 'string' && currentProse.trim() ?
      { currentProseVerified: true, currentProseMessageId: id, currentProse } : {};
    return { sourceVerified: true, accountId: verifiedAccountId, roomId, messageId: id,
      authorAccountId, createdAtUnix, body, attachments: [...attachments.values()],
      ...(replyToMessageId ? { replyToMessageId } : {}), ...currentFields };
  }).filter(Boolean);
  const oldestLoadedUnix = loadedTimes.length ? Math.min(...loadedTimes) : null;
  // An empty/unloaded DOM or a partially loaded history can never certify zero
  // matching messages. No unobserved reply ancestry or edit timestamp is invented.
  const sourceLoaded = receipts.length > 0;
  return {
    schema: 'yutakasa-chatwork-dom-receipts-v1', collectorVerified: true,
    source: { kind: 'chatwork', accountId: verifiedAccountId, scopeId: roomId },
    sourceLoaded, loading,
    paginationComplete: sourceLoaded && !loading && unverifiedMessageIds.length === 0 &&
      oldestLoadedUnix <= fromUnix && callerHistoryVerified === true && callerTailVerified === true,
    oldestLoadedUnix, observedAtUnix: nowUnix, receipts, unverifiedMessageIds,
    deferred,
  };
}

// Self-contained source for review/testing. The current CUA evaluate must receive
// the exported function object, not this string. There is no fetch, hidden
// application state, browser storage access or UI mutation.
export const CHATWORK_DOM_COLLECTOR_SOURCE = `(${collectChatworkDOM.toString()})`;
