import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  aiServiceUrl: process.env.AI_SERVICE_URL ?? "http://localhost:8000",
  internalApiKey: process.env.INTERNAL_API_KEY ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 20),
  maxPdfPages: Number(process.env.MAX_PDF_PAGES ?? 100),
  dailyMessageCap: Number(process.env.DAILY_MESSAGE_CAP ?? 30),
};

