export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type ConversationResponseMode = "coach" | "draft_reply";

export interface DraftReplyContext {
  anchorMessageIndex: number;
  sourceMessage: string;
  requiredQuestionLabels: string[];
  requiresDelayApology: boolean;
  requiresOneMonthDelay: boolean;
  requiresDirectAnswer: boolean;
  completionCheckQuestionLabels: string[];
  positiveCompletionQuestionLabels: string[];
  sourceContainsSelfWorthClaim: boolean;
}

export interface ConversationResponsePlan {
  mode: ConversationResponseMode;
  draftReply: DraftReplyContext | null;
}

const DRAFT_REQUEST_PATTERN =
  /(?:(?:お客(?:さん|様)|受講者|相談者).{0,100}(?:返答|返信|返事).{0,30}(?:考えて|作って|書いて|お願い)|(?:この|以下の)(?:質問|問い合わせ|相談).{0,80}(?:返答|返信|返事).{0,30}(?:考えて|作って|書いて|お願い)|(?:返答|返信|返事)(?:文|案).{0,20}(?:考えて|作って|書いて|お願い)|(?:なんて|何て)答え(?:たら|れば)(?:いい|良い))/u;
const DRAFT_FOLLOW_UP_PATTERN =
  /(?:①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|返答|返信|返事|回答|答えて|文面|文章|ニュアンス|謝罪|申し訳|お詫び|含めて|入れて|加えて|直して|修正|書き直|もっと|短く|長く|丁寧|やさしく|柔らかく|厳しく|その内容|その回答|前の|さっき|これに|この質問|真面目|はっきり|イエス|ノー|yes|no)/iu;
const NEW_TOPIC_PATTERN =
  /(?:話は変わ|話を変え|別の(?:質問|相談|話)|新しい(?:質問|相談|話))/u;
const QUESTION_LABEL_PATTERN = /[①②③④⑤⑥⑦⑧⑨⑩]/gu;
const ONE_MONTH_DELAY_PATTERN =
  /(?:1|１|一)\s*(?:か月|カ月|ケ月|ヶ月|箇月)(?:以上)?/u;
const DELAY_PATTERN =
  /(?:確認.{0,20}遅|気[づ付]く.{0,20}遅|返(?:事|信).{0,20}遅)/u;
const APOLOGY_REQUEST_PATTERN =
  /(?:申し訳|謝(?:罪|って)|お詫び|すみません|ごめんなさい|ニュアンス.{0,20}(?:含|入)|(?:含|入).{0,20}(?:申し訳|お詫び))/u;
const DIRECT_ANSWER_PATTERN =
  /(?:(?:イエス|yes|はい).{0,15}(?:ノー|no|いいえ)|(?:ノー|no|いいえ).{0,15}(?:イエス|yes|はい)|(?:はっきり|明確に|真面目に).{0,30}(?:答えて|回答して)|(?:①|②).{0,120}(?:答えて|回答して))/iu;
const PASTED_ASSISTANT_PATTERN =
  /(?:豊かさタッピング\s*AI\s*Coach|講座の第\s*\d+\s*回|確実に.{0,20}(?:外れ|治り|改善)|これまでのお話から)/u;
const COMPLETION_CHECK_PATTERN =
  /(?:(?:思い出さ|忘れ|怒り.{0,30}なく)[\s\S]{0,180}(?:十分|感情処理|終え|終了)|(?:十分|感情処理|終え|終了)[\s\S]{0,180}(?:思い出さ|忘れ|怒り.{0,30}なく))/u;
const POSITIVE_COMPLETION_PATTERN =
  /(?:(?:怒り|感情)[\s\S]{0,80}(?:全く|まったく)[\s\S]{0,30}(?:なくな|収ま)|(?:怒り|感情)[\s\S]{0,120}(?:なくな|収ま)[\s\S]{0,80}忘れ)/u;

interface UserEntry {
  index: number;
  content: string;
}

function userEntries(messages: ConversationMessage[]): UserEntry[] {
  return messages.flatMap((message, index) => {
    const content = message.content.trim();
    return message.role === "user" && content ? [{ index, content }] : [];
  });
}

function questionLabels(content: string): string[] {
  return Array.from(new Set(content.match(QUESTION_LABEL_PATTERN) ?? []));
}

function questionSection(
  content: string,
  label: string,
  labels: string[]
): string {
  const start = content.indexOf(label);
  if (start === -1) return "";
  const nextStarts = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => content.indexOf(candidate, start + label.length))
    .filter((index) => index > start);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : content.length;
  return content.slice(start + label.length, end);
}

function isDraftFollowUp(content: string): boolean {
  if (NEW_TOPIC_PATTERN.test(content)) return false;
  return DRAFT_FOLLOW_UP_PATTERN.test(content);
}

function isSeparatelyPastedCustomerSource(content: string): boolean {
  return (
    content.length >= 80 &&
    /(?:①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|[?？]|お世話にな|相談者|受講者|質問)/u.test(
      content
    )
  );
}

function findDraftAnchor(entries: UserEntry[]): UserEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (!DRAFT_REQUEST_PATTERN.test(candidate.content)) continue;

    const following = entries.slice(index + 1);
    const expectsSeparateSource =
      questionLabels(candidate.content).length === 0 &&
      candidate.content.length < 180;
    if (
      following.every(
        (entry, followingIndex) =>
          isDraftFollowUp(entry.content) ||
          (expectsSeparateSource &&
            followingIndex === 0 &&
            isSeparatelyPastedCustomerSource(entry.content))
      )
    ) {
      return candidate;
    }
  }
  return null;
}

function sourceScore(entry: UserEntry, anchorIndex: number): number {
  const labels = questionLabels(entry.content).length;
  const questionMarks = entry.content.match(/[?？]/gu)?.length ?? 0;
  const anchorBonus = entry.index === anchorIndex ? 2_000 : 0;
  const assistantPastePenalty = PASTED_ASSISTANT_PATTERN.test(entry.content)
    ? 15_000
    : 0;

  return (
    labels * 10_000 +
    questionMarks * 500 +
    Math.min(entry.content.length, 4_000) +
    anchorBonus -
    assistantPastePenalty
  );
}

function findDraftSource(
  entries: UserEntry[],
  anchor: UserEntry
): UserEntry {
  const candidates = entries.filter((entry) => entry.index >= anchor.index);
  return candidates.reduce(
    (best, candidate) =>
      sourceScore(candidate, anchor.index) >= sourceScore(best, anchor.index)
        ? candidate
        : best,
    anchor
  );
}

export function buildConversationResponsePlan(
  messages: ConversationMessage[]
): ConversationResponsePlan {
  const entries = userEntries(messages);
  const anchor = findDraftAnchor(entries);
  if (!anchor) {
    return { mode: "coach", draftReply: null };
  }

  const source = findDraftSource(entries, anchor);
  const requiredQuestionLabels = questionLabels(source.content);
  const completionCheckQuestionLabels = requiredQuestionLabels.filter(
    (label) =>
      COMPLETION_CHECK_PATTERN.test(
        questionSection(source.content, label, requiredQuestionLabels)
      )
  );
  const positiveCompletionQuestionLabels =
    completionCheckQuestionLabels.filter((label) =>
      POSITIVE_COMPLETION_PATTERN.test(
        questionSection(source.content, label, requiredQuestionLabels)
      )
    );
  const taskMessages = entries
    .filter((entry) => entry.index >= anchor.index)
    .map((entry) => entry.content)
    .join("\n");

  return {
    mode: "draft_reply",
    draftReply: {
      anchorMessageIndex: anchor.index,
      sourceMessage: source.content,
      requiredQuestionLabels,
      requiresDelayApology:
        (ONE_MONTH_DELAY_PATTERN.test(taskMessages) ||
          DELAY_PATTERN.test(taskMessages)) &&
        APOLOGY_REQUEST_PATTERN.test(taskMessages),
      requiresOneMonthDelay: ONE_MONTH_DELAY_PATTERN.test(taskMessages),
      requiresDirectAnswer:
        requiredQuestionLabels.length > 0 ||
        DIRECT_ANSWER_PATTERN.test(taskMessages),
      completionCheckQuestionLabels,
      positiveCompletionQuestionLabels,
      sourceContainsSelfWorthClaim: /自分には価値がない/u.test(
        source.content
      ),
    },
  };
}

export function draftRetrievalQuery(context: DraftReplyContext): string {
  const content = context.sourceMessage.replace(/\r\n?/gu, "\n").trim();
  const lastFirstLabel = content.lastIndexOf("①");
  const questionTail =
    lastFirstLabel >= 0
      ? content.slice(Math.max(0, lastFirstLabel - 900))
      : content;
  const head = Array.from(content).slice(0, 900).join("");
  const relevant = questionTail === content ? content : `${head}\n${questionTail}`;
  const characters = Array.from(relevant);
  if (characters.length <= 4_000) return relevant;
  return characters.slice(-4_000).join("");
}
