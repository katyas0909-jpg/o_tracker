import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Verify a Telegram Login Widget payload.
 * https://core.telegram.org/widgets/login#checking-authorization
 *
 * secret_key = SHA256(bot_token); the received `hash` must equal
 * HMAC-SHA256(data_check_string, secret_key), where data_check_string is all
 * fields except `hash`, sorted by key, joined as "key=value" with "\n".
 */
export interface TelegramAuthData {
  id: string;
  first_name?: string;
  username?: string;
  auth_date: string;
  hash: string;
  [k: string]: string | undefined;
}

const MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyTelegramAuth(data: TelegramAuthData): boolean {
  const { hash, ...fields } = data;
  if (!hash) return false;

  const dataCheckString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(config.TELEGRAM_BOT_TOKEN).digest();
  const hmac = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(hmac);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate)) return false;
  if (Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return false;

  return true;
}
