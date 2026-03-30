import { GoogleGenerativeAI } from "@google/generative-ai";
import { GOOGLE_DOC_TRANSCRIPTS, getTranscriptUrl } from "./transcript-config";
import {
  GEMINI_MODEL,
  SYSTEM_INSTRUCTION,
  TRANSCRIPT_CACHE_TTL,
} from "./constants";

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }
  return new GoogleGenerativeAI(apiKey);
}

interface CacheEntry {
  content: string;
  timestamp: number;
}

let transcriptCache: Map<string, CacheEntry> = new Map();

async function fetchTranscript(docId: string): Promise<string> {
  const cached = transcriptCache.get(docId);

  if (cached && Date.now() - cached.timestamp < TRANSCRIPT_CACHE_TTL) {
    return cached.content;
  }

  const url = getTranscriptUrl(docId);

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed to fetch transcript for ${docId}: ${response.status}`);
    return "";
  }

  const content = await response.text();
  transcriptCache.set(docId, { content, timestamp: Date.now() });

  return content;
}

let systemPromptCache: { content: string; timestamp: number } | null = null;

export async function getSystemPrompt(): Promise<string> {
  if (
    systemPromptCache &&
    Date.now() - systemPromptCache.timestamp < TRANSCRIPT_CACHE_TTL
  ) {
    return systemPromptCache.content;
  }

  console.log("Fetching all transcripts...");
  const transcripts = await Promise.all(
    GOOGLE_DOC_TRANSCRIPTS.map((doc) => fetchTranscript(doc.id))
  );

  const courseContent = GOOGLE_DOC_TRANSCRIPTS.map((doc, index) => {
    return `### ${doc.title}\n\n${transcripts[index]}`;
  }).join("\n\n---\n\n");

  const prompt = SYSTEM_INSTRUCTION.replace("---COURSE_CONTENT---", courseContent);
  systemPromptCache = { content: prompt, timestamp: Date.now() };

  console.log(`System prompt built: ${prompt.length} characters`);
  return prompt;
}

export async function clearTranscriptCache() {
  transcriptCache.clear();
  systemPromptCache = null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function streamChatCompletion(
  messages: ChatMessage[]
): Promise<ReadableStream<string>> {
  const systemPrompt = await getSystemPrompt();
  const client = getClient();

  const model = client.getGenerativeModel({ model: GEMINI_MODEL });

  const stream = await model.generateContentStream({
    contents: messages.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    })),
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 8192,
    },
  });

  return new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const chunk of stream.stream) {
          const text = chunk.text();
          if (text) {
            controller.enqueue(text);
          }
        }
        controller.close();
      } catch (error) {
        console.error("Gemini streaming error:", error);
        controller.error(error);
      }
    },
  });
}
