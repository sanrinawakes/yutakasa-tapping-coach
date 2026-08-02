export interface CoachResponseStep {
  title: string;
  instruction: string;
}

export interface StructuredCoachResponse {
  acknowledgement: string;
  explanation: string;
  steps: CoachResponseStep[];
  practicePhrases: string[];
  closing: string;
}

const MAX_RESPONSE_CHARS = 700;
const SENTENCE_PATTERN = /[^。！？!?]+[。！？!?]+|[^。！？!?]+$/gu;
const GENERIC_EMPATHY_PATTERN =
  /(?:その)?お気持ち[、,]?\s*(?:よく)?(?:分かります|わかります|理解できます)[。！？!?]?|(?:心中を)?お察しします[。！？!?]?/gu;

function asCleanText(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(GENERIC_EMPATHY_PATTERN, "")
        .replace(/\s+/gu, " ")
        .trim()
    : "";
}

function takeSentences(value: string, count: number): string {
  const sentences = value.match(SENTENCE_PATTERN)?.map((sentence) =>
    sentence.trim()
  );
  return sentences?.slice(0, count).join("") || value;
}

function truncateComplete(value: string, maxChars: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;

  const candidate = characters.slice(0, maxChars - 1).join("");
  const sentenceBoundary = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("！"),
    candidate.lastIndexOf("？")
  );
  if (sentenceBoundary >= Math.floor(maxChars * 0.55)) {
    return candidate.slice(0, sentenceBoundary + 1).trim();
  }

  const clauseBoundary = candidate.lastIndexOf("、");
  if (clauseBoundary >= Math.floor(maxChars * 0.55)) {
    return `${candidate.slice(0, clauseBoundary).trim()}。`;
  }

  return `${candidate.trim()}。`;
}

function parseStep(value: unknown): CoachResponseStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = asCleanText((value as { title?: unknown }).title);
  const instruction = asCleanText(
    (value as { instruction?: unknown }).instruction
  );
  return title && instruction ? { title, instruction } : null;
}

export function parseStructuredCoachResponse(
  content: string
): StructuredCoachResponse {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini returned an invalid coaching response object");
  }

  const object = parsed as Record<string, unknown>;
  const acknowledgement = asCleanText(object.acknowledgement);
  const explanation = asCleanText(object.explanation);
  const steps = Array.isArray(object.steps)
    ? object.steps.map(parseStep).filter((step): step is CoachResponseStep => !!step)
    : [];
  const practicePhrases = Array.isArray(object.practicePhrases)
    ? object.practicePhrases.map(asCleanText).filter(Boolean).slice(0, 2)
    : [];
  const closing = asCleanText(object.closing);

  if (!acknowledgement || (!explanation && steps.length === 0)) {
    throw new Error("Gemini returned an incomplete coaching response");
  }

  return {
    acknowledgement,
    explanation,
    steps: steps.slice(0, 3),
    practicePhrases,
    closing,
  };
}

function limitQuotedPhrases(
  value: string,
  keptPhrases: string[]
): string {
  return value
    .replace(/「([^」]+)」/gu, (match, phrase: string) => {
      const normalized = phrase.trim();
      if (!normalized) return "";
      if (keptPhrases.includes(normalized)) return match;
      if (keptPhrases.length >= 2) return "";
      keptPhrases.push(normalized);
      return match;
    })
    .replace(/「」/gu, "")
    .replace(/(?:、\s*){2,}/gu, "、")
    .replace(/(?:や|または)\s*(?=[、。])/gu, "")
    .replace(/\s+([、。])/gu, "$1")
    .trim();
}

function buildResponse(
  response: StructuredCoachResponse,
  options: {
    includeClosing: boolean;
    explanationSentences: number;
    instructionChars: number;
    includeSeparatePhrases: boolean;
  }
): string {
  const keptPhrases: string[] = [];
  const acknowledgement = truncateComplete(
    limitQuotedPhrases(takeSentences(response.acknowledgement, 1), keptPhrases),
    90
  );
  const explanation = truncateComplete(
    limitQuotedPhrases(
      takeSentences(response.explanation, options.explanationSentences),
      keptPhrases
    ),
    options.explanationSentences === 1 ? 150 : 220
  );
  const steps = response.steps.slice(0, 3).map((step, index) => {
    const title = truncateComplete(step.title.replace(/[。！？!?]+$/u, ""), 36);
    const instruction = truncateComplete(
      limitQuotedPhrases(step.instruction, keptPhrases),
      options.instructionChars
    );
    return `${index + 1}. **${title}**: ${instruction}`;
  });

  let phraseLine = "";
  if (options.includeSeparatePhrases && keptPhrases.length < 2) {
    const additions = response.practicePhrases
      .filter((phrase) => !keptPhrases.includes(phrase))
      .slice(0, 2 - keptPhrases.length);
    keptPhrases.push(...additions);
    if (additions.length > 0) {
      phraseLine = `フレーズ例: ${additions
        .map((phrase) => `「${truncateComplete(phrase, 70).replace(/。$/u, "")}」`)
        .join("／")}`;
    }
  }

  const closing = options.includeClosing
    ? truncateComplete(
        limitQuotedPhrases(takeSentences(response.closing, 1), keptPhrases),
        100
      )
    : "";
  return [acknowledgement, explanation, ...steps, phraseLine, closing]
    .filter(Boolean)
    .join("\n\n");
}

export function renderStructuredCoachResponse(
  response: StructuredCoachResponse
): string {
  const attempts = [
    {
      includeClosing: true,
      explanationSentences: 2,
      instructionChars: 150,
      includeSeparatePhrases: true,
    },
    {
      includeClosing: false,
      explanationSentences: 2,
      instructionChars: 140,
      includeSeparatePhrases: true,
    },
    {
      includeClosing: false,
      explanationSentences: 1,
      instructionChars: 120,
      includeSeparatePhrases: false,
    },
    {
      includeClosing: false,
      explanationSentences: 1,
      instructionChars: 90,
      includeSeparatePhrases: false,
    },
  ] as const;

  for (const options of attempts) {
    const rendered = buildResponse(response, options);
    if (Array.from(rendered).length <= MAX_RESPONSE_CHARS) return rendered;
  }

  throw new Error("Structured coaching response could not fit the output limit");
}
