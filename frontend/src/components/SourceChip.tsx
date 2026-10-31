import { useState } from "react";
import { BookOpen, ExternalLink, FileText, Globe } from "lucide-react";
import type { SourceItem } from "../lib/api";

export function SourceChip({ source }: { source: SourceItem }) {
  const [expanded, setExpanded] = useState(false);

  const Icon =
    source.type === "document"
      ? FileText
      : source.type === "statute"
      ? BookOpen
      : Globe;

  return (
    <div className="inline-block align-top">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-200 transition-colors"
      >
        <Icon className="h-3.5 w-3.5 text-slate-600 shrink-0" aria-hidden="true" />
        <span className="font-semibold">[{source.id}]</span>
        <span className="truncate max-w-[180px]">{source.title}</span>
        {source.page !== undefined && (
          <span className="text-slate-500">p.{source.page}</span>
        )}
      </button>

      {expanded && (
        <div className="mt-1.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 max-w-md space-y-1.5 shadow-sm">
          <div className="flex items-center justify-between gap-2 font-medium text-slate-900">
            <span>
              [{source.id}] {source.title} — {source.ref}
            </span>
            {source.url && (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-700 hover:underline shrink-0"
              >
                Source <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
          {source.snippet && (
            <p className="text-slate-600 whitespace-pre-wrap leading-relaxed">
              {source.snippet}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

