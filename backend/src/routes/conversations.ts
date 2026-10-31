import { Router, type Response } from "express";
import type { AuthenticatedRequest, SupabaseProvider } from "../middleware/auth.js";
import { getSupabaseAdmin } from "../supabase.js";

export function createConversationsRouter(
  getSupabase: SupabaseProvider = getSupabaseAdmin
): Router {
  const router = Router();

  // GET /api/conversations - List user's conversations ordered newest first
  router.get("/", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("conversations")
        .select("id, title, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) {
        res.status(500).json({
          error: { code: "DB_ERROR", message: "Failed to load conversations." },
        });
        return;
      }

      res.status(200).json({ conversations: data ?? [] });
    } catch {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unexpected error loading conversations." },
      });
    }
  });

  // POST /api/conversations - Create a new conversation
  router.post("/", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    const rawTitle = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const title = rawTitle ? rawTitle.slice(0, 100) : "New conversation";

    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("conversations")
        .insert({
          user_id: user.id,
          title,
        })
        .select("id, title, created_at")
        .single();

      if (error || !data) {
        res.status(500).json({
          error: { code: "DB_ERROR", message: "Failed to create conversation." },
        });
        return;
      }

      res.status(201).json(data);
    } catch {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unexpected error creating conversation." },
      });
    }
  });

  // DELETE /api/conversations/:id - Delete a conversation owned by the user
  router.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    const conversationId = String(req.params.id || "");
    if (!conversationId) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "Conversation ID is required." },
      });
      return;
    }

    try {
      const supabase = getSupabase();
      const { error } = await supabase
        .from("conversations")
        .delete()
        .eq("id", conversationId)
        .eq("user_id", user.id);

      if (error) {
        res.status(500).json({
          error: { code: "DB_ERROR", message: "Failed to delete conversation." },
        });
        return;
      }

      res.status(200).json({ status: "deleted", id: conversationId });
    } catch {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unexpected error deleting conversation." },
      });
    }
  });

  // GET /api/conversations/:id/messages - List messages in a conversation owned by the user
  router.get("/:id/messages", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    const conversationId = String(req.params.id || "");
    if (!conversationId) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "Conversation ID is required." },
      });
      return;
    }

    try {
      const supabase = getSupabase();

      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .select("id, title, created_at")
        .eq("id", conversationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (convErr || !conv) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "Conversation not found." },
        });
        return;
      }

      const { data: messages, error: msgErr } = await supabase
        .from("messages")
        .select("id, conversation_id, role, content, scope_label, sources, created_at")
        .eq("conversation_id", conversationId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });

      if (msgErr) {
        res.status(500).json({
          error: { code: "DB_ERROR", message: "Failed to load messages." },
        });
        return;
      }

      res.status(200).json({
        conversation: conv,
        messages: messages ?? [],
      });
    } catch {
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unexpected error loading messages." },
      });
    }
  });

  return router;
}

