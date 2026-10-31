import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "./app.js";
import type { SupabaseProvider } from "./middleware/auth.js";

interface ConvRow {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  scope_label: string | null;
  sources: unknown[];
  created_at: string;
}

function createInMemorySupabase() {
  const conversations: ConvRow[] = [];
  const messages: MsgRow[] = [];
  const usage = new Map<string, { messages: number; llm_calls: number; web_searches: number }>();

  const client = {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-jwt-user-a") {
          return {
            data: {
              user: {
                id: "11111111-1111-4111-8111-111111111111",
                email: "citizen@example.in",
              },
            },
            error: null,
          };
        }
        return { data: { user: null }, error: new Error("Invalid JWT") };
      },
    },
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "11111111-1111-4111-8111-111111111111",
                  display_name: "Citizen User",
                  audience: "citizen",
                  created_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "usage_daily") {
        return {
          select: () => ({
            eq: (_c1: string, userId: string) => ({
              eq: (_c2: string, day: string) => ({
                maybeSingle: async () => ({
                  data: usage.get(`${userId}:${day}`) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
          upsert: async (row: {
            user_id: string;
            day: string;
            messages: number;
            llm_calls: number;
            web_searches: number;
          }) => {
            usage.set(`${row.user_id}:${row.day}`, {
              messages: row.messages,
              llm_calls: row.llm_calls,
              web_searches: row.web_searches,
            });
            return { error: null };
          },
        };
      }

      if (table === "conversations") {
        return {
          select: () => ({
            eq: (_c1: string, val1: string) => ({
              order: async () => ({
                data: conversations.filter((c) => c.user_id === val1),
                error: null,
              }),
              eq: (_c2: string, val2: string) => ({
                maybeSingle: async () => ({
                  data:
                    conversations.find((c) => c.id === val1 && c.user_id === val2) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
          insert: (row: { user_id: string; title: string }) => {
            const created: ConvRow = {
              id: `conv-${conversations.length + 1}`,
              user_id: row.user_id,
              title: row.title,
              created_at: new Date().toISOString(),
            };
            conversations.push(created);
            return {
              select: () => ({
                single: async () => ({ data: created, error: null }),
              }),
            };
          },
          update: (updates: { title?: string }) => ({
            eq: (_c1: string, id: string) => ({
              eq: async (_c2: string, userId: string) => {
                const target = conversations.find(
                  (c) => c.id === id && c.user_id === userId
                );
                if (target && updates.title) {
                  target.title = updates.title;
                }
                return { error: null };
              },
            }),
          }),
          delete: () => ({
            eq: (_c1: string, id: string) => ({
              eq: async (_c2: string, userId: string) => {
                const idx = conversations.findIndex(
                  (c) => c.id === id && c.user_id === userId
                );
                if (idx >= 0) conversations.splice(idx, 1);
                return { error: null };
              },
            }),
          }),
        };
      }

      if (table === "messages") {
        return {
          insert: (row: {
            conversation_id: string;
            user_id: string;
            role: "user" | "assistant";
            content: string;
            sources?: unknown[];
          }) => {
            const created: MsgRow = {
              id: `msg-${messages.length + 1}`,
              conversation_id: row.conversation_id,
              user_id: row.user_id,
              role: row.role,
              content: row.content,
              scope_label: null,
              sources: row.sources ?? [],
              created_at: new Date().toISOString(),
            };
            messages.push(created);
            return {
              select: () => ({
                single: async () => ({ data: created, error: null }),
              }),
              then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
            };
          },
          select: () => ({
            eq: (_c1: string, convId: string) => ({
              eq: (_c2: string, userId: string) => ({
                order: (_col: string, opts: { ascending: boolean }) => {
                  const filtered = messages.filter(
                    (m) => m.conversation_id === convId && m.user_id === userId
                  );
                  const ordered = opts.ascending ? filtered : [...filtered].reverse();
                  return {
                    limit: async (n: number) => ({
                      data: ordered.slice(0, n),
                      error: null,
                    }),
                    then: (
                      resolve: (v: { data: MsgRow[]; error: null }) => void
                    ) => resolve({ data: ordered, error: null }),
                  };
                },
              }),
            }),
          }),
          update: (updates: { scope_label?: string }) => ({
            eq: (_c1: string, msgId: string) => ({
              eq: async (_c2: string, userId: string) => {
                const target = messages.find(
                  (m) => m.id === msgId && m.user_id === userId
                );
                if (target && updates.scope_label) {
                  target.scope_label = updates.scope_label;
                }
                return { error: null };
              },
            }),
          }),
        };
      }

      return {};
    },
  };

  return {
    provider: () => client as unknown as ReturnType<SupabaseProvider>,
    conversations,
    messages,
    usage,
  };
}

async function runMilestone3Tests() {
  // Spin up mock ai-service SSE server
  const fakeAiServer = http.createServer((req, res) => {
    if (req.url === "/ai/chat/stream" && req.method === "POST") {
      if (req.headers["x-internal-key"] !== "test-internal-secret") {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(`event: status\ndata: {"stage":"answering"}\n\n`);
      res.write(`event: token\ndata: {"text":"You can file an application "}\n\n`);
      res.write(`event: token\ndata: {"text":"for release of your vehicle before the Magistrate."}\n\n`);
      res.write(`event: sources\ndata: {"items":[]}\n\n`);
      res.write(`event: done\ndata: {"usage":{"llm_calls":1}}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });

  await new Promise<void>((resolve) => fakeAiServer.listen(0, resolve));
  const aiAddr = fakeAiServer.address();
  const aiPort = typeof aiAddr === "object" && aiAddr ? aiAddr.port : 0;

  const { provider, messages } = createInMemorySupabase();
  const app = createApp({
    getSupabase: provider,
    aiServiceUrl: `http://127.0.0.1:${aiPort}`,
    internalApiKey: "test-internal-secret",
    dailyMessageCap: 2,
  });

  const apiServer = app.listen(0);
  const apiAddr = apiServer.address();
  const apiPort = typeof apiAddr === "object" && apiAddr ? apiAddr.port : 0;
  const baseUrl = `http://127.0.0.1:${apiPort}`;

  try {
    console.log("1. Streaming POST /api/chat (auto-creates conversation + saves user & assistant messages)...");
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-jwt-user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "My bike was seized by the police. What can I do next?",
      }),
    });
    assert.equal(chatRes.status, 200);
    const sseText = await chatRes.text();
    assert.ok(sseText.includes("event: conversation"));
    assert.ok(sseText.includes("event: token"));
    assert.ok(sseText.includes("for release of your vehicle before the Magistrate."));
    assert.ok(sseText.includes("event: done"));

    assert.equal(messages.length, 2, "Expected both user and assistant messages stored in DB");
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(
      messages[1].content,
      "You can file an application for release of your vehicle before the Magistrate."
    );
    console.log("   Stored assistant message:", messages[1].content);

    console.log("2. Checking GET /api/conversations & GET /api/conversations/:id/messages...");
    const convsRes = await fetch(`${baseUrl}/api/conversations`, {
      headers: { Authorization: "Bearer valid-jwt-user-a" },
    });
    assert.equal(convsRes.status, 200);
    const convsData = await convsRes.json();
    assert.equal(convsData.conversations.length, 1);
    const convId = convsData.conversations[0].id;

    const histRes = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
      headers: { Authorization: "Bearer valid-jwt-user-a" },
    });
    assert.equal(histRes.status, 200);
    const histData = await histRes.json();
    assert.equal(histData.messages.length, 2);

    console.log("3. Sending second message in same conversation...");
    const chatRes2 = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-jwt-user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversation_id: convId,
        message: "Which court should I approach?",
      }),
    });
    await chatRes2.text();
    assert.equal(messages.length, 4);

    console.log("4. Verifying DAILY_MESSAGE_CAP enforcement on 3rd message...");
    const chatRes3 = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-jwt-user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversation_id: convId,
        message: "Third message over cap",
      }),
    });
    const sseCap = await chatRes3.text();
    assert.ok(sseCap.includes("DAILY_LIMIT_REACHED"), "Expected DAILY_LIMIT_REACHED event");
    console.log("   Daily cap SSE frame:", sseCap.trim());

    console.log("ALL BACKEND MILESTONE 3 STREAMING CHAT & HISTORY TESTS PASSED!");
  } finally {
    apiServer.close();
    fakeAiServer.close();
  }
}

runMilestone3Tests().catch((err) => {
  console.error(err);
  process.exit(1);
});

