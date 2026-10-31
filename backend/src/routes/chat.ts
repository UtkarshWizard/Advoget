import { Router, type Response } from "express";
import { config } from "../config.js";
import type { AuthenticatedRequest, SupabaseProvider } from "../middleware/auth.js";
import { getSupabaseAdmin } from "../supabase.js";

export interface ChatRouterOptions {
  getSupabase?: SupabaseProvider;
  aiServiceUrl?: string;
  internalApiKey?: string;
  dailyMessageCap?: number;
}

function writeSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function summarizeTitle(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New conversation";
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

export function createChatRouter(opts: ChatRouterOptions = {}): Router {
  const getSupabase = opts.getSupabase ?? getSupabaseAdmin;
  const aiServiceUrl = opts.aiServiceUrl ?? config.aiServiceUrl;
  const internalApiKey = opts.internalApiKey ?? config.internalApiKey;
  const dailyMessageCap = opts.dailyMessageCap ?? config.dailyMessageCap;

  const router = Router();

  router.post("/", async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated." } });
      return;
    }

    const rawMessage = typeof req.body?.message === "string" ? req.body.message : "";
    const documentIds: string[] = Array.isArray(req.body?.document_ids)
      ? req.body.document_ids.filter((id: unknown): id is string => typeof id === "string")
      : [];
    let conversationId: string =
      typeof req.body?.conversation_id === "string" ? req.body.conversation_id.trim() : "";

    if (!rawMessage.trim()) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "Message cannot be empty." },
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const supabase = getSupabase();
      const today = new Date().toISOString().slice(0, 10);

      // 1. Check daily usage cap
      const { data: usageRow } = await supabase
        .from("usage_daily")
        .select("messages, llm_calls, web_searches")
        .eq("user_id", user.id)
        .eq("day", today)
        .maybeSingle();

      const usedMessages = Number(usageRow?.messages ?? 0);
      const usedLlmCalls = Number(usageRow?.llm_calls ?? 0);
      const usedWebSearches = Number(usageRow?.web_searches ?? 0);

      if (usedMessages >= dailyMessageCap) {
        writeSseEvent(res, "error", {
          code: "DAILY_LIMIT_REACHED",
          message: `You have reached your daily limit of ${dailyMessageCap} messages. Please try again tomorrow.`,
        });
        res.end();
        return;
      }

      // 2. Ensure conversation exists and belongs to the user
      if (!conversationId) {
        const { data: createdConv, error: createConvErr } = await supabase
          .from("conversations")
          .insert({
            user_id: user.id,
            title: summarizeTitle(rawMessage),
          })
          .select("id, title")
          .single();

        if (createConvErr || !createdConv) {
          writeSseEvent(res, "error", {
            code: "DB_ERROR",
            message: "Failed to create conversation.",
          });
          res.end();
          return;
        }
        conversationId = createdConv.id;
      } else {
        const { data: existingConv, error: existingErr } = await supabase
          .from("conversations")
          .select("id, title")
          .eq("id", conversationId)
          .eq("user_id", user.id)
          .maybeSingle();

        if (existingErr || !existingConv) {
          writeSseEvent(res, "error", {
            code: "NOT_FOUND",
            message: "Conversation not found.",
          });
          res.end();
          return;
        }

        if (!existingConv.title || existingConv.title === "New conversation") {
          await supabase
            .from("conversations")
            .update({ title: summarizeTitle(rawMessage) })
            .eq("id", conversationId)
            .eq("user_id", user.id);
        }
      }

      // Emit conversation event so the frontend knows the active conversation ID
      writeSseEvent(res, "conversation", { conversation_id: conversationId });

      // 3. Persist the user's message and increment daily message count
      const { data: insertedUserMsg, error: userMsgErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          user_id: user.id,
          role: "user",
          content: rawMessage,
        })
        .select("id")
        .single();

      if (userMsgErr || !insertedUserMsg) {
        writeSseEvent(res, "error", {
          code: "DB_ERROR",
          message: "Failed to save your message.",
        });
        res.end();
        return;
      }

      await supabase.from("usage_daily").upsert(
        {
          user_id: user.id,
          day: today,
          messages: usedMessages + 1,
          llm_calls: usedLlmCalls,
          web_searches: usedWebSearches,
        },
        { onConflict: "user_id,day" }
      );

      // 4. Fetch user's audience setting and the last 10 messages of the conversation
      const { data: profileRow } = await supabase
        .from("profiles")
        .select("audience")
        .eq("id", user.id)
        .maybeSingle();

      const audience: "citizen" | "lawyer" =
        profileRow?.audience === "lawyer" ? "lawyer" : "citizen";

      const { data: recentRows } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      const recentMessages = (recentRows ?? []).reverse();

      // 5. Proxy SSE stream from Python ai-service
      const aiResponse = await fetch(`${aiServiceUrl}/ai/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": internalApiKey,
        },
        body: JSON.stringify({
          user_id: user.id,
          audience,
          messages: recentMessages,
          document_ids: documentIds,
          remaining_budget: Math.min(4, dailyMessageCap - usedMessages),
        }),
      });

      if (!aiResponse.ok || !aiResponse.body) {
        writeSseEvent(res, "error", {
          code: "AI_SERVICE_ERROR",
          message: `AI service returned HTTP ${aiResponse.status}.`,
        });
        res.end();
        return;
      }

      const reader = aiResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";
      let collectedSources: unknown[] = [];
      let scopeLabel: string | null = null;
      let llmCallsUsed = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundaryIdx = buffer.indexOf("\n\n");
        while (boundaryIdx !== -1) {
          const rawBlock = buffer.slice(0, boundaryIdx);
          buffer = buffer.slice(boundaryIdx + 2);

          let eventName = "message";
          let dataPayloadStr = "";

          for (const line of rawBlock.split("\n")) {
            if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
            } else if (line.startsWith("data:")) {
              dataPayloadStr += line.slice("data:".length).trim();
            }
          }

          if (dataPayloadStr) {
            try {
              const parsed = JSON.parse(dataPayloadStr);

              if (eventName === "token" && typeof parsed.text === "string") {
                assistantContent += parsed.text;
              } else if (eventName === "sources" && Array.isArray(parsed.items)) {
                collectedSources = parsed.items;
              } else if (eventName === "refusal" && typeof parsed.message === "string") {
                assistantContent = parsed.message;
                scopeLabel = parsed.scope_label || "not_legal";
              } else if (eventName === "done") {
                if (typeof parsed.scope_label === "string") {
                  scopeLabel = parsed.scope_label;
                }
                llmCallsUsed = Number(parsed.usage?.llm_calls ?? 1);

                // Persist assistant message & sources before forwarding 'done'
                if (assistantContent.trim()) {
                  await supabase.from("messages").insert({
                    conversation_id: conversationId,
                    user_id: user.id,
                    role: "assistant",
                    content: assistantContent,
                    sources: collectedSources,
                  });
                }

                if (scopeLabel) {
                  await supabase
                    .from("messages")
                    .update({ scope_label: scopeLabel })
                    .eq("id", insertedUserMsg.id)
                    .eq("user_id", user.id);
                }

                if (llmCallsUsed > 0) {
                  await supabase.from("usage_daily").upsert(
                    {
                      user_id: user.id,
                      day: today,
                      messages: usedMessages + 1,
                      llm_calls: usedLlmCalls + llmCallsUsed,
                      web_searches: usedWebSearches,
                    },
                    { onConflict: "user_id,day" }
                  );
                }
              }

              writeSseEvent(res, eventName, parsed);
            } catch {
              // Ignore malformed JSON frames
            }
          }

          boundaryIdx = buffer.indexOf("\n\n");
        }
      }

      res.end();
    } catch {
      writeSseEvent(res, "error", {
        code: "STREAM_PROXY_ERROR",
        message: "Failed to reach the AI service. Please check your connection and retry.",
      });
      res.end();
    }
  });

  return router;
}

