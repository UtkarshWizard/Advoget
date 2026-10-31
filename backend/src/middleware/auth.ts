import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../supabase.js";

export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export type SupabaseProvider = () => Pick<SupabaseClient, "auth" | "from" | "storage">;

export function createRequireAuth(getSupabase: SupabaseProvider = getSupabaseAdmin) {
  return async function requireAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or malformed Authorization Bearer token.",
        },
      });
      return;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Empty Authorization Bearer token.",
        },
      });
      return;
    }

    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        res.status(401).json({
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid or expired session token.",
          },
        });
        return;
      }

      req.user = {
        id: data.user.id,
        email: data.user.email,
      };
      next();
    } catch {
      res.status(503).json({
        error: {
          code: "AUTH_UNAVAILABLE",
          message: "Authentication service is not configured or temporarily unavailable.",
        },
      });
    }
  };
}

