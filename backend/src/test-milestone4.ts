import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "./app.js";
import type { SupabaseProvider } from "./middleware/auth.js";

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

function createFakeSupabaseForRefusal() {
  const messages: MsgRow[] = [];
  const conversations = [
    {
      id: "conv-1",
      user_id: "11111111-1111-4111-8111-111111111111",
      title: "Test Chat",
      created_at: new Date().toISOString(),
    },
  ];

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
        return { data: { user: null }, error: new Error("Invalid token") };
      },
    },
    from: (table: string) => {
      if (table === "usage_daily") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
          upsert: async () => ({ error: null }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { audience: "citizen" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "conversations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: conversations[0],
                  error: null,
                }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: async () => ({ error: null }),
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
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: messages, error: null }),
                }),
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
    messages,
  };
}

async function runMilestone4BackendTests() {
  const fakeAiServer = http.createServer((req, res) => {
    if (req.url === "/ai/chat/stream" && req.method === "POST") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(`event: status\ndata: {"stage":"checking_scope"}\n\n`);
      res.write(
        `event: refusal\ndata: {"message":"I only assist with questions about Indian law, courts, and legal procedure.","scope_label":"not_legal"}\n\n`
      );
      res.write(
        `event: done\ndata: {"scope_label":"not_legal","usage":{"llm_calls":0}}\n\n`
      );
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => fakeAiServer.listen(0, resolve));
  const aiAddr = fakeAiServer.address();
  const aiPort = typeof aiAddr === "object" && aiAddr ? aiAddr.port : 0;

  const { provider, messages } = createFakeSupabaseForRefusal();
  const app = createApp({
    getSupabase: provider,
    aiServiceUrl: `http://127.0.0.1:${aiPort}`,
    internalApiKey: "test-internal-secret",
  });

  const apiServer = app.listen(0);
  const apiAddr = apiServer.address();
  const apiPort = typeof apiAddr === "object" && apiAddr ? apiAddr.port : 0;
  const baseUrl = `http://127.0.0.1:${apiPort}`;

  try {
    console.log("1. Testing SSE refusal stream & DB persistence of scope_label='not_legal'...");
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-jwt-user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversation_id: "conv-1",
        message: "Give me a biryani recipe.",
      }),
    });

    assert.equal(resp.status, 200);
    const sseText = await resp.text();
    assert.ok(sseText.includes("event: refusal"));
    assert.ok(sseText.includes("I only assist with questions about Indian law"));

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].scope_label, "not_legal");
    assert.equal(messages[1].role, "assistant");
    assert.ok(
      messages[1].content.includes("I only assist with questions about Indian law")
    );
    console.log("   User message scope_label:", messages[0].scope_label);
    console.log("   Saved refusal assistant message:", messages[1].content);
    console.log("ALL BACKEND MILESTONE 4 REFUSAL STREAMING TESTS PASSED!");
  } finally {
    apiServer.close();
    fakeAiServer.close();
  }
}

runMilestone4BackendTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
