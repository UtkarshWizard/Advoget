export type Audience = "citizen" | "lawyer";

export interface UserProfile {
  id: string;
  email: string | null;
  display_name: string | null;
  audience: Audience;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
}

export interface SourceItem {
  id: string;
  type: "document" | "statute" | "web";
  title: string;
  ref: string;
  page?: number;
  url?: string;
  snippet: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  scope_label?: string | null;
  sources: SourceItem[];
  created_at: string;
  isRefusal?: boolean;
}

export type StreamStage =
  | "checking_scope"
  | "searching_documents"
  | "searching_statutes"
  | "searching_web"
  | "answering";

export interface StreamCallbacks {
  onConversation?: (conversationId: string) => void;
  onStatus?: (stage: StreamStage) => void;
  onToken?: (text: string) => void;
  onSources?: (items: SourceItem[]) => void;
  onRefusal?: (message: string) => void;
  onDone?: (usage: Record<string, unknown>) => void;
  onError?: (error: { code: string; message: string }) => void;
}

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export async function fetchMe(accessToken: string): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/api/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Failed to load profile (HTTP ${res.status})`);
  }
  return res.json();
}

export async function updateMe(
  accessToken: string,
  updates: { audience?: Audience; display_name?: string }
): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/api/me`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Failed to update profile (HTTP ${res.status})`);
  }
  return res.json();
}

export async function deleteMyData(accessToken: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/me/data`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Failed to delete user data (HTTP ${res.status})`);
  }
}

export async function fetchConversations(accessToken: string): Promise<ConversationSummary[]> {
  const res = await fetch(`${API_URL}/api/conversations`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Failed to load conversations (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.conversations ?? [];
}

export async function createConversation(
  accessToken: string,
  title?: string
): Promise<ConversationSummary> {
  const res = await fetch(`${API_URL}/api/conversations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Failed to create conversation (HTTP ${res.status})`);
  }
  return res.json();
}

export async function deleteConversation(
  accessToken: string,
  conversationId: string
): Promise<void> {
  const res = await fetch(`${API_URL}/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Failed to delete conversation (HTTP ${res.status})`);
  }
}

export async function fetchConversationMessages(
  accessToken: string,
  conversationId: string
): Promise<ChatMessage[]> {
  const res = await fetch(
    `${API_URL}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Failed to load messages (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.messages ?? [];
}

export async function streamChatMessage(
  accessToken: string,
  payload: {
    conversation_id?: string | null;
    message: string;
    document_ids?: string[];
  },
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversation_id: payload.conversation_id || undefined,
      message: payload.message,
      document_ids: payload.document_ids ?? [],
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    callbacks.onError?.({
      code: body?.error?.code || `HTTP_${res.status}`,
      message:
        body?.error?.message || `Request failed with HTTP ${res.status}. Please try again.`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventType = "message";
      let dataStr = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataStr += line.slice("data:".length).trim();
        }
      }

      if (dataStr) {
        try {
          const parsed = JSON.parse(dataStr);
          switch (eventType) {
            case "conversation":
              if (typeof parsed.conversation_id === "string") {
                callbacks.onConversation?.(parsed.conversation_id);
              }
              break;
            case "status":
              if (typeof parsed.stage === "string") {
                callbacks.onStatus?.(parsed.stage as StreamStage);
              }
              break;
            case "token":
              if (typeof parsed.text === "string") {
                callbacks.onToken?.(parsed.text);
              }
              break;
            case "sources":
              if (Array.isArray(parsed.items)) {
                callbacks.onSources?.(parsed.items as SourceItem[]);
              }
              break;
            case "refusal":
              if (typeof parsed.message === "string") {
                callbacks.onRefusal?.(parsed.message);
              }
              break;
            case "done":
              callbacks.onDone?.((parsed.usage as Record<string, unknown>) ?? {});
              break;
            case "error":
              callbacks.onError?.({
                code: String(parsed.code || "STREAM_ERROR"),
                message: String(parsed.message || "An error occurred during streaming."),
              });
              break;
          }
        } catch {
          // Ignore malformed JSON frames
        }
      }

      boundary = buffer.indexOf("\n\n");
    }
  }
}
