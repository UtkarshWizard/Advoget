import { useEffect, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, Scale } from "lucide-react";
import { DisclaimerBar } from "../components/DisclaimerBar";
import { isSupabaseConfigured, supabase } from "../lib/supabase";

const dirtyState = new WeakMap<
  HTMLInputElement,
  { hasInteracted: boolean; hasBlurred: boolean }
>();

function syncInputValidationState(
  input: HTMLInputElement,
  eventType: "blur" | "input"
) {
  if (typeof CSS !== "undefined" && CSS.supports("selector(:user-invalid)")) {
    if (eventType === "blur" || input.hasAttribute("aria-invalid")) {
      input.setAttribute(
        "aria-invalid",
        input.matches(":user-invalid") ? "true" : "false"
      );
    }
    return;
  }

  // Fallback for browsers without :user-invalid support
  const current = dirtyState.get(input) ?? {
    hasInteracted: false,
    hasBlurred: false,
  };
  if (eventType === "input") {
    current.hasInteracted = true;
  } else if (eventType === "blur") {
    current.hasBlurred = true;
  }
  dirtyState.set(input, current);

  if (current.hasInteracted && current.hasBlurred) {
    const isValid = input.checkValidity();
    input.classList.toggle("user-invalid-fallback", !isValid);
    input.classList.toggle("user-valid-fallback", isValid);
    if (!isValid) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
  }
}

export function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    setErrorMessage(null);
    setInfoMessage(null);
  }, [mode]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    if (!isSupabaseConfigured) {
      setErrorMessage(
        "Supabase is not configured yet. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env."
      );
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          throw error;
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: displayName.trim()
              ? { full_name: displayName.trim() }
              : undefined,
          },
        });
        if (error) {
          throw error;
        }
        if (data.user && !data.session) {
          setInfoMessage(
            "Account created! Please check your email inbox to confirm your address before signing in."
          );
        }
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Authentication failed."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogleLogin() {
    setErrorMessage(null);
    if (!isSupabaseConfigured) {
      setErrorMessage(
        "Supabase is not configured yet. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env."
      );
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (error) {
        throw error;
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Google sign-in failed."
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col bg-slate-50 text-slate-900">
      <DisclaimerBar />

      <main className="flex-1 flex flex-col justify-start sm:justify-center items-center px-4 py-6 sm:py-12">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm p-6 sm:p-8 space-y-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-slate-900 text-white flex items-center justify-center shrink-0">
              <Scale className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                {mode === "signin"
                  ? "Sign in to Advoget"
                  : "Create your Advoget account"}
              </h1>
              <p className="text-xs text-slate-600">
                Indian Legal &amp; Judiciary Information Assistant
              </p>
            </div>
          </div>

          {!isSupabaseConfigured && (
            <div
              role="status"
              className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
            >
              <strong>Setup note:</strong> Configure{" "}
              <code className="font-mono">VITE_SUPABASE_URL</code> and{" "}
              <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> in{" "}
              <code className="font-mono">frontend/.env</code> (and apply{" "}
              <code className="font-mono">
                supabase/migrations/001_initial_schema.sql
              </code>
              ) to sign in against your Supabase project.
            </div>
          )}

          {errorMessage && (
            <div
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"
            >
              {errorMessage}
            </div>
          )}

          {infoMessage && (
            <div
              role="status"
              className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"
            >
              {infoMessage}
            </div>
          )}

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            className="space-y-4"
            onBlur={(e) => {
              if (e.target instanceof HTMLInputElement) {
                syncInputValidationState(e.target, "blur");
              }
            }}
            onInput={(e) => {
              if (e.target instanceof HTMLInputElement) {
                syncInputValidationState(e.target, "input");
              }
            }}
          >
            {mode === "signup" && (
              <div className="auth-field">
                <label
                  htmlFor="display-name"
                  className="block text-sm font-medium text-slate-800 mb-1"
                >
                  Full Name (optional)
                </label>
                <input
                  type="text"
                  id="display-name"
                  name="name"
                  autoComplete="name"
                  enterKeyHint="next"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Adv. Priya Sharma or Rakesh Kumar"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>
            )}

            <div className="auth-field">
              <label
                htmlFor="email"
                className="block text-sm font-medium text-slate-800"
              >
                Email Address
              </label>
              <span
                id="email-hint"
                className="block text-xs text-slate-500 mb-1"
              >
                Format: you@example.com
              </span>
              <input
                type="email"
                id="email"
                name="email"
                required
                spellCheck={false}
                autoComplete="username"
                enterKeyHint="next"
                aria-describedby="email-hint"
                aria-errormessage="email-error"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
              />
              <div id="email-error" className="error-msg">
                <span aria-hidden="true">❌ </span>Please enter a valid email
                address.
              </div>
            </div>

            <div className="auth-field">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-slate-800"
              >
                {mode === "signup" ? "New Password" : "Password"}
              </label>

              {mode === "signup" && (
                <ul
                  id="password-rules"
                  className="rules-list text-xs text-slate-500 mb-1.5 list-disc list-inside space-y-0.5"
                >
                  <li>At least 8 characters</li>
                  <li>One uppercase &amp; one lowercase letter</li>
                  <li>One number &amp; one special character</li>
                </ul>
              )}

              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  id="password"
                  name="password"
                  required
                  minLength={mode === "signup" ? 8 : 6}
                  pattern={
                    mode === "signup"
                      ? "(?=.*\\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[\\W_]).{8,}"
                      : undefined
                  }
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  enterKeyHint="done"
                  aria-describedby={
                    mode === "signup" ? "password-rules" : undefined
                  }
                  aria-errormessage="password-error"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 pl-3 pr-10 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-500 hover:text-slate-800"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
              <div id="password-error" className="error-msg">
                <span aria-hidden="true">❌ </span>
                {mode === "signup"
                  ? "Password must meet all requirements listed above."
                  : "Please enter your password."}
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {submitting
                ? "Please wait..."
                : mode === "signin"
                ? "Sign in"
                : "Create account"}
            </button>
          </form>

          <div className="relative flex items-center justify-center">
            <div className="border-t border-slate-200 w-full" />
            <span className="bg-white px-3 text-xs text-slate-500 uppercase tracking-wider">
              or
            </span>
            <div className="border-t border-slate-200 w-full" />
          </div>

          <button
            type="button"
            disabled={submitting}
            onClick={handleGoogleLogin}
            className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            Continue with Google
          </button>

          <div className="text-center text-xs text-slate-600 pt-2 border-t border-slate-100">
            {mode === "signin" ? (
              <>
                New to Advoget?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signup")}
                  className="font-semibold text-slate-900 hover:underline"
                >
                  Create account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signin")}
                  className="font-semibold text-slate-900 hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

