"use client";

import ReactMarkdown from "react-markdown";

interface Message {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface ChatMessagesProps {
  messages: Message[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export default function ChatMessages({
  messages,
  messagesEndRef,
}: ChatMessagesProps) {
  return (
    <div
      className="flex-1 overflow-y-auto px-4 md:px-8 lg:px-12 py-6 bg-pattern"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {messages.length === 0 ? (
        <div className="h-full flex items-center justify-center fade-in">
          <div className="text-center max-w-sm">
            <div
              className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6"
              style={{
                backgroundColor: "var(--bg-tertiary)",
                boxShadow: "var(--shadow-glow)",
              }}
            >
              <span className="text-4xl">🌿</span>
            </div>
            <h2 className="font-display text-2xl font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
              ようこそ
            </h2>
            <p className="text-base leading-relaxed mb-2" style={{ color: "var(--text-secondary)" }}>
              豊かさタッピングについて、何でもお気軽にご質問ください。
            </p>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              講座の内容に基づいて、AIコーチがサポートします。
            </p>
          </div>
        </div>
      ) : (
        <div className="max-w-3xl mx-auto space-y-5">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${
                message.role === "user" ? "justify-end" : "justify-start"
              } message-item`}
            >
              {/* Assistant avatar */}
              {message.role === "assistant" && (
                <div className="flex-shrink-0 mr-3 mt-1">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ backgroundColor: "var(--bg-tertiary)" }}
                  >
                    <span className="text-lg">🌿</span>
                  </div>
                </div>
              )}

              <div
                className={`max-w-[80%] lg:max-w-[70%] px-6 py-4 rounded-2xl break-words ${
                  message.role === "user" ? "rounded-br-md" : "rounded-bl-md"
                }`}
                style={
                  message.role === "user"
                    ? {
                        background: "var(--bg-user-msg)",
                        color: "var(--text-inverse)",
                        boxShadow: "0 2px 8px rgba(22, 101, 52, 0.15)",
                        overflowWrap: "anywhere",
                      }
                    : {
                        backgroundColor: "var(--bg-assistant-msg)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-secondary)",
                        boxShadow: "var(--shadow-sm)",
                        overflowWrap: "anywhere",
                      }
                }
              >
                {message.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown
                      components={{
                        p: ({ children }) => (
                          <p className="mb-3 text-base leading-relaxed">{children}</p>
                        ),
                        h1: ({ children }) => (
                          <h1 className="text-lg font-bold mt-5 mb-2.5">{children}</h1>
                        ),
                        h2: ({ children }) => (
                          <h2 className="text-base font-bold mt-4 mb-2">{children}</h2>
                        ),
                        h3: ({ children }) => (
                          <h3 className="text-base font-semibold mt-3 mb-1.5">{children}</h3>
                        ),
                        ul: ({ children }) => (
                          <ul className="list-disc list-outside ml-5 space-y-1.5 my-3">{children}</ul>
                        ),
                        ol: ({ children }) => (
                          <ol className="list-decimal list-outside ml-5 space-y-1.5 my-3">{children}</ol>
                        ),
                        li: ({ children }) => (
                          <li className="text-base leading-relaxed">{children}</li>
                        ),
                        code: ({ children }) => (
                          <code
                            className="px-1.5 py-0.5 rounded text-sm font-mono"
                            style={{
                              backgroundColor: "var(--bg-tertiary)",
                              color: "var(--accent-green)",
                            }}
                          >
                            {children}
                          </code>
                        ),
                        pre: ({ children }) => (
                          <pre className="bg-[#0a1a0a] text-[#e8f0de] p-4 rounded-xl overflow-auto my-3 text-sm border border-[#2d4a2d]">
                            {children}
                          </pre>
                        ),
                        blockquote: ({ children }) => (
                          <blockquote
                            className="pl-4 italic my-3 text-base"
                            style={{
                              borderLeft: "3px solid var(--accent-gold)",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {children}
                          </blockquote>
                        ),
                        strong: ({ children }) => (
                          <strong className="font-semibold">{children}</strong>
                        ),
                        em: ({ children }) => <em className="italic">{children}</em>,
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-base leading-relaxed">
                    {message.content}
                  </p>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}
    </div>
  );
}
