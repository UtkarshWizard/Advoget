import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { LogOut, Scale } from "lucide-react";
import { AudienceToggle } from "./components/AudienceToggle";
import { DisclaimerBar } from "./components/DisclaimerBar";
import {
  fetchMe,
  updateMe,
  type Audience,
  type UserProfile,
} from "./lib/api";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import { LoginPage } from "./pages/LoginPage";

function AuthenticatedWorkspace({ session }: { session: Session }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [savingAudience, setSavingAudience] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadProfile() {
      try {
        setLoadingProfile(true);
        const data = await fetchMe(session.access_token);
        if (active) {
          setProfile(data);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Failed to load profile."
          );
        }
      } finally {
        if (active) {
          setLoadingProfile(false);
        }
      }
    }
    loadProfile();
    return () => {
      active = false;
    };
  }, [session.access_token]);

  async function handleAudienceChange(nextAudience: Audience) {
    if (!profile || profile.audience === nextAudience) return;
    const prev = profile.audience;
    setProfile({ ...profile, audience: nextAudience });
    setSavingAudience(true);
    try {
      const updated = await updateMe(session.access_token, {
        audience: nextAudience,
      });
      setProfile(updated);
      setError(null);
    } catch (err) {
      setProfile({ ...profile, audience: prev });
      setError(
        err instanceof Error ? err.message : "Failed to update answer style."
      );
    } finally {
      setSavingAudience(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="min-h-dvh flex flex-col bg-slate-50 text-slate-900">
      <DisclaimerBar />

      <header className="border-b border-slate-200 bg-white px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-slate-900 text-white flex items-center justify-center">
            <Scale className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <span className="font-semibold text-base tracking-tight text-slate-900">
              Advoget
            </span>
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium">
              Indian Legal AI
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {profile && (
            <AudienceToggle
              audience={profile.audience}
              onChange={handleAudienceChange}
              disabled={savingAudience}
            />
          )}

          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto p-6 flex flex-col justify-center">
        <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-4">
          <h1 className="text-lg font-semibold text-slate-900">
            Authenticated Profile (`GET /api/me`)
          </h1>

          {loadingProfile && (
            <p className="text-sm text-slate-600">
              Waking up the server &amp; loading your profile...
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"
            >
              {error}
            </div>
          )}

          {profile && (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm bg-slate-50 border border-slate-200 rounded-lg p-4">
              <div>
                <dt className="text-xs text-slate-500">Display Name</dt>
                <dd className="font-medium text-slate-900">
                  {profile.display_name || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Email</dt>
                <dd className="font-medium text-slate-900">
                  {profile.email || session.user.email}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Answer Style (`audience`)</dt>
                <dd className="font-medium text-slate-900 capitalize">
                  {profile.audience}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">User ID</dt>
                <dd className="font-mono text-xs text-slate-700 truncate">
                  {profile.id}
                </dd>
              </div>
            </dl>
          )}
        </section>
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setInitializing(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitializing(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  if (initializing) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-slate-50 text-sm text-slate-600">
        Loading session...
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={session ? <Navigate to="/" replace /> : <LoginPage />}
        />
        <Route
          path="/"
          element={
            session ? (
              <AuthenticatedWorkspace session={session} />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
