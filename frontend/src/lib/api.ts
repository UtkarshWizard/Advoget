export type Audience = "citizen" | "lawyer";

export interface UserProfile {
  id: string;
  email: string | null;
  display_name: string | null;
  audience: Audience;
  created_at: string;
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

