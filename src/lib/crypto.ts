import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Application-level encryption for Oura tokens (AES-256-GCM).
 * We never rely on DB-at-rest encryption alone for health-adjacent secrets.
 *
 * Stored format: base64(iv):base64(authTag):base64(ciphertext)
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function getKey(): Buffer {
  const key = Buffer.from(config.ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must decode to 32 bytes (base64). " +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed ciphertext");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

/** URL-safe random token (for OAuth state, one-time links). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
