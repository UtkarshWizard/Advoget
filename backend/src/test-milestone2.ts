import assert from "node:assert/strict";
import { createApp } from "./app.js";
import type { SupabaseProvider } from "./middleware/auth.js";

interface StoredProfile {
  id: string;
  display_name: string | null;
  audience: "citizen" | "lawyer";
  created_at: string;
}

function createFakeSupabase(): {
  provider: SupabaseProvider;
  profiles: Map<string, StoredProfile>;
} {
  const profiles = new Map<string, StoredProfile>();

  const fakeClient = {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-jwt-user-a") {
          return {
            data: {
              user: {
                id: "11111111-1111-4111-8111-111111111111",
                email: "advocate.sharma@example.in",
              },
            },
            error: null,
          };
        }
        return {
          data: { user: null },
          error: new Error("Invalid token"),
        };
      },
    },
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({
                data: profiles.get(id) ?? null,
                error: null,
              }),
            }),
          }),
          insert: (row: { id: string; display_name: string; audience: "citizen" | "lawyer" }) => {
            const created: StoredProfile = {
              id: row.id,
              display_name: row.display_name,
              audience: row.audience,
              created_at: new Date().toISOString(),
            };
            profiles.set(row.id, created);
            return {
              select: () => ({
                single: async () => ({ data: created, error: null }),
              }),
            };
          },
          upsert: (row: Partial<StoredProfile> & { id: string }) => {
            const existing = profiles.get(row.id);
            const updated: StoredProfile = {
              id: row.id,
              display_name: row.display_name ?? existing?.display_name ?? "User",
              audience: row.audience ?? existing?.audience ?? "citizen",
              created_at: existing?.created_at ?? new Date().toISOString(),
            };
            profiles.set(row.id, updated);
            return {
              select: () => ({
                single: async () => ({ data: updated, error: null }),
              }),
            };
          },
        };
      }

      return {
        select: () => ({
          eq: async () => ({ data: [], error: null }),
        }),
        delete: () => ({
          eq: async () => ({ error: null }),
        }),
      };
    },
    storage: {
      from: () => ({
        remove: async () => ({ data: [], error: null }),
      }),
    },
  };

  return {
    provider: () => fakeClient as unknown as ReturnType<SupabaseProvider>,
    profiles,
  };
}

async function runMilestone2Tests() {
  const { provider } = createFakeSupabase();
  const app = createApp({ getSupabase: provider });
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log("1. Testing GET /api/me without token -> 401...");
    const r1 = await fetch(`${baseUrl}/api/me`);
    assert.equal(r1.status, 401);

    console.log("2. Testing GET /api/me with invalid token -> 401...");
    const r2 = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: "Bearer forged-token" },
    });
    assert.equal(r2.status, 401);

    console.log("3. Testing GET /api/me with valid token -> 200 (auto-creates citizen profile)...");
    const r3 = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: "Bearer valid-jwt-user-a" },
    });
    assert.equal(r3.status, 200);
    const profile1 = await r3.json();
    assert.equal(profile1.id, "11111111-1111-4111-8111-111111111111");
    assert.equal(profile1.email, "advocate.sharma@example.in");
    assert.equal(profile1.display_name, "advocate.sharma");
    assert.equal(profile1.audience, "citizen");
    console.log("   Returned profile:", JSON.stringify(profile1));

    console.log("4. Testing PATCH /api/me -> update audience to 'lawyer'...");
    const r4 = await fetch(`${baseUrl}/api/me`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer valid-jwt-user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audience: "lawyer", display_name: "Adv. R. Sharma" }),
    });
    assert.equal(r4.status, 200);
    const profile2 = await r4.json();
    assert.equal(profile2.audience, "lawyer");
    assert.equal(profile2.display_name, "Adv. R. Sharma");
    console.log("   Updated profile:", JSON.stringify(profile2));

    console.log("5. Testing PATCH /api/me with invalid audience -> 400...");
    const r5 = await fetch(`${baseUrl}/api/me`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer valid-jwt-user-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audience: "judge" }),
    });
    assert.equal(r5.status, 400);

    console.log("6. Testing DELETE /api/me/data -> 200...");
    const r6 = await fetch(`${baseUrl}/api/me/data`, {
      method: "DELETE",
      headers: { Authorization: "Bearer valid-jwt-user-a" },
    });
    assert.equal(r6.status, 200);

    console.log("ALL MILESTONE 2 BACKEND AUTH & PROFILE TESTS PASSED!");
  } finally {
    server.close();
  }
}

runMilestone2Tests().catch((err) => {
  console.error(err);
  process.exit(1);
});

