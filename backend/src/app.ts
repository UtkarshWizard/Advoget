import cors from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { config } from "./config.js";
import { createRequireAuth, type SupabaseProvider } from "./middleware/auth.js";
import { createMeRouter } from "./routes/me.js";
import { getSupabaseAdmin } from "./supabase.js";

export interface AppDependencies {
  getSupabase?: SupabaseProvider;
  aiServiceUrl?: string;
}

export function createApp(deps: AppDependencies = {}): Express {
  const getSupabase = deps.getSupabase ?? getSupabaseAdmin;
  const aiServiceUrl = deps.aiServiceUrl ?? config.aiServiceUrl;

  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests, please slow down.",
      },
    },
  });

  app.use("/api", apiLimiter);

  app.get("/api/health", async (_req, res) => {
    let aiServiceStatus: "ok" | "unreachable" = "unreachable";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`${aiServiceUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        aiServiceStatus = "ok";
      }
    } catch {
      aiServiceStatus = "unreachable";
    }

    res.status(200).json({
      status: "ok",
      service: "backend",
      ai_service: aiServiceStatus,
      timestamp: new Date().toISOString(),
    });
  });

  const requireAuth = createRequireAuth(getSupabase);

  app.use("/api/me", requireAuth, createMeRouter(getSupabase));

  return app;
}

