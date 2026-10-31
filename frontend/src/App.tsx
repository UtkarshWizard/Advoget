import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import {
  AlertCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Scale,
  Trash2,
  X,
} from "lucide-react";
import { AudienceToggle } from "./components/AudienceToggle";
import { Composer } from "./components/Composer";
import { DisclaimerBar } from "./components/DisclaimerBar";
import { EmptyState } from "./components/EmptyState";
import { MessageList } from "./components/MessageList";
import {
  deleteConversation,
  deleteMyData,
  fetchConversationMessages,
  fetchConversations,
  fetchMe,
  streamChatMessage,
  updateMe,
  type Audience,
  type ChatMessage,
  type ConversationSummary,
  type SourceItem,
  type StreamStage,
  type UserProfile,
} from "./lib/api";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import { LoginPage } from "./pages/LoginPage";

function ChatWorkspace({ session }: { session: Session }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [streaming, setStreaming] = useState(false);
  const [activeStage, setActiveStage] = useState<StreamStage | null>(null);
  const [wakingUpServer, setWakingUpServer] = useState(false);
  const [savingAudience, setSavingAudience] = useState(false);

  const [errorState, setErrorState] = useState<{
    code: string;
    message: string;
    retryPrompt?: string;
  } | null>(null);

  const wakeTimerRef = useRef<number | null>(null);

  const loadInitialData = useCallback(async () => {
    try {
      const [meData, convList] = await Promise.all([
        fetchMe(session.access_token),
        fetchConversations(session.access_token),
      ]);
      setProfile(meData);
      setConversations(convList);
    } catch (err) {
      setErrorState({
        code: "INIT_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to load your workspace.",
      });
    }
  }, [session.access_token]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  async function handleSelectConversation(convId: string) {
    setSidebarOpen(false);
    setActiveConversationId(convId);
    setErrorState(null);
    try {
      const msgs = await fetchConversationMessages(session.access_token, convId);
      setMessages(msgs);
    } catch (err) {
      setErrorState({
        code: "LOAD_MESSAGES_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to load conversation messages.",
      });
    }
  }

  function handleNewChat() {
    setSidebarOpen(false);
    setActiveConversationId(null);
    setMessages([]);
    setErrorState(null);
  }

  async function handleDeleteConversation(convId: string) {
    try {
      await deleteConversation(session.access_token, convId);
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (activeConversationId === convId) {
        setActiveConversationId(null);
        setMessages([]);
      }
    } catch (err) {
      setErrorState({
        code: "DELETE_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to delete conversation.",
      });
    }
  }

  async function handleDeleteAllData() {
    if (
      !window.confirm(
        "Delete all your conversations and uploaded documents permanently?"
      )
    ) {
      return;
    }
    try {
      await deleteMyData(session.access_token);
      setConversations([]);
      setActiveConversationId(null);
      setMessages([]);
      setErrorState(null);
    } catch (err) {
      setErrorState({
        code: "DELETE_ALL_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to delete your data.",
      });
    }
  }

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
    } catch (err) {
      setProfile({ ...profile, audience: prev });
      setErrorState({
        code: "AUDIENCE_ERROR",
        message:
          err instanceof Error ? err.message : "Failed to update answer style.",
      });
    } finally {
      setSavingAudience(false);
    }
  }

  async function handleSendMessage(promptText: string) {
    if (streaming) return;
    setErrorState(null);
    setStreaming(true);
    setActiveStage("answering");
    setWakingUpServer(false);

    const tempUserMsgId = `user-${Date.now()}`;
    const tempAssistantMsgId = `assistant-${Date.now()}`;
    const nowIso = new Date().toISOString();

    setMessages((prev) => [
      ...prev,
      {
        id: tempUserMsgId,
        conversation_id: activeConversationId || "pending",
        role: "user",
        content: promptText,
        sources: [],
        created_at: nowIso,
      },
      {
        id: tempAssistantMsgId,
        conversation_id: activeConversationId || "pending",
        role: "assistant",
        content: "",
        sources: [],
        created_at: nowIso,
      },
    ]);

    wakeTimerRef.current = window.setTimeout(() => {
      setWakingUpServer(true);
    }, 2500);

    const clearWakeTimer = () => {
      if (wakeTimerRef.current !== null) {
        clearTimeout(wakeTimerRef.current);
        wakeTimerRef.current = null;
      }
      setWakingUpServer(false);
    };

    let resolvedConvId = activeConversationId;

    try {
      await streamChatMessage(
        session.access_token,
        {
          conversation_id: activeConversationId,
          message: promptText,
          document_ids: [],
        },
        {
          onConversation(convId) {
            clearWakeTimer();
            resolvedConvId = convId;
            setActiveConversationId(convId);
          },
          onStatus(stage) {
            clearWakeTimer();
            setActiveStage(stage);
          },
          onToken(delta) {
            clearWakeTimer();
            setActiveStage(null);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAssistantMsgId
                  ? { ...m, content: m.content + delta }
                  : m
              )
            );
          },
          onSources(items: SourceItem[]) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAssistantMsgId ? { ...m, sources: items } : m
              )
            );
          },
          onRefusal(refusalMsg) {
            clearWakeTimer();
            setActiveStage(null);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAssistantMsgId
                  ? {
                      ...m,
                      content: refusalMsg,
                      isRefusal: true,
                      scope_label: "not_legal",
                    }
                  : m
              )
            );
          },
          onDone() {
            clearWakeTimer();
            setActiveStage(null);
          },
          onError(err) {
            clearWakeTimer();
            setActiveStage(null);
            // Remove empty assistant placeholder if no tokens arrived
            setMessages((prev) =>
              prev.filter(
                (m) => !(m.id === tempAssistantMsgId && !m.content.trim())
              )
            );
            setErrorState({
              code: err.code,
              message: err.message,
              retryPrompt: promptText,
            });
          },
        }
      );

      // Refresh sidebar list so new or re-titled conversations appear immediately
      const updatedList = await fetchConversations(session.access_token);
      setConversations(updatedList);
      if (resolvedConvId && !activeConversationId) {
        setActiveConversationId(resolvedConvId);
      }
    } catch (err) {
      clearWakeTimer();
      setActiveStage(null);
      setMessages((prev) =>
        prev.filter((m) => !(m.id === tempAssistantMsgId && !m.content.trim()))
      );
      setErrorState({
        code: "NETWORK_ERROR",
        message:
          err instanceof Error
            ? err.message
            : "Network error while contacting the server.",
        retryPrompt: promptText,
      });
    } finally {
      clearWakeTimer();
      setStreaming(false);
      setActiveStage(null);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="h-dvh flex flex-col bg-slate-50 text-slate-900 overflow-hidden">
      <DisclaimerBar />

      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white px-4 py-2.5 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-label="Toggle conversations sidebar"
            className="md:hidden p-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100"
          >
            {sidebarOpen ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Menu className="h-4 w-4" aria-hidden="true" />
            )}
          </button>

          <div className="h-8 w-8 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
            <Scale className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className="font-semibold text-base tracking-tight text-slate-900">
            Advoget
          </span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {profile && (
            <AudienceToggle
              audience={profile.audience}
              onChange={handleAudienceChange}
              disabled={savingAudience || streaming}
            />
          )}

          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      {/* Main Layout: Sidebar + Chat Panel */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Sidebar */}
        <aside
          aria-label="Conversation history"
          className={`${
            sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
          } fixed md:static inset-y-0 left-0 z-20 w-72 bg-white border-r border-slate-200 flex flex-col transition-transform duration-150 ease-out`}
        >
          <div className="p-3 border-b border-slate-100">
            <button
              type="button"
              onClick={handleNewChat}
              disabled={streaming}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New Legal Question
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {conversations.length === 0 ? (
              <p className="px-3 py-6 text-xs text-slate-400 text-center">
                No conversations yet.
              </p>
            ) : (
              conversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                return (
                  <div
                    key={conv.id}
                    className={`group flex items-center justify-between rounded-lg px-2.5 py-2 text-xs transition-colors ${
                      isActive
                        ? "bg-slate-100 text-slate-900 font-semibold"
                        : "text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectConversation(conv.id)}
                      className="flex-1 flex items-center gap-2 text-left truncate"
                    >
                      <MessageSquare
                        className="h-3.5 w-3.5 text-slate-400 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">
                        {conv.title || "Untitled conversation"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteConversation(conv.id)}
                      aria-label={`Delete conversation ${conv.title || ""}`}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-slate-400 hover:text-rose-600 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="p-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
            <span className="truncate max-w-[140px]">
              {profile?.display_name || session.user.email}
            </span>
            <button
              type="button"
              onClick={handleDeleteAllData}
              className="text-rose-700 hover:underline font-medium"
            >
              Delete my data
            </button>
          </div>
        </aside>

        {/* Chat Area */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {messages.length === 0 ? (
            <EmptyState
              onSelectExample={(prompt) => handleSendMessage(prompt)}
              disabled={streaming}
            />
          ) : (
            <MessageList
              messages={messages}
              activeStage={activeStage}
              wakingUpServer={wakingUpServer}
            />
          )}

          {errorState && (
            <div className="px-4 pb-2 max-w-3xl w-full mx-auto">
              <div
                role="alert"
                className={`rounded-xl border p-3 text-xs flex items-center justify-between gap-3 ${
                  errorState.code === "DAILY_LIMIT_REACHED" ||
                  errorState.code === "RATE_LIMIT"
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : "border-rose-200 bg-rose-50 text-rose-800"
                }`}
              >
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{errorState.message}</span>
                </div>

                {errorState.retryPrompt &&
                  errorState.code !== "DAILY_LIMIT_REACHED" && (
                    <button
                      type="button"
                      onClick={() => {
                        const promptToRetry = errorState.retryPrompt!;
                        setMessages((prev) => prev.slice(0, -1));
                        handleSendMessage(promptToRetry);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-current px-2.5 py-1 font-semibold hover:opacity-80 shrink-0"
                    >
                      <RefreshCw className="h-3 w-3" aria-hidden="true" />
                      Retry
                    </button>
                  )}
              </div>
            </div>
          )}

          <Composer onSend={handleSendMessage} disabled={streaming} />
        </main>
      </div>
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
              <ChatWorkspace session={session} />
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
