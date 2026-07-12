import { prisma } from "../lib/db.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { refreshTokens, type OuraTokenResponse } from "./oauth.js";

// Refresh the access token this many seconds before it actually expires.
const REFRESH_SKEW_SECONDS = 120;

/** Persist a token response for a user (encrypted at rest). */
export async function saveTokens(userId: number, tok: OuraTokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + tok.expires_in * 1000);
  const data = {
    accessTokenEnc: encrypt(tok.access_token),
    refreshTokenEnc: encrypt(tok.refresh_token),
    expiresAt,
    scope: tok.scope ?? null,
  };
  await prisma.$transaction([
    prisma.ouraToken.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    }),
    prisma.user.update({ where: { id: userId }, data: { ouraConnected: true } }),
  ]);
}

/**
 * Return a currently-valid access token for the user, transparently refreshing
 * (and re-persisting) if it is expired or about to expire. Returns null if the
 * user has no token or the refresh has irrecoverably failed.
 */
export async function getValidAccessToken(userId: number): Promise<string | null> {
  const row = await prisma.ouraToken.findUnique({ where: { userId } });
  if (!row) return null;

  const now = Date.now();
  const expiresMs = row.expiresAt.getTime() - REFRESH_SKEW_SECONDS * 1000;
  if (now < expiresMs) {
    return decrypt(row.accessTokenEnc);
  }

  // Needs refresh.
  try {
    const refreshed = await refreshTokens(decrypt(row.refreshTokenEnc));
    await saveTokens(userId, refreshed);
    return refreshed.access_token;
  } catch (err) {
    console.error(`[oura] token refresh failed for user ${userId}:`, err);
    return null;
  }
}

/** Delete a user's Oura tokens and mark them disconnected. */
export async function deleteTokens(userId: number): Promise<void> {
  await prisma.$transaction([
    prisma.ouraToken.deleteMany({ where: { userId } }),
    prisma.user.update({ where: { id: userId }, data: { ouraConnected: false } }),
  ]);
}
