export function DisclaimerBar() {
  return (
    <div
      role="note"
      aria-label="Legal disclaimer"
      className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-900 flex items-center justify-between gap-2"
    >
      <span>
        <strong>AI-generated, verify before relying:</strong> This assistant provides general Indian legal information, not legal advice.
      </span>
      <span className="shrink-0 font-medium text-amber-800">
        Emergency: Dial 112
      </span>
    </div>
  );
}

