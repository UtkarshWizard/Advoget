import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Paperclip, Send } from "lucide-react";

interface ComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function Composer({ onSend, disabled }: ComposerProps) {
  const [text, setText] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const lastCompositionEndAtRef = useRef<number | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    onSend(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();

      // IME-safe enter-to-submit (handles Hindi/Hinglish/CJK IME composition & Safari WebKit bug 165004)
      const nativeEvent = e.nativeEvent;
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      if (
        lastCompositionEndAtRef.current !== null &&
        Math.abs(nativeEvent.timeStamp - lastCompositionEndAtRef.current) < 50
      ) {
        return;
      }

      formRef.current?.requestSubmit();
    }
  }

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="max-w-3xl w-full mx-auto flex items-end gap-2"
      >
        <button
          type="button"
          disabled
          title="PDF upload arrives in Milestone 7"
          aria-label="Attach PDF document (coming in Milestone 7)"
          className="h-10 w-10 rounded-xl border border-slate-200 text-slate-400 flex items-center justify-center shrink-0 cursor-not-allowed"
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="flex-1">
          <label htmlFor="chat-composer-input" className="sr-only">
            Ask an Indian legal question
          </label>
          <textarea
            id="chat-composer-input"
            name="message"
            rows={1}
            disabled={disabled}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onCompositionEnd={(e) => {
              lastCompositionEndAtRef.current = e.nativeEvent.timeStamp;
            }}
            onKeyDown={handleKeyDown}
            placeholder="Ask a legal question in English, Hindi, or Hinglish... (Enter to send, Shift+Enter for new line)"
            className="composer-textarea rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none disabled:opacity-60 resize-none"
          />
        </div>

        <button
          type="submit"
          disabled={disabled || !text.trim()}
          aria-label="Send message"
          className="h-10 px-4 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors inline-flex items-center justify-center gap-1.5 shrink-0"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Send</span>
        </button>
      </form>
    </div>
  );
}

