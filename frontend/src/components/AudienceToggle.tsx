import type { Audience } from "../lib/api";

interface AudienceToggleProps {
  audience: Audience;
  onChange: (next: Audience) => void;
  disabled?: boolean;
}

export function AudienceToggle({ audience, onChange, disabled }: AudienceToggleProps) {
  return (
    <div
      role="group"
      aria-label="Answer style"
      className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-xs font-medium"
    >
      <button
        type="button"
        disabled={disabled}
        aria-pressed={audience === "citizen"}
        onClick={() => onChange("citizen")}
        className={`px-3 py-1.5 rounded-md transition-colors ${
          audience === "citizen"
            ? "bg-white text-slate-900 shadow-sm"
            : "text-slate-600 hover:text-slate-900"
        }`}
      >
        Citizen (Plain)
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={audience === "lawyer"}
        onClick={() => onChange("lawyer")}
        className={`px-3 py-1.5 rounded-md transition-colors ${
          audience === "lawyer"
            ? "bg-white text-slate-900 shadow-sm"
            : "text-slate-600 hover:text-slate-900"
        }`}
      >
        Lawyer (Citations)
      </button>
    </div>
  );
}

