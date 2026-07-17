import "dotenv/config";
import { z } from "zod";

/**
 * Centralized, validated configuration.
 * Fails fast on boot if a required secret is missing.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),

  // Public HTTPS base URL of the deployed service (no trailing slash),
  // e.g. https://o-tracker.onrender.com — used for OAuth redirect, webhook, dashboard links.
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  // Secret path segment / secret_token for the webhook so only Telegram can call it.
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8),

  // Oura OAuth2 application credentials (cloud.ouraring.com/oauth/applications)
  OURA_CLIENT_ID: z.string().min(1),
  OURA_CLIENT_SECRET: z.string().min(1),
  // Optional: verification token for validating Oura webhook subscriptions (stage 2)
  OURA_WEBHOOK_VERIFICATION_TOKEN: z.string().optional(),

  // Gemini (Google AI Studio)
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),

  // 32-byte key, base64-encoded, for AES-256-GCM token encryption.
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ENCRYPTION_KEY: z.string().min(1),

  // Product behaviour
  DEFAULT_LANGUAGE: z.enum(["ru", "en", "pt"]).default("ru"),
  GEMINI_DAILY_QUOTA_PER_USER: z.coerce.number().default(8),
  METRIC_CONTEXT_DAYS: z.coerce.number().default(7),

  // Invite-only mode: comma-separated Telegram user IDs allowed to use the bot.
  // Leave empty to allow anyone (open mode).
  ALLOWED_TELEGRAM_IDS: z.string().default(""),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const OURA_REDIRECT_URI = `${config.PUBLIC_URL}/oauth/oura/callback`;
export const TELEGRAM_WEBHOOK_PATH = `/telegram/webhook/${config.TELEGRAM_WEBHOOK_SECRET}`;

// Parsed allowlist. Empty set = open to everyone.
export const ALLOWED_TELEGRAM_IDS = new Set(
  config.ALLOWED_TELEGRAM_IDS.split(",").map((s) => s.trim()).filter(Boolean),
);

export type Config = typeof config;
