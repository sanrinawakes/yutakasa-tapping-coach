import MiniSearch from "minisearch";
import generatedCourseContent from "@/generated/course-content.json";

interface GeneratedCourseDocument {
  id: string;
  title: string;
  content: string;
}

interface GeneratedCourseContent {
  generatedAt: string;
  sourceCount: number;
  totalChars: number;
  contentSha256: string;
  documents: GeneratedCourseDocument[];
}

interface CourseChunk {
  id: string;
  documentId: string;
  title: string;
  chunkIndex: number;
  content: string;
}

export interface CourseContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SelectedCourseContext {
  content: string;
  chunkIds: string[];
  titles: string[];
  selectedChars: number;
  sourceChars: number;
  sourceCount: number;
  generatedAt: string;
  contentSha256: string;
}

const courseData = generatedCourseContent as GeneratedCourseContent;
const MAX_CHUNK_CHARS = 3_200;
const MIN_CHUNK_BREAK_CHARS = 2_100;
const DEFAULT_MAX_CHUNKS = 4;
const DEFAULT_MAX_CONTEXT_CHARS = 13_000;
const SEARCH_RESULT_LIMIT = 30;
const MAX_CHUNKS_PER_DOCUMENT = 2;
const stopWords = new Set([
  "これ",
  "それ",
  "あれ",
  "こと",
  "もの",
  "ため",
  "よう",
  "です",
  "ます",
  "して",
  "した",
  "いる",
  "ある",
  "ない",
  "から",
  "まで",
  "より",
  "について",
  "ください",
  "教えて",
  "今日",
  "タッピング",
  "進め方",
  "具体的",
  "詳しく",
  "理由",
  "方法",
  "手順",
  "実践",
]);
const japaneseSegmenter = new Intl.Segmenter("ja", {
  granularity: "word",
});

let searchIndex: MiniSearch<CourseChunk> | null = null;
let chunksById: Map<string, CourseChunk> | null = null;

function findChunkBoundary(content: string, start: number, proposedEnd: number) {
  const minimumEnd = Math.min(start + MIN_CHUNK_BREAK_CHARS, proposedEnd);
  const candidate = content.slice(minimumEnd, proposedEnd);
  const relativeBoundary = Math.max(
    candidate.lastIndexOf("\n"),
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("！"),
    candidate.lastIndexOf("？")
  );
  return relativeBoundary >= 0
    ? minimumEnd + relativeBoundary + 1
    : proposedEnd;
}

function splitDocument(document: GeneratedCourseDocument): CourseChunk[] {
  const content = document.content
    .replace(/\r\n?/gu, "\n")
    .replace(/【\s*\d{1,3}(?:\s*[-ー―−]\s*\d{1,3})?(?:\s*回)?\s*】/gu, "")
    .replace(/\[\s*\d{1,3}\s*\]/gu, "")
    .trim();
  const chunks: CourseChunk[] = [];
  let start = 0;

  while (start < content.length) {
    const proposedEnd = Math.min(start + MAX_CHUNK_CHARS, content.length);
    const end =
      proposedEnd < content.length
        ? findChunkBoundary(content, start, proposedEnd)
        : proposedEnd;
    const chunkContent = content.slice(start, end).trim();
    if (chunkContent) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: `${document.id}:${chunkIndex}`,
        documentId: document.id,
        title: document.title,
        chunkIndex,
        content: chunkContent,
      });
    }
    start = Math.max(end, start + 1);
  }

  return chunks;
}

function tokenizeJapanese(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];

  for (const segment of japaneseSegmenter.segment(normalized)) {
    const token = segment.segment.trim();
    if (!segment.isWordLike || !token || stopWords.has(token)) continue;
    tokens.push(token);

    const characters = Array.from(token);
    if (characters.length >= 3) {
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.push(characters.slice(index, index + 2).join(""));
      }
    }
  }

  return tokens;
}

function ensureSearchIndex() {
  if (searchIndex && chunksById) {
    return { index: searchIndex, chunks: chunksById };
  }

  const allChunks = courseData.documents.flatMap(splitDocument);
  chunksById = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
  searchIndex = new MiniSearch<CourseChunk>({
    fields: ["title", "content"],
    idField: "id",
    storeFields: ["documentId", "title", "chunkIndex"],
    tokenize: tokenizeJapanese,
    processTerm: (term) => (stopWords.has(term) ? null : term),
    searchOptions: {
      boost: { title: 8, content: 1 },
      combineWith: "OR",
      prefix: false,
      fuzzy: false,
    },
  });
  searchIndex.addAll(allChunks);

  return { index: searchIndex, chunks: chunksById };
}

function queryFromMessages(messages: CourseContextMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join(" ");
}

function requestedCourseNumber(query: string): number | null {
  const match = query.match(/第\s*(\d{1,2})\s*回/u);
  return match ? Number(match[1]) : null;
}

const PRIORITY_COURSE_RULES: Array<{
  query: RegExp;
  title: RegExp;
}> = [
  { query: /借金|負債|ローン|返済/u, title: /第12回[：:]/u },
  { query: /受け取|受取/u, title: /第19回[：:]/u },
  { query: /価値がない|自己価値/u, title: /第17回[：:]/u },
  { query: /努力が報われない|報われない/u, title: /第18回[：:]/u },
  { query: /お金持ち.*(?:抵抗|怖)|富裕.*(?:抵抗|怖)/u, title: /第20回[：:]|第21回[：:]/u },
  { query: /家族.*(?:価値観|考え|思い込|パラダイム)/u, title: /第6回[：:]/u },
  { query: /目標.*(?:怖|不安)|大きな目標/u, title: /第14回[：:]|第15回[：:]/u },
];

function priorityCourseTitles(query: string): RegExp[] {
  return PRIORITY_COURSE_RULES.filter((rule) => rule.query.test(query)).map(
    (rule) => rule.title
  );
}

function isTappingProcedureQuestion(query: string): boolean {
  return (
    /タッピング/u.test(query) &&
    /やり方|方法|進め方|手順|ポイント|叩く|実践|できる|教えて/u.test(query)
  );
}

export function selectCourseContext(
  messages: CourseContextMessage[],
  options: { maxChunks?: number; maxContextChars?: number } = {}
): SelectedCourseContext {
  const { index, chunks } = ensureSearchIndex();
  const query = queryFromMessages(messages);
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const maxContextChars =
    options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const selected: CourseChunk[] = [];
  const selectedIds = new Set<string>();
  const perDocumentCount = new Map<string, number>();
  const prioritizedDocumentIds = new Set<string>();

  const addChunk = (chunk: CourseChunk | undefined) => {
    if (!chunk || selectedIds.has(chunk.id) || selected.length >= maxChunks) {
      return;
    }
    const documentCount = perDocumentCount.get(chunk.documentId) ?? 0;
    if (documentCount >= MAX_CHUNKS_PER_DOCUMENT) return;
    const nextChars =
      selected.reduce((total, item) => total + item.content.length, 0) +
      chunk.content.length;
    if (selected.length > 0 && nextChars > maxContextChars) return;

    selected.push(chunk);
    selectedIds.add(chunk.id);
    perDocumentCount.set(chunk.documentId, documentCount + 1);
  };

  const addPrioritizedDocument = (titlePattern: RegExp) => {
    const matchingChunks = Array.from(chunks.values()).filter((chunk) =>
      titlePattern.test(chunk.title)
    );
    const documentId = matchingChunks[0]?.documentId;
    if (!documentId) return;

    prioritizedDocumentIds.add(documentId);
    addChunk(matchingChunks[0]);
  };

  const courseNumber = requestedCourseNumber(query);
  if (courseNumber !== null) {
    addPrioritizedDocument(new RegExp(`第${courseNumber}回(?:\\D|$)`, "u"));
  }

  for (const titlePattern of priorityCourseTitles(query)) {
    addPrioritizedDocument(titlePattern);
  }

  if (isTappingProcedureQuestion(query)) {
    const basicChunk = Array.from(chunks.values()).find((chunk) =>
      /第1回[：:]/u.test(chunk.title)
    );
    addChunk(basicChunk);
  }

  if (query) {
    for (const result of index.search(query).slice(0, SEARCH_RESULT_LIMIT)) {
      const chunk = chunks.get(String(result.id));
      if (
        chunk &&
        prioritizedDocumentIds.size > 0 &&
        !prioritizedDocumentIds.has(chunk.documentId)
      ) {
        continue;
      }
      addChunk(chunk);
    }
  }

  if (selected.length === 0) {
    const fallbackTitles = [/オリエンテーション/u, /第1回[：:]/u];
    for (const titlePattern of fallbackTitles) {
      addChunk(
        Array.from(chunks.values()).find((chunk) =>
          titlePattern.test(chunk.title)
        )
      );
    }
  }

  const content = selected
    .map(
      (chunk) =>
        `### ${chunk.title}\n\n${chunk.content}`
    )
    .join("\n\n---\n\n");

  return {
    content,
    chunkIds: selected.map((chunk) => chunk.id),
    titles: Array.from(new Set(selected.map((chunk) => chunk.title))),
    selectedChars: content.length,
    sourceChars: courseData.totalChars,
    sourceCount: courseData.sourceCount,
    generatedAt: courseData.generatedAt,
    contentSha256: courseData.contentSha256,
  };
}

export function getCourseContentMetadata() {
  const { chunks } = ensureSearchIndex();
  return {
    generatedAt: courseData.generatedAt,
    sourceCount: courseData.sourceCount,
    sourceChars: courseData.totalChars,
    chunkCount: chunks.size,
    contentSha256: courseData.contentSha256,
  };
}

export function resetCourseSearchIndex() {
  searchIndex = null;
  chunksById = null;
}
