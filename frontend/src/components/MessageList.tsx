import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { ChatMessage, StreamStage } from "../lib/api";
import { MessageBubble } from "./MessageBubble";

const STAGE_LABELS: Record<StreamStage, string> = {
  checking_scope: "Checking legal scope...",
  searching_documents: "Searching your uploaded document...",
  searching_statutes: "Checking Indian statutes...",
  searching_web: "Searching trusted legal sources...",
  answering: "Writing answer...",
};

interface MessageListProps {
  messages: ChatMessage[];
  activeStage: StreamStage | null;
  wakingUpServer: boolean;
}

export function MessageList({
  messages,
  activeStage,
  wakingUpServer,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeStage, wakingUpServer]);

  return (
    <div
      role="log"
      aria-live="polite"
      className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl w-full mx-auto"
    >
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {(activeStage || wakingUpServer) && (
        <div
          role="status"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs text-slate-600 shadow-sm"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-700" aria-hidden="true" />
          <span>
            {wakingUpServer
              ? "Waking up the server (free-tier cold start can take up to a minute)..."
              : activeStage
              ? STAGE_LABELS[activeStage]
              : "Processing..."}
          </span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

