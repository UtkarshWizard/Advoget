import { Router, type Response } from "express";
import type { AuthenticatedRequest, SupabaseProvider } from "../middleware/auth.js";
import { getSupabaseAdmin } from "../supabase.js";

export type AudienceType = "citizen" | "lawyer";

export interface ProfileRecord {
  id: string;
  display_name: string | null;
  audience: AudienceType;
  created_at: string;
}

export function createMeRouter(getSupabase: SupabaseProvider = getSupabaseAdmin): Router {
  const router = Router();

  // GET /api/me - Return current user's profile (creating default citizen profile if missing)
  router.get("/", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    try {
      const supabase = getSupabase();
      const { data: existing, error: selectError } = await supabase
        .from("profiles")
        .select("id, display_name, audience, created_at")
        .eq("id", user.id)
        .maybeSingle();

      if (selectError) {
        res.status(500).json({
          error: { code: "DB_ERROR", message: "Failed to load user profile." },
        });
        return;
      }

      if (existing) {
        res.status(200).json({
          id: existing.id,
          email: user.email ?? null,
          display_name: existing.display_name,
          audience: existing.audience as AudienceType,
          created_at: existing.created_at,
        });
        return;
      }

      const defaultDisplayName = user.email ? user.email.split("@")[0] : "User";
      const { data: created, error: insertError } = await supabase
        .from("profiles")
        .insert({
          id: user.id,
          display_name: defaultDisplayName,
          audience: "citizen",
        })
        .select("id, display_name, audience, created_at")
        .single();

      if (insertError || !created) {
        res.status(500).json({
          error: { code: "DB_ERROR", message: "Failed to initialize user profile." },
        });
        return;
      }

      res.status(200).json({
        id: created.id,
        email: user.email ?? null,
        display_name: created.display_name,
        audience: created.audience as AudienceType,
        created_at: created.created_at,
      });
    } catch {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unexpected error fetching profile." },
      });
    }
  });

  // PATCH /api/me - Update audience ('citizen' | 'lawyer') or display_name
  router.patch("/", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    const { audience, display_name } = req.body ?? {};
    const updates: Record<string, string> = {};

    if (audience !== undefined) {
      if (audience !== "citizen" && audience !== "lawyer") {
        res.status(400).json({
          error: {
            code: "INVALID_INPUT",
            message: "audience must be either 'citizen' or 'lawyer'.",
          },
        });
        return;
      }
      updates.audience = audience;
    }

    if (display_name !== undefined) {
      if (typeof display_name !== "string" || display_name.trim().length > 100) {
        res.status(400).json({
          error: {
            code: "INVALID_INPUT",
            message: "display_name must be a string up to 100 characters.",
          },
        });
        return;
      }
      updates.display_name = display_name.trim();
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Provide at least one field to update (audience or display_name).",
        },
      });
      return;
    }

    try {
      const supabase = getSupabase();
      const { data: updated, error } = await supabase
        .from("profiles")
        .upsert(
          {
            id: user.id,
            ...updates,
          },
          { onConflict: "id" }
        )
        .select("id, display_name, audience, created_at")
        .single();

      if (error || !updated) {
        res.status(500).json({
          error: { code: "DB_ERROR", message: "Failed to update user profile." },
        });
        return;
      }

      res.status(200).json({
        id: updated.id,
        email: user.email ?? null,
        display_name: updated.display_name,
        audience: updated.audience as AudienceType,
        created_at: updated.created_at,
      });
    } catch {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unexpected error updating profile." },
      });
    }
  });

  // DELETE /api/me/data - Delete all of the user's conversations and documents
  router.delete("/data", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    try {
      const supabase = getSupabase();

      // 1. Find all storage paths owned by user and remove files from private 'documents' bucket
      const { data: docs } = await supabase
        .from("documents")
        .select("storage_path")
        .eq("user_id", user.id);

      if (docs && docs.length > 0) {
        const paths = docs.map((d: { storage_path: string }) => d.storage_path).filter(Boolean);
        if (paths.length > 0) {
          await supabase.storage.from("documents").remove(paths);
        }
      }

      // 2. Delete documents (cascades to document_chunks) and conversations (cascades to messages)
      await supabase.from("documents").delete().eq("user_id", user.id);
      await supabase.from("conversations").delete().eq("user_id", user.id);

      res.status(200).json({ status: "deleted" });
    } catch {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Failed to delete user data." },
      });
    }
  });

  return router;
}

