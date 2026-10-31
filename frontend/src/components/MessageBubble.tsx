import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Info } from "lucide-react";
import type { ChatMessage } from "../lib/api";
import { SourceChip } from "./SourceChip";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isRefusal =
    message.isRefusal || message.scope_label === "not_legal";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-sm bg-slate-900 px-4 py-2.5 text-sm text-white shadow-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[92%] sm:max-w-[82%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm shadow-sm space-y-3 ${
          isRefusal
            ? "border border-slate-300 bg-slate-100 text-slate-800"
            : "border border-slate-200 bg-white text-slate-900"
        }`}
      >
        {isRefusal && (
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Legal &amp; Judiciary Scope Notice</span>
          </div>
        )}

        <div className="prose prose-sm prose-slate max-w-none leading-relaxed space-y-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>

        {message.sources && message.sources.length > 0 && (
          <div className="pt-2 border-t border-slate-100 space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Verified Sources
            </div>
            <div className="flex flex-wrap gap-1.5">
              {message.sources.map((src) => (
                <SourceChip key={src.id} source={src} />
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] text-slate-400 pt-1">
          AI-generated legal information — verify against official sources before relying.
        </div>
      </div>
    </div>
  );
}

