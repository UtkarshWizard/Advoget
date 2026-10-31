import { Scale } from "lucide-react";

const EXAMPLE_QUESTIONS = [
  {
    audience: "Citizen",
    prompt: "My bike was seized by the police. What can I do next?",
  },
  {
    audience: "Citizen",
    prompt: "Police are not registering my FIR. What are my options?",
  },
  {
    audience: "Lawyer",
    prompt: "What does Section 480 of BNSS cover regarding bail in non-bailable offences?",
  },
  {
    audience: "Lawyer",
    prompt: "Compare cognizable offence FIR registration procedure under CrPC Section 154 and BNSS Section 173.",
  },
];

export function EmptyState({
  onSelectExample,
  disabled,
}: {
  onSelectExample: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 max-w-2xl w-full mx-auto text-center space-y-6">
      <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow-sm">
        <Scale className="h-6 w-6" aria-hidden="true" />
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-slate-900">
          Ask an Indian Legal or Judiciary Question
        </h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          Ask in English, Hindi, or Hinglish. Switch between{" "}
          <strong>Citizen</strong> (plain steps) and <strong>Lawyer</strong>{" "}
          (dense, citation-forward) styles above.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full text-left">
        {EXAMPLE_QUESTIONS.map((item) => (
          <button
            key={item.prompt}
            type="button"
            disabled={disabled}
            onClick={() => onSelectExample(item.prompt)}
            className="rounded-xl border border-slate-200 bg-white p-3.5 text-left hover:border-slate-400 hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50 space-y-1"
          >
            <span className="inline-block rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
              {item.audience}
            </span>
            <p className="text-xs font-medium text-slate-900 leading-snug">
              {item.prompt}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

