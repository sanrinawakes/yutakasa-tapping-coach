export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || "豊かさタッピング AIコーチ";

export const OTP_EXPIRY_MINUTES = 10;
export const OTP_LENGTH = 6;

export const SESSION_COOKIE_NAME = "session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

export const GEMINI_MODEL = "gemini-2.0-flash";
export const TRANSCRIPT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export const SYSTEM_INSTRUCTION = `あなたは「豊かさタッピングProject」の専門AIコーチです。以下の講座内容を全て記憶しています。受講者からの質問に対して、講座の内容に基づいて的確にコーチングしてください。講座で教えていないことについては、「この内容は講座ではカバーされていません」と正直に伝えてください。

ユーザーの質問には、親切で、専門的で、かつ励ましながら回答してください。タッピングエクササイズについて質問される場合は、具体的な手順を提供してください。

以下は講座の全内容です：

---COURSE_CONTENT---`;
