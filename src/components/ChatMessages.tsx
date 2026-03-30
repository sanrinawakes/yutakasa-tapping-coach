"use client";

import { useEffect } from "react";
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
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 bg-warm-50">
      {messages.length === 0 ? (
        <div className="h-full flex items-center justify-center">
          <div className="text-center text-gray-500">
            <div className="text-5xl mb-4">✨</div>
            <h2 className="text-2xl font-semibold mb-2 text-gray-700">
              新しいチャットを始めましょう
            </h2>
            <p className="text-gray-600">
              何か質問したいことはありますか？
            </p>
          </div>
        </div>
      ) : (
        <>
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${
                message.role === "user" ? "justify-end" : "justify-start"
              } message-item`}
            >
              <div
                className={`max-w-xs lg:max-w-2xl px-4 py-3 rounded-lg ${
                  message.role === "user"
                    ? "bg-primary-500 text-white"
                    : "bg-white text-gray-900 border border-gray-200 shadow-sm"
                }`}
              >
                {message.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown
                      components={{
                        p: ({ children }) => <p className="mb-2">{children}</p>,
                        h1: ({ children }) => (
                          <h1 className="text-lg font-bold mt-3 mb-2">
                            {children}
                          </h1>
                        ),
                        h2: ({ children }) => (
                          <h2 className="text-base font-bold mt-2 mb-1">
                            {children}
                          </h2>
                        ),
                        h3: ({ children }) => (
                          <h3 className="text-sm font-semibold mt-2 mb-1">
                            {children}
                          </h3>
                        ),
                        ul: ({ children }) => (
                          <ul className="list-disc list-inside space-y-1 my-2">
                            {children}
                          </ul>
                        ),
                        ol: ({ children }) => (
                          <ol className="list-decimal list-inside space-y-1 my-2">
                            {children}
                          </ol>
                        ),
                        li: ({ children }) => <li className="ml-2">{children}</li>,
                        code: ({ children }) => (
                          <code className="bg-gray-100 px-2 py-1 rounded text-xs font-mono">
                            {children}
                          </code>
                        ),
                        pre: ({ children }) => (
                          <pre className="bg-gray-900 text-white p-3 rounded overflow-auto my-2 text-xs">
                            {children}
                          </pre>
                        ),
                        blockquote: ({ children }) => (
                          <blockquote className="border-l-4 border-gray-400 pl-3 italic my-2">
                            {children}
                          </blockquote>
                        ),
                        strong: ({ children }) => (
                          <strong className="font-semibold">{children}</strong>
                        ),
                        em: ({ children }) => (
                          <em className="italic">{children}</em>
                        ),
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm">
                    {message.content}
                  </p>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </>
      )}
    </div>
  );
}
