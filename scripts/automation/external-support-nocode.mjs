// This is a deliberately closed vocabulary, not a general intent classifier.
// Adding a FAQ or accepting quoted/attachment-bearing messages requires normal
// reviewed code. Customer prose, a triage flag, or configuration cannot add one.
export const LOGIN_FAQ = Object.freeze({
  id: 'yutakasa-login-url-v1',
  siteUrl: 'https://yutakasa-tapping-coach.vercel.app/login',
  condition: 'Pure request for the official Yutakasa BOT login URL, without a reported failure.',
  body: '豊かさBOTのログインページはこちらです。\nhttps://yutakasa-tapping-coach.vercel.app/login\nこちらからログインしてご利用ください。',
  flowId: 'yutakasa-login-url-dedicated-synthetic-v1',
});

const normalized = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().trim().replace(/[\s\u3000]+/gu, '').replace(/[。.!！?？]+$/gu, '')
  : null;
const faqBodies = new Set([
  '豊かさBOTのログインURLを教えてください。',
  '豊かさBOTのログインURLを教えて。',
  '豊かさBOTのログインURLはどこですか？',
  '豊かさBOTのログインURLはどこ？',
  '豊かさBOTのログインページを教えてください。',
  '豊かさBOTのログインページはどこですか？',
].map(normalized));
const thanksBodies = new Set([
  'ありがとうございます。', 'ありがとうございました。',
  '有難うございます。', '有難うございました。',
  'ありがとうございます。助かりました。', 'ありがとうございました。助かりました。',
  '助かりました。ありがとうございます。', '助かりました。ありがとうございました。',
  'Thank you.', 'Thanks.',
].map(normalized));
const faqSubjects = new Set([
  '', '豊かさBOT', '豊かさBOTについて', '豊かさBOTのログインURL',
  '豊かさBOTのログインURLについて', 'ログインURL', 'ログインURLについて',
].map(normalized));
const thanksSubjects = new Set(['', 'ありがとうございます', 'ありがとうございました', 'お礼', 'Thanks', 'Thank you'].map(normalized));
const bareSubject = value => normalized(typeof value === 'string' ? value.replace(/^(?:\s*re\s*[:：]\s*)+/iu, '') : '');
const safeEnvelope = event => event && typeof event === 'object' &&
  Array.isArray(event.attachments ?? []) && (event.attachments ?? []).length === 0 &&
  event.decisionRequired !== true && (event.prohibitedActions ?? []).length === 0;

export function isLoginFAQEvent(event) {
  return Boolean(safeEnvelope(event) && faqBodies.has(normalized(event.body)) &&
    faqSubjects.has(normalized(event.subject ?? '')));
}

export function isPureThanksEvent(event, priorSubjects = []) {
  if (!safeEnvelope(event) || !thanksBodies.has(normalized(event.body))) return false;
  const subject = bareSubject(event.subject);
  return thanksSubjects.has(subject) || priorSubjects.some(prior => bareSubject(prior) === subject);
}

export function isLoginFAQHistory(history) {
  return Array.isArray(history) && history.length > 0 && isLoginFAQEvent(history.at(-1)) &&
    history.every(event => isLoginFAQEvent(event) || isPureThanksEvent(event));
}
