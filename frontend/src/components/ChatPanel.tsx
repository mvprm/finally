"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { describeActions, type ActionLine } from "@/logic/chatActions";
import type { ChatMessage } from "@/logic/types";

const SUGGESTIONS = [
  "How concentrated is my portfolio?",
  "Buy 5 NVDA",
  "Add PYPL to my watchlist",
  "Which position is doing worst?",
];

const LINE_STYLE: Record<ActionLine["tone"], { bar: string; text: string; prefix: string }> = {
  buy: { bar: "bg-up", text: "text-text", prefix: "" },
  sell: { bar: "bg-down", text: "text-text", prefix: "" },
  neutral: { bar: "bg-info", text: "text-text", prefix: "" },
  error: { bar: "bg-down", text: "text-down", prefix: "Not done: " },
};

interface Props {
  messages: ChatMessage[];
  pending: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onSend: (text: string) => Promise<void>;
}

export function ChatPanel({ messages, pending, collapsed, onToggle, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, collapsed]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || pending) return;
    setDraft("");
    onSend(t);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  };

  if (collapsed) {
    return (
      <aside data-testid="chat-panel" data-collapsed="true" className="flex w-11 flex-col items-center border-l border-rule bg-panel py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Open the assistant"
          aria-expanded={false}
          className="flex flex-col items-center gap-3 rounded-sm px-1.5 py-2 text-dim hover:bg-raised hover:text-text"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" fill="none" />
          </svg>
          <span className="text-[12px] font-semibold [writing-mode:vertical-rl]">Assistant</span>
          {pending && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="chat-panel"
      data-collapsed="false"
      className="flex min-h-0 w-full flex-col border-l border-rule bg-panel lg:w-[360px]"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule px-3">
        <span className="h-2 w-2 bg-brand" aria-hidden="true" />
        <h2 className="text-[12.5px] font-semibold" style={{ fontStretch: "110%" }}>
          Assistant
        </h2>
        <span className="text-[11px] text-faint">can trade and edit your watchlist</span>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse the assistant"
          aria-expanded={true}
          className="ml-auto hidden rounded-sm p-1 text-dim hover:bg-raised hover:text-text lg:block"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" fill="none" />
          </svg>
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
        {messages.length === 0 && !pending && (
          <div className="space-y-3 pt-2">
            <p className="text-[12.5px] leading-relaxed text-dim">
              Ask about your holdings, or tell me what to do. I place market orders and change the watchlist straight away, so
              phrase trades the way you want them filled.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setDraft(s)}
                  className="rounded-sm border border-rule px-2 py-1 text-[11.5px] text-dim hover:border-info/60 hover:text-text"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}

        {pending && (
          <div data-testid="chat-loading" role="status" className="flex items-center gap-2 text-[12px] text-dim">
            <span className="flex gap-1" aria-hidden="true">
              <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-brand" />
              <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-brand" />
              <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-brand" />
            </span>
            FinAlly is working on it
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 border-t border-rule p-2">
        <div className="flex items-end gap-1.5 rounded-sm border border-rule bg-ink p-1.5 focus-within:border-info/60">
          <textarea
            data-testid="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Ask or instruct, e.g. buy 10 AAPL"
            aria-label="Message the assistant"
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-1 text-[13px] leading-snug placeholder:text-faint focus:outline-none"
          />
          <button
            data-testid="chat-send"
            type="submit"
            disabled={pending || !draft.trim()}
            className="h-8 rounded-sm bg-submit px-3 text-[12.5px] font-bold text-white transition-colors hover:bg-submit-hover disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const lines = describeActions(message.actions);
  if (message.role === "user") {
    return (
      <div data-testid="chat-message" data-role="user" className="flex justify-end">
        <p className="max-w-[85%] rounded-sm bg-raised px-2.5 py-1.5 text-[13px] leading-snug whitespace-pre-wrap text-text">
          {message.content}
        </p>
      </div>
    );
  }
  return (
    <div data-testid="chat-message" data-role="assistant" className="border-l-2 border-brand/70 pl-2.5">
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text">{message.content}</p>
      {lines.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {lines.map((l, i) => {
            const s = LINE_STYLE[l.tone];
            return (
              <li
                key={i}
                data-testid="chat-action"
                data-kind={l.kind}
                className={`num flex items-center gap-2 rounded-sm bg-ink/70 px-2 py-1 text-[12px] ${s.text}`}
              >
                <span className={`h-3 w-[3px] shrink-0 ${s.bar}`} aria-hidden="true" />
                {s.prefix}
                {l.text}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
